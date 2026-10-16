// src/egress.js
//
// Egress-IP pool for the OpenCode Zen free tier — fully self-contained.
//
// WHY
// ---
// opencode.ai enforces its free tier with a per-EGRESS-IP usage budget: an
// address that spent its budget keeps answering every session id with
// `429 FreeUsageLimitError` plus a `Retry-After` measured in hours, while a
// different address answers 200 immediately. Rotating ses_/msg_ identifiers
// changes nothing — the limiter is keyed on the source address.
//
// src/fingerprint.js supplies the client fingerprint the free-tier gate
// requires. This module supplies the other half: a pool of verified egress
// proxies, used per request, with per-address cooldowns driven by the
// upstream's own Retry-After.
//
// CONTRACT
// --------
// - Zero npm dependencies: CONNECT tunneling lives on node:net / node:tls /
//   node:http / node:https only.
// - Its own files, under its own directory (overridable):
//     <dataDir>/egress-pool.json — verified egress addresses (atomic writes).
//   No reads from, and no state shared with, any other tool or repo.
// - Its own harvest from one public proxy-list URL (proxifly free-proxy-list).
//
// Runtime rules
// -------------
// - Sessions pin to one address so a conversation consumes that address's
//   budget instead of spraying the pool. Pin expires by TTL or cooldown.
// - 429 from upstream → cool THE ADDRESS (Retry-After clamped), never the
//   whole pool; the caller retries on the next candidate.
// - Empty or disabled pool → the relay falls back to a plain direct fetch,
//   identical behavior to a build without this module.

import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { peekFingerprintHeaders } from './fingerprint.js'
import { ZEN_FREE_TOOLS } from './config.js'

// ── Configuration (all overridable by env) ──────────────────────────────────

const envStr = (name, fallback) =>
  (typeof process.env[name] === 'string' && process.env[name].length) ? process.env[name] : fallback
const envFlag = (name, fallback) => {
  if (!process.env[name]) return fallback
  const v = process.env[name].toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}
const envNum = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const POOL_DIR = envStr(
  'OFP_POOL_DIR',
  path.join(os.homedir(), '.local', 'share', 'opencode-free-provider'),
)
export const POOL_FILE = envStr('OFP_POOL_FILE', path.join(POOL_DIR, 'egress-pool.json'))

export const UPSTREAM_BASE = envStr('OFP_UPSTREAM_BASE', 'https://opencode.ai/inference/v1')
// A base override means a mock/local upstream (tests, sandbox): the pool is
// pointless there and its real-network vetting would break the harness, so it
// defaults OFF unless explicitly forced on.
export const POOL_ENABLED = envFlag('OFP_POOL_ENABLED', !process.env.OPENCODE_BASE_OVERRIDE)
export const POOL_TTL_MS = envNum('OFP_POOL_TTL_MS', 30 * 60 * 1000)            // re-vet freshness window
export const POOL_SEED = envFlag('OFP_POOL_SEED', true)                        // harvest from public list
export const POOL_SEED_TARGET = envNum('OFP_POOL_SEED_TARGET', 40)             // live egresses wanted
export const POOL_SEED_CANDIDATES = envNum('OFP_POOL_SEED_CANDIDATES', 240)    // candidates per cycle
export const POOL_VET_W = envNum('OFP_POOL_VET_W', 16)                         // parallel vet probes
export const POOL_VET_TIMEOUT = envNum('OFP_POOL_VET_TIMEOUT_MS', 12_000)
export const POOL_MAX_TTFB = envNum('OFP_POOL_MAX_TTFB_MS', 4000)              // keep only fast egresses
export const MAX_ATTEMPTS = envNum('OFP_POOL_MAX_ATTEMPTS', 10)                // candidates per request
export const SESSION_TTL = envNum('OFP_POOL_SESSION_TTL_MS', 30 * 60 * 1000)
export const EGRESS_COOL_MAX = envNum('OFP_EGRESS_COOL_MAX_MS', 2 * 60 * 60 * 1000)
export const EGRESS_FAIL_COOL = envNum('OFP_EGRESS_FAIL_COOL_MS', 5 * 60 * 1000)
export const EGRESS_FAILS_TO_COOL = envNum('OFP_EGRESS_FAILS_TO_COOL', 3)
export const REQUEST_TIMEOUT = envNum('OFP_POOL_REQUEST_TIMEOUT_MS', 60_000)   // runtime request cap

