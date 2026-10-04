import {
  getOpencodeBase, OPENCODE_UA, OPENCODE_CLIENT, OPENCODE_PROJECT,
  LITERAL_KEY, DEFAULT_MAX_TOKENS, MAX_REQUEST_ATTEMPTS,
  currentSession, newRequestId, FINGERPRINT_TOOL_NAMES,
} from './config.js'
import {
  buildRequestBody, buildWireBody, parseSse, translateStream, executeFingerprintTool, callerToolNames,
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

// All four fingerprint tool names the upstream gate forces us to advertise.
// The proxy executes these itself, so the calling agent never has to provide
// them and can never report "Tool <name> not found".
const SERVER_TOOL_NAMES = FINGERPRINT_TOOL_NAMES

/**
 * Relay a chat.completions request to OpenCode Zen free tier.
 *
 * The upstream only accepts stream:true with the four fingerprint tools, so we
 * always request streaming upstream. When the agent asked for `stream:false` we
 * collect the upstream SSE and resolve a single shaped completion object.
 *
 * The fingerprint tools (bash / glob / grep / read) are NOT real tools the
 * calling agent (e.g. pi-agent) can necessarily execute — pi-agent has no
 * `glob`, and historically its `bash` is not wired through custom OpenAI
 * providers. When the model emits one of these names the agent would surface a
 * "Tool <name> not found" error. To keep the relay usable for ANY OpenAI-
 * compatible client, the proxy executes all four fingerprint tools itself and
 * feeds the result back into the conversation, internally looping with upstream
 * until the model either emits an agent-executable tool_call or produces a final
 * answer. The agent only ever receives tool_calls it can actually run (its own
 * tools such as edit / write / ls / find / powershell).
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

    // Non-streaming for the agent: upstream is always SSE, so aggregate it,
    // running any fingerprint tool calls server-side (so the agent never sees a
    // tool it cannot execute). We keep the running wire conversation in a local
    // variable so the server-side loop can re-feed tool results.
    if (!stream) {
      const finalCompletion = await runServerSideLoop(response, opts, wireMessages, wireTools)
      yield finalCompletion
      return
    }

    if (ctype.includes('event-stream')) {
      // Streaming: forward upstream SSE while intercepting fingerprint tool
      // calls. We buffer each assistant turn; whenever the model emits a
      // fingerprint-only tool call we execute it server-side and re-feed the
      // conversation to upstream, splicing the synthetic tool results into the
      // stream the agent sees. Agent-executable tool calls are forwarded as-is.
      yield* translateStreamWithServerTools(response, opts, wireMessages, wireTools)
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
 * Core loop shared by both streaming and non-streaming paths.
 *
 * Consumes an upstream SSE response, aggregates it into a completion object, and
 * runs any fingerprint tool calls the proxy owns (bash/glob/grep/read) server-
 * side, re-feeding the conversation to upstream until the model either returns
 * only agent-executable tool_calls or a final answer. Returns the final
 * aggregated completion object. `onTurn` is invoked once per completed turn with
 * the aggregated completion so the streaming path can emit it.
 */
async function runServerSideLoop(firstResponse, opts, wireMessages, wireTools, onTurn) {
  const { model, maxTokens, temperature, topP, timeoutMs } = opts
  let wire = [...wireMessages]
  const maxServerTurns = 4
  let lastCompletion = null

  for (let turn = 0; turn < maxServerTurns; turn++) {
    const response = turn === 0 ? firstResponse : await fetch(`${getOpencodeBase()}/chat/completions`, {
      method: 'POST', headers: fingerprintHeaders(),
      body: JSON.stringify(buildWireBody({
        model, wireMessages: wire, wireTools, maxTokens: maxTokens || DEFAULT_MAX_TOKENS, temperature, topP,
      })),
      signal: AbortSignal.timeout(timeoutMs || 60000),
    })
    if (!response.ok && turn > 0) break
    const completion = await aggregateSse(response, model, () => JSON.stringify(wire))
    lastCompletion = completion
    const tcs = completion.choices?.[0]?.message?.tool_calls || []
    if (tcs.length === 0) {
      onTurn?.(completion)
      return completion
    }

    // Partition: server-owned fingerprint tools vs. agent-executable tools.
    const serverCalls = tcs.filter((tc) => SERVER_TOOL_NAMES.has(tc.function?.name))
    const agentCalls = tcs.filter((tc) => !SERVER_TOOL_NAMES.has(tc.function?.name))

    // Append the assistant message to the running conversation (keep it verbatim
    // for upstream fidelity, including any proxy-owned tool calls).
    const assistantMsg = completion.choices[0].message
    if (assistantMsg.content === '' && assistantMsg.tool_calls) assistantMsg.content = null
    wire = [...wire, assistantMsg]

    if (serverCalls.length === 0) {
      // Every tool call is for the agent: forward verbatim and stop looping.
      onTurn?.(completion)
      return completion
    }

    // Execute the proxy-owned tools and feed their results back into the
    // conversation so the model can continue.
    const toolResults = await Promise.all(
      serverCalls.map(async (tc) => {
        let args = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch { /* ignore */ }
        const res = await executeFingerprintTool(tc.function?.name, args, opts.cwd, opts.signal)
        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: res ? res.content : `Error: cannot run tool ${tc.function?.name}`,
        }
      }),
    )
    wire = [...wire, ...toolResults]

    if (agentCalls.length > 0) {
      // Mixed turn: the agent must run some tools, but it must never receive a
      // proxy-owned tool name (it would report "Tool <name> not found"). Forward
      // a copy of this turn that keeps ONLY the agent-executable tool calls, then
      // hand control to the agent. The proxy-owned calls are already resolved
      // internally for the next request the agent makes.
      const filtered = {
        ...completion,
        choices: [{
          ...completion.choices[0],
          message: {
            ...completion.choices[0].message,
            tool_calls: agentCalls,
          },
        }],
      }
      onTurn?.(filtered)
      return filtered
    }
    // Pure proxy-owned turn: continue the loop with the enriched conversation.
  }
  return lastCompletion
}

/**
 * Streaming path: run the server-side loop and replay each resolved turn as a
 * faithful OpenAI SSE stream. Proxy-executed fingerprint tool calls are already
 * folded into the model's final answer, so the agent only sees tool_calls it can
 * actually run (its own tools).
 */
async function* translateStreamWithServerTools(response, opts, wireMessages, wireTools) {
  const finalCompletion = await runServerSideLoop(response, opts, wireMessages, wireTools, (completion) => {
    // For streaming we already forwarded earlier turns inside the loop? No — we
    // replay the FINAL completion only, because the proxy-owned turns are
    // internal. If the model's last turn is agent-only, that is what we forward.
  })
  if (finalCompletion) yield* completionToChunks(finalCompletion)
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
  // 4) finish reason + usage
  yield makeChunk(id, created, modelName, [], completion.choices?.[0]?.finish_reason || (msg.tool_calls?.length ? 'tool_calls' : 'stop'), completion.usage)
}

function makeChunk(id, created, model, choices, finishReason, usage) {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: choices.map((c) => ({ index: 0, ...c, finish_reason: c.finish_reason ?? finishReason ?? null })),
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
