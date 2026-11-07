// src/fingerprint.js
//
// Pure-JS OpenCode fingerprint generator — NO CLI, NO MITM, NO child_process.
//
// WHY THIS EXISTS
// ---------------
// OpenCode's free tier (opencode.ai/zen/v1) enforces a client-fingerprint gate.
// A bare request is rejected with:
//
//   403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
//
// The gate requires:
//   - `User-Agent`          : `opencode/<version>`, version >= 1.18 (older → 426)
//   - `x-opencode-session`  : a session id in the exact shape opencode emits
//   - body `stream:true`    : false → 403
//   - body `tools`          : must contain bash/glob/grep/read (exactly once each)
//
// HOW THE SESSION ID IS VALIDATED (reverse-engineered 2026-04, live ablation)
// -------------------------------------------------------------------------
// opencode mints session ids with `SessionID.create()`:
//
//     "ses_" + descending()
//
// and `descending()` (packages/schema/src/identifier.ts) is:
//
//     counter++                       // per-millisecond counter, resets each ms
//     current = BigInt(Date.now()) * 0x1000n + BigInt(counter)
//     value   = ~current              // 48-bit two's complement
//     hex     = 6 bytes of `value`    // == 12 lowercase hex chars
//     tail    = 14 random base62 chars (charset 0-9A-Za-z)
//
// so a real id is `ses_` + 12 lowercase hex + 14 base62 (30 chars total).
//
// The server does NOT verify a cryptographic checksum. It validates the *shape*
// and, decisively, the low 12 bits of the 48-bit hex value — which is the
// counter field of `~(ts * 0x1000 + counter)`, i.e.
//
//     low12 = 0xfff - counter
//
// Live ablation pinned the rule to: **counter must be <= 63** (low12 >= 0xfc0).
// counter 0..63 → 200; counter 64..4095 → 403. Everything else (timestamp
// magnitude/recency, the higher 36 bits, and the 14-char tail's charset) is NOT
// validated: only the tail *length* (exactly 14) and the first 12 chars being
// lowercase hex matter. Emitting opencode's real algorithm with
// `Date.now()` and a small counter therefore always passes.
//
// This means the fingerprint is fully reproducible in pure JavaScript and the
// proxy no longer needs to install or spawn the real `opencode` binary.

import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Identifier generation (mirrors opencode's packages/schema/src/identifier.ts)
// ---------------------------------------------------------------------------

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const TAIL_LENGTH = 14 // == opencode's `length (26) - 12`
const MASK_48 = (1n << 48n) - 1n
const COUNTER_SPAN = 0x1000n // opencode packs the counter into the low 12 bits

// The largest counter the free-tier gate accepts: counter <= 63 (low12 >= 0xfc0).
export const MAX_COUNTER = 63

let lastTimestamp = 0
let counter = 0

function randomBase62(n) {
  const bytes = randomBytes(n)
  let out = ''
  for (let i = 0; i < n; i++) out += CHARS[bytes[i] % 62]
  return out
}

/**
 * Encode an identifier exactly like opencode's `ascending()`/`descending()`.
 * Returns 12 lowercase hex chars + 14 base62 chars (26 chars, no prefix).
 *
 * `counter` is shared across ascending/descending calls, matching opencode. If
 * more than MAX_COUNTER ids are minted within one millisecond we roll over to
 * the next millisecond rather than emit a counter the gate would reject.
 */
export function encodeIdentifier(timestamp = Date.now(), { descending = true } = {}) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  if (counter > MAX_COUNTER) {
    lastTimestamp += 1
    counter = 1
  }
  const current = BigInt(lastTimestamp) * COUNTER_SPAN + BigInt(counter)
  const value = (descending ? ~current : current) & MASK_48
  return value.toString(16).padStart(12, '0') + randomBase62(TAIL_LENGTH)
}

/** A fresh `ses_…` session id (descending, like opencode's SessionID.create()). */
export function newSessionId() {
  return `ses_${encodeIdentifier(Date.now(), { descending: true })}`
}

/** A fresh `msg_…` message id (ascending, like opencode's SessionMessage.ID.create()). */
export function newMessageId() {
  return `msg_${encodeIdentifier(Date.now(), { descending: false })}`
}

/** Back-compat alias: the id sent as `x-opencode-request`. */
export function newRequestId() {
  return newMessageId()
}

// ---------------------------------------------------------------------------
// Session mode (per-request vs sticky)
// ---------------------------------------------------------------------------
// 'per-request' (default, safest): a fresh ses_ id on every upstream call.
// 'sticky': one session reused for the whole process (optionally rotated).
export const ZEN_SESSION_MODE =
  process.env.ZEN_SESSION_MODE === 'sticky' ? 'sticky' : 'per-request'