const HARVEST_URL = envStr(
  'OFP_POOL_HARVEST_URL',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.json',
)
const HARVEST_TIMEOUT = envNum('OFP_POOL_HARVEST_TIMEOUT_MS', 25_000)

const LITERAL_KEY =
  process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_G_API_KEY || 'public'

// ── Proxy URIs ───────────────────────────────────────────────────────────────

export function parseProxy(raw) {
  if (!raw || typeof raw !== 'string') return null
  let host, port, scheme = 'http', auth
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
    const u = new URL(withScheme)
    scheme = u.protocol.replace(':', '').toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return null
    host = u.hostname
    port = u.port
    if (!host || !port) return null
    if (u.username) auth = Buffer.from(`${dbu(u.username)}:${dbu(u.password || '')}`).toString('base64')
  } catch { return null }
  return { id: `${scheme}://${host}:${port}`, host, port: Number(port), scheme, auth }
}
const dbu = (s) => { try { return decodeURIComponent(s) } catch { return s } }

// ── State ────────────────────────────────────────────────────────────────────

const entries = new Map()   // id → entry
const pins = new Map()      // sessionKey → { id, at }
const book = {}             // { loaded, harvested, vetted, accepted, dead, saveError, harvestError }
let lastRefresh = 0
let refreshInFlight = null

function upsert(parsed) {
  const id = parsed.id
  let e = entries.get(id)
  if (!e) {
    e = { id, host: parsed.host, port: parsed.port, scheme: parsed.scheme, auth: parsed.auth }
    entries.set(id, e)
  }
  return e
}
function addCandidate(parsed, source) {
  if (!parsed) return false
  const id = parsed.id
  if (entries.has(id)) return false
  upsert(parsed)
  entries.get(id).from = source
  book[source] = (book[source] || 0) + 1
  return true
}

const now = () => Date.now()

function live() {
  const out = []
  for (const e of entries.values()) if ((e.cooldownUntil || 0) < now()) out.push(e)
  out.sort((a, b) =>
    ((Number.isFinite(a.ttfbMs) ? a.ttfbMs : Infinity) - (Number.isFinite(b.ttfbMs) ? b.ttfbMs : Infinity)) ||
    ((a.verifiedAt || 0) - (b.verifiedAt || 0)))
  return out
}

export function healthyCount() {
  let n = 0
  for (const e of entries.values()) {
    if ((e.cooldownUntil || 0) < now() && Number.isFinite(e.ttfbMs)) n++
  }
  return n
}

// Selection policy: stay-on-until-exhausted.
//
// - New start (no session pin): the FASTEST verified, non-cooling address is
//   picked — and only that one.
// - An existing pin keeps its address until that address is exhausted (429
//   from upstream, padded by a grace window so follow-up requests during the
//   same zen budget window keep riding the same quota tank) or meets the
//   discard criteria below.
// - Discard: pick a new fastest address when the pinned one goes into
//   cooldown, or its measured latency exceeds POOL_MAX_TTFB_MS (new candidates
//   discard at vet time; live ones degrade and rotate here), or it fails
//   EGRESS_FAILS_TO_COOL times in a row.

export function pickEgress(sessionKey) {
  const ranked = live().filter((e) => Number.isFinite(e.ttfbMs) && (e.verifiedAt || 0) > 0)
  if (!ranked.length) return null
  if (sessionKey) {
    const pin = pins.get(sessionKey)
    const pinned = pin ? entries.get(pin.id) : null
    if (pinned &&
        Number.isFinite(pinned.ttfbMs) && (pinned.verifiedAt || 0) > 0 &&
        (pinned.cooldownUntil || 0) < now() &&
        pinned.ttfbMs <= POOL_MAX_TTFB) {
      return pinned // stay put until this address is cooled or discarded
    }
  }
  // Fresh start (or the previous address was exhausted/discarded): fastest.
  const e = ranked[0]
  if (sessionKey) pins.set(sessionKey, { id: e.id, at: now() })
  return e
}

