// src/ipinfo.js
//
// Startup diagnostic: report the client (egress) IP and its geo/ASN metadata.
//
// WHY THIS EXISTS
// ---------------
// The relay talks to the free tier from THIS host's egress IP, and the free
// tier's behaviour (quota, 429s) is partly tied to that IP. When the relay runs
// behind a corporate/NAT/cloud egress, knowing where the requests actually
// originate from makes "why is upstream rejecting/slowing us" much easier to
// debug. So on startup we ask https://ipinfo.io/json (no token → the free,
// missingauth response) and print it to the console.
//
// Design notes:
//   - Never fatal: a slow/blocked network must not prevent the relay from
//     starting, so the lookup is fire-and-forget with a hard timeout and every
//     error is only logged as a warning.
//   - Disable with IPINFO_DISABLED=1 (e.g. in CI or air-gapped deployments).
//   - Override the endpoint with IPINFO_URL (used by tests / self-hosted mirror).

export const DEFAULT_IPINFO_URL = 'https://ipinfo.io/json'
export const DEFAULT_IPINFO_TIMEOUT_MS = 5000

/** The endpoint to query (env-overridable). */
export function ipinfoUrl() {
  const configured = process.env.IPINFO_URL
  return typeof configured === 'string' && configured.length > 0 ? configured : DEFAULT_IPINFO_URL
}

/** False when IPINFO_DISABLED=1 (or true/yes/on). */
export function ipinfoEnabled() {
  const value = String(process.env.IPINFO_DISABLED ?? '').trim().toLowerCase()
  return !(value === '1' || value === 'true' || value === 'yes' || value === 'on')
}

/** Timeout for the lookup, in ms (IPINFO_TIMEOUT_MS, default 5000). */
export function ipinfoTimeoutMs() {
  const configured = Number(process.env.IPINFO_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IPINFO_TIMEOUT_MS
}

const FIELDS = ['ip', 'city', 'region', 'country', 'loc', 'org', 'postal', 'timezone']

/**
 * Fetch the caller's IP info. Resolves to the parsed object (the raw upstream
 * shape: ip/city/region/country/loc/org/postal/timezone) or null when the
 * lookup is disabled. Rejects on network/HTTP/JSON errors — callers decide.
 */
export async function fetchIpinfo({ url = ipinfoUrl(), timeoutMs = ipinfoTimeoutMs(), signal } = {}) {
  if (!ipinfoEnabled()) return null
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'opencode-free-provider' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) throw new Error(`ipinfo returned HTTP ${res.status}`)
  return await res.json()
}

/** One-line human summary of an ipinfo payload. */
export function formatIpinfo(info) {
  if (!info || typeof info !== 'object') return 'unknown'
  const parts = []
  const where = [info.city, info.region, info.country].filter(Boolean).join(', ')
  if (where) parts.push(where)
  if (info.org) parts.push(info.org)
  if (info.timezone) parts.push(info.timezone)
  return parts.length ? parts.join(' | ') : 'unknown'
}

/**
 * Fire-and-forget startup log: prints the client IP info to the console.
 * Never throws; failures are logged as a warning and the relay keeps starting.
 */
export async function logClientIpInfo({ log = console.log, warn = console.warn } = {}) {
  if (!ipinfoEnabled()) {
    log('[opencode-free-provider] client ip info: disabled (IPINFO_DISABLED)')
    return null
  }
  try {
    const info = await fetchIpinfo()
    if (!info) return null
    log(`[opencode-free-provider] client ip info (${ipinfoUrl()}): ${JSON.stringify(info)}`)
    log(`[opencode-free-provider] client ip summary: ip=${info.ip || '?'} — ${formatIpinfo(info)}`)
    return info
  } catch (err) {
    warn(`[opencode-free-provider] client ip lookup failed: ${err && err.message ? err.message : err}`)
    return null
  }
}

export { FIELDS }
