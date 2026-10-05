import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { PROVIDER } from '../src/config.js'
import { relayChatCompletions } from '../src/upstream.js'

// Fake upstream that (a) returns a configurable assistant tool_calls turn on the
// first request, and (b) returns a final text answer whenever the proxy loops
// back with tool results (a `role:tool` message present).
let upstream
let upstreamPort
let firstTurnCalls = [] // [{ name, args }]
let requestCount = 0

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

function emitToolTurn(res, calls) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  calls.forEach((c, i) => {
    sse(res, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: 'call_' + i, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }] } }] })
  })
  sse(res, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  sse(res, '[DONE]')
  res.end()
}

function emitFinal(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  sse(res, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta: { content: text } }] })
  sse(res, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  sse(res, '[DONE]')
  res.end()
}

before(async () => {
  await new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        requestCount++
        const parsed = JSON.parse(body || '{}')
        const hasToolResult = (parsed.messages || []).some((m) => m.role === 'tool')
        if (hasToolResult) return emitFinal(res, 'done')
        return emitToolTurn(res, firstTurnCalls)
      })
    })
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address()).port
      process.env.OPENCODE_BASE_OVERRIDE = `http://127.0.0.1:${upstreamPort}/v1`
      resolve()
    })
  })
})

after(() => {
  return new Promise((resolve) => upstream.close(() => resolve()))
})

function collect(opts) {
  // relayChatCompletions is an async generator; drive it to completion.
  return (async () => {
    const out = []
    for await (const chunk of relayChatCompletions(opts)) out.push(chunk)
    return out
  })()
}

function toolCallNames(completion) {
  return (completion.choices?.[0]?.message?.tool_calls || []).map((t) => t.function?.name)
}

const callerTools = (names) => names.map((n) => ({
  type: 'function',
  function: { name: n, parameters: { type: 'object', properties: {}, required: [] } },
}))

test('caller with bash/grep/read registered: proxy backstops only glob, delegates bash', async () => {
  firstTurnCalls = [
    { name: 'glob', args: { pattern: '*.md' } },
    { name: 'bash', args: { command: 'echo hi' } },
  ]
  requestCount = 0
  const out = await collect({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'scan' }],
    tools: callerTools(['bash', 'grep', 'read']),
    stream: false,
  })
  assert.equal(out.length, 1)
  const names = toolCallNames(out[0])
  // glob was executed server-side; the agent must only see its own bash.
  assert.deepEqual(names, ['bash'], 'agent sees only the tool it registered')
  assert.ok(!names.includes('glob'), 'agent never receives the proxy-backstop tool')
  // Single upstream round-trip: mixed turn is filtered and handed back, no loop.
  assert.equal(requestCount, 1)
})

test('caller with no fingerprint tools registered: proxy executes all four', async () => {
  firstTurnCalls = [
    { name: 'glob', args: { pattern: '*.md' } },
    { name: 'bash', args: { command: 'echo hi' } },
    { name: 'grep', args: { pattern: 'x', path: '.' } },
    { name: 'read', args: { path: 'README.md' } },
  ]
  requestCount = 0
  const out = await collect({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'scan' }],
    tools: callerTools(['edit', 'write']), // none of the four
    stream: false,
  })
  assert.equal(out.length, 1)
  const names = toolCallNames(out[0])
  // All four ran server-side; the agent gets the final answer, no tool_calls.
  assert.deepEqual(names, [], 'agent receives final answer, no tool_calls')
  assert.equal(out[0].choices[0].message.content, 'done')
  // Proxy looped once: executed 4 tools, re-fed results, got final answer.
  assert.equal(requestCount, 2)
})

test('caller with all four fingerprint tools registered: proxy delegates everything', async () => {
  firstTurnCalls = [
    { name: 'glob', args: { pattern: '*.md' } },
    { name: 'bash', args: { command: 'echo hi' } },
    { name: 'grep', args: { pattern: 'x', path: '.' } },
    { name: 'read', args: { path: 'README.md' } },
  ]
  requestCount = 0
  const out = await collect({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'scan' }],
    tools: callerTools(['bash', 'glob', 'grep', 'read']),
    stream: false,
  })
  assert.equal(out.length, 1)
  const names = toolCallNames(out[0])
  // Proxy executes nothing; every tool_call is forwarded verbatim to the agent.
  assert.deepEqual(names.sort(), ['bash', 'glob', 'grep', 'read'], 'all tools delegated to agent')
  assert.equal(requestCount, 1)
})