export function markOk(id, ttfbMs) {
  const e = entries.get(id)
  if (!e) return
  e.ok = (e.ok || 0) + 1
  e.fail = 0
  if (Number.isFinite(ttfbMs)) {
    e.ttfbMs = Number.isFinite(e.ttfbMs) ? Math.round(e.ttfbMs * 0.7 + ttfbMs * 0.3) : ttfbMs
  }
  e.verifiedAt = now()
}
export function markRateLimited(id, retryAfterRawMs = 0) {
  const e = entries.get(id)
  if (!e) return
  const ms = Math.max(0, Number(retryAfterRawMs) || 0)
  e.cooldownUntil = now() + Math.min(ms || EGRESS_COOL_MAX, EGRESS_COOL_MAX)
}
export function markFail(id) {
  const e = entries.get(id)
  if (!e) return
  e.fail = (e.fail || 0) + 1
  if (e.fail >= EGRESS_FAILS_TO_COOL) e.cooldownUntil = now() + EGRESS_FAIL_COOL
}

export function unpin(sessionKey) { if (sessionKey) pins.delete(sessionKey) }

// ── Transport: single request over an HTTP CONNECT tunnel ────────────────────
//
// requestViaProxy(proxy, destUrl, init) resolves to a fetch-like response
// adapter (status/headers/text/json) whose body is a native stream we can
// pipe. init: {method, headers, body, signal, timeoutMs}.

export function requestViaProxy(proxy, destUrl, init = {}) {
  const dest = new URL(destUrl)
  const isTls = dest.protocol === 'https:'
  const destPort = dest.port || (isTls ? 443 : 80)
  const timeout = init.timeoutMs || REQUEST_TIMEOUT

  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) return reject(new RequestError('aborted', 'ABORTED'))
    let settled = false
    const cleanup = []
    const fail = (err, code) => {
      if (settled) return
      settled = true
      try { sock?.destroy() } catch { /* noop */ }
      err.code = err.code || code
      reject(err instanceof RequestError ? err : new RequestError(String(err?.message || err), code))
    }
    let sock = null

    // 1) TCP (or TLS) to the proxy.
    if (proxy.scheme === 'https') {
      sock = tls.connect({ host: proxy.host, port: proxy.port, rejectUnauthorized: false })
    } else {
      sock = net.connect({ host: proxy.host, port: proxy.port })
    }
    sock.setTimeout(timeout, () => fail(new RequestError('proxy connect timeout', 'ETIMEDOUT'), 'ETIMEDOUT'))
    sock.once('error', (err) => fail(err, 'EPROXY'))
    sock.once('connect', () => {
      const head =
        `CONNECT ${dest.hostname}:${destPort} HTTP/1.1\r\n` +
        `Host: ${dest.hostname}:${destPort}\r\n` +
        (proxy.auth ? `Proxy-Authorization: Basic ${proxy.auth}\r\n` : '') +
        `Proxy-Connection: keep-alive\r\n\r\n`
      sock.write(head)
    })

    // 2) Parse the CONNECT verdict.
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('latin1')
      const i = buf.indexOf('\r\n\r\n')
      if (i === -1) return
      sock.removeListener('data', onData)
      const status = Number((buf.match(/HTTP\/\S+ (\d{3})/) || [])[1])
      if (!(status >= 200 && status < 300)) {
        return fail(new RequestError(`CONNECT ${proxy.host}:${proxy.port} → ${status || 'no response'}`, 'ETUNNEL'), 'ETUNNEL')
      }
      sock.setTimeout(0)
      const rest = Buffer.from(buf.slice(i + 4), 'latin1')

      const transport = isTls
        ? tls.connect({ socket: sock, servername: dest.hostname, rejectUnauthorized: false })
        : sock
      if (rest.length) transport.once('connect', () => transport.unshift(rest))
      if (isTls) {
        transport.once('error', (err) => fail(err, 'ETLS'))
        transport.once('secureConnect', () => startRequest(transport))
      } else {
        startRequest(transport)
      }
    }
    sock.on('data', onData)

    // 3) Issue the actual request through the established tunnel.
    function startRequest(transport) {
      const req = (isTls ? https : http).request({
        hostname: dest.hostname, port: destPort,
        path: dest.pathname + (dest.search || ''),
        method: init.method || 'GET',
        headers: init.headers || {},
        agent: false,
        createConnection: () => transport,
        signal: init.signal,
        timeout,
      }, (msg) => {
        settle(transport, msg)
      })
      req.once('timeout', () => { req.destroy(new RequestError('request timeout', 'ETIMEDOUT')) })
      req.once('error', (err) => fail(err, 'EREQUEST'))
      if (init.signal) init.signal.addEventListener('abort', () => req.destroy(new RequestError('aborted', 'ABORTED')), { once: true })
      if (init.body != null) req.write(init.body)
      req.end()
      cleanup.push(req)
    }

    function settle(transport, msg) {
      if (settled) return
      settled = true
      resolve(makeResponse(msg, transport, init.signal))
    }
  })
}

