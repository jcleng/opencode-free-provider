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
import { ProxyAgent } from 'undici'

import { getOpencodeBase, LITERAL_KEY } from './config.js'
import { getFingerprintHeaders } from './fingerprint.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const POOL_FILE = process.env.EGRESS_POOL_FILE || path.join(ROOT, 'egress-pool.json')
const DUSTBIN_FILE = process.env.EGRESS_DUSTBIN_FILE || path.join(ROOT, 'egress-dustbin.json')

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
// scraping SCRAPE_SOURCES is OFF by default (opt-in via EGRESS_SCRAPE_ENABLED=true/1);
// when off, the pool only uses entries already in egress-pool.json + direct egress
export const SCRAPE_ENABLED =
  process.env.EGRESS_SCRAPE_ENABLED === 'true' || process.env.EGRESS_SCRAPE_ENABLED === '1'

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
}

function persist() {
  if (saving) return
  saving = true
  try {
    writeFileSync(POOL_FILE, JSON.stringify({ savedAt: Date.now(), entries: pool }, null, 1) + '\n')
    writeFileSync(DUSTBIN_FILE, JSON.stringify({ savedAt: Date.now(), entries: dustbin }, null, 1) + '\n')
  } catch (e) {
    console.error(`[egress] persist failed: ${e?.message}`)
  } finally {
    saving = false
  }
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
    } catch (e) {
      console.warn(`[egress] scrape ${src.name} failed: ${e?.message}`)
    }
  }
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
    if (scrape && SCRAPE_ENABLED) {
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

    let ok = 0, quota = 0, dead = 0
    const results = await Promise.all(targets.map((p) => testProxy(p)))
    for (const r of results) {
      if (r.status === 'ok') {
        const e = upsertPool(r.proxy, 'sweep')
        e.status = 'ok'
        e.ttfbMs = r.ttfbMs
        e.verifiedAt = Date.now()
        e.ok++
        ok++
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
  const best = pickEgress()
  if (best) return best
  if (!SCRAPE_ENABLED) return best
  if (!pool.some((e) => e.status === 'untested' && !isDustbinned(e.proxy))) {
    const fresh = await scrapeSources().catch(() => [])
    const added = addCandidates(fresh, 'scrape')
    if (added) console.log(`[egress] fast-rotate: scraped +${added} fresh candidates on demand`)
  }
  let tried = 0
  while (tried < quick) {
    const candidate = pool.find((e) => e.status === 'untested' && !isDustbinned(e.proxy))
    if (!candidate) break
    tried++
    const r = await testProxy(candidate.proxy)
    if (r.status === 'ok') {
      const e = upsertPool(r.proxy, 'quick')
      e.status = 'ok'
      e.ttfbMs = r.ttfbMs
      e.verifiedAt = Date.now()
      e.ok++
      persist()
      console.log(`[egress] fast-rotate: ${r.proxy} verified ok (${r.ttfbMs}ms)`)
      return r.proxy
    }
    dustbinProxy(r.proxy, r.status, { detail: r.detail, retryAfterSec: r.retryAfterSec })
  }
  persist()
  return pickEgress()
}

export function startSweeper() {
  let timer = null
  const tick = async () => {
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
// Best usable proxy: verified-ok, lowest ttfb, not dustbinned. Returns null when
// the pool is empty (caller falls back to the direct connection).
export function pickEgress() {
  const now = Date.now()
  const usable = pool
    .filter((e) => e.status === 'ok')
    .filter((e) => !isDustbinned(e.proxy))
    .sort((a, b) => (a.ttfbMs || 9e9) - (b.ttfbMs || 9e9))
  return usable[0]?.proxy || null
}

// Called by the relay when a real request succeeded / failed on a proxy, so the
// pool reflects live reality between sweeps.
export function reportEgress(proxyUrl, outcome, { retryAfterSec } = {}) {
  if (!proxyUrl) return
  if (outcome === 'ok') {
    const e = upsertPool(proxyUrl, 'relay')
    e.status = 'ok'
    e.verifiedAt = Date.now()
    e.ok++
    e.fail = 0
  } else if (outcome === 'quota') {
    dustbinProxy(proxyUrl, 'quota', { retryAfterSec })
  } else {
    const e = findPool(proxyUrl)
    if (e) e.fail++
    dustbinProxy(proxyUrl, 'dead', { detail: outcome })
  }
  persist()
}

export function egressState() {
  return {
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

// load on import so pickEgress works before the first sweep
loadState()
