// src/auth.js
//
// Optional client authentication.
//
// WHY THIS EXISTS
// ---------------
// The relay listens on a public port (compose/Docker maps 8791 to the host), so
// anyone who learns the URL can burn the free-tier quota of that egress IP. Set
// the `API_KEY` env var (the Dockerfile defaults it to `public`) and the relay
// requires every proxied request to present it. Agents configure exactly this
// value as their provider `apiKey`:
//
//   "opencode-zen-server": {
//     "baseUrl": "http://<host>:<port>/v1",
//     "api": "openai-completions",
//     "apiKey": "<API_KEY>",
//     "models": [{ "id": "big-pickle", "contextWindow": 200000 }]
//   }
//
// Semantics:
//   - `API_KEY` unset or empty      → auth disabled (backwards compatible).
//   - `API_KEY=public` (image default) → the historical `apiKey: public` still
//     works; set a private value to actually lock the relay down.
//   - Accepted presentations: `Authorization: Bearer <key>` (what OpenAI
//     clients send) and `x-api-key: <key>` (handy for curl / some SDKs).
//
// This checks the CLIENT→relay credential only. The relay→upstream credential
// is separate and lives in src/upstream.js (`resolveApiKey`: OPENCODE_ZEN_API_KEY
// or the literal "public").
import { timingSafeEqual } from 'node:crypto'

const HEADER_NAMES = ['authorization', 'x-api-key']

/** The configured client key, or null when auth is disabled. */
export function expectedApiKey() {
  const key = process.env.API_KEY
  return typeof key === 'string' && key.length > 0 ? key : null
}

/** True when the relay requires clients to present API_KEY. */
export function authRequired() {
  return expectedApiKey() !== null
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function presentedKeys(req) {
  const headers = (req && req.headers) || {}
  const keys = []
  for (const name of HEADER_NAMES) {
    const value = headers[name]
    if (typeof value !== 'string' || value.length === 0) continue
    if (name === 'authorization') {
      const match = /^bearer\s+(.+)$/i.exec(value.trim())
      keys.push(match ? match[1].trim() : value.trim())
    } else {
      keys.push(value.trim())
    }
  }
  return keys
}

/**
 * True when the request may be served. Always true while API_KEY is unset, so
 * an unconfigured relay keeps working for existing clients.
 */
export function isAuthorized(req) {
  const expected = expectedApiKey()
  if (!expected) return true
  return presentedKeys(req).some((key) => safeEqual(key, expected))
}

/**
 * Paths that stay public even when API_KEY is set: the health/landing routes.
 * Everything else (`/v1/*`, `/__*` debug endpoints) is authenticated — the
 * debug endpoints expose the generated session id, so they are NOT exempt.
 */
export function isPublicPath(path) {
  return path === '/' || path === '/health' || path === '/v1' || path === '/v1/'
}
