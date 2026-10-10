// dsh-opencode-free-models style: shared literal key "public" — no login, no key needed.
export const LITERAL_KEY = 'public'

// OpenCode Zen free tier base (official free endpoint, accepts Bearer public).
// Lazy getter so env overrides (e.g. OPENCODE_BASE_OVERRIDE for tests) take effect
// even when config.js is already module-cached.
export const getOpencodeBase = () =>
  process.env.OPENCODE_BASE_OVERRIDE || 'https://opencode.ai/zen/v1'

// Mimic the official opencode client UA. The free-tier gateway rejects anything
// that is not an `opencode/<version>` UA with version >= 1.18 (too-old UAs get
// 426, non-opencode UAs get 403 FreeTierError). The version string MUST stay
// >= 1.18 and start with a lowercase `opencode/`.
export const OPENCODE_UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

// Extra fingerprint headers the upstream free-tier gateway requires. Without a
// valid `x-opencode-session` (ses_<12 hex><14 hex>) AND a body that contains
// the four agent tools (bash/glob/grep/read) it returns 403 FreeTierError.
export const OPENCODE_CLIENT = 'cli'
export const OPENCODE_PROJECT = 'global'

// Default provider name advertised by /v1/models (OpenAI-style id === "provider/model").
export const PROVIDER = 'opencode-free'

export const DEFAULT_PORT = 8791
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_MAX_TOKENS = 128000
export const DEFAULT_CONTEXT_WINDOW = 200000
export const MAX_REQUEST_ATTEMPTS = 2

// ---------------------------------------------------------------------------
// Session / request fingerprint generation
// ---------------------------------------------------------------------------
// The upstream free tier only accepts `x-opencode-session` values of the form
//   ses_ + 12 hex chars + 14 hex chars   (26 chars total)
// UUID-formatted values are rejected (403). We generate exactly that shape.
import crypto from 'node:crypto'

// session mode: 'per-request' (fresh ses_ every call, default & safest) or
// 'sticky' (one session reused for the whole process; optional rotation).
// Mirrors the reference zen_relay.py knobs.
export const ZEN_SESSION_MODE =
  process.env.ZEN_SESSION_MODE === 'sticky' ? 'sticky' : 'per-request'
export const ZEN_SESSION_ROTATE_SECONDS = Number(process.env.ZEN_SESSION_ROTATE_SECONDS) || 0

function randomHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n)
}

export function newSessionId() {
  // ses_ + 12 hex + 14 hex == 26 chars (matches upstream expectation)
  return `ses_${randomHex(12)}${randomHex(14)}`
}

export function newRequestId() {
  return `msg_${randomHex(12)}${randomHex(14).toUpperCase()}`
}

// Process-wide sticky session state (only used when ZEN_SESSION_MODE === 'sticky').
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

