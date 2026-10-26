// Apply the outbound connect-timeout tuning before any fetch is made.
import './network.js'
import {
  getOpencodeBase, OPENCODE_UA, LITERAL_KEY, DEFAULT_MAX_TOKENS, MAX_REQUEST_ATTEMPTS,
  isFingerprintTool, getFingerprintHeaders, peekFingerprintHeaders,
} from './config.js'
import {
  buildRequestBody, buildWireBody, parseSse,
  callerToolNames, translateFingerprintCall, encodeTranslatedId,
  normalizeToolArguments, shapeCompletion,
} from './conversions.js'

function resolveApiKey() {
  return process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_G_API_KEY || LITERAL_KEY
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function abortedError() {
  const e = new Error('OpenCode Zen request aborted by caller')
  e.code = 'ABORTED'
  return e
}

// ---------------------------------------------------------------------------
// Quota exhaustion (429 FreeUsageLimitError / GoUsageLimitError)
// ---------------------------------------------------------------------------
// A plain 429 ("slow down") is a transient throttle and is worth retrying. The
// Zen free tier ALSO returns 429 for an exhausted daily quota, with a body like:
//
//   {"type":"error","error":{"type":"FreeUsageLimitError","message":
//    "Free usage limit reached. ... subscribe to OpenCode Go ..."}}
//
// and a `Retry-After` measured in hours. That is an account/IP budget, not a
// throttle: retrying 500ms later can never succeed, it only burns three
// upstream round-trips and spams the log (exactly the reported symptom). We
// classify it separately, surface `Retry-After`, and remember the reset time so
// every subsequent request fails fast until the quota is replenished.
const QUOTA_ERROR_TYPES = new Set([
  'freeusagelimiterror',
  'gousagelimiterror',
  'creditlimitexceeded',
  'quotaexceedederror',
])
const QUOTA_MESSAGE_RE =
  /free usage limit|usage limit reached|subscribe to opencode go|monthly usage limit|quota (?:exhausted|reached)|insufficient[_ ]quota/i
const QUOTA_COOLDOWN_FALLBACK_MS = 60_000

const quota = {
  until: 0, // epoch ms; requests fail fast while now < until
  resetAt: null,
  message: '',
  upstreamType: '',
  identity: '',
  hits: 0,
}

export function quotaState() {
  const now = Date.now()
  const active = quota.until > now
  return {
    active,
    until: active ? new Date(quota.until).toISOString() : null,
    resetAt: quota.resetAt ? new Date(quota.resetAt).toISOString() : null,
    remainingSeconds: active ? Math.ceil((quota.until - now) / 1000) : 0,
    hits: quota.hits,
    upstreamType: quota.upstreamType || null,
    message: quota.message || null,
  }
}

// Tests (and an operator after topping up / switching keys) can clear the gate.
export function resetQuotaState() {
  quota.until = 0
  quota.resetAt = null
  quota.message = ''
  quota.upstreamType = ''
  quota.identity = ''
  quota.hits = 0
}

function quotaBlocked() {
  return quota.until > Date.now() && quota.identity === resolveApiKey()
}

function quotaError() {
  const e = new Error(quota.message || 'OpenCode Zen free-tier quota exhausted')
  e.code = 'QUOTA_EXHAUSTED'
  e.status = 429
  e.quota = true
  e.retryAfterMs = Math.max(0, quota.until - Date.now())
  e.resetAt = quota.until
  return e
}

function markQuotaExhausted(err) {
  const now = Date.now()
  const resetAt = Number.isFinite(err.resetAt) && err.resetAt > now
    ? err.resetAt
    : now + QUOTA_COOLDOWN_FALLBACK_MS
  quota.until = resetAt
  quota.resetAt = resetAt
  quota.upstreamType = err.upstreamType || 'FreeUsageLimitError'
  quota.message = err.message
  quota.identity = resolveApiKey()
  quota.hits += 1
  console.warn(
    `[opencode-free-provider] free-tier quota exhausted (${quota.upstreamType}); ` +
    `failing fast until ${new Date(resetAt).toISOString()}`,
  )
}

// Parse the small subset of the upstream error shape we need.
function parseErrorPayload(raw) {
  try {
    const parsed = JSON.parse(raw)
    const error = parsed && parsed.error
    if (error && typeof error === 'object') {
      return { type: String(error.type || ''), message: String(error.message || '') }
    }
    if (typeof error === 'string') return { type: '', message: error }
    if (parsed && typeof parsed.message === 'string') {
      return { type: String(parsed.type || ''), message: parsed.message }
    }
  } catch { /* non-JSON body */ }
  return { type: '', message: '' }
}

// `Retry-After` is either delta-seconds or an HTTP date. Return ms or null.
function parseRetryAfter(value) {
  if (value == null || value === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

function upstreamHttpError(status, raw, retryAfterHeader) {
  const { type, message } = parseErrorPayload(raw)
  const retryAfterMs = parseRetryAfter(retryAfterHeader)
  const isQuota = status === 429 && (
    QUOTA_ERROR_TYPES.has(type.toLowerCase()) || QUOTA_MESSAGE_RE.test(message || raw)
  )

  const e = new Error(`OpenCode Zen HTTP ${status}: ${(raw || '').slice(0, 300)}`)
  e.status = status
  if (retryAfterMs != null) e.retryAfterMs = retryAfterMs

  if (isQuota) {
    e.code = 'QUOTA_EXHAUSTED'
    e.quota = true
    e.retryable = false
    e.upstreamType = type || 'FreeUsageLimitError'
    e.resetAt = retryAfterMs != null ? Date.now() + retryAfterMs : null
    return e
  }

  e.code = status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
  // 429 with a generic body and 5xx are transient; other 4xx are not.
  e.retryable = status === 429 || status >= 500
  return e
}


// ---------------------------------------------------------------------------
// Transport-failure classification + retry policy
// ---------------------------------------------------------------------------
// Node's global fetch surfaces network-level failures as TypeError("fetch
// failed") with the real cause on err.cause (e.g. { code: 'ECONNRESET' }). The
// upstream free tier is flaky: it resets connections mid-stream, and long
// reasoning turns can exceed the per-request timeout (AbortError). We classify
// those as retryable and enrich the error message with the underlying cause so
// "fetch failed" becomes actionable (ECONNRESET / ETIMEDOUT / ...).
const RETRYABLE_CAUSE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_STREAM_TIMEOUT', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED',
])

function isRetryableUpstreamError(err) {
  if (!err) return false
  // Account/IP budget exhaustion is deterministic until the reset time.
  if (err.quota || err.code === 'QUOTA_EXHAUSTED') return false
  if (err.retryable === true) return true
  if (err.code === 'RATE_LIMITED' || err.code === 'TRANSPORT') return true
  if (err.name === 'AbortError') return true // our per-request timeout fired
  const cause = err.cause
  const causeCode = cause?.code || err.code
  if (causeCode && RETRYABLE_CAUSE_CODES.has(causeCode)) return true
  return /fetch failed|socket hang up|reset by peer/i.test(String(err.message || ''))
}

// Enrich a transport error with its real cause / a timeout marker so the
// operator sees ECONNRESET/ETIMEDOUT/... instead of a bare "fetch failed".
function enrichTransportError(err, phase, timeoutMs) {
  if (!err) return new Error(`OpenCode Zen ${phase} failed`)
  if (err.name === 'AbortError') {
    err.message = `OpenCode Zen ${phase} timed out after ${timeoutMs || 60000}ms`
    err.retryable = true
    return err
  }
  const cause = err.cause
  const causeInfo = cause ? (cause.code || cause.message) : null
  if (causeInfo && !String(err.message).includes(String(causeInfo))) {
    err.message = `${err.message} (${causeInfo})`
  }
  if (!err.code) err.retryable = true
  return err
}

// Exponential backoff with jitter: ~500ms, 1s, 2s ... capped at 8s.
function backoffMs(attempt) {
  const base = 500 * 2 ** attempt
  const jitter = Math.random() * base * 0.5
  return Math.min(Math.round(base + jitter), 8000)
}

// Fingerprint headers the upstream free-tier gateway requires on every request.
//
// The fingerprint is generated in pure JS (see src/fingerprint.js) — no CLI or
// MITM. `fp` is the (awaited) fingerprint header set; when null we fall back to
// the synchronous peek. Both carry only the shape the upstream gate validates.
function fingerprintHeaders(fp) {
  const real = fp || peekFingerprintHeaders()
  // The generator emits lower-cased keys (no authorization); strip any
  // authorization that may have been merged in so our resolved key is the only
  // one, then add the resolved `Authorization`.
  const { authorization: _drop, ...rest } = real
  void _drop
  return {
    ...rest,
    Authorization: `Bearer ${resolveApiKey()}`,
  }
}

// The set of fingerprint tool names the upstream gate forces us to advertise
// (bash/glob/grep/read). The proxy never executes them; when the calling agent
// does not implement one, runTranslateLoop rewrites that tool_call into an
// agent-supported tool so the agent runs it itself.

/**
 * Relay a chat.completions request to OpenCode Zen free tier.
 *
 * The proxy is a PURE forwarder: it never executes tools itself. The upstream
 * gate forces the tool names bash/glob/grep/read onto the wire, but the calling
 * agent (e.g. pi-agent) does not necessarily implement every one of them
 * (pi-agent has bash/grep/read but no `glob`). When the model emits a
 * fingerprint tool the agent cannot run, the proxy rewrites that tool_call into
 * a tool the agent DOES implement (e.g. `glob` -> `bash` with a globstar loop),
 * hands the rewritten call to the agent, and lets the agent execute it in ITS
 * OWN working directory. The agent's real result is then fed back to the model
 * as ordinary text. This keeps the relay usable for ANY OpenAI-compatible
 * client without the proxy ever touching the filesystem or assuming a cwd.
 *
 * The upstream only accepts stream:true, so we always request streaming
 * upstream. When the agent asked for `stream:false` we collect the upstream SSE
 * and resolve a single shaped completion object.
 *
 * Returns an async generator of OpenAI streaming chunks when stream=true, or a
 * single shaped completion object when stream=false.
 */
export async function* relayChatCompletions(opts) {
  const {
    model, messages, system, tools, maxTokens, temperature, stream, topP, signal, timeoutMs,
  } = opts

  // The free-tier quota is per IP/account and resets on a schedule. While it is
  // exhausted, replaying the request upstream is guaranteed to 429 again, so
  // fail immediately with the reset time instead of burning retries.
  if (quotaBlocked()) throw quotaError()

  const clientToolNames = callerToolNames(tools)
  // Await the real opencode fingerprint once (cached/promised inside config.js).
  const fpHeaders = await getFingerprintHeaders().catch(() => null)
  const baseBody = buildRequestBody({
    model, messages, system, tools,
    maxTokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature, stream: true, topP,
  })

  // The wire conversation we keep re-sending to upstream (starts as the request
  // body's messages; grows with assistant tool-call + tool-result messages).
  let wireMessages = baseBody.messages
  const wireTools = baseBody.tools

  // One complete upstream round-trip: fetch + consume the SSE (via
  // runTranslateLoop) + translate tool calls. Connection-level failures
  // (fetch failed / reset / timeout) and retryable HTTP statuses are thrown and
  // retried by the loop below. Nothing is emitted to the agent until a turn
  // fully succeeds, so retrying never duplicates already-delivered content.
  async function performTurn() {
    if (signal?.aborted) throw abortedError()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || 60000)
    const onAbort = () => controller.abort()
    if (signal) signal.addEventListener('abort', onAbort)
    let response
    try {
      const body = { ...baseBody, messages: wireMessages }
      response = await fetch(`${getOpencodeBase()}/chat/completions`, {
        method: 'POST',
        headers: fingerprintHeaders(fpHeaders),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      throw enrichTransportError(err, 'fetch', timeoutMs)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      throw upstreamHttpError(response.status, raw, response.headers.get('retry-after'))
    }

    const ctype = response.headers.get('content-type') || ''
    try {
      // Fully consume the upstream stream (this is where a mid-stream connection
      // drop surfaces) and translate fingerprint tool calls for the agent.
      if (ctype.includes('event-stream')) {
        return await runTranslateLoop(response, opts, wireMessages, wireTools, clientToolNames, fpHeaders)
      }
      // Unexpected non-stream JSON response for a streaming request.
      const payload = await response.json().catch(() => null)
      if (!payload) throw new Error('OpenCode Zen returned an unexpected (non-SSE) completion body')
      return shapeCompletion(payload, model)
    } catch (err) {
      throw enrichTransportError(err, 'stream', timeoutMs)
    }
  }

  // Retry loop over the FULL turn. The free tier is flaky: connections get
  // reset mid-stream and long turns can exceed the per-request timeout. We
  // retry connection-level failures and 429/5xx with exponential backoff +
  // jitter, enriching errors with the real cause (ECONNRESET, ETIMEDOUT, ...).
  // Non-retryable 4xx and client aborts surface immediately.
  const attempts = Math.max(1, MAX_REQUEST_ATTEMPTS)
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    let completion
    try {
      completion = await performTurn()
    } catch (err) {
      if (signal?.aborted) throw abortedError()
      lastError = err
      if (err.code === 'QUOTA_EXHAUSTED') {
        // Deterministic until the reset time: record it, fail fast afterwards.
        markQuotaExhausted(err)
        throw err
      }
      if (!isRetryableUpstreamError(err)) throw err
      if (attempt >= attempts - 1) break
      // A transient 429 may still carry Retry-After; honor it (capped so a
      // single client request cannot be held open for minutes).
      const retryAfterMs = Number(err.retryAfterMs) || 0
      const waitMs = Math.max(backoffMs(attempt), Math.min(retryAfterMs, 10_000))
      console.warn(`[opencode-free-provider] upstream attempt ${attempt + 1}/${attempts} failed: ${err.message}; retrying in ${waitMs}ms`)
      await sleep(waitMs)
      continue
    }

    if (!stream) { yield completion; return }
    if (completion) yield* completionToChunks(completion)
    return
  }
  throw lastError || new Error('OpenCode Zen request failed')
}

/**
 * Aggregate upstream SSE responses and rewrite any fingerprint tool_call the
 * agent cannot run into an agent-supported tool. Returns the completion object
 * that the proxy hands to the agent (standard OpenAI shape). The proxy NEVER
 * executes tools: translation is purely a rewrite of tool_call names/args, and
 * the agent runs the rewritten calls in ITS OWN working directory.
 *
 * Agent-executable tool_calls (names the caller registered) are forwarded
 * verbatim. Fingerprint tool_calls the agent does NOT implement are translated
 * via translateFingerprintCall (e.g. `glob` -> `bash` with a globstar loop). If
 * no registered tool can stand in for a fingerprint call, the proxy records a
 * textual note and re-queries upstream (a pure relay — no shell/filesystem
 * execution) until the model yields either real agent work or a final answer.
 */
async function runTranslateLoop(firstResponse, opts, wireMessages, wireTools, clientToolNames, fpHeaders) {
  const { model, maxTokens, temperature, topP, timeoutMs } = opts
  let wire = [...wireMessages]
  let response = firstResponse

  for (let turn = 0; turn < 4; turn++) {
    const completion = await aggregateSse(response, model, () => JSON.stringify(wire))
    const msg = completion.choices?.[0]?.message || {}
    const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    if (tcs.length === 0) return completion

    const agentCalls = []
    const translatedCalls = [] // real agent tools produced from fingerprint calls
    const noteResults = [] // textual stand-ins when no agent tool can stand in
    for (const tc of tcs) {
      const name = tc.function?.name
      if (clientToolNames.has(name)) {
        agentCalls.push(tc) // agent runs it itself; forward verbatim
      } else if (isFingerprintTool(name)) {
        let args = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch { /* ignore */ }
        const tr = translateFingerprintCall(name, args, clientToolNames)
        if (tr) {
          translatedCalls.push({
            id: encodeTranslatedId(tc.id, name, tc.function?.arguments || '{}'),
            type: 'function',
            function: { name: tr.name, arguments: JSON.stringify(tr.arguments) },
          })
        } else {
          // Nothing in the agent's toolset can stand in; give the model a textual
          // result directly (pure relay, not execution) and continue the loop.
          noteResults.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `The tool "${name}" is not available in your environment; no result provided.`,
          })
        }
      } else {
        agentCalls.push(tc) // unknown tool registered by a different name; forward
      }
    }

    if (noteResults.length) {
      // Feed the textual notes back to upstream and continue; the model either
      // stops or emits real (agent-executable) tool calls on the next turn.
      const assistantMsg = { ...msg, content: msg.content || null }
      wire = [...wire, assistantMsg, ...noteResults]
      // Use a guarded AbortController (not a bare AbortSignal.timeout) so that a
      // truncated stream here is caught and surfaces as a real error instead of
      // being silently aggregated into a completion with a missing finish_reason
      // — which is what later triggers "Stream ended without finish_reason".
      const noteController = new AbortController()
      const noteTimer = setTimeout(() => noteController.abort(), timeoutMs || 60000)
      try {
        response = await fetch(`${getOpencodeBase()}/chat/completions`, {
          method: 'POST', headers: fingerprintHeaders(fpHeaders),
          body: JSON.stringify(buildWireBody({
            model, wireMessages: wire, wireTools, maxTokens: maxTokens || DEFAULT_MAX_TOKENS, temperature, topP,
          })),
          signal: noteController.signal,
        })
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          throw upstreamHttpError(response.status, raw, response.headers.get('retry-after'))
        }
      } finally {
        clearTimeout(noteTimer)
      }
      continue
    }

    if (agentCalls.length === 0 && translatedCalls.length === 0) return completion

    const agentMsg = {
      ...msg,
      content: msg.content || null,
      tool_calls: [...agentCalls, ...translatedCalls],
    }
    return {
      ...completion,
      choices: [{ ...completion.choices[0], message: agentMsg, finish_reason: 'tool_calls' }],
    }
  }
  return completion
}

