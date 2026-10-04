import {
  getOpencodeBase, OPENCODE_UA, OPENCODE_CLIENT, OPENCODE_PROJECT,
  LITERAL_KEY, DEFAULT_MAX_TOKENS, MAX_REQUEST_ATTEMPTS,
  currentSession, newRequestId,
} from './config.js'
import { buildRequestBody, parseSse, translateStream } from './conversions.js'

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
 * always request streaming upstream. When the agent asked for `stream:false`
 * we collect the upstream SSE and resolve a single shaped completion object.
 *
 * Returns an async generator of OpenAI streaming chunks when stream=true, or a
 * single shaped completion object when stream=false.
 */
export async function* relayChatCompletions(opts) {
  const {
    model, messages, system, tools, maxTokens, temperature, stream, topP, signal, timeoutMs,
  } = opts

  const body = buildRequestBody({
    model, messages, system, tools,
    maxTokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature, stream: true, topP,
  })

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
    const estimateInput = () => JSON.stringify(body.messages)

    // Non-streaming for the agent: upstream is always SSE, so aggregate it.
    if (!stream) {
      const aggregated = await aggregateSse(response, model, estimateInput)
      yield aggregated
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

// Turn a single upstream JSON completion into a one-chunk async iterable that
// translateStream can ingest (handles the rare non-SSE success path).
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