export class RequestError extends Error {
  constructor(message, code) { super(message); this.name = 'RequestError'; this.code = code }
}

// Fetch-like adapter over a Node IncomingMessage: the relay consumes upstream
// responses exactly as it consumes a real fetch Response (status, ok,
// headers.get(), json()/text(), body.getReader()).
function makeResponse(msg, req, signal) {
  const status = msg.statusCode || 0
  const rawHeaders = msg.headers || {}
  const headers = {
    get: (name) => rawHeaders[String(name).toLowerCase()] ?? null,
    has: (name) => rawHeaders[String(name).toLowerCase()] != null,
    forEach: (fn) => { for (const [k, v] of Object.entries(rawHeaders)) fn(v, k) },
    entries: () => Object.entries(rawHeaders)[Symbol.iterator](),
    raw: rawHeaders,
  }
  const adapter = {
    ok: status >= 200 && status < 300,
    status,
    statusText: msg.statusMessage || '',
    headers,
    url: null,
    _raw: msg,
    text: () => collect(msg, signal, req),
    json: () => adapter.text().then((t) => JSON.parse(t)),
    body: {
      getReader() {
        const iterator = msg[Symbol.asyncIterator]()
        let released = false
        const reader = {
          async read() {
            if (released) return { value: undefined, done: true }
            const { value, done } = await iterator.next()
            return { value, done }
          },
          cancel() { released = true; try { req.destroy() } catch { /* noop */ } },
          releaseLock() { released = true },
        }
        return reader
      },
      async *[Symbol.asyncIterator]() {
        const it = this.getReader()
        for (;;) {
          const { value, done } = await it.read()
          if (done) return
          yield value
        }
      },
    },
  }
  return adapter
}

function collect(msg, signal, req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    msg.on('data', (c) => chunks.push(c))
    msg.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    msg.on('error', reject)
    if (signal) signal.addEventListener('abort', () => req.destroy(new RequestError('aborted', 'ABORTED')), { once: true })
  })
}

// ── Proving an address: one real zen pong through the tunnel ─────────────────

function pongHeaders() {
  const h = peekFingerprintHeaders()
  h['content-type'] = 'application/json'
  h['authorization'] = `Bearer ${LITERAL_KEY}`
  return h
}
function pongBody(model) {
  return JSON.stringify({
    model,
    stream: true,
    max_tokens: 24,
    messages: [{ role: 'user', content: 'ping' }],
    tools: ZEN_FREE_TOOLS,
    tool_choice: 'auto',
  })
}

export async function vetOne(entry, model) {
  const proxy = { id: entry.id, host: entry.host, port: entry.port, scheme: entry.scheme, auth: entry.auth }
  const t0 = now()
  const res = await requestViaProxy(proxy, `${UPSTREAM_BASE}/chat/completions`, {
    method: 'POST',
    headers: pongHeaders(),
    body: pongBody(model || VET_MODEL_FALLBACK),
    timeoutMs: POOL_VET_TIMEOUT,
  })
  const ttfb = now() - t0
  const status = res.status
  if (status === 429) { void res; return { verdict: 'upstream-limit', ttfb } } // address works; budget spent
  if (status >= 300 || status < 200) throw new RequestError(`vet HTTP ${status}`, 'EVET')
  // Consume the first SSE event — proof of real data flow, then close.
  const first = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new RequestError('pong timeout', 'EVET')), POOL_VET_TIMEOUT)
    res._raw.once('data', (c) => { clearTimeout(to); resolve(c) })
    res._raw.once('end', () => { clearTimeout(to); resolve(Buffer.alloc(0)) })
    res._raw.once('error', (e) => { clearTimeout(to); reject(e) })
  })
  try { res._raw.destroy() } catch { /* noop */ }
  if (!first.length) throw new RequestError('empty pong', 'EVET')
  if (ttfb > POOL_MAX_TTFB) return { verdict: 'slow', ttfb }
  return { verdict: 'ok', ttfb }
}