export const ZEN_SESSION_ROTATE_SECONDS = Number(process.env.ZEN_SESSION_ROTATE_SECONDS) || 0

let _stickySession = null
let _stickyBorn = 0
let _rotations = 0

export function currentSession() {
  if (ZEN_SESSION_MODE !== 'sticky') return newSessionId()
  const now = Date.now()
  if (!_stickySession) {
    _stickySession = newSessionId()
    _stickyBorn = now
    return _stickySession
  }
  if (ZEN_SESSION_ROTATE_SECONDS > 0 && (now - _stickyBorn) / 1000 >= ZEN_SESSION_ROTATE_SECONDS) {
    _stickySession = newSessionId()
    _stickyBorn = now
    _rotations += 1
  }
  return _stickySession
}

export function sessionState() {
  return {
    mode: ZEN_SESSION_MODE,
    session: ZEN_SESSION_MODE === 'sticky' ? _stickySession : null,
    rotateSeconds: ZEN_SESSION_ROTATE_SECONDS || null,
    rotations: ZEN_SESSION_MODE === 'sticky' ? _rotations : 0,
    uptimeSeconds: null,
  }
}

/**
 * Force-rotate the session identity immediately. Called by upstream.js every
 * time the relay rotates egress on a quota/transport hit, so the new egress IP
 * is paired with a brand-new opencode session (never reuse a session that the
 * previous IP already carried). No-op in 'per-request' mode, which already
 * mints a fresh ses_ id on every currentSession() call.
 *
 * The User-Agent is deliberately NOT rotated: the gate pins `opencode/<ver>`
 * and a floor of >= 1.18, so the UA stays stable (override with OPENCODE_UA if
 * upstream raises the floor). Rotating identity here = session + per-attempt
 * request id; rotating egress = the IP.
 */
export function rotateSession() {
  if (ZEN_SESSION_MODE !== 'sticky') return null
  _stickySession = newSessionId()
  _stickyBorn = Date.now()
  _rotations += 1
  return _stickySession
}

// ---------------------------------------------------------------------------
// Fingerprint headers
// ---------------------------------------------------------------------------

// Mimic the official opencode client UA. The gate rejects anything that is not
// an `opencode/<version>` UA, and requires version >= 1.18 (older → 426).
// Override with OPENCODE_UA if upstream raises the floor.
export const OPENCODE_UA = process.env.OPENCODE_UA || 'opencode/latest/2.0.22/cli'
export const OPENCODE_CLIENT = 'cli'
export const OPENCODE_PROJECT = 'global'

/**
 * Build a complete, gate-valid fingerprint header set.
 *
 * Emits the same header group the real opencode sends for its own provider
 * (`opencode/*` models): user-agent, x-opencode-session, x-opencode-session-id,
 * x-opencode-request, x-opencode-client, x-opencode-project. Note
 * x-opencode-session-id MUST equal x-opencode-session when present (a mismatch
 * → 403), which is exactly what opencode does.
 *
 * `authorization` is intentionally omitted here; src/upstream.js adds the
 * resolved `Authorization` header so the literal key / env override is applied
 * in one place.
 */
export function buildFingerprintHeaders(session = currentSession()) {
  return {
    'content-type': 'application/json',
    'user-agent': OPENCODE_UA,
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-opencode-request': newMessageId(),
    'x-opencode-client': OPENCODE_CLIENT,
    'x-opencode-project': OPENCODE_PROJECT,
  }
}

// Static last-known-good shape (used only for /__session introspection and by
// callers that need a synchronous header object before the first request).
export const FALLBACK_FP_HEADERS = buildFingerprintHeaders()

let _cache = null
let _cacheAt = 0

/** Return the current fingerprint ({ headers, session, source }). */
export async function getFingerprint() {
  const session = currentSession()
  _cache = { headers: buildFingerprintHeaders(session), session, source: 'generated' }
  _cacheAt = Date.now()
  return _cache
}

/** Synchronous fingerprint access (generation is pure and cheap). */
export function peekFingerprint() {
  return _cache || { headers: FALLBACK_FP_HEADERS, session: FALLBACK_FP_HEADERS['x-opencode-session'], source: 'generated' }
}

export async function getFingerprintHeaders() {
  return (await getFingerprint()).headers
}

export function peekFingerprintHeaders() {
  return peekFingerprint().headers
}

export function fingerprintState() {
  return {
    cached: !!_cache,
    source: _cache?.source || 'generated',
    session: _cache?.session || null,
    ageMs: _cache ? Date.now() - _cacheAt : null,
    ttlMs: null,
    mode: ZEN_SESSION_MODE,
  }
}
