import { PROVIDER, sessionState, ensureModels, refreshModels, modelsCacheState } from './config.js'
import { fingerprintState } from './fingerprint.js'
import { quotaState, relayChatCompletions } from './upstream.js'
import { listModelsPayload, isValidModel, findModel, splitModelId } from './models.js'
import { authRequired } from './auth.js'

const RUNTIME = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    ...headers,
  })
  res.end(body)
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function handleModels(req, res) {
  // Refresh from upstream when the cached list is stale (best-effort: on
  // failure the previous list is served).
  await ensureModels()
  return sendJson(res, 200, listModelsPayload())
}

// Local debug endpoint (never forwarded upstream). Reports the discovered
// model registry and its cache state.
export async function handleModelsInfo(req, res, url) {
  if (url && url.searchParams.get('refresh') === '1') await refreshModels()
  return sendJson(res, 200, { provider: PROVIDER, ...modelsCacheState() })
}

// Local debug endpoint (never forwarded upstream). Reports the current
// x-opencode-session mode/state so the operator can confirm the fingerprint.
export function handleSessionInfo(req, res) {
  return sendJson(res, 200, {
    provider: PROVIDER,
    runtime: RUNTIME,
    auth: { required: authRequired() },
    ...sessionState(),
    fingerprint: fingerprintState(),
    quota: quotaState(),
  })
}

export async function handleModel(req, res, id) {
  await ensureModels()
  if (isValidModel(id)) {
    const m = findModel(id)
    return sendJson(res, 200, {
      id: `${PROVIDER}/${m.id}`,
      object: 'model',
      created: 0,
      owned_by: 'opencode-zen-free',
      description: m.description,
      context_window: m.contextWindow,
    })
  }
  return sendJson(res, 404, { error: { message: `Model '${id}' not found`, type: 'not_found_error', code: 'model_not_found' } })
}

function openaiError(status, message, type = 'invalid_request_error', code) {
  const e = { error: { message, type } }
  if (code) e.error.code = code
  return { status, body: e }
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours && minutes) return `${hours}h ${minutes}m`
  if (hours) return `${hours}h`
  return `${minutes}m`
}

// Actionable description of an exhausted free-tier budget (429 QUOTA_EXHAUSTED).
function quotaMessage(err) {
  const resetAt = Number.isFinite(err.resetAt) ? new Date(err.resetAt) : null
  const when = resetAt
    ? ` Resets at ${resetAt.toISOString()} (in ~${formatDuration(resetAt.getTime() - Date.now())}).`
    : ''
  return `OpenCode Zen free-tier quota is exhausted for this IP/account.${when} `
    + 'This gate is about the CLIENT, not an IP quota: the relay must run on Bun '
    + '(bun server.js — the Docker image already does; Node/OpenSSL is rejected) and must send '
    + "OpenCode's <env> system-prompt block (OPENCODE_SYSTEM_FP must not be 0). "
    + 'To bypass the free tier entirely, set OPENCODE_ZEN_API_KEY to use your own Zen key, '
    + 'or subscribe to OpenCode Go (https://opencode.ai/go).'
}

// Resolve the environment info injected into the system prompt as OpenCode's
// <env> block (the free tier rejects requests without it with
// 429 FreeUsageLimitError — see injectOpencodeSystemEnv in src/conversions.js).
// Returns null when the caller opted out via OPENCODE_SYSTEM_FP=0.
function requestSystemEnv(req) {
  if (process.env.OPENCODE_SYSTEM_FP === '0') return null
  const h = req.headers || {}
  const directory =
    h['x-opencode-directory'] || h['x-opencode-cwd'] || h['x-cwd'] || h['x-working-directory']
  return {
    directory: typeof directory === 'string' && directory.trim() ? directory.trim() : undefined,
  }
}

export function anthropicSystemToString(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return undefined
  const text = system.map((block) => block?.type === 'text' ? String(block.text || '') : '').join('\n')
  return text || undefined
}

export function anthropicToolsToOpenAI(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    type: 'function',
    function: {
      name: String(tool?.name || ''),
      description: String(tool?.description || ''),
      parameters: tool?.input_schema || { type: 'object', properties: {} },
    },
  })).filter((tool) => tool.function.name)
}