const VET_MODEL_FALLBACK = 'space-bunny-free'

// ── Persistence ──────────────────────────────────────────────────────────────

function sanitize(e) {
  return {
    proxy: e.id,
    ttfbMs: e.ttfbMs,
    verifiedAt: e.verifiedAt,
    ok: e.ok || 0,
    fail: e.fail || 0,
  }
}
export function savePool() {
  try {
    fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true })
    const data = {
      savedAt: now(),
      entries: [...entries.values()]
        .filter((e) => Number.isFinite(e.ttfbMs) && e.ttfbMs <= POOL_MAX_TTFB && (e.verifiedAt || 0) > 0)
        .sort((a, b) => a.ttfbMs - b.ttfbMs)
        .slice(0, 400)
        .map(sanitize),
    }
    const tmp = `${POOL_FILE}.tmp-${randomUUID()}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1))
    fs.renameSync(tmp, POOL_FILE)
    return true
  } catch (err) {
    book.saveError = String(err && err.message)
    return false
  }
}

export function loadPoolFile(file = POOL_FILE) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return 0 }
  let added = 0
  try {
    const data = JSON.parse(text)
    const list = Array.isArray(data) ? data : data.entries || []
    for (const item of list) {
      const raw = typeof item === 'string' ? item : (item.proxy ?? item.id ?? item.address)
      const parsed = parseProxy(raw)
      if (!parsed) continue
      const isNew = addCandidate(parsed, 'file')
      if (isNew) added++
      const e = entries.get(parsed.id)
      if (e && typeof item === 'object' && item !== null && Number.isFinite(item.ttfbMs) && (item.verifiedAt || 0) > 0) {
        e.ttfbMs = item.ttfbMs
        e.verifiedAt = item.verifiedAt
        e.ok = item.ok || e.ok || 0
        e.fail = item.fail || 0
      }
    }
  } catch {
    // Text fallback: one proxy per line (`host:port` or a full URI).
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim().split(/\s+/)[0]
      if (!s || s.startsWith('#')) continue
      if (addCandidate(parseProxy(s), 'file')) added++
    }
  }
  return added
}

// ── Harvest (own, public) + refresh cycle ────────────────────────────────────

async function harvestCandidates() {
  try {
    const r = await fetch(HARVEST_URL, {
      headers: { 'User-Agent': 'opencode-free-provider/1.0 (egress pool)' },
      signal: AbortSignal.timeout(HARVEST_TIMEOUT),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const payload = await r.json()
    const list = Array.isArray(payload) ? payload : (payload?.data || [])
    let added = 0
    for (const item of list) {
      let raw
      if (typeof item === 'string') raw = item
      else raw = item.proxy ?? (item.host ? `${item.host}:${item.port}` : item.ipAddress ?? item.ip)
      const p = parseProxy(raw)
      if (p && addCandidate(p, 'harvest')) added++
      if (added >= POOL_SEED_CANDIDATES) break
    }
    return added
  } catch (err) {
    book.harvestError = String(err && err.message)
    return 0
  }
}

export async function vetPending() {
  const todo = live().filter((e) => !Number.isFinite(e.ttfbMs) || (e.verifiedAt || 0) === 0)
  let accepted = 0
  let vetted = 0
  for (let i = 0; i < todo.length; i += POOL_VET_W) {
    const chunk = todo.slice(i, i + POOL_VET_W)
    const results = await Promise.allSettled(chunk.map((e) => vetOne(e)))
    for (let j = 0; j < chunk.length; j++) {
      const e = chunk[j]
      const r = results[j]
      vetted++
      if (r.status === 'fulfilled') {
        const v = r.value
        if (v.verdict === 'ok') {
          markOk(e.id, v.ttfb)
          accepted++
          if (accepted >= POOL_SEED_TARGET) return accepted // enough live addresses
        } else if (v.verdict === 'upstream-limit') {
          markOk(e.id, v.ttfb) // address works; only its budget is spent right now
          book['upstream-limit'] = (book['upstream-limit'] || 0) + 1
        } else {
          book.dead = (book.dead || 0) + 1
        }
      } else {
        book.dead = (book.dead || 0) + 1
      }
    }
    if (vetted >= POOL_SEED_CANDIDATES) break
  }
  return accepted
}

// Refresh: load the pool file, farm fresh candidates when low, vet, persist.
export const POOL_REFRESH_MIN = 120_000
export async function refresh({ force = false } = {}) {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      if (!POOL_ENABLED) return poolState()
      loadPoolFile()
      const fresh = candidates().filter((e) => isFresh(e)).length
      if (!force && fresh >= POOL_SEED_TARGET && lastFarm > now() - POOL_REFRESH_MIN) return poolState()
      const accepted = await vetPending()
      if (accepted > 0) savePool()
      lastRefresh = now()
      book.lastAccepted = accepted
      book.lastAt = lastRefresh
      if (healthyCount() < POOL_SEED_TARGET && POOL_SEED && POOL_ENABLED) {
        await harvest()
        const again = await vetPending()
        if (again) savePool()
        book.lastHarvestAccepted = again
      }
      return poolState()
    } finally { refreshInFlight = null }
  })()
  return refreshInFlight
}

function harvest() {
  book.harvestAt = now()
  lastFarm = now()
  return harvestCandidates()
}

// Internal: fresh = verified inside TTL
function isFresh(e) { return Number.isFinite(e.ttfbMs) && (e.verifiedAt || 0) > now() - POOL_TTL_MS }

function candidates() { return live() }

let lastFarm = 0
export function poolState() {
  const st = {
    enabled: POOL_ENABLED,
    file: POOL_FILE,
    lastRefresh: lastRefresh || null,
    live: healthyCount(),
    total: entries.size,
    book: { ...book },
  }
  st.entries = live().slice(0, 40).map((e) => ({
    proxy: e.id,
    ttfbMs: Number.isFinite(e.ttfbMs) ? e.ttfbMs : null,
    verifiedAt: e.verifiedAt || null,
    ok: e.ok || 0,
    fail: e.fail || 0,
    cooldownUntil: e.cooldownUntil || null,
    from: e.from || null,
  }))
  st.cooling = [...entries.values()].filter((e) => (e.cooldownUntil || 0) >= now()).length
  st.pinnedSessions = pins.size
  return st
}

export function markUsed(id, ttfbMs) { markOk(id, ttfbMs) }

// ── Request-path routing ─────────────────────────────────────────────────────
//
// createRouteSend(sessionKey) → async send(url, init):
//   - pool enabled & healthy → requests travel through verified addresses,
//     rotating on 429 (cooldown marks that ADDRESS with the raw Retry-After,
//     never the whole pool) or hard transport failure.
//   - every signalling response (5xx) and transport error rotates within the
//     bounded per-request budget (MAX_ATTEMPTS); between rotations nothing is
//     re-rolled upstream.
//   - endpoint exhausted/disabled → plain direct fetch, which is exactly what
//     the baseline relay does.
// The returned function is used for every upstream call of one request, so
// translate-loop follow-ups ride the same tunnel/conversation pin.

function parseRetryAfter(headers) {
  const raw = headers?.['retry-after']
  if (raw == null) return 0
  if (Array.isArray(raw)) return parseRetryAfter({ 'retry-after': raw[0] })
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n * 1000
  const d = Date.parse(String(raw))
  return Number.isFinite(d) ? Math.max(0, d - now()) : 0
}

export function createRouteSend(sessionKey) {
  return async function send(url, init = {}) {
    if (!POOL_ENABLED) return globalThis.fetch(url, init)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const e = pickEgress(sessionKey)
      if (!e) break
      const t0 = now()
      let res
      try {
        res = await requestViaProxy(
          { id: e.id, host: e.host, port: e.port, scheme: e.scheme, auth: e.auth },
          url,
          { ...init, timeoutMs: init.timeoutMs || REQUEST_TIMEOUT },
        )
      } catch {
        markFail(e.id)
        unpin(sessionKey)
        continue
      }
      const ttfb = now() - t0
      if (res.status === 429) {
        // This address ran out of budget; cool it with the upstream's own
        // window and hand the conversation to the next address.
        markRateLimited(e.id, parseRetryAfter(res.headers))
        unpin(sessionKey)
        continue
      }
      if (res.status >= 500 && res.status < 600) {
        markFail(e.id)
        unpin(sessionKey)
        continue
      }
      markOk(e.id, ttfb)
      try {
        if (res.headers && typeof res.headers.get === 'function') {
          res.headers.raw['x-ofp-egress'] = e.id
        }
      } catch { /* noop */ }
      return res
    }
    return globalThis.fetch(url, init)
  }
}