// Convert an aggregated completion object into OpenAI streaming chunks so the
// agent receives a standards-compliant stream.
async function* completionToChunks(completion) {
  const msg = completion.choices?.[0]?.message || {}
  const id = completion.id || `chatcmpl-${Date.now()}`
  const created = completion.created ?? Math.floor(Date.now() / 1000)
  const modelName = completion.model || msg.model || 'opencode-free/big-pickle'

  // 1) reasoning (if any)
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length) {
    yield makeChunk(id, created, modelName, [{ delta: { reasoning_content: msg.reasoning_content }, finish_reason: null }])
  }
  // 2) text content (if any)
  if (typeof msg.content === 'string' && msg.content.length) {
    yield makeChunk(id, created, modelName, [{ delta: { content: msg.content }, finish_reason: null }])
  }
  // 3) tool calls (if any)
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i]
      yield makeChunk(id, created, modelName, [{
        delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments || '' } }] },
        finish_reason: null,
      }])
    }
  }
  // 4) terminal chunk: carries the finish_reason (and usage). This MUST contain
  //    a choice with a non-null finish_reason, otherwise OpenAI-compatible
  //    clients abort with "Stream ended without finish_reason".
  //
  //    IMPORTANT: coerce to a non-null sentinel. The upstream free tier can drop
  //    the finish_reason (stream truncated by a network glitch or the per-request
  //    AbortSignal.timeout firing in runTranslateLoop's note sub-loop), leaving
  //    completion.choices[0].finish_reason === null/undefined. Passing that null
  //    through is exactly what makes the client throw "Stream ended without
  //    finish_reason". Always fall back to a concrete reason here.
  const rawFinish = completion.choices?.[0]?.finish_reason
  const finish = (rawFinish && typeof rawFinish === 'string' && rawFinish.length > 0)
    ? rawFinish
    : (msg.tool_calls?.length ? 'tool_calls' : 'stop')
  yield makeChunk(id, created, modelName, [{ delta: {}, finish_reason: finish }], finish, completion.usage)
}

