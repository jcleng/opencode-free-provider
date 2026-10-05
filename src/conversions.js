import { ZEN_FREE_TOOLS, isFingerprintTool } from './config.js'

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
      // Build tool_calls from EITHER standard OpenAI format (m.tool_calls) OR
      // pi-agent content blocks (type 'tool-call').
      const toolCalls = [
        ...(Array.isArray(m.tool_calls) ? m.tool_calls : []),
        ...blocksOf(m.content, 'tool-call').map((b) => ({
          id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments },
        })),
      ].map(restoreTranslatedToolCall)
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    if (role === 'tool') {
      // Standard OpenAI tool result message. Restore if it was a translated
      // fingerprint call so upstream sees the original tool_call_id.
      const restored = restoreTranslatedToolMessage(m)
      wire.push(restored || { role: 'tool', tool_call_id: m.tool_call_id, content: flattenText(m.content) || '(no output)' })
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

// ---------------------------------------------------------------------------
// Fingerprint-tool translation
// ---------------------------------------------------------------------------
// The upstream gate forces the tool NAMES bash/glob/grep/read onto the wire, but
// the calling agent does NOT necessarily implement them (e.g. pi-agent has
// bash/grep/read but no `glob`). The proxy is a PURE forwarder: it never executes
// filesystem or shell commands itself (no server-side cwd, no /app default). When
// the model emits a fingerprint tool the agent cannot run, the proxy rewrites
// that tool_call into a tool the agent DOES implement, hands the rewritten call
// to the agent, and lets the agent execute it in ITS OWN working directory.
// The agent's real result is then fed back to the model as ordinary text.
//
// To survive the stateless request boundary (the agent calls back with tool
// results in a separate HTTP request), the original fingerprint tool_call is
// encoded into the id we hand to the agent. On the agent's follow-up we decode
// it and restore the original call for upstream — see serializeMessages above.
export const TRANSLATED_PREFIX = 'tr:'

export function encodeTranslatedId(origId, origName, origArgs) {
  const payload = JSON.stringify({ i: origId, n: origName, a: origArgs ?? {} })
  return TRANSLATED_PREFIX + Buffer.from(payload).toString('base64url')
}

export function decodeTranslatedId(id) {
  if (typeof id !== 'string' || !id.startsWith(TRANSLATED_PREFIX)) return null
  try {
    const json = Buffer.from(id.slice(TRANSLATED_PREFIX.length), 'base64url').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

// Translate a fingerprint tool_call into the best tool the agent registered.
// Returns { name, arguments } for an agent-executable tool, or null if no
// registered tool can stand in for the fingerprint tool.
//
// `glob` -> bash with a globstar loop (runs in the agent's cwd), else find.
// `grep`/`read` are usually implemented directly by agents, but if not they fall
// back to bash equivalents so the agent still executes them locally.
function shellQuotePattern(pattern) {
  // Glob patterns contain * ? [ ] { } which are meaningful to the shell; quote
  // them so they are expanded by bash globbing rather than interpreted.
  return JSON.stringify(pattern)
}

export function translateFingerprintCall(name, args, clientToolNames) {
  const set = clientToolNames || new Set()
  if (name === 'glob') {
    const pattern = args?.pattern || args?.p || '*'
    if (set.has('bash')) {
      const cmd = `shopt -s globstar nullglob; for f in ${shellQuotePattern(pattern)}; do echo "$f"; done`
      return { name: 'bash', arguments: { command: cmd } }
    }
    if (set.has('find')) {
      return { name: 'find', arguments: { path: '.', pattern: `-name ${JSON.stringify(pattern)}` } }
    }
    return null
  }
  if (name === 'grep') {
    const pattern = args?.pattern || args?.p || ''
    const target = args?.path || args?.p2 || '.'
    if (set.has('bash')) {
      const cmd = `grep -rn ${JSON.stringify(pattern)} ${JSON.stringify(target)}`
      return { name: 'bash', arguments: { command: cmd } }
    }
    return null
  }
  if (name === 'read') {
    const p = args?.path || args?.p || ''
    if (set.has('bash')) {
      const cmd = `cat ${JSON.stringify(p)}`
      return { name: 'bash', arguments: { command: cmd } }
    }
    if (set.has('read')) return { name: 'read', arguments: { path: p } }
    return null
  }
  if (name === 'bash') {
    // The agent likely registers its own bash; only translate if it does.
    return set.has('bash') ? { name: 'bash', arguments: { command: args?.command || '' } } : null
  }
  return null
}

// Rewrite an agent-facing assistant tool_call back to the original fingerprint
// call (used when building the wire conversation from the agent's history).
function restoreTranslatedToolCall(tc) {
  const decoded = decodeTranslatedId(tc?.id)
  if (!decoded) return tc
  return {
    id: decoded.i,
    type: 'function',
    function: { name: decoded.n, arguments: typeof decoded.a === 'string' ? decoded.a : JSON.stringify(decoded.a) },
  }
}

// Rewrite an agent-facing tool RESULT back to the original fingerprint call for
// upstream. The agent's real result becomes the content the model sees.
function restoreTranslatedToolMessage(m) {
  const decoded = decodeTranslatedId(m?.tool_call_id)
  if (!decoded) return null
  return {
    role: 'tool',
    tool_call_id: decoded.i,
    content: flattenText(m.content) || '(no output)',
  }
}

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

// Build the chat.completions request body for OpenCode Zen, serializing the
// agent's internal messages + tools into wire format.
export function buildRequestBody({ model, messages, system, tools, maxTokens, temperature, stream, topP }) {
  const wireMessages = serializeMessages(messages, system)
  const wireTools = mergeTools(tools)
  return finalizeBody({ model, wireMessages, wireTools, maxTokens, temperature, topP })
}

// Build a request body from messages/tools that are ALREADY in OpenAI wire format
// (used for server-side follow-up turns where we re-feed a running conversation
// of assistant tool-call + tool-result messages).
export function buildWireBody({ model, wireMessages, wireTools, maxTokens, temperature, topP }) {
  return finalizeBody({
    model,
    wireMessages,
    wireTools: wireTools || mergeTools([]),
    maxTokens,
    temperature,
    topP,
  })
}

function finalizeBody({ model, wireMessages, wireTools, maxTokens, temperature, topP }) {
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

// Combine any caller-supplied tools with the mandatory fingerprint tools.
//
// CRITICAL: the upstream free-tier gateway requires the tool NAMES
// `bash` / `glob` / `grep` / `read` to be present in the `tools` array, but it
// REJECTS the request (HTTP 403 FreeTierError) if ANY tool name appears more
// than once. OpenCode's built-in tools are already named bash/glob/grep/read,
// so naively appending the fingerprint tools created duplicate names -> 403,
// and a corrupted tool namespace that made the model emit `tool_call`s the
// agent could not resolve (surfaced by OpenCode as "Tool not found").
//
// Fix: keep the caller's own tools verbatim, and inject each required name
// ONLY when it is missing. Exact names are preserved so the gate stays happy
// and there are never duplicates.
export function mergeTools(tools) {
  const out = []
  const names = new Set()
  const add = (t) => {
    const name = t?.function?.name
    if (!name || names.has(name)) return
    names.add(name)
    out.push(t)
  }
  // 1) Preserve the caller's own tools (these are what the agent can actually
  //    execute — e.g. OpenCode's real bash/glob/grep/read with param command/path).
  for (const t of tools || []) add(t)
  // 2) Inject each mandatory fingerprint name ONLY if the caller did not already
  //    provide one with that exact name. This guarantees no duplicate names.
  for (const t of ZEN_FREE_TOOLS) add(t)
  return out
}

// Returns the set of tool names the caller registered (used to decide which
// tool_calls the model emits must be executed server-side vs. handed to the
// calling agent). Fingerprint-only tools the agent does not register are run by
// the proxy so they never surface as "Tool <name> not found".
export function callerToolNames(tools) {
  const set = new Set()
  for (const t of tools || []) {
    const n = t?.function?.name
    if (n) set.add(n)
  }
  return set
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
