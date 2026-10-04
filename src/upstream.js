import {
  getOpencodeBase, OPENCODE_UA, OPENCODE_CLIENT, OPENCODE_PROJECT,
  LITERAL_KEY, DEFAULT_MAX_TOKENS, MAX_REQUEST_ATTEMPTS,
  currentSession, newRequestId, isFingerprintTool,
} from './config.js'
import {
  buildRequestBody, buildWireBody, parseSse, translateStream, executeFingerprintTool, callerToolNames,
} from './conversions.js'

function resolveApiKey() {
  return process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_GO_API_KEY || LITERAL_KEY
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

/**
 * Relay a chat.completions request to OpenCode Zen free tier.
 *
 * The upstream only accepts stream:true with the four fingerprint tools, so we
 * always request streaming upstream. When the agent asked for `stream:false` we
 * collect the upstream SSE and resolve a single shaped completion object.
 *
 * Fingerprint tool calls the calling agent does NOT register (e.g. `glob` for
 * pi-agent) are executed server-side and fed back to the model internally, so
 * the agent never sees a "Tool <name> not found" error. Agent-registered tools
 * are always handed back to the agent to execute.
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
    // running any fingerprint-only tool calls server-side (so the agent never
    // sees a tool it cannot execute). We keep the running wire conversation in a
    // local variable so the server-side loop can re-feed tool results.
    if (!stream) {
      const aggregated = await aggregateSse(response, model, estimateInput)
      const resolved = await resolveServerSideTools(aggregated, opts, clientToolNames, wireMessages)
      yield resolved
      return
    }

    if (ctype.includes('event-stream')) {
      yield* translateStream(parseSse(response), estimateInput)
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
 * Given a completed (non-streaming) response, run any fingerprint tool calls the
 * calling agent cannot execute server-side, then continue the conversation with
 * upstream until the model either emits only agent-executable tool_calls or
 * produces a final answer. `setWire` persists the running conversation and
 * returns the next request body to send upstream.
 */
async function resolveServerSideTools(completion, opts, clientToolNames, initialMessages) {
  let current = completion
  let wire = [...initialMessages]
  const maxServerTurns = 4 // safety bound for server-side tool rounds
  for (let turn = 0; turn < maxServerTurns; turn++) {
    const tcs = current.choices?.[0]?.message?.tool_calls || []
    if (tcs.length === 0) break

    const serverCalls = tcs.filter(
      (tc) => isFingerprintTool(tc.function?.name) && !clientToolNames.has(tc.function?.name),
    )
    // Nothing for us to run: hand the whole message back to the agent.
    if (serverCalls.length === 0) break

    // Append the assistant message (with its tool_calls) to the conversation.
    const assistantMsg = current.choices[0].message
    if (assistantMsg.content === '' && assistantMsg.tool_calls) assistantMsg.content = null
    wire = [...wire, assistantMsg]

    // Execute the server-side calls and collect synthetic tool results.
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

    // Re-feed the running conversation + tool results to upstream for the next turn.
    const nextBody = buildWireBody({
      model: opts.model,
      wireMessages: [...wire, ...toolResults],
      wireTools: buildRequestBody({ model: opts.model, messages: opts.messages, system: opts.system, tools: opts.tools || [], maxTokens: opts.maxTokens || DEFAULT_MAX_TOKENS, temperature: opts.temperature, stream: true, topP: opts.topP }).tools,
      maxTokens: opts.maxTokens || DEFAULT_MAX_TOKENS,
      temperature: opts.temperature,
      topP: opts.topP,
    })
    const response = await fetch(`${getOpencodeBase()}/chat/completions`, {
      method: 'POST',
      headers: fingerprintHeaders(),
      body: JSON.stringify(nextBody),
      signal: AbortSignal.timeout(opts.timeoutMs || 60000),
    })
    if (!response.ok) break
    const estimateInput = () => JSON.stringify(nextBody.messages)
    current = await aggregateSse(response, opts.model, estimateInput)
  }
  return current
}

async function* aggregateToChunks(payload) {
  yield payload
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
