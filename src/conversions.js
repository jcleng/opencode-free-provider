import { ZEN_FREE_TOOLS } from './config.js'

// Conversions between the OpenAI chat.completions wire format (what agents
// send to /v1/chat/completions) and the wire format OpenCode Zen expects
// (also OpenAI-compatible — so this is mostly normalization + reasoning/tool
// handling to keep the upstream happy).

function flattenText(content) {
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return typeof content === 'string' ? content : ''
}

function blocksOf(content, type) {
  return Array.isArray(content) ? content.filter((b) => b.type === type) : []
}

// OpenAI messages → OpenAI messages. We only need to normalize non-standard
// agent content blocks (reasoning / tool-call / tool-result) into the standard
// text / tool_calls / tool roles that OpenCode Zen understands.
export function serializeMessages(messages, systemPrompt) {
  const wire = []
  if (systemPrompt) wire.push({ role: 'system', content: systemPrompt })
  for (const m of messages || []) {
    const role = m.role
    if (role === 'system') {
      wire.push({ role: 'system', content: flattenText(m.content) })
      continue
    }
    if (role === 'assistant') {
      const text = flattenText(m.content)
      const reasoning = blocksOf(m.content, 'reasoning').map((b) => b.text).join('')
      const toolCalls = blocksOf(m.content, 'tool-call').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments },
      }))
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    const toolResults = blocksOf(m.content, 'tool-result')
    const text = flattenText(m.content)
    if (text || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const r of toolResults) {
      wire.push({ role: 'tool', tool_call_id: r.toolCallId, content: flattenText(r.content) || '(no output)' })
    }
  }
  return wire
}

export function serializeTools(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

// SSE line parser. Yields parsed JSON objects per `data:` line. Stops at [DONE].
export async function* parseSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') return
          continue
        }
        try { yield JSON.parse(data) } catch { /* ignore malformed SSE line */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// OpenAI usage → safe integer token counts.
export function mapUsage(usage) {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens || 0
  return {
    inputTokens: (usage?.prompt_tokens || 0) - (cacheRead || 0),
    outputTokens: usage?.completion_tokens || 0,
    cacheReadTokens: cacheRead || 0,
  }
}

// Translate upstream OpenAI streaming chunks into the OpenAI streaming chunks
// we forward to the agent. This is mostly a pass-through that fixes up tool
// call deltas (index / name) and finalizes usage.
export async function* translateStream(rawChunks, estimateInput) {
  let nextIndex = 0
  let textSeen = false
  let toolCalls = new Map()
  let finishReason = null
  let usage = null
  let upstreamSentUsage = false

  for await (const chunk of rawChunks) {
    const out = {
      id: chunk.id,
      object: chunk.object || 'chat.completion.chunk',
      created: chunk.created ?? 0,
      model: chunk.model,
      choices: [],
    }
    let emit = false
    for (const choice of chunk.choices || []) {
      const c = { index: choice.index ?? 0, delta: {}, finish_reason: null }
      const delta = choice.delta || {}

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        c.delta.reasoning_content = delta.reasoning_content
        emit = true
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        c.delta.content = delta.content
        textSeen = true
        emit = true
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const bIdx = call.index || 0
          let block = toolCalls.get(bIdx)
          if (!block) {
            block = { index: bIdx, id: '', name: '', args: '' }
            toolCalls.set(bIdx, block)
          }
          if (call.id) block.id = call.id
          if (call.function?.name) block.name = call.function.name
          if (call.function?.arguments) block.args += call.function.arguments
          c.delta.tool_calls = c.delta.tool_calls || []
          c.delta.tool_calls.push({
            index: bIdx,
            ...(call.id ? { id: call.id } : {}),
            ...(call.function?.name ? { function: { name: call.function.name, arguments: '' } } : {}),
            ...(call.function?.arguments ? { function: { arguments: call.function.arguments } } : {}),
          })
          emit = true
        }
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason
        c.finish_reason = choice.finish_reason
        emit = true
      }
      if (emit) out.choices.push(c)
    }
    if (chunk.usage) { usage = mapUsage(chunk.usage); upstreamSentUsage = true }
    if (out.choices.length) yield out
  }

  if (!usage && estimateInput) {
    const inputText = estimateInput()
    usage = {
      inputTokens: Math.ceil(inputText.length / 4),
      outputTokens: 0,
      cacheReadTokens: 0,
    }
  }
  if (usage && !upstreamSentUsage) {
    yield {
      id: undefined,
      object: 'chat.completion.chunk',
      created: 0,
      model: undefined,
      choices: [],
      usage: {
        prompt_tokens: usage.inputTokens + usage.cacheReadTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.cacheReadTokens + usage.outputTokens,
        ...(usage.cacheReadTokens ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
      },
    }
  }
  if (finishReason) {
    yield {
      id: undefined, object: 'chat.completion.chunk', created: 0, model: undefined,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    }
  }
  void nextIndex
}

// Build the chat.completions request body for OpenCode Zen.
//
// IMPORTANT: the upstream free-tier gateway ONLY accepts stream:true. We always
// force it on internally (the relay converts the upstream SSE back to a single
// JSON object when the agent asked for non-streaming). We also always include
// the four mandatory fingerprint tools (bash/glob/grep/read) — the upstream
// rejects any body missing any of them with 403 FreeTierError.
export function buildRequestBody({ model, messages, system, tools, maxTokens, temperature, stream, topP }) {
  const wireMessages = serializeMessages(messages, system)
  const wireTools = mergeTools(tools)
  return {
    model,
    messages: wireMessages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    top_p: topP ?? 0.95,
    ...(temperature !== undefined && temperature !== null ? { temperature } : {}),
    tools: wireTools,
    tool_choice: 'auto',
  }
}

// Combine any caller-supplied tools with the four mandatory fingerprint tools.
// The caller's own tools (prompted by the agent) are kept; the fingerprint
// tools are appended if not already present. Order does not matter upstream.
export function mergeTools(tools) {
  const out = []
  const names = new Set()
  const add = (t) => {
    const name = t?.function?.name
    if (name && names.has(name)) return
    if (name) names.add(name)
    out.push(t)
  }
  for (const t of tools || []) add(t)
  for (const t of ZEN_FREE_TOOLS) add(t)
  return out
}

// Shape a single upstream non-streaming completion into the OpenAI response.
export function shapeCompletion(payload, model) {
  return {
    id: payload.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: payload.created ?? Math.floor(Date.now() / 1000),
    model: payload.model || model,
    choices: (payload.choices || []).map((c) => ({
      index: c.index ?? 0,
      message: c.message || {},
      finish_reason: c.finish_reason || null,
    })),
    usage: payload.usage || null,
  }
}
