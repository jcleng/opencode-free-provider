import { ZEN_FREE_TOOLS, isFingerprintTool } from './config.js'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Resolve relative to repo root (src/ -> repo root); used as the default cwd for
// server-side fingerprint tool execution.
const ROOT = path.resolve(__dirname, '..')

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

// Server-side execution of the fingerprint tools the upstream gate requires
// (bash/glob/grep/read). These must be present in the request tools array, but
// the calling agent may not register every one of them (e.g. pi-agent has bash,
// grep and read but NOT glob). When the model calls such a tool the agent would
// otherwise report "Tool <name> not found". To keep the relay usable for ANY
// OpenAI-compatible client, we execute the fingerprint tools ourselves and feed
// the result back into the conversation as a synthetic tool message.
//
// Callers' own tools are never executed here — the agent does that. We only run
// the synthetic fingerprint tools (those the gate forces us to advertise). If a
// client already registers a real `bash`/`grep`/`read`, the model may call
// either; we only intercept the fingerprint-named ones we injected.
export async function executeFingerprintTool(name, args, cwd, signal) {
  switch (name) {
    case 'bash': {
      const cmd = args?.command
      if (typeof cmd !== 'string' || cmd.length === 0) return err('Missing command')
      try {
        const { stdout, stderr } = await execFileP('sh', ['-c', cmd], {
          cwd: cwd || ROOT, maxBuffer: 8 * 1024 * 1024, signal,
        })
        return ok(stdout || stderr || '')
      } catch (e) {
        return ok((e.stdout || '') + (e.stderr || '') + `\n[exit ${e.code ?? '?'}]`)
      }
    }
    case 'glob': {
      const pattern = args?.pattern || args?.p
      if (typeof pattern !== 'string' || pattern.length === 0) return err('Missing pattern')
      try {
        const files = await nodeGlob(pattern, cwd || ROOT)
        return ok(files.length ? files.join('\n') : '(no files)')
      } catch (e) {
        return err(String(e?.message || e))
      }
    }
    case 'grep': {
      const pattern = args?.pattern || args?.p
      if (typeof pattern !== 'string' || pattern.length === 0) return err('Missing pattern')
      const pathArg = args?.path || '.'
      try {
        const results = await nodeGrep(pattern, pathArg, cwd || ROOT, {
          ignoreCase: !!args?.['-i'], lineNumbers: args?.['-n'] !== false, glob: args?.glob,
        })
        return ok(results.length ? results.join('\n') : '(no matches)')
      } catch (e) {
        return ok(`(error: ${String(e?.message || e)})`)
      }
    }
    case 'read': {
      const p = args?.path || args?.p
      if (typeof p !== 'string' || p.length === 0) return err('Missing path')
      const abs = path.isAbsolute(p) ? p : path.resolve(cwd || ROOT, p)
      if (!existsSync(abs)) return err(`File not found: ${p}`)
      try {
        const data = await readFile(abs, 'utf8')
        return ok(data)
      } catch (e) {
        return err(String(e?.message || e))
      }
    }
    default:
      return null
  }
}

// Minimal glob/regex search using only Node builtins (no external `rg` needed).
async function nodeGlob(pattern, cwd, seen = new Set(), results = [], root = null) {
  // `root` is the original search root; we always match the glob against the
  // path relative to `root` (so `src/**/*.js` matches `src/config.js`).
  if (root === null) root = path.resolve(cwd)
  // Translate a shell-style glob into a regex (supports **, *, ?, [..]).
  const re = globToRegExp(pattern)
  const dir = path.resolve(cwd)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      await nodeGlob(pattern, full, seen, results, root)
    } else {
      // Match the glob against the full relative path (so `**/*.mjs` works),
      // not just the basename.
      const rel = path.relative(root, full)
      if (re.test(rel) && !seen.has(rel)) { seen.add(rel); results.push(rel) }
    }
  }
  return results
}

async function nodeGrep(pattern, target, cwd, opts) {
  const re = new RegExp(pattern, opts.ignoreCase ? 'i' : '')
  const out = []
  const absTarget = path.isAbsolute(target) ? target : path.resolve(cwd, target)
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) { await walk(full); continue }
      if (opts.glob && !globToRegExp(opts.glob).test(ent.name)) continue
      try {
        const text = await readFile(full, 'utf8')
        const rel = path.relative(cwd, full)
        text.split('\n').forEach((line, i) => {
          if (re.test(line)) out.push(`${opts.lineNumbers ? i + 1 + ':' : ''}${rel}:${line}`)
        })
      } catch { /* skip unreadable */ }
    }
  }
  if (existsSync(absTarget) && statSync(absTarget).isFile()) {
    const text = await readFile(absTarget, 'utf8')
    const rel = path.relative(cwd, absTarget)
    text.split('\n').forEach((line, i) => { if (re.test(line)) out.push(`${opts.lineNumbers ? i + 1 + ':' : ''}${rel}:${line}`) })
  } else {
    await walk(absTarget)
  }
  return out
}

function globToRegExp(glob) {
  const special = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])
  let re = '^'
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` then an optional slash: matches zero or more path segments.
        let j = i + 2
        if (glob[j] === '/') j++ // consume the slash after **
        re += '(?:.*/)?'
        i = j
        continue
      }
      re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (special.has(c)) re += '\\' + c
    else re += c
    i++
  }
  return new RegExp(re + '$')
}

function ok(content) {
  return { ok: true, content: String(content).slice(0, 20000) }
}
function err(message) {
  return { ok: true, content: `Error: ${message}` }
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
