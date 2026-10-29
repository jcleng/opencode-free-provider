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
