import { PROVIDER, sessionState } from './config.js'
import { listModelsPayload, isValidModel, findModel, splitModelId } from './models.js'
import { relayChatCompletions } from './upstream.js'

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
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
  return sendJson(res, 200, listModelsPayload())
}

// Local debug endpoint (never forwarded upstream). Reports the current
// x-opencode-session mode/state so the operator can confirm the fingerprint.
export function handleSessionInfo(req, res) {
  return sendJson(res, 200, { provider: PROVIDER, ...sessionState() })
}

export function handleModel(req, res, id) {
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

  // Abort the upstream fetch if the client disconnects.
  const clientAbort = new AbortController()
  const onClose = () => clientAbort.abort()
  res.on('close', onClose)

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      })
      const writeChunk = (obj) => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
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
      })) {
        writeChunk(chunk)
      }
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
    const message = err.code === 'RATE_LIMITED'
      ? 'Rate limit reached on the OpenCode Zen free tier. Try a different network/IP (the free quota is per-IP) or wait.'
      : `Upstream error from OpenCode Zen: ${err.message}`
    if (!res.headersSent) {
      return sendJson(res, status, openaiError(status, message, 'upstream_error', err.code).body)
    }
    // streaming already started — send a final error event
    try {
      res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: err.code } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } catch { /* ignore */ }
  } finally {
    res.removeListener('close', onClose)
  }
}