export function anthropicMessagesToOpenAI(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user'
    const blocks = Array.isArray(message?.content)
      ? message.content
      : [{ type: 'text', text: message?.content || '' }]
    if (role === 'assistant') {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
      const toolCalls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({
        id: String(b.id || ''),
        type: 'function',
        function: {
          name: String(b.name || ''),
          arguments: JSON.stringify(b.input || {}),
        },
      }))
      const item = { role, content: text }
      if (toolCalls.length) item.tool_calls = toolCalls
      out.push(item)
    } else {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
      const toolResults = blocks.filter((b) => b?.type === 'tool_result').map((b) => {
        let content = ''
        if (typeof b.content === 'string') content = b.content
        else if (Array.isArray(b.content)) {
          content = b.content.map((part) => part?.type === 'text' ? part.text || '' : JSON.stringify(part)).join('\n')
        } else if (b.content != null) content = JSON.stringify(b.content)
        return {
          role: 'tool',
          tool_call_id: String(b.tool_use_id || ''),
          content,
        }
      })
      out.push(...toolResults)
      if (text) out.push({ role, content: text })
    }
  }
  return out
}

export function openAIToAnthropicMessage(completion, requestedModel) {
  const choice = completion?.choices?.[0] || {}
  const message = choice.message || {}
  const usage = completion?.usage || {}
  const content = []
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content })
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    let input = {}
    try { input = JSON.parse(call.function?.arguments || '{}') } catch { input = {} }
    content.push({
      type: 'tool_use',
      id: String(call.id || ''),
      name: String(call.function?.name || ''),
      input,
    })
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  const stopReason = choice.finish_reason === 'length'
    ? 'max_tokens'
    : content.some((block) => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn'
  return {
    id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    type: 'message',
    role: 'assistant',
    model: requestedModel || completion?.model || 'unknown',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
    },
  }
}

