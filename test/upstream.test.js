import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { relayChatCompletions } from '../src/upstream.js'
import { encodeTranslatedId } from '../src/conversions.js'

// Fake upstream that (a) on a turn WITHOUT a tool result returns a configurable
// assistant tool_calls turn, and (b) on a turn WITH a tool result returns a final
// text answer. This mirrors the real upstream: it is stateless, the proxy re-sends
// the running conversation each request.
let upstream
let upstreamPort
let firstTurnCalls = [] // [{ name, args }]
let requestCount = 0
let lastWireBody = null

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

function emitToolTurn(res, calls) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  calls.forEach((c, i) => {
    sse(res, { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id || ('call_' + i), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }] } }] })
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
        lastWireBody = parsed
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

test('caller with bash/grep/read: model glob is translated to bash, not executed by proxy', async () => {
  // Upstream model emits a `glob` call the agent lacks.
  firstTurnCalls = [{ id: 'call_0', name: 'glob', args: { pattern: '*.md' } }]
  requestCount = 0
  const out = await collect({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'scan' }],
    tools: callerTools(['bash', 'grep', 'read']),
    stream: false,
  })
  assert.equal(out.length, 1)
  const names = toolCallNames(out[0])
  // The agent must receive a `bash` call (its own tool), never the fingerprint `glob`.
  assert.deepEqual(names, ['bash'], 'glob translated into agent-supported bash')
  assert.ok(!names.includes('glob'), 'agent never receives the un-runnable fingerprint name')
  // Exactly one upstream round-trip: proxy is a pure forwarder, no server-side loop.
  assert.equal(requestCount, 1)
})

test('caller with all four fingerprint tools: glob forwarded verbatim, no translation', async () => {
  firstTurnCalls = [{ id: 'call_0', name: 'glob', args: { pattern: '*.md' } }]
  requestCount = 0
  const out = await collect({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'scan' }],
    tools: callerTools(['bash', 'glob', 'grep', 'read']),
    stream: false,
  })
  assert.equal(out.length, 1)
  const names = toolCallNames(out[0])
  assert.deepEqual(names, ['glob'], 'agent runs glob itself; proxy forwards verbatim')
  assert.equal(requestCount, 1)
})

test('round-trip: agent result under encoded id is restored to the original glob call for upstream', async () => {
  // 1) First relay: model emits glob -> translated to bash with an encoded id.
  firstTurnCalls = [{ id: 'call_0', name: 'glob', args: { pattern: '*.md' } }]
  requestCount = 0
  const first = await collect({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'scan' }],
    tools: callerTools(['bash', 'grep', 'read']),
    stream: false,
  })
  const bashCall = first[0].choices[0].message.tool_calls[0]
  assert.equal(bashCall.function.name, 'bash')
  assert.ok(bashCall.id.startsWith('tr:'), 'translated call carries an encoded id')

  // 2) Agent "runs" the bash tool in ITS OWN cwd and calls back with the result.
  const agentMessages = [
    { role: 'user', content: 'scan' },
    { role: 'assistant', content: null, tool_calls: [bashCall] },
    { role: 'tool', tool_call_id: bashCall.id, content: 'README.md\nagents.md' },
  ]
  requestCount = 0
  await collect({
    model: 'big-pickle',
    messages: agentMessages,
    tools: callerTools(['bash', 'grep', 'read']),
    stream: false,
  })
  // The wire body sent to upstream must restore the ORIGINAL glob call + the
  // agent's result, so the model sees a natural glob result (not a bash one).
  const toolMsg = (lastWireBody.messages || []).find((m) => m.role === 'tool')
  const assistantTc = lastWireBody.messages
    .find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))?.tool_calls?.[0]
  assert.ok(assistantTc, 'wire assistant keeps the original tool call')
  assert.equal(assistantTc.function.name, 'glob', 'original fingerprint name restored for upstream')
  assert.equal(assistantTc.id, 'call_0', 'original tool_call id restored for upstream')
  assert.ok(toolMsg, 'agent result fed back to upstream')
  assert.equal(toolMsg.tool_call_id, 'call_0')
  assert.match(toolMsg.content, /README\.md/)
})

test('caller with no stand-in tool: glob becomes a textual note, not a tool the agent cannot run', async () => {
  // Agent supports only edit/write: no bash/find/ls can stand in for glob.
  firstTurnCalls = [{ id: 'call_0', name: 'glob', args: { pattern: '*.md' } }]
  requestCount = 0
  const out = await collect({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'scan' }],
    tools: callerTools(['edit', 'write']),
    stream: false,
  })
  assert.equal(out.length, 1)
  const names = toolCallNames(out[0])
  // The proxy cannot translate glob into any known agent tool, so it relays a
  // textual note back upstream itself (pure relay, no execution) and the model
  // terminates with a final answer. The agent is never handed the un-runnable
  // fingerprint name nor a missing-tool error.
  assert.deepEqual(names, [], 'no un-runnable tool handed to the agent')
  assert.equal(out[0].choices[0].message.content, 'done')
  // The note was fed back to upstream as a tool result for the original call.
  assert.equal(requestCount, 2)
  const toolMsg = (lastWireBody.messages || []).find((m) => m.role === 'tool')
  assert.ok(toolMsg && /not available/.test(toolMsg.content), 'model gets a textual note for the missing tool')
})
