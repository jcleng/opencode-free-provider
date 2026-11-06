import { PROVIDER, sessionState, ensureModels, refreshModels, modelsCacheState } from './config.js'
import { fingerprintState } from './fingerprint.js'
import { listModelsPayload, isValidModel, findModel, splitModelId } from './models.js'
import { relayChatCompletions } from './upstream.js'
import {
  egressState, egressFullState, importProxies, toggleProxy, retestProxy, removeUserProxy, setEgressOn,
  sweep, maskProxy, PROXY_FILE,
} from './egress.js'
import { egressDashboardHtml } from './egress-dashboard.js'

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
  return sendJson(res, 200, { provider: PROVIDER, ...sessionState(), fingerprint: fingerprintState() })
}

// Local debug endpoint (never forwarded upstream). Egress pool / dustbin state.
export function handleEgressInfo(req, res) {
  return sendJson(res, 200, { provider: PROVIDER, egress: egressState() })
}

// Full state for the dashboard: complete pool, user proxies, disabled set, dustbin.
export function handleEgressFull(req, res) {
  return sendJson(res, 200, { provider: PROVIDER, ...egressFullState() })
}

// Dashboard: single-file HTML control panel for the egress pool — IP toggles,
// user-proxy add/import (paste or file), retest-now, and dustbin re-enable.
export function handleEgressDashboard(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(egressDashboardHtml())
}

// POST /__egress/import — body is text (one proxy per line) or JSON {proxies:[...]}
export async function handleEgressImport(req, res) {
  let raw
  try { raw = await readBody(req, 2 * 1024 * 1024) } catch {
    return sendJson(res, 413, { error: { message: 'import too large' } })
  }
  const text = raw.toString('utf8').trim()
  let input
  try { input = JSON.parse(text) } catch { input = text }
  const r = importProxies(input)
  // immediately verify everything we just added (bounded by Promise.all, ~15s each)
  const results = await Promise.all((r.addedEntries || []).slice(0, 20).map((e) => retestProxy(e.proxy)))
  return sendJson(res, 200, { added: r.added, invalid: r.invalid, results: results.map((x) => ({ proxy: x.proxy, status: x.status, retryAfterSec: x.retryAfterSec || null, detail: x.detail || null })) })
}

// POST /__egress/toggle  { proxy }
export async function handleEgressToggle(req, res) {
  let parsed
  try { parsed = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) } catch { parsed = {} }
  const r = toggleProxy(parsed.proxy)
  return sendJson(res, 200, { proxy: parsed.proxy || null, ...r })
}

// POST /__egress/retest { proxy }
export async function handleEgressRetest(req, res) {
  let parsed
  try { parsed = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) } catch { parsed = {} }
  const r = await retestProxy(parsed.proxy)
  return sendJson(res, 200, { proxy: parsed.proxy || null, ...r })
}

// POST /__egress/remove-user { proxy }
export async function handleEgressRemoveUser(req, res) {
  let parsed
  try { parsed = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) } catch { parsed = {} }
  const r = removeUserProxy(parsed.proxy)
  return sendJson(res, 200, { proxy: parsed.proxy || null, ...r })
}

// POST /__egress/set { on: true|false } — master switch. on=false forces every
// relay turn to the DIRECT connection (the egress pool is ignored entirely).
export async function handleEgressSet(req, res) {
  let parsed
  try { parsed = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) } catch { parsed = {} }
  const r = setEgressOn(parsed.on)
  return sendJson(res, 200, { ...r, mode: r.egressOn ? 'pool-rotation' : 'direct-only' })
}

// POST /__egress/sweep-now { size, scrape } — force a sweep immediately.
export async function handleEgressSweepNow(req, res) {
  let parsed
  try { parsed = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) } catch { parsed = {} }
  const r = await sweep({ size: Number(parsed.size) || 30, scrape: parsed.scrape !== false })
  return sendJson(res, 200, r)
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
    // Streaming already started (headers sent) — we cannot send an HTTP error.
    // Emit a terminal finish_reason chunk so the client completes cleanly (never
    // "Stream ended without finish_reason"), then surface the error as a final
    // event for clients that parse it.
    try {
      res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: err.code } })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-error', object: 'chat.completion.chunk', created: 0, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } catch { /* ignore */ }
  } finally {
    res.removeListener('close', onClose)
  }
}