function sendAnthropicSse(res, message) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  })

  res.write(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: { ...message, content: [] },
  })}\n\n`)

  message.content.forEach((block, index) => {
    const blockStart = block.type === 'tool_use'
      ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
      : { type: 'text', text: '' }
    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index,
      content_block: blockStart,
    })}\n\n`)

    const delta = block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) }
      : { type: 'text_delta', text: block.text || '' }
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index,
      delta,
    })}\n\n`)

    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index,
    })}\n\n`)
  })

  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage?.output_tokens || 0 },
  })}\n\n`)
  res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  res.end()
}

export async function handleAnthropicMessages(req, res) {
  let raw
  try {
    raw = await readBody(req)
  } catch {
    return sendJson(res, 413, { type: 'error', error: { type: 'invalid_request_error', message: 'Payload too large' } })
  }
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } })
  }

  await ensureModels()
  const requested = typeof parsed.model === 'string' && parsed.model ? parsed.model : ''
  const fallbackModel = process.env.OPENCODE_ANTHROPIC_MODEL || 'glm-5.3-flash-free'
  const { model } = splitModelId(isValidModel(requested) ? requested : fallbackModel)
  const system = anthropicSystemToString(parsed.system)
  const messages = anthropicMessagesToOpenAI(parsed.messages)
  const systemEnv = requestSystemEnv(req)
  const clientAbort = new AbortController()
  const onClose = () => clientAbort.abort()
  res.on('close', onClose)

  try {
    let completion = null
    for await (const item of relayChatCompletions({
      model,
      messages,
      system,
      tools: anthropicToolsToOpenAI(parsed.tools),
      maxTokens: parsed.max_tokens,
      temperature: parsed.temperature,
      stream: false,
      topP: parsed.top_p,
      signal: clientAbort.signal,
      timeoutMs: 120000,
      systemEnv,
    })) {
      completion = item
    }
    const anthropicMessage = openAIToAnthropicMessage(completion, requested)
    if (parsed.stream === true) return sendAnthropicSse(res, anthropicMessage)
    return sendJson(res, 200, anthropicMessage)
  } catch (err) {
    if (clientAbort.signal.aborted && !res.headersSent) {
      res.end()
      return
    }
    const message = err.code === 'QUOTA_EXHAUSTED'
      ? quotaMessage(err)
      : `Upstream error: ${err.message}`
    return sendJson(res, err.status || 502, { type: 'error', error: { type: 'upstream_error', message } })
  } finally {
    res.off('close', onClose)
  }
}

export async function handleChatCompletions(req, res) {
  let raw
  try {
    raw = await readBody(req)
  } catch {
    return sendJson(res, 413, openaiError(413, 'Payload too large').body)
  }
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    return sendJson(res, 400, openaiError(400, 'Invalid JSON in request body', 'invalid_request_error').body)
  }

  // Make sure the discovered model list is fresh before validating, so a model
  // that just appeared upstream (or a cold start) is not rejected.
  await ensureModels()

  const requested = parsed.model
  if (!requested || typeof requested !== 'string') {
    return sendJson(res, 400, openaiError(400, "Missing 'model' field", 'invalid_request_error').body)
  }
  if (!isValidModel(requested)) {
    return sendJson(res, 404, openaiError(404, `Model '${requested}' is not available on the free provider`, 'invalid_request_error', 'model_not_found').body)
  }

  const { model } = splitModelId(requested)
  const stream = parsed.stream === true
  const timeoutMs = Number.isFinite(parsed.timeout_ms) ? parsed.timeout_ms : 60000

  // The free tier fingerprints the system prompt as well as the headers: it
  // expects OpenCode's <env> block (see injectOpencodeSystemEnv in
  // src/conversions.js). Forward the caller's working directory when it
  // advertises one (OpenCode sends `x-opencode-directory`); otherwise the block
  // falls back to OPENCODE_ENV_CWD. OPENCODE_SYSTEM_FP=0 disables it.
  const systemEnv = requestSystemEnv(req)

  // Abort the upstream fetch if the client disconnects.
  const clientAbort = new AbortController()
  const onClose = () => clientAbort.abort()
  res.on('close', onClose)

  try {
    if (stream) {
      // Delay the SSE headers until the first chunk is ready. The relay buffers
      // the whole upstream turn; if it fails before producing anything we can
      // still return a proper HTTP error (the catch block below) instead of
      // committing to a stream that would end with no finish_reason — which is
      // what makes OpenAI-compatible clients throw "Stream ended without
      // finish_reason".
      let started = false
      const startStream = () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Accel-Buffering': 'no',
        })
        started = true
      }
      for await (const chunk of relayChatCompletions({
        model,
        messages: parsed.messages,
        system: typeof parsed.system === 'string' ? parsed.system : undefined,
        tools: parsed.tools,
        maxTokens: parsed.max_tokens,
        temperature: parsed.temperature,
        stream: true,
        topP: parsed.top_p,
        signal: clientAbort.signal,
        timeoutMs,
        systemEnv,
      })) {
        if (!started) startStream()
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      if (!started) startStream()
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      let completion = null
      for await (const obj of relayChatCompletions({
        model,
        messages: parsed.messages,
        system: typeof parsed.system === 'string' ? parsed.system : undefined,
        tools: parsed.tools,
        maxTokens: parsed.max_tokens,
        temperature: parsed.temperature,
        stream: false,
        topP: parsed.top_p,
        signal: clientAbort.signal,
        timeoutMs,
        systemEnv,
      })) {
        completion = obj
      }
      return sendJson(res, 200, completion)
    }
  } catch (err) {
    if (clientAbort.signal.aborted && !res.headersSent) {
      // client gone; nothing to send
      res.end()
      return
    }
    const status = err.status || (err.code === 'RATE_LIMITED' ? 429 : 502)
    const message = err.code === 'QUOTA_EXHAUSTED'
      ? quotaMessage(err)
      : err.code === 'RATE_LIMITED'
        ? 'OpenCode Zen rejected the request with 429 FreeUsageLimitError. This is the runtime/system-prompt '
          + 'gate, not an IP quota: run the relay on Bun (bun server.js) and keep the injected <env> block '
          + '(OPENCODE_SYSTEM_FP must not be 0). See README "Two gates, not one".'
        : `Upstream error from OpenCode Zen: ${err.message}`
    // Propagate the upstream reset hint so OpenAI-compatible clients back off
    // instead of hammering the relay (and the relay hammering upstream).
    const headers = {}
    if (Number.isFinite(err.retryAfterMs)) {
      headers['Retry-After'] = String(Math.max(0, Math.ceil(err.retryAfterMs / 1000)))
    }
    if (Number.isFinite(err.resetAt)) {
      headers['X-Opencode-Quota-Reset'] = new Date(err.resetAt).toISOString()
    }
    if (!res.headersSent) {
      return sendJson(res, status, openaiError(status, message, 'upstream_error', err.code).body, headers)
    }
    // Streaming already started (headers sent) — we cannot send an HTTP error.
    // Emit a terminal finish_reason chunk so the client completes cleanly (never
    // "Stream ended without finish_reason"), then surface the error as a final
    // event for clients that parse it.
    try {
      const errorEvent = { message, type: 'upstream_error', code: err.code }
      if (headers['Retry-After']) errorEvent.retry_after = Number(headers['Retry-After'])
      if (headers['X-Opencode-Quota-Reset']) errorEvent.reset_at = headers['X-Opencode-Quota-Reset']
      res.write(`data: ${JSON.stringify({ error: errorEvent })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-error', object: 'chat.completion.chunk', created: 0, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } catch { /* ignore */ }
  } finally {
    res.removeListener('close', onClose)
  }
}
