#!/usr/bin/env node
// opencode-free-provider — local OpenAI-compatible proxy for OpenCode Zen free models.
//
// Listens on http://127.0.0.1:8791/v1 and exposes:
//   GET  /v1/models
//   GET  /v1/models/:id
//   POST /v1/chat/completions   (stream: true/false → SSE / JSON)
//
// Every request is relayed (with the shared literal key "Bearer public") to
// OpenCode Zen's free tier (https://opencode.ai/zen/v1). No login, no key.
//
// Connect an agent (e.g. OpenCode) with:
//   baseURL: http://127.0.0.1:8791/v1
//   apiKey:  public            (or any non-empty string)
//   model:   opencode-free/big-pickle
//
// The upstream free tier enforces a client-fingerprint gate (User-Agent must be
// opencode/>=1.18, a valid x-opencode-session, and the request body must include
// the four agent tools bash/glob/grep/read). This proxy injects all of that for
// you, so any OpenAI-compatible client just points at the local endpoint.

import http from 'node:http'
import { DEFAULT_HOST, DEFAULT_PORT, PROVIDER } from './src/config.js'
import { handleModels, handleModel, handleChatCompletions, handleSessionInfo } from './src/routes.js'

const HOST = process.env.HOST || DEFAULT_HOST
const PORT = Number(process.env.PORT || DEFAULT_PORT)

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(text)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const method = req.method || 'GET'

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      })
      res.end()
      return
    }

    // Health
    if (path === '/' || path === '/health' || path === '/v1' || path === '/v1/') {
      return sendText(res, 200, `opencode-free-provider (${PROVIDER}) — proxy to OpenCode Zen free tier.\nEndpoints: GET /v1/models, POST /v1/chat/completions`)
    }

    // /v1/models
    if (method === 'GET' && path === '/v1/models') {
      return await handleModels(req, res)
    }

    // /v1/models/:id  (id may contain slashes, e.g. opencode-free/hy3-free)
    const modelMatch = path.match(/^\/v1\/models\/(.+)$/)
    if (method === 'GET' && modelMatch) {
      return handleModel(req, res, decodeURIComponent(modelMatch[1]))
    }

    // /v1/chat/completions
    if (method === 'POST' && path === '/v1/chat/completions') {
      return await handleChatCompletions(req, res)
    }

    // /__session — local debug endpoint (never forwarded upstream).
    if (method === 'GET' && path === '/__session') {
      return handleSessionInfo(req, res)
    }

    return sendText(res, 404, 'Not Found', { 'Access-Control-Allow-Origin': '*' })
  } catch (err) {
    console.error(`[opencode-free-provider] unhandled request error: ${err && err.stack || err}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: 'Internal Server Error', type: 'server_error' } }))
    } else {
      try { res.end() } catch { /* ignore */ }
    }
  }
})

function start() {
  server.on('error', (err) => {
    console.error(`[opencode-free-provider] server error: ${err && err.message}`)
    process.exit(1)
  })
  server.listen(PORT, HOST, () => {
    console.log(`[opencode-free-provider] listening on http://${HOST}:${PORT}/v1`)
    console.log(`[opencode-free-provider] relaying to OpenCode Zen free tier (Bearer public)`)
  })
}

export default server
export { server, start }

// Auto-listen only when executed directly (not when imported by tests).
function isRunDirectly() {
  const arg1 = process.argv[1]
  if (!arg1) return false
  if (arg1.includes('node:test')) return false
  const normalized = arg1.replace(/\\/g, '/')
  return import.meta.url === `file://${arg1}` || import.meta.url.endsWith(normalized)
}
if (isRunDirectly()) {
  start()
}
