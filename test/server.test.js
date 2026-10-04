import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PROVIDER } from '../src/config.js'
import server, { start } from '../server.js'
let upstream
let lastUpstreamReq
let failWith
let upstreamPort

function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        lastUpstreamReq = { method: req.method, url: req.url, auth: req.headers['authorization'], ua: req.headers['user-agent'], body }
        if (failWith) {
          res.writeHead(failWith.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: failWith.error }))
          return
        }
        const parsed = JSON.parse(body || '{}')
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: { content: 'Hi' } }] }) + '\n\n')
          res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }) + '\n\n')
          res.write('data: [DONE]\n\n')
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: parsed.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }))
        }
        res.end()
      })
    })
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address()).port
      resolve()
    })
  })
}

let serverRef

before(async () => {
  await startUpstream()
  // OPENCODE_BASE is lazy (reads env per-request via getOpencodeBase), so we can
  // point the proxy at our fake upstream without re-importing.
  process.env.OPENCODE_BASE_OVERRIDE = `http://127.0.0.1:${upstreamPort}/v1`
  serverRef = server
  await new Promise((r) => serverRef.listen(0, '127.0.0.1', r))
})

after(() => {
  return new Promise((resolve) => {
    const closeUp = () => upstream.close(() => resolve())
    if (serverRef && serverRef.listening) serverRef.close(closeUp)
    else closeUp()
  })
})

function fetchProxy(path, opts = {}) {
  return fetch(`http://127.0.0.1:${serverRef.address().port}${path}`, opts)
}

test('/v1/models returns openai-style list', async () => {
  const res = await fetchProxy('/v1/models')
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.object, 'list')
  assert.ok(json.data.some((m) => m.id === `${PROVIDER}/big-pickle`))
})

test('/v1/models/:id for known model', async () => {
  const res = await fetchProxy(`/v1/models/${PROVIDER}/big-pickle`)
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.id, `${PROVIDER}/big-pickle`)
})

test('/v1/models/:id 404 for unknown', async () => {
  const res = await fetchProxy('/v1/models/nope')
  assert.equal(res.status, 404)
})

test('POST /v1/chat/completions (non-stream) proxies and forwards to upstream', async () => {
  const res = await fetchProxy('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `${PROVIDER}/big-pickle`, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.object, 'chat.completion')
  assert.equal(json.choices[0].message.content, 'Hi')
  assert.equal(lastUpstreamReq.auth, 'Bearer public')
  assert.equal(lastUpstreamReq.body.includes('big-pickle'), true)
})

test('POST /v1/chat/completions (stream) returns SSE ending with [DONE]', async () => {
  const res = await fetchProxy('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `${PROVIDER}/big-pickle`, messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const text = await res.text()
  assert.ok(text.includes('"content":"Hi"'))
  assert.ok(text.trimEnd().endsWith('data: [DONE]'))
})

test('unknown model returns 404', async () => {
  const res = await fetchProxy('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 404)
  const json = await res.json()
  assert.equal(json.error.code, 'model_not_found')
})

test('upstream 429 surfaces as rate-limit error', async () => {
  failWith = { status: 429, error: { message: 'rate limited' } }
  try {
    const res = await fetchProxy('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `${PROVIDER}/big-pickle`, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 429)
    const json = await res.json()
    assert.equal(json.error.code, 'RATE_LIMITED')
  } finally {
    failWith = null
  }
})

test('Health endpoint', async () => {
  const res = await fetchProxy('/')
  assert.equal(res.status, 200)
})