// ---------------------------------------------------------------------------
// Mandatory tool "fingerprint"
// ---------------------------------------------------------------------------
// The upstream free tier rejects (403) any chat/completions body whose `tools`
// does not contain ALL of bash / glob / grep / read. We always include them
// (appending when the caller's tool list is missing any of them).
export const ZEN_FREE_TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'bash', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
  { type: 'function', function: { name: 'glob', description: 'glob', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
  { type: 'function', function: { name: 'grep', description: 'grep', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
  { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } } },
]

// The set of tool names the upstream gate forces us to advertise. Used to decide
// whether a tool_call the model emits must be executed server-side (when the
// calling agent does not register that exact name).
export const FINGERPRINT_TOOL_NAMES = new Set(ZEN_FREE_TOOLS.map((t) => t.function.name))
export function isFingerprintTool(name) {
  return FINGERPRINT_TOOL_NAMES.has(name)
}

// ---------------------------------------------------------------------------
// Model registry — discovered live from the upstream /models endpoint
// ---------------------------------------------------------------------------
// The upstream list is the source of truth. We query
//
//   GET {getOpencodeBase()}/models      (no auth needed; Bearer public sent anyway)
//
// and keep only the ids that look like free-tier models: an id is kept when it
// contains `big-pickle` OR contains `-free`. Everything else (claude-*, gpt-*,
// gemini-*, grok-*, …) is filtered out because the free gateway rejects it.
//
// The filtered list is cached (TTL below) so the hot paths (`/v1/models`, chat
// routing) stay synchronous and work offline. If the upstream call fails we fall
// back to the last good list, and to DEFAULT_MODELS before the first success —
// the proxy still runs, and the upstream per-request fingerprint gate remains
// the real authority on whether a given model is usable.

export const DEFAULT_MODELS = [
  { id: 'big-pickle', name: 'Big Pickle (Free)', contextWindow: DEFAULT_CONTEXT_WINDOW, description: 'OpenCode Zen 免费档' },
]

// Kept when: id mentions `big-pickle` or contains `-free`.
export const MODEL_ID_FILTER = (id) =>
  typeof id === 'string' && (id.includes('big-pickle') || id.includes('-free'))

// Cache TTL for the discovered model list (seconds). 0 disables expiry.
export const ZEN_MODELS_TTL_SECONDS = Number.isFinite(Number(process.env.ZEN_MODELS_TTL_SECONDS))
  ? Number(process.env.ZEN_MODELS_TTL_SECONDS)
  : 600
export const ZEN_MODELS_TIMEOUT_MS = Number(process.env.ZEN_MODELS_TIMEOUT_MS) || 5000

// Normalize one upstream entry ({ id, object, created, owned_by }) into the
// local registry shape used by src/models.js.
export function normalizeModel(entry) {
  const id = typeof entry === 'string' ? entry : entry && entry.id
  if (!MODEL_ID_FILTER(id)) return null
  return {
    id,
    name: (entry && entry.name) || id,
    contextWindow: (entry && (entry.context_window || entry.contextWindow)) || DEFAULT_CONTEXT_WINDOW,
    description: `OpenCode Zen 免费档 (${id})`,
  }
}

// Filter + normalize a raw upstream payload (or a bare array of ids).
export function filterModels(payload) {
  const data = Array.isArray(payload) ? payload : (payload && payload.data) || []
  const out = []
  const seen = new Set()
  for (const entry of data) {
    const model = normalizeModel(entry)
    if (model && !seen.has(model.id)) {
      seen.add(model.id)
      out.push(model)
    }
  }
  return out
}

let _models = DEFAULT_MODELS
let _modelsAt = 0
let _modelsSource = 'default'
let _modelsError = null
let _modelsInFlight = null

// Synchronous accessor used by the request paths. Never throws.
export function getModels() {
  return _models
}

export function modelsCacheState() {
  return {
    source: _modelsSource,
    count: _models.length,
    ids: _models.map((m) => m.id),
    fetchedAt: _modelsAt || null,
    ageSeconds: _modelsAt ? Math.round((Date.now() - _modelsAt) / 1000) : null,
    ttlSeconds: ZEN_MODELS_TTL_SECONDS || null,
    stale: isModelsCacheStale(),
    error: _modelsError,
  }
}

export function isModelsCacheStale() {
  if (!_modelsAt) return true
  if (!ZEN_MODELS_TTL_SECONDS) return false
  return (Date.now() - _modelsAt) / 1000 >= ZEN_MODELS_TTL_SECONDS
}

// Query the upstream /models endpoint and refresh the cache. On failure the
// previous list (or DEFAULT_MODELS) is kept and the error is recorded.
// Concurrent callers share one in-flight request.
export async function refreshModels({ timeoutMs = ZEN_MODELS_TIMEOUT_MS, signal } = {}) {
  if (_modelsInFlight) return _modelsInFlight
  _modelsInFlight = (async () => {
    const url = `${getOpencodeBase().replace(/\/$/, '')}/models`
    const timeout = AbortSignal.timeout(timeoutMs)
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': OPENCODE_UA,
        Authorization: `Bearer ${process.env.OPENCODE_ZEN_API_KEY || LITERAL_KEY}`,
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!res.ok) throw new Error(`upstream /models returned HTTP ${res.status}`)
    const payload = await res.json()
    const models = filterModels(payload)
    if (!models.length) throw new Error('upstream /models returned no free-tier models')
    _models = models
    _modelsAt = Date.now()
    _modelsSource = 'upstream'
    _modelsError = null
    return _models
  })()
  try {
    return await _modelsInFlight
  } catch (err) {
    _modelsError = err && err.message ? err.message : String(err)
    return _models
  } finally {
    _modelsInFlight = null
  }
}

// Refresh only when the cache is stale (or `force`). Errors are swallowed;
// the caller always gets a usable list.
export async function ensureModels({ force = false, timeoutMs } = {}) {
  if (force || isModelsCacheStale()) await refreshModels({ timeoutMs })
  return _models
}
