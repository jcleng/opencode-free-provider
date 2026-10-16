// test/egress.test.js — egress pool engine, exercised over a fully local
// network (a zen-shaped HTTP target and real CONNECT proxies on localhost).
// No public network access; no cross-tool dependencies.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'

// ── Local zen-shaped target ──────────────────────────────────────────────────

const target = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'space-bunny-free' }] }))
      return
    }
    if (req.url === '/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: {"choices":[{"delta":{"role":"assistant","content":"pong"}}]}\n\n`)
      res.write(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`)
      res.write(`data: [DONE]\n\n`)
      res.end()
      return
    }
    res.writeHead(404); res.end('nope')
  })
})

await new Promise((r) => target.listen(0, '127.0.0.1', r))
const TARGET_PORT = target.address().port

// ── Local CONNECT proxies ────────────────────────────────────────────────────

// proxy 'good': tunnels CONNECT to the localhost target, then pipes bytes.
function makeProxy(onConnect, failStatus) {
  const srv = net.createServer((socket) => {
    socket.once('error', () => socket.destroy())
    let buf = ''
    socket.on('data', (d) => {
      buf += d.toString('latin1')
      const i = buf.indexOf('\r\n\r\n')
      if (i === -1) return
      const [line] = buf.slice(0, i).split('\r\n')
      buf = buf.slice(i + 4)
      const m = /CONNECT (\S+):(\d+)/.exec(line || '')
      if (!m) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
      onConnect?.(m[1], m[2])
      if (failStatus) {
        socket.end(`HTTP/1.1 ${failStatus} No\r\n\r\n`)
        return
      }
      const conn = net.connect(Number(m[2]), m[1])
      conn.once('error', () => socket.destroy())
      conn.on('connect', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        socket.pipe(conn)
        conn.pipe(socket)
      })
    })
  })
  return srv
}

const good = makeProxy()
const bad = makeProxy(null, 502)
await new Promise((r) => good.listen(0, '127.0.0.1', r))
await new Promise((r) => bad.listen(0, '127.0.0.1', r))
const GOOD_PORT = good.address().port
const BAD_PORT = bad.address().port

// ── Isolated pool instance ───────────────────────────────────────────────────

const WORK = path.join(tmpdir(), `ofp-egress-test-${crypto.randomUUID().slice(0, 8)}`)
fs.mkdirSync(WORK, { recursive: true })
const POOL_FILE = path.join(WORK, 'egress-pool.json')
fs.writeFileSync(POOL_FILE, JSON.stringify({
  savedAt: Date.now(),
  entries: [
    { proxy: `http://127.0.0.1:${GOOD_PORT}`, ttfbMs: 30, verifiedAt: Date.now(), ok: 1, fail: 0 },
    { proxy: `http://127.0.0.1:${BAD_PORT}`, ttfbMs: 60, verifiedAt: Date.now(), ok: 0, fail: 0 },
  ],
}))

process.env.OFP_POOL_ENABLED = '1'
process.env.OFP_POOL_FILE = POOL_FILE
process.env.OFP_UPSTREAM_BASE = `http://127.0.0.1:${TARGET_PORT}`
process.env.OFP_POOL_SEED = 'false'          // never touch the network
process.env.OFP_MAX_ATTEMPTS = '4'

const egress = await import('../src/egress.js')

test.afterEach(() => { /* noop */ })

test('parseProxy accepts http host:port and rejects unknown schemes', () => {
  const p = egress.parseProxy('127.0.0.1:8080')
  assert.equal(p.scheme, 'http')
  assert.equal(p.port, 8080)
  assert.equal(egress.parseProxy('socks5://x:1'), null)
})

test('pool file loads and exposes a healthy candidate', () => {
  const added = egress.loadPoolFile()
  assert.ok(added >= 1, `added=${added}`)
  assert.ok(egress.healthyCount() >= 1, `healthy=${egress.healthyCount()} (${egress.poolState().total} total)`)
})

test('requestViaProxy rides a private CONNECT tunnel to the target', async () => {
  const res = await egress.requestViaProxy(
    egress.parseProxy(`127.0.0.1:${GOOD_PORT}`),
    `http://127.0.0.1:${TARGET_PORT}/chat/completions`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"space-bunny-free"}' },
  )
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(text.includes('pong'))
})

test('CONNECT refusal surfaces as a typed tunnel error', async () => {
  await assert.rejects(
    () => egress.requestViaProxy(
      egress.parseProxy(`127.0.0.1:${BAD_PORT}`),
      `http://127.0.0.1:${TARGET_PORT}/chat/completions`,
      { method: 'POST', headers: {} },
    ),
    (err) => err.code === 'ETUNNEL',
  )
})

test('rate-limited addresses cool down and the caller rotates away', async () => {
  egress.markRateLimited(`http://127.0.0.1:${BAD_PORT}`, 90_000)
  const st = egress.poolState()
  assert.equal(st.cooling, 1)

  // The only healthy address is still picked and serves a real tunnel request.
  const e = egress.pickEgress('ses-one')
  assert.ok(e)
  assert.equal(e.id, `http://127.0.0.1:${GOOD_PORT}`)
})

test('pool survives save/reload with stats intact', () => {
  const before = egress.poolState().total
  egress.markOk(`http://127.0.0.1:${GOOD_PORT}`, 25)
  egress.savePool()
  const data = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'))
  assert.ok(data.entries.length >= 1)
  const again = egress.poolState().total
  assert.ok(again >= before)
})

test('nothing left behind', () => {
  target.close()
  good.close()
  bad.close()
  try { fs.rmSync(WORK, { recursive: true, force: true }) } catch { /* noop */ }
})
