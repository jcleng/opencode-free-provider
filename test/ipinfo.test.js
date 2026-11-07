import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  ipinfoEnabled,
  ipinfoUrl,
  ipinfoTimeoutMs,
  fetchIpinfo,
  formatIpinfo,
  logClientIpInfo,
  DEFAULT_IPINFO_URL,
} from '../src/ipinfo.js'

const SAMPLE = {
  ip: '111.10.182.15',
  city: 'Chongqing',
  region: 'Chongqing',
  country: 'CN',
  loc: '29.5603,106.5577',
  org: 'AS9808 China Mobile Communications Group Co., Ltd.',
  postal: '401100',
  timezone: 'Asia/Shanghai',
  readme: 'https://ipinfo.io/missingauth',
}

let upstream
let upstreamPort
let lastUrl

before(async () => {
  upstream = http.createServer((req, res) => {
    lastUrl = req.url
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(SAMPLE))
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = upstream.address().port
})

after(() => new Promise((r) => upstream.close(() => r())))

test('ipinfoEnabled: default on, IPINFO_DISABLED=1 turns it off', () => {
  const saved = process.env.IPINFO_DISABLED
  delete process.env.IPINFO_DISABLED
  assert.equal(ipinfoEnabled(), true)
  for (const v of ['1', 'true', 'YES', 'on']) {
    process.env.IPINFO_DISABLED = v
    assert.equal(ipinfoEnabled(), false, `IPINFO_DISABLED=${v}`)
  }
  process.env.IPINFO_DISABLED = '0'
  assert.equal(ipinfoEnabled(), true)
  if (saved === undefined) delete process.env.IPINFO_DISABLED
  else process.env.IPINFO_DISABLED = saved
})

test('ipinfoUrl / ipinfoTimeoutMs honour env overrides', () => {
  const savedUrl = process.env.IPINFO_URL
  const savedTimeout = process.env.IPINFO_TIMEOUT_MS
  delete process.env.IPINFO_URL
  delete process.env.IPINFO_TIMEOUT_MS
  assert.equal(ipinfoUrl(), DEFAULT_IPINFO_URL)
  assert.equal(ipinfoTimeoutMs(), 5000)
  process.env.IPINFO_URL = 'http://example.test/json'
  process.env.IPINFO_TIMEOUT_MS = '1234'
  assert.equal(ipinfoUrl(), 'http://example.test/json')
  assert.equal(ipinfoTimeoutMs(), 1234)
  process.env.IPINFO_TIMEOUT_MS = 'nope'
  assert.equal(ipinfoTimeoutMs(), 5000)
  if (savedUrl === undefined) delete process.env.IPINFO_URL
  else process.env.IPINFO_URL = savedUrl
  if (savedTimeout === undefined) delete process.env.IPINFO_TIMEOUT_MS
  else process.env.IPINFO_TIMEOUT_MS = savedTimeout
})

test('fetchIpinfo returns the raw response structure', async () => {
  const info = await fetchIpinfo({ url: `http://127.0.0.1:${upstreamPort}/json` })
  assert.deepEqual(info, SAMPLE)
  assert.equal(lastUrl, '/json')
})

test('fetchIpinfo returns null when disabled', async () => {
  const saved = process.env.IPINFO_DISABLED
  process.env.IPINFO_DISABLED = '1'
  assert.equal(await fetchIpinfo({ url: `http://127.0.0.1:${upstreamPort}/json` }), null)
  if (saved === undefined) delete process.env.IPINFO_DISABLED
  else process.env.IPINFO_DISABLED = saved
})

test('fetchIpinfo rejects on a non-2xx response', async () => {
  const failServer = http.createServer((req, res) => {
    res.writeHead(502)
    res.end('bad gateway')
  })
  await new Promise((r) => failServer.listen(0, '127.0.0.1', r))
  const port = failServer.address().port
  try {
    await assert.rejects(() => fetchIpinfo({ url: `http://127.0.0.1:${port}/json` }), /HTTP 502/)
  } finally {
    await new Promise((r) => failServer.close(() => r()))
  }
})

test('formatIpinfo renders a compact summary', () => {
  const line = formatIpinfo(SAMPLE)
  assert.match(line, /Chongqing, Chongqing, CN/)
  assert.match(line, /AS9808/)
  assert.match(line, /Asia\/Shanghai/)
  assert.equal(formatIpinfo(null), 'unknown')
})

test('logClientIpInfo prints the JSON response and never throws on failure', async () => {
  const logLines = []
  const warnLines = []
  const info = await logClientIpInfo.call(null, {
    log: (m) => logLines.push(m),
    warn: (m) => warnLines.push(m),
  })
  // Real network is unavailable/unreliable in CI: either we get the payload
  // logged, or a warning — in both cases nothing throws and nothing is silent.
  assert.ok(logLines.length + warnLines.length >= 1)
  if (info) {
    assert.ok(logLines.some((l) => l.includes('"ip"')), 'logs the raw JSON response')
    assert.ok(logLines.some((l) => l.includes('client ip summary')))
  }
})

test('logClientIpInfo fetches from IPINFO_URL and logs the structure', async () => {
  const savedUrl = process.env.IPINFO_URL
  const savedDisabled = process.env.IPINFO_DISABLED
  process.env.IPINFO_URL = `http://127.0.0.1:${upstreamPort}/json`
  delete process.env.IPINFO_DISABLED
  const logLines = []
  try {
    const info = await logClientIpInfo({ log: (m) => logLines.push(m), warn: (m) => logLines.push(`WARN ${m}`) })
    assert.equal(info.ip, SAMPLE.ip)
    assert.ok(logLines.some((l) => l.includes(JSON.stringify(SAMPLE))), 'prints the raw response')
  } finally {
    if (savedUrl === undefined) delete process.env.IPINFO_URL
    else process.env.IPINFO_URL = savedUrl
    if (savedDisabled === undefined) delete process.env.IPINFO_DISABLED
    else process.env.IPINFO_DISABLED = savedDisabled
  }
})

test('logClientIpInfo reports disabled state', async () => {
  const saved = process.env.IPINFO_DISABLED
  process.env.IPINFO_DISABLED = '1'
  const logLines = []
  try {
    assert.equal(await logClientIpInfo({ log: (m) => logLines.push(m) }), null)
    assert.ok(logLines.some((l) => l.includes('disabled')))
  } finally {
    if (saved === undefined) delete process.env.IPINFO_DISABLED
    else process.env.IPINFO_DISABLED = saved
  }
})
