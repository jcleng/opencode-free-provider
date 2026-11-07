// src/egress.js — egress IP pool: web-scraped fast proxies + dustbin for bad/used IPs.
//
// Sources: geonode.com/free-proxy-list (RSC-embedded JSON records) and the
// monosans/proxy-list GitHub raw file. Only *fast* HTTP proxies are kept
// (latency/speed/uptime filters). Every candidate is verified with a real
// POST to the Zen chat endpoint before it is ever used for a relay:
//   200 → ok (usable, has free quota)
//   429 → quota-exhausted on that egress IP → dustbin until `retry-after`
//   transport error / non-2xx → dead → dustbin with backoff
//
// A background sweep re-tests dustbin entries when their retest time is due and
// tops up the pool with fresh scrapes, N IPs at a time in parallel.
//
// State files (project root):
//   egress-pool.json    — live pool entries
//   egress-dustbin.json — dustbin for dead / quota-used IPs

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { ProxyAgent } from 'undici'

import { getOpencodeBase, LITERAL_KEY } from './config.js'
import { getFingerprintHeaders } from './fingerprint.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const POOL_FILE = process.env.EGRESS_POOL_FILE || path.join(ROOT, 'egress-pool.json')
const DUSTBIN_FILE = process.env.EGRESS_DUSTBIN_FILE || path.join(ROOT, 'egress-dustbin.json')
// Proxies the user explicitly added ("my" free-tier proxies). They are always
// preferred in rotation and are never auto-culled by the sweeper.
const USER_FILE = process.env.EGRESS_USER_FILE || path.join(ROOT, 'egress-user.json')

// --- knobs -------------------------------------------------------------------
export const SWEEP_CONCURRENCY = Number(process.env.EGRESS_SWEEP_CONCURRENCY) || 30
export const SWEEP_INTERVAL_MS = Number(process.env.EGRESS_SWEEP_INTERVAL_MS) || 3 * 60_000
// re-verify "ok" entries older than this so the best-IP ranking stays fresh
export const OK_REVERIFY_MS = Number(process.env.EGRESS_OK_REVERIFY_MS) || 10 * 60_000
export const PROBE_TIMEOUT_MS = Number(process.env.EGRESS_PROBE_TIMEOUT_MS) || 15_000
// "fast only" filters (geonode record fields)
export const FAST_MAX_LATENCY_MS = Number(process.env.EGRESS_FAST_MAX_LATENCY_MS) || 500
export const FAST_MIN_SPEED = Number(process.env.EGRESS_FAST_MIN_SPEED) || 800
export const FAST_MIN_UPTIME = Number(process.env.EGRESS_FAST_MIN_UPTIME) || 90
// dead proxy gets re-tested after this long in the dustbin
export const DEAD_RETEST_MS = Number(process.env.EGRESS_DEAD_RETEST_MS) || 30 * 60_000
// max pool entries kept
export const POOL_MAX = Number(process.env.EGRESS_POOL_MAX) || 400
// Optional file of proxy lines (user:pass@host:port) to auto-import as the
// preferred user pool on startup (e.g. ~/proxy.txt). Defaults to
// ~/proxy.txt; override with EGRESS_PROXY_FILE.
export const PROXY_FILE = process.env.EGRESS_PROXY_FILE
  || path.join(os.homedir(), 'proxy.txt')

const SCRAPE_SOURCES = [
  {
    name: 'geonode',
    url: 'https://geonode.com/free-proxy-list',
    parse: parseGeonodeHtml,
  },
  {
    name: 'monosans',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    parse: parseLineList,
  },
  {
    name: 'free-proxy-list.net',
    url: 'https://free-proxy-list.net/',
    parse: parseFreeProxyListHtml,
  },
  {
    name: 'proxyscrape',
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=json',
    parse: parseProxyscrapeJson,
  },
]

const GEO_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// --- state -------------------------------------------------------------------
let pool = [] // { proxy, status:'ok'|'untested', ttfbMs, verifiedAt, ok, fail, source }
let dustbin = [] // { proxy, reason:'dead'|'quota', detail, dustedAt, retestAt }
let userProxies = [] // proxies the user added ("my" free-tier proxies)
let disabled = new Set() // user-toggled-off proxies (excluded from rotation)
// Master switch: false = force DIRECT connection (ignore the pool entirely).
let egressOn = true
let loaded = false
let saving = false

