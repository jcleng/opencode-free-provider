import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  anthropicSystemToString,
  anthropicToolsToOpenAI,
  anthropicMessagesToOpenAI,
  openAIToAnthropicMessage,
} from '../src/routes.js'
import server from '../server.js'

// ---------------------------------------------------------------------------
// Unit tests for the pure Anthropic <-> OpenAI converters
// ---------------------------------------------------------------------------

test('anthropicSystemToString joins text blocks and passes strings through', () => {
  assert.equal(anthropicSystemToString('be brief'), 'be brief')
  assert.equal(
    anthropicSystemToString([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    'a\nb',
  )
  assert.equal(anthropicSystemToString([{ type: 'tool_result', content: 'x' }]), undefined)
})

test('anthropicToolsToOpenAI maps tool name/description/input_schema', () => {
  const out = anthropicToolsToOpenAI([
    { name: 'bash', description: 'run a command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } },
    { name: '' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'function')
  assert.equal(out[0].function.name, 'bash')
  assert.equal(out[0].function.parameters.properties.cmd.type, 'string')
})

test('anthropicMessagesToOpenAI flattens text, tool_use, and tool_result blocks', () => {
  const out = anthropicMessagesToOpenAI([
    { role: 'user', content: [{ type: 'text', text: 'list files' }] },
    { role: 'assistant', content: [
      { type: 'text', text: 'running' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'a.txt' }] },
      { type: 'text', text: 'done?' },
    ] },
  ])
  assert.deepEqual(out[0], { role: 'user', content: 'list files' })
  assert.equal(out[1].role, 'assistant')
  assert.equal(out[1].content, 'running')
  assert.deepEqual(out[1].tool_calls, [{
    id: 'tu_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' },
  }])
  assert.deepEqual(out[2], { role: 'tool', tool_call_id: 'tu_1', content: 'a.txt' })
  assert.deepEqual(out[3], { role: 'user', content: 'done?' })
})

test('openAIToAnthropicMessage wraps content and tool_calls in Anthropic shape', () => {
  const msg = openAIToAnthropicMessage({
    id: 'c', model: 'big-pickle',
    choices: [{
      index: 0, finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: 'calling',
        tool_calls: [{ id: 'call_1', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  }, 'opencode/big-pickle')
  assert.match(msg.id, /^msg_/)
  assert.equal(msg.type, 'message')
  assert.equal(msg.role, 'assistant')
  assert.equal(msg.model, 'opencode/big-pickle')
  assert.equal(msg.stop_reason, 'tool_use')
  assert.deepEqual(msg.content.filter((b) => b.type === 'tool_use')[0], {
    type: 'tool_use', id: 'call_1', name: 'bash', input: { cmd: 'ls' },
  })
  assert.deepEqual(msg.usage, { input_tokens: 10, output_tokens: 3 })
})

test('openAIToAnthropicMessage maps finish_reason length -> stop_reason max_tokens', () => {
  const msg = openAIToAnthropicMessage({
    choices: [{ message: { role: 'assistant', content: 'long' }, finish_reason: 'length' }],
  }, 'm')
  assert.equal(msg.stop_reason, 'max_tokens')
})

// ---------------------------------------------------------------------------
// Integration: /v1/messages served by the relay against a mock upstream
// ---------------------------------------------------------------------------

let upstream
let lastUpstreamReq
let respondWith
let upstreamPort

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      lastUpstreamReq = { method: req.method, url: req.url, body }
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3-flash-free', object: 'model', created: 0, owned_by: 'opencode' }] }))
        return
      }
      const completion = respondWith && respondWith.completion
        ? respondWith.completion
        : { id: 'c', object: 'chat.completion', created: 0, model: 'glm-5.3-flash-free',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(completion))
      res.end()
    })
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = upstream.address().port
  process.env.OPENCODE_BASE_OVERRIDE = `http://127.0.0.1:${upstreamPort}/v1`
})

after(() => {
  return new Promise((resolve) => {
    const closeUp = () => upstream.close(() => resolve())
    if (server.listening) server.close(closeUp)
    else closeUp()
  })
})

function fetchProxy(path, opts = {}) {
  if (!server.listening) {
    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        fetchProxy(path, opts).then(resolve, reject)
      })
    })
  }
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, opts)
}

const ANTHROPIC_BODY = {
  model: 'glm-5.3-flash-free',
  max_tokens: 64,
  system: [{ type: 'text', text: 'be terse' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Reply with exactly ANTHROPIC-OK' }] },
  ],
}

test('POST /v1/messages returns a valid Anthropic message (JSON mode)', async () => {
  const res = await fetchProxy('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...ANTHROPIC_BODY, stream: false }),
  })
  assert.equal(res.status, 200)
  const msg = await res.json()
  assert.equal(msg.type, 'message')
  assert.equal(msg.role, 'assistant')
  assert.match(msg.id, /^msg_/)
  assert.equal(msg.stop_reason, 'end_turn')
  assert.equal(msg.content[0].type, 'text')
  assert.equal(msg.content[0].text, 'Hi')
  assert.deepEqual(msg.usage, { input_tokens: 4, output_tokens: 1 })
})

test('POST /v1/messages forwards converted tool_use and emits Anthropic tool_use back', async () => {
  respondWith = { completion: { id: 'c', object: 'chat.completion', created: 0, model: 'glm-5.3-flash-free',
    choices: [{ index: 0, finish_reason: 'tool_calls',
      message: { role: 'assistant', content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
    }],
    usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } } }
  try {
    const res = await fetchProxy('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...ANTHROPIC_BODY,
        tools: [{ name: 'bash', description: 'run', input_schema: { type: 'object', properties: {} } }],
      }),
    })
    assert.equal(res.status, 200)
    const msg = await res.json()
    assert.equal(msg.stop_reason, 'tool_use')
    assert.ok(msg.content.some((b) => b.type === 'tool_use' && b.name === 'bash'))
    // upstream must see OpenAI function tools, not the anthropic input_schema shape
    const upstreamBody = JSON.parse(lastUpstreamReq.body)
    const fn = upstreamBody.tools.find((t) => t.type === 'function')
    assert.equal(fn.function.name, 'bash')
  } finally {
    respondWith = null
  }
})

test('POST /v1/messages (stream:true) emits Anthropic SSE lifecycle events', async () => {
  const res = await fetchProxy('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...ANTHROPIC_BODY, stream: true }),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const raw = await res.text()
  const types = [...raw.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(types, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
  assert.match(raw, /"text":"Hi"/)
})

test('POST /v1/messages maps model fallback when the id is unknown', async () => {
  const res = await fetchProxy('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...ANTHROPIC_BODY, model: 'nota-model' }),
  })
  assert.equal(res.status, 200)
  assert.ok(JSON.stringify(JSON.parse(lastUpstreamReq.body)).includes('glm-5.3-flash-free'))
})
