import {
  getOpencodeBase, OPENCODE_UA, OPENCODE_CLIENT, OPENCODE_PROJECT,
  LITERAL_KEY, DEFAULT_MAX_TOKENS, MAX_REQUEST_ATTEMPTS,
  currentSession, newRequestId, isFingerprintTool,
} from './config.js'
import {
  buildRequestBody, buildWireBody, parseSse, translateStream,
  callerToolNames, translateFingerprintCall, encodeTranslatedId,
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

// Fingerprint headers the upstream free-tier gateway requires on every request.
function fingerprintHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': OPENCODE_UA,
    Authorization: `Bearer ${resolveApiKey()}`,
    'x-opencode-session': currentSession(),
    'x-opencode-request': newRequestId(),
    'x-opencode-client': OPENCODE_CLIENT,
    'x-opencode-project': OPENCODE_PROJECT,
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

  const clientToolNames = callerToolNames(tools)
  const baseBody = buildRequestBody({
    model, messages, system, tools,
    maxTokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature, stream: true, topP,
  })

  // The wire conversation we keep re-sending to upstream (starts as the request
  // body's messages; grows with assistant tool-call + tool-result messages).
  let wireMessages = baseBody.messages
  const wireTools = baseBody.tools

  let lastError = null
  const attempts = Math.max(1, MAX_REQUEST_ATTEMPTS)
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw abortedError()
    let response
    let controller
    let timer
    let onAbort
    try {
      controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeoutMs || 60000)
      onAbort = () => controller.abort()
      if (signal) signal.addEventListener('abort', onAbort)

      const body = { ...baseBody, messages: wireMessages }
      response = await fetch(`${getOpencodeBase()}/chat/completions`, {
        method: 'POST',
        headers: fingerprintHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (signal?.aborted) throw abortedError()
      lastError = err
      if (attempt < attempts - 1) { await sleep(400 * (attempt + 1)); continue }
      throw err
    } finally {
      clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
      lastError = new Error(`OpenCode Zen HTTP ${response.status}: ${raw.slice(0, 300)}`)
      lastError.code = code
      lastError.status = response.status
      // 429 / 5xx are retried; 4xx (besides 429) are surfaced immediately.
      if (code !== 'RATE_LIMITED' && code !== 'TRANSPORT') throw lastError
      if (attempt < attempts - 1) { await sleep(400 * (attempt + 1)); continue }
      throw lastError
    }

    const ctype = response.headers.get('content-type') || ''
    const estimateInput = () => JSON.stringify(wireMessages)

    // Aggregate the upstream SSE into a single completion, rewriting any
    // fingerprint tool_call the agent cannot run into an agent-supported tool
    // (so the agent executes it itself). The agent never receives a tool name it
    // cannot run; the proxy never executes anything.
    if (!stream) {
      const finalCompletion = await runTranslateLoop(response, opts, wireMessages, wireTools, clientToolNames)
      yield finalCompletion
      return
    }

    if (ctype.includes('event-stream')) {
      const finalCompletion = await runTranslateLoop(response, opts, wireMessages, wireTools, clientToolNames)
      if (finalCompletion) yield* completionToChunks(finalCompletion)
      return
    }

    // Unexpected non-stream upstream response for a streaming request: try JSON.
    const payload = await response.json().catch(() => null)
    if (!payload) throw new Error('OpenCode Zen returned an unexpected (non-SSE) completion body')
    yield* translateStream(aggregateToChunks(payload), estimateInput)
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
async function runTranslateLoop(firstResponse, opts, wireMessages, wireTools, clientToolNames) {
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
      response = await fetch(`${getOpencodeBase()}/chat/completions`, {
        method: 'POST', headers: fingerprintHeaders(),
        body: JSON.stringify(buildWireBody({
          model, wireMessages: wire, wireTools, maxTokens: maxTokens || DEFAULT_MAX_TOKENS, temperature, topP,
        })),
        signal: AbortSignal.timeout(timeoutMs || 60000),
      })
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
  const finish = completion.choices?.[0]?.finish_reason || (msg.tool_calls?.length ? 'tool_calls' : 'stop')
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