function loadState() {
  if (loaded) return
  loaded = true
  const norm = (raw) => {
    // accept both legacy entries ({proxy, ttfbMs, verifiedAt, ok, fail}) and
    // current ones; everything without a usable proxy string is dropped
    const proxy = typeof raw?.proxy === 'string' ? raw.proxy : (typeof raw === 'string' ? raw : null)
    if (!proxy || !/^https?:\/\//.test(proxy)) return null
    return {
      proxy,
      status: raw.status === 'ok' ? 'ok' : 'untested',
      ttfbMs: Number(raw.ttfbMs) || null,
      verifiedAt: Number(raw.verifiedAt) || 0,
      ok: Number(raw.ok) || 0,
      fail: Number(raw.fail) || 0,
      source: raw.source || 'pool',
    }
  }
  try {
    if (existsSync(POOL_FILE)) {
      const raw = JSON.parse(readFileSync(POOL_FILE, 'utf8'))
      pool = (Array.isArray(raw?.entries) ? raw.entries : []).map(norm).filter(Boolean)
    }
  } catch { /* start empty */ }
  try {
    if (existsSync(DUSTBIN_FILE)) {
      const raw = JSON.parse(readFileSync(DUSTBIN_FILE, 'utf8'))
      dustbin = (Array.isArray(raw?.entries) ? raw.entries : [])
        .map((d) => {
          const proxy = typeof d?.proxy === 'string' ? d.proxy : (typeof d?.proxy?.proxy === 'string' ? d.proxy.proxy : null)
          if (!proxy) return null
          return { proxy, reason: d.reason === 'quota' ? 'quota' : 'dead', detail: d.detail || '', dustedAt: Number(d.dustedAt) || 0, retestAt: Number(d.retestAt) || 0 }
        })
        .filter(Boolean)
    }
  } catch { /* start empty */ }
  // user-added proxies + toggle state live in one file
  try {
    if (existsSync(USER_FILE)) {
      const raw = JSON.parse(readFileSync(USER_FILE, 'utf8'))
      userProxies = (Array.isArray(raw?.proxies) ? raw.proxies : []).filter((p) => /^https?:\/\//.test(p || ''))
      disabled = new Set(Array.isArray(raw?.disabled) ? raw.disabled : [])
      if (raw?.egressOn === false) egressOn = false
    }
  } catch { /* start empty */ }
}

function writeSync() {
  try {
    writeFileSync(POOL_FILE, JSON.stringify({ savedAt: Date.now(), entries: pool }, null, 1) + '\n')
    writeFileSync(DUSTBIN_FILE, JSON.stringify({ savedAt: Date.now(), entries: dustbin }, null, 1) + '\n')
    writeFileSync(USER_FILE, JSON.stringify({ savedAt: Date.now(), proxies: userProxies, disabled: [...disabled], egressOn }, null, 1) + '\n')
  } catch (e) {
    console.error(`[egress] persist failed: ${e?.message}`)
  }
}
let persistTimer = null
export function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
    writeSync()
  }
}
function persist() {
  if (saving) return
  if (persistTimer) return // already scheduled inside the window
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeSync()
  }, 120)
  if (persistTimer.unref) persistTimer.unref()
}

// --- scraping ----------------------------------------------------------------
// geonode embeds its proxy table as escaped JSON inside the Next.js RSC payload.
function parseGeonodeHtml(html) {
  const unesc = html.replace(/\\"/g, '"')
  const recs = []
  const re = /\{"_id":"[^"]+","ip":"[0-9.]+"[^{}]*?\}/g
  for (const m of unesc.matchAll(re)) {
    try { recs.push(JSON.parse(m[0])) } catch { /* skip malformed record */ }
  }
  return recs
    .filter((r) => Array.isArray(r.protocols) && r.protocols.includes('http'))
    .filter((r) => Number(r.latency) <= FAST_MAX_LATENCY_MS)
    .filter((r) => Number(r.speed) >= FAST_MIN_SPEED)
    .filter((r) => Number(r.upTime) >= FAST_MIN_UPTIME)
    .sort((a, b) => Number(a.latency) - Number(b.latency))
    .map((r) => `http://${r.ip}:${r.port}`)
}

function parseLineList(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const s = line.trim()
    if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s)) out.push(`http://${s}`)
  }
  return out
}