function makeChunk(id, created, model, choices, finishReason, usage) {
  // Each choice carries its own finish_reason (explicitly set, even if null for
  // non-terminal chunks). The overall `finishReason` is the fallback only used
  // by callers that omit it on a choice.
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: choices.map((c) => ({
      index: 0, ...c,
      finish_reason: c.finish_reason === undefined ? (finishReason ?? null) : c.finish_reason,
    })),
    ...usage ? { usage: mapUsageForChunk(usage) } : {},
  }
}

function mapUsageForChunk(usage) {
  if (!usage) return undefined
  return {
    prompt_tokens: (usage.prompt_tokens || 0),
    completion_tokens: (usage.completion_tokens || 0),
    total_tokens: (usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
  }
}

// Read the full upstream SSE stream, aggregate it into a single OpenAI
// chat.completion object (matching shapeCompletion's output).
async function aggregateSse(response, model, estimateInput) {
  let out = null
  const content = []
  const reasoning = []
  const toolCalls = new Map()
  let finishReason = null
  let usage = null
  let id = null
  let created = null
  let modelOut = null

  for await (const chunk of parseSse(response)) {
    id = chunk.id ?? id
    created = chunk.created ?? created
    modelOut = chunk.model ?? modelOut
    if (chunk.usage) usage = chunk.usage
    for (const choice of chunk.choices || []) {
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta || {}
      if (typeof delta.content === 'string') content.push(delta.content)
      if (typeof delta.reasoning_content === 'string') reasoning.push(delta.reasoning_content)
      for (const tc of delta.tool_calls || []) {
        const i = tc.index || 0
        let block = toolCalls.get(i)
        if (!block) {
          block = { id: '', type: 'function', function: { name: '', arguments: '' } }
          toolCalls.set(i, block)
        }
        if (tc.id) block.id = tc.id
        if (tc.function?.name) block.function.name += tc.function.name
        if (tc.function?.arguments) block.function.arguments += tc.function.arguments
      }
    }
  }

  // Sanitize aggregated tool-call arguments before the message is either handed
  // to the agent or re-sent upstream. When the upstream stream is truncated
  // (network glitch) an arguments fragment can be empty/invalid; OpenCode Zen
  // rejects that with HTTP 400 "function.arguments must be a JSON object".
  for (const block of toolCalls.values()) {
    block.function.arguments = normalizeToolArguments(block.function.arguments)
  }

  const message = { role: 'assistant', content: content.join('') }
  if (reasoning.length) message.reasoning_content = reasoning.join('')
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.keys()].sort((a, b) => a - b).map((i) => toolCalls.get(i))
    if (!message.content) message.content = null
  }

  out = {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: modelOut || model,
    choices: [{ index: 0, message, finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop') }],
    usage: usage || null,
  }
  return out
}
