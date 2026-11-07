import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Files/modules
// -------------
// PROVE two things end-to-end against local fake servers (no real network):
//   1. A quota-hit on the egress IP rotates the IP AND re-mints the opencode
//      identity: the next upstream attempt carries a NEW x-opencode-session
//      (and a new x-opencode-request id) instead of the one the previous IP
//      already used.
//   2. rotateSession() is a documented no-op in 'per-request' mode.
//
// Layout: a fake upstream server (OPENCODE_BASE_OVERRIDE) + a fake HTTP proxy
// registered in an env-overridden egress pool. Attempt 1 goes THROUGH the
// proxy (which answers 429 RateLimitError — generic, retryable → rotation
// path); attempt 2 rotates: pool = 1 entry now dustbinned → pickEgress null →
// DIRECT to the fake upstream which answers 200 SSE.

process.env.EGRESS_POOL_FILE = join(mkdtempSync(join(tmpdir(), 'egress-id-rot-')), 'pool.json')
process.env.EGRESS_DUSTBIN_FILE = join(process.env.EGRESS_POOL_FILE, '..', 'dustbin.json')
process.env.EGRESS_USER_FILE = join(process.env.EGRESS_POOL_FILE, '..', 'user.json')

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

function emitFinal(res, text, session) {
  emitFinal.session = session
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  sse(res, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta: { content: text } }] })
  sse(res, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  sse(res, '[DONE]')
  res.end()
}

let upstream, proxy
let upstreamSessions = []
let proxySessions = []
let proxyHits = 0

before(async () => {
  // Fake upstream: plain http target reachable both directly and via env base.
  await new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        upstreamSessions.push(String(req.headers['x-opencode-session'] || ''))
        emitFinal(res, 'ok-after-rotation', req.headers['x-opencode-session'])
      })
    })
    upstream.listen(0, '127.0.0.1', resolve)
  })
  const upstreamPort = upstream.address().port
  process.env.OPENCODE_BASE_OVERRIDE = `http://127.0.0.1:${upstreamPort}`

  // Fake HTTP proxy: request 1 → generic 429 (retryable → rotation path);
  // request 2 would never arrive here (the pool now has nothing else usable,
  // so attempt 2 goes DIRECT to the fake upstream).
  await new Promise((resolve) => {
    proxy = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        proxyHits++
        proxySessions.push(String(req.headers['x-opencode-session'] || ''))
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'RateLimitError', message: 'slow down' } }))
      })
    })
    proxy.listen(0, '127.0.0.1', resolve)
  })

  // Seed an env-overridden pool with exactly one verified-ok entry: the fake
  // proxy. egress state loads lazily on first use, so writing the file here is
  // early enough as long as no prior test in this file touched egress.
  writeFileSync(process.env.EGRESS_POOL_FILE, JSON.stringify({
    savedAt: Date.now(),
    entries: [
      { proxy: `http://127.0.0.1:${proxy.address().port}`, status: 'ok', ttfbMs: 1, verifiedAt: Date.now(), ok: 1, fail: 0, source: 'pool' },
    ],
  }, null, 2))

  // Dynamic import so the env above is in place before egress binds paths and
  // before quota state exists.
  ;({ relayChatCompletions, resetQuotaState, quotaState } = await import('../src/upstream.js'))
  ;({ egressState, egressFullState } = await import('../src/egress.js'))
})

let relayChatCompletions, resetQuotaState, quotaState, egressState, egressFullState

after(() => {
  upstream?.close()
  proxy?.close()
})

const SES_PREFIX_OK = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

test('proxy quota-hit rotates IP and session identity; retry succeeds direct', async () => {
  resetQuotaState()
  assert.ok(egressState().egressOn === true, 'egress on by default')

  const completion = await (async () => {
    let out = null
    for await (const obj of relayChatCompletions({
      model: 'opencode-free/big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      systemEnv: null,
    })) {
      out = obj
    }
    return out
  })()
  assert.equal(completion.choices[0].finish_reason, 'stop')
  assert.equal(completion.choices[0].message.content, 'ok-after-rotation')

  // Exactly one attempt through the proxy...
  assert.equal(proxyHits, 1)
  assert.match(proxySessions[0], SES_PREFIX_OK)
  // ...then a direct retry with a DIFFERENT session identity.
  assert.equal(upstreamSessions.length, 1)
  assert.match(upstreamSessions[0], SES_PREFIX_OK)
  assert.notEqual(upstreamSessions[0], proxySessions[0])

  // The used proxy was dustbinned as 'quota' and the turn recorded as a rotation.
  const st = egressFullState().stats
  assert.equal(st.viaProxy, 1)
  assert.equal(st.quota, 1)
  assert.equal(st.rotations, 1)
  assert.equal(st.directFallbacks, 1)
  const st2 = egressState()
  assert.equal(st2.dustbinQuota >= 1, true, 'the rate-limited proxy must be dustbinned with reason quota')
})

test('rotateSession() is a no-op in per-request mode', async () => {
  const { rotateSession, sessionState, currentSession } = await import('../src/fingerprint.js')
  if (sessionState().mode === 'sticky') return // suite runs per-request by default
  const before = currentSession()
  assert.equal(rotateSession(), null)
  // per-request mints fresh ids anyway; the call must not crash or leak state
  assert.match(currentSession(), SES_PREFIX_OK)
})