// free-proxy-list.net: a plain HTML table with columns
//   IP | Port | Code | Country | Anonymity | Google | Https | Last Checked
// Keep only HTTPS-capable (CONNECT-tunnel) proxies that were checked within
// the last few minutes — that is the "fast" subset actually able to reach
// opencode.ai.
function parseFreeProxyListHtml(html) {
  const out = []
  // rows: 8 <td> cells; class attributes may use single or double quotes
  const tdRe = /<td(?:\s+class=['\"][^'\"]*['\"])?>([^<]*)<\/td>/g
  for (const row of String(html).matchAll(/<tr>(?:<td[^>]*>[^<]*<\/td>){8}<\/tr>/g)) {
    const cells = [...row[0].matchAll(tdRe)].map((c) => c[1].trim())
    if (cells.length < 8) continue
    const [ip, port, , , , , https, checked] = cells
    if (!ip || !port) continue
    if (https !== 'yes') continue // no CONNECT tunnel → cannot reach HTTPS upstream
    const secs = /(\d+)\s*(\w+)\s*ago/i.exec(checked || '')
    if (!secs) continue
    const unit = { s: 1, sec: 1, secs: 1, min: 60, mins: 60, m: 60, h: 3600, hrs: 3600 }[secs[2].toLowerCase()]
    if (!unit) continue
    const ageSec = Number(secs[1]) * unit
    if (ageSec > 5 * 60) continue // stale: likely dead
    out.push({ proxy: `http://${ip}:${port}`, ageSec })
  }
  out.sort((a, b) => a.ageSec - b.ageSec)
  return out.map((e) => e.proxy).slice(0, 150)
}

// proxyscrape v4 API (JSON): { proxies: [{ protocol, ip, port, alive, ssl, uptime, ... }] }
// Keep live HTTP proxies that support the SSL/CONNECT tunnel (required to reach
// the HTTPS upstream), ranked by uptime (the "fast + reliable" subset), capped.
function parseProxyscrapeJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const rows = Array.isArray(data?.proxies) ? data.proxies : []
  return rows
    .filter((p) => /http/i.test(p.protocol || ''))
    .filter((p) => p.alive === true)
    .filter((p) => p.ssl !== false)
    .filter((p) => Number(p.uptime ?? 0) >= 80)
    .sort((a, b) => Number(b.uptime) - Number(a.uptime))
    .map((p) => `http://${p.ip}:${p.port}`)
    .slice(0, 300)
}

export async function scrapeSources({ timeoutMs = 30_000 } = {}) {
  const found = []
  for (const src of SCRAPE_SOURCES) {
    try {
      const res = await fetch(src.url, {
        headers: { 'user-agent': GEO_UA, accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = src.name === 'geonode' ? await res.text() : await res.text()
      const proxies = src.parse(body)
      console.log(`[egress] scrape ${src.name}: ${proxies.length} fast http proxies`)
      found.push(...proxies)
      scrapeStats = scrapeStats.filter((s) => s.name !== src.name)
      scrapeStats.push({ name: src.name, count: proxies.length, at: Date.now(), ok: true })
    } catch (e) {
      console.warn(`[egress] scrape ${src.name} failed: ${e?.message}`)
      scrapeStats = scrapeStats.filter((s) => s.name !== src.name)
      scrapeStats.push({ name: src.name, count: 0, at: Date.now(), ok: false, error: e?.message })
    }
  }
  pushEvent('scrape', `web: ${scrapeStats.reduce((a, s) => a + s.count, 0)} fast proxies from ${scrapeStats.filter((s) => s.ok).length}/${scrapeStats.length} sources`)
  return [...new Set(found)]
}

// --- probing -----------------------------------------------------------------
function dispatcherFor(proxyUrl) {
  return new ProxyAgent({ uri: proxyUrl, connectTimeout: 10_000, bodyTimeout: 0, headersTimeout: PROBE_TIMEOUT_MS })
}

// POST a minimal chat completion through the proxy. This is the ONLY test that
// tells us whether the egress IP still has free quota (the 429 is per-IP).
export async function testProxy(proxyUrl, { model = 'big-pickle' } = {}) {
  // Use the REAL fingerprint generator (valid ses_ shape + counter bound). A
  // hand-rolled session id fails the gate with 403 FreeTierError even when the
  // proxy itself is fine — which previously poisoned the dustbin with "dead".
  const headers = {
    ...(await getFingerprintHeaders().catch(() => ({}))),
    authorization: `Bearer ${LITERAL_KEY}`,
  }
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Say OK.' }],
    stream: true,
    max_tokens: 8,
    tools: [
      { type: 'function', function: { name: 'bash', description: 'bash', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
      { type: 'function', function: { name: 'glob', description: 'glob', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
      { type: 'function', function: { name: 'grep', description: 'grep', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
      { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
    ],
  })
  const t0 = Date.now()
  try {
    const res = await fetch(`${getOpencodeBase()}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      dispatcher: dispatcherFor(proxyUrl),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const ttfb = Date.now() - t0
    const retryAfter = Number(res.headers.get('retry-after')) || 0
    await res.text().catch(() => {})
    if (res.ok) return { proxy: proxyUrl, status: 'ok', ttfbMs: ttfb }
    if (res.status === 429) return { proxy: proxyUrl, status: 'quota', ttfbMs: ttfb, retryAfterSec: retryAfter }
    return { proxy: proxyUrl, status: 'dead', ttfbMs: ttfb, detail: `HTTP ${res.status}` }
  } catch (e) {
    return { proxy: proxyUrl, status: 'dead', ttfbMs: Date.now() - t0, detail: e?.cause?.code || e?.name || e?.message }
  }
}

// --- pool / dustbin bookkeeping ----------------------------------------------
function findPool(proxyUrl) {
  return pool.find((e) => e.proxy === proxyUrl)
}

function upsertPool(proxyUrl, source) {
  let e = findPool(proxyUrl)
  if (!e) {
    e = { proxy: proxyUrl, status: 'untested', ttfbMs: null, verifiedAt: 0, ok: 0, fail: 0, source: source || 'scrape' }
    pool.push(e)
  }
  return e
}

export function dustbinProxy(proxyUrl, reason, { detail, retryAfterSec } = {}) {
  const now = Date.now()
  const existing = dustbin.find((d) => d.proxy === proxyUrl)
  const retestAt =
    reason === 'quota' && retryAfterSec > 0
      ? now + (retryAfterSec + 60) * 1000
      : now + DEAD_RETEST_MS
  if (existing) {
    existing.reason = reason
    existing.detail = detail || existing.detail
    existing.dustedAt = now
    existing.retestAt = retestAt
  } else {
    dustbin.push({ proxy: proxyUrl, reason, detail: detail || '', dustedAt: now, retestAt })
  }
  pool = pool.filter((e) => e.proxy !== proxyUrl)
}

function isDustbinned(proxyUrl) {
  return dustbin.some((d) => d.proxy === proxyUrl)
}

// --- user proxies ("my" free-tier proxies) + toggles + import ---------------
// Normalize a user-supplied proxy reference to a canonical http(s) URL,
// PRESERVING any user:pass credentials (authenticated pools, e.g.
// `user:pass@host:port` lines from a proxy.txt). Accepts bare `host:port`,
// `user:pass@host:port`, or a full URL; rejects anything without host+port.
export function normalizeProxyInput(input) {
  let s = String(input || '').trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    if (!/^(http:|https:)$/.test(u.protocol)) return null
    if (!u.hostname || !u.port) return null
    return u.href // keeps userinfo (user:pass) when present
  } catch {
    return null
  }
}

// Sanitize a proxy URL for display: mask the password, keep user + host:port.
export function maskProxy(url) {
  try {
    const u = new URL(String(url || ''))
    if (u.password) u.password = '••••'
    return u.href
  } catch {
    return String(url || '')
  }
}

// Import from either a plain string body (one proxy per line) or an array of
// proxy strings. Returns { added, invalid } where added are the pool entries.
export function importProxies(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/)
  const added = []
  const invalid = []
  for (const line of list) {
    const s = String(line).trim()
    if (!s || s.startsWith('#')) continue
    const norm = normalizeProxyInput(s)
    if (!norm) { invalid.push(s); continue }
    if (userProxies.includes(norm)) continue
    userProxies.push(norm)
    const e = upsertPool(norm, 'user')
    e.status = 'untested' // force a fresh verification on next sweep/relay
    added.push(e)
  }
  persist()
  return { added: added.length, addedEntries: added, invalid }
}

export function addUserProxy(input) {
  const r = importProxies([input])
  return r
}

// File import: read a local text file (one proxy per line; ip:port or
// http://ip:port; # lines and blanks ignored) and import it. The dashboard's
// file picker reads the file client-side and POSTs its contents to
// /__egress/import — this helper is for the shell: `node -e "import('./src/egress.js').then(m=>m.importProxiesFromFile('/path/to/list.txt'))"`.
export async function importProxiesFromFile(filePath) {
  const { readFileSync: rfs } = await import('node:fs')
  const text = rfs(filePath, 'utf8')
  const r = importProxies(text)
  console.log(`[egress] imported ${r.added} proxies from ${filePath} (${r.invalid.length} invalid lines)`)
  return r
}

export function removeUserProxy(proxy) {
  const p = normalizeProxyInput(proxy)
  if (!p) return { removed: false }
  userProxies = userProxies.filter((x) => x !== p)
  disabled.delete(p)
  persist()
  return { removed: true }
}

// Toggle a proxy's participation in rotation. Disabled proxies are never picked
// and never re-tested by sweeps; re-enabling marks it untested so it gets
// verified on demand.
export function toggleProxy(proxy) {
  const p = normalizeProxyInput(proxy)
  if (!p) return { enabled: null }
  let enabled
  if (disabled.has(p)) {
    disabled.delete(p)
    enabled = true
    const e = findPool(p) || upsertPool(p, userProxies.includes(p) ? 'user' : 'scrape')
    e.status = 'untested'
    // give it a chance immediately if it was dustbinned
    dustbin = dustbin.filter((d) => d.proxy !== p)
  } else {
    disabled.add(p)
    enabled = false
  }
  persist()
  return { enabled }
}

// Force a re-test of one proxy now (used by the dashboard "retest" button).
export async function retestProxy(proxy) {
  const p = normalizeProxyInput(proxy)
  if (!p) return { proxy: p, status: 'invalid' }
  const r = await testProxy(p)
  if (r.status === 'ok') {
    const e = upsertPool(r.proxy, userProxies.includes(p) ? 'user' : 'sweep')
    e.status = 'ok'
    e.ttfbMs = r.ttfbMs
    e.verifiedAt = Date.now()
    e.ok++
    dustbin = dustbin.filter((d) => d.proxy !== p)
  } else {
    dustbinProxy(p, r.status, { detail: r.detail, retryAfterSec: r.retryAfterSec })
  }
  persist()
  return r
}

function addCandidates(proxies, source) {
  let added = 0
  for (const p of proxies) {
    if (isDustbinned(p)) continue
    if (findPool(p)) continue
    if (pool.length >= POOL_MAX) break
    upsertPool(p, source)
    added++
  }
  return added
}

// --- sweep (parallel re-test) -------------------------------------------------
let sweeping = false
let lastSweep = null

export async function sweep({ size = SWEEP_CONCURRENCY, scrape = true } = {}) {
  if (sweeping) return { skipped: true }
  sweeping = true
  try {
    if (scrape) {
      const fresh = await scrapeSources()
      const added = addCandidates(fresh, 'scrape')
      if (added) console.log(`[egress] +${added} new candidates from web`)
    }
    // candidates: untested pool entries first, then stale "ok" entries that need
    // re-verification (keeps the best-IP ranking honest), then dustbin entries
    // whose retest time is due (dead ones get a second chance, quota ones after
    // the free-quota reset)
    const dueDust = dustbin.filter((d) => d.retestAt <= Date.now())
    const untested = pool.filter((e) => e.status === 'untested')
    const staleOk = pool
      .filter((e) => e.status === 'ok' && Date.now() - e.verifiedAt >= OK_REVERIFY_MS)
      .sort((a, b) => a.verifiedAt - b.verifiedAt)
    const targets = [
      ...untested.map((e) => e.proxy),
      ...staleOk.map((e) => e.proxy),
      ...dueDust.map((d) => d.proxy),
    ].slice(0, size)
    if (!targets.length) return { tested: 0 }

    let ok = 0, quota = 0, dead = 0, recovered = 0
    const results = await Promise.all(targets.map((p) => testProxy(p)))
    for (const r of results) {
      if (r.status === 'ok') {
        const wasDusted = isDustbinned(r.proxy) || pool.find((e) => e.proxy === r.proxy && e.status === 'ok')
        const e = upsertPool(r.proxy, 'sweep')
        e.status = 'ok'
        e.ttfbMs = r.ttfbMs
        e.verifiedAt = Date.now()
        e.ok++
        ok++
        if (wasDusted) {
          recovered++
          stats.recoveries++
          dustbin = dustbin.filter((d) => d.proxy !== r.proxy)
        }
      } else {
        dustbinProxy(r.proxy, r.status, { detail: r.detail, retryAfterSec: r.retryAfterSec })
        if (r.status === 'quota') quota++
        else dead++
      }
    }
    // trim pool: drop stale untested entries beyond the cap
    if (pool.length > POOL_MAX) pool = pool.slice(0, POOL_MAX)
    persist()
    lastSweep = { at: Date.now(), tested: targets.length, ok, quota, dead }
    if (ok || recovered) pushEvent('recovery', `${ok} verified ok, ${recovered} returned from dustbin`)
    if (dead) pushEvent('dead', `${dead} proxies dustbinned dead`)
    if (quota) pushEvent('quota', `${quota} proxies quota-exhausted (dustbinned until retry-after)`)
    console.log(`[egress] sweep: tested ${targets.length} → ok ${ok}, quota ${quota}, dead ${dead}`)
    return lastSweep
  } finally {
    sweeping = false
  }
}

// Fast rotation for the relay: when no verified proxy is available, inline-
// probe up to `quick` untested candidates right now (bounded, ~8s each) so a
// 429'd request rotates to fresh IPs immediately instead of waiting for the
// next background sweep. If the pool is fully exhausted (everything dead or
// quota-dusted), scrape the web on demand first so there is something to probe.
export async function ensureEgress({ quick = 3 } = {}) {
  if (!egressOn) return null // master switch forces direct
  const best = pickEgress()
  if (best) return best
  if (!pool.some((e) => e.status === 'untested' && !isDustbinned(e.proxy))) {
    const fresh = await scrapeSources().catch(() => [])
    const added = addCandidates(fresh, 'scrape')
    if (added) console.log(`[egress] fast-rotate: scraped +${added} fresh candidates on demand`)
  }
  // probe untested candidates in parallel (fast decisions); first ok wins
  const candidates = pool.filter((e) => e.status === 'untested' && !isDustbinned(e.proxy)).slice(0, quick)
  if (!candidates.length) { persist(); return pickEgress() }
  const results = await Promise.all(candidates.map((c) => testProxy(c.proxy).catch(() => ({ proxy: c.proxy, status: 'dead', detail: 'probe-threw' }))))
  const ok = results.find((r) => r.status === 'ok')
  const dead = results.filter((r) => r.status !== 'ok')
  const now = Date.now()
  for (const r of dead) {
    const e = upsertPool(r.proxy, 'quick')
    if (r.status === 'quota') dustbinProxy(r.proxy, 'quota', { retryAfterSec: r.retryAfterSec })
    else dustbinProxy(r.proxy, 'dead', { detail: r.detail })
  }
  if (ok) {
    const e = upsertPool(ok.proxy, 'quick')
    e.status = 'ok'
    e.ttfbMs = ok.ttfbMs
    e.verifiedAt = now
    e.ok++
    persist()
    console.log(`[egress] fast-rotate: ${ok.proxy} verified ok (${ok.ttfbMs}ms)`)
    return ok.proxy
  }
  persist()
  return pickEgress()
}

// Auto-import a local proxy file (one `user:pass@host:port` or `host:port`
// per line; # comments and blanks ignored). Runs once at startup so the
// operator's own pool is preferred from the first relay. Missing file is a
// no-op.
export async function importProxyFile(filePath = PROXY_FILE) {
  if (!filePath) return { imported: 0, missing: true }
  try {
    const { readFileSync: rfs, existsSync: xs } = await import('node:fs')
    if (!xs(filePath)) return { imported: 0, missing: true, path: filePath }
    const r = importProxies(rfs(filePath, 'utf8'))
    console.log(`[egress] imported ${r.added} proxies from ${filePath} (${r.invalid.length} invalid lines)`)
    return { imported: r.added, missing: false, path: filePath, invalid: r.invalid }
  } catch (e) {
    console.warn(`[egress] proxy file import failed (${filePath}): ${e?.message}`)
    return { imported: 0, missing: false, path: filePath, error: e?.message }
  }
}

export function startSweeper() {
  let timer = null
  const tick = async () => {
    // one-time: import the operator's own proxy file (EGRESS_PROXY_FILE) so
    // the preferred pool is in place before the first relay.
    if (!startSweeper._imported) {
      startSweeper._imported = true
      await importProxyFile()
    }
    const r = await sweep().catch((e) => {
      console.warn(`[egress] sweep error: ${e?.message}`)
      return null
    })
    // busy mode: no usable IP → tighten the loop to 20s; healthy → 180s
    const busy = r && r.ok === 0
    const delay = busy ? 20_000 : SWEEP_INTERVAL_MS
    if (timer && timer.unref) timer.unref()
    timer = setTimeout(() => tick(), delay)
    if (timer.unref) timer.unref()
  }
  setTimeout(tick, 2_000)
  console.log(`[egress] background sweeper running: base every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s (20s busy), ${SWEEP_CONCURRENCY} IPs in parallel`)
}

// --- selection ----------------------------------------------------------------
// Master switch toggle (persisted). `on=false` forces DIRECT connection for
// every relay turn — the pool is ignored entirely (pickEgress returns null).
export function setEgressOn(on) {
  egressOn = on !== false
  persist()
  return { egressOn }
}

export function egressOnState() {
  return egressOn
}

// Best usable proxy: verified-ok, not disabled, not dustbinned, and the master
// switch on. User-added ("my") proxies are preferred over scraped ones; among
// the rest, lowest ttfb. Returns null when nothing usable (caller falls back
// to the direct connection).
export function pickEgress() {
  if (!egressOn) return null // master switch: force direct
  const usable = pool
    .filter((e) => e.status === 'ok')
    .filter((e) => !isDustbinned(e.proxy))
    .filter((e) => !disabled.has(e.proxy))
    .sort((a, b) => {
      const au = userProxies.includes(a.proxy) ? 0 : 1
      const bu = userProxies.includes(b.proxy) ? 0 : 1
      if (au !== bu) return au - bu // user proxies first
      return (a.ttfbMs || 9e9) - (b.ttfbMs || 9e9)
    })
  return usable[0]?.proxy || null
}

// Called by the relay when a real request succeeded / failed on a proxy, so the
// pool reflects live reality between sweeps. Pure pool bookkeeping; stats are
// recorded separately by recordRequest().
export function reportEgress(proxyUrl, outcome, { retryAfterSec } = {}) {
  if (!proxyUrl) return
  if (outcome === 'ok') {
    const e = upsertPool(proxyUrl, 'relay')
    e.status = 'ok'
    e.verifiedAt = Date.now()
    e.ok++
    e.fail = 0
  } else if (outcome === 'quota') {
    pushEvent('rotation', maskProxy(proxyUrl) + ' quota-exhausted; rotating')
    dustbinProxy(proxyUrl, 'quota', { retryAfterSec })
  } else {
    const e = findPool(proxyUrl)
    if (e) e.fail++
    dustbinProxy(proxyUrl, 'dead', { detail: outcome })
  }
  persist()
}

// --- live stats (KPI tiles + sparklines for the dashboard) -------------------
const stats = {
  requests: 0,        // relay turns attempted through a proxy
  viaProxy: 0,       // turns that actually used a proxy
  directFallbacks: 0, // turns that fell back to the direct connection
  ok: 0,
  quota: 0,
  dead: 0,
  rotations: 0,       // egress→direct flips triggered by a 429
  recoveries: 0,      // quota-dusted IPs verified ok again on retest
  bytesIn: 0,
  bytesOut: 0,
  series: [],         // rolling { at, ok, quota, dead } for the sparkline
}
const SERIES_MAX = 240

// Rolling event ring for the dashboard "events" tab (sweeps, rotations,
// dustbin/recoveries, imports). Newest last.
const events = []
const EVENTS_MAX = 200
export function pushEvent(kind, detail) {
  events.push({ at: Date.now(), kind, detail: detail || '' })
  if (events.length > EVENTS_MAX) events.shift()
}

// Per-source scrape results for the "sources" strip ({ name, count, at }).
let scrapeStats = []

function recordEgress(outcome, origin) {
  if (outcome === 'ok') stats.ok++
  else if (outcome === 'quota') stats.quota++
  else stats.dead++
  if (origin === 'direct') stats.directFallbacks++
  else stats.viaProxy++
}

export function recordRequest({ viaProxy, outcome, rotated } = {}) {
  stats.requests++
  recordEgress(outcome || 'ok', viaProxy ? 'proxy' : 'direct')
  if (rotated || (viaProxy && outcome === 'quota')) stats.rotations++
  const now = Date.now()
  stats.series.push({ at: now, ok: stats.ok, quota: stats.quota, dead: stats.dead })
  if (stats.series.length > SERIES_MAX) stats.series.shift()
}

export function statsSnapshot() {
  return { ...stats, series: stats.series, events: events.slice(-80), scrapeStats }
}

// Record in/out byte volume for the "Data moved" KPI (call from the relay with
// the request + response body sizes).
export function recordBytes(inBytes = 0, outBytes = 0) {
  stats.bytesIn += Number(inBytes) || 0
  stats.bytesOut += Number(outBytes) || 0
}

export function egressState() {
  return {
    egressOn,
    poolSize: pool.length,
    ok: pool.filter((e) => e.status === 'ok').length,
    untested: pool.filter((e) => e.status === 'untested').length,
    dustbin: dustbin.length,
    dustbinQuota: dustbin.filter((d) => d.reason === 'quota').length,
    dustbinDead: dustbin.filter((d) => d.reason === 'dead').length,
    sweeping,
    lastSweep,
    best: pickEgress(),
    top: pool
      .filter((e) => e.status === 'ok')
      .sort((a, b) => (a.ttfbMs || 9e9) - (b.ttfbMs || 9e9))
      .slice(0, 5)
      .map((e) => ({ proxy: e.proxy, ttfbMs: e.ttfbMs, ok: e.ok, verifiedAt: e.verifiedAt })),
  }
}

// Complete state for the dashboard: every pool entry, user proxies, disabled
// set and the dustbin (capped for transport).
export function egressFullState() {
  const quotaEntries = dustbin.filter((d) => d.reason === 'quota')
  const nextQuotaReturn = quotaEntries.length ? Math.min(...quotaEntries.map((d) => d.retestAt)) : null
  return {
    ...egressState(),
    stats: statsSnapshot(),
    proxyFile: PROXY_FILE || null,
    nextQuotaReturn,
    pool: pool.map((e) => ({ ...e, mine: userProxies.includes(e.proxy) })),
    user: userProxies.map((p) => ({ proxy: p, disabled: disabled.has(p) })),
    disabled: [...disabled],
    dustbin: [...dustbin].sort((a, b) => a.retestAt - b.retestAt).slice(0, 500),
  }
}

// load on import so pickEgress works before the first sweep
loadState()
