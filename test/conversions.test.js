import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  serializeMessages,
  serializeTools,
  buildRequestBody,
  buildWireBody,
  mergeTools,
  shapeCompletion,
  parseSse,
  translateStream,
  callerToolNames,
  translateFingerprintCall,
  encodeTranslatedId,
  decodeTranslatedId,
  normalizeToolArguments,
  sanitizeWireMessages,
  injectOpencodeSystemEnv,
  opencodeEnvBlock,
} from '../src/conversions.js'
import { isFingerprintTool } from '../src/config.js'
import { splitModelId, findModel, isValidModel, listModelsPayload } from '../src/models.js'

test('splitModelId handles provider/model and bare id', () => {
  assert.deepEqual(splitModelId('opencode-free/big-pickle'), { provider: 'opencode-free', model: 'big-pickle' })
  assert.deepEqual(splitModelId('big-pickle'), { provider: 'opencode-free', model: 'big-pickle' })
  assert.deepEqual(splitModelId(''), { provider: 'opencode-free', model: '' })
})

test('findModel / isValidModel', () => {
  assert.equal(isValidModel('opencode-free/big-pickle'), true)
  assert.equal(isValidModel('big-pickle'), true)
  assert.equal(isValidModel('nope'), false)
  assert.equal(findModel('big-pickle').contextWindow, 200000)
})

test('listModelsPayload returns openai-style list with prefixed ids', () => {
  const p = listModelsPayload()
  assert.equal(p.object, 'list')
  assert.ok(Array.isArray(p.data) && p.data.length >= 1)
  assert.ok(p.data.every((m) => m.id.startsWith('opencode-free/')))
  assert.ok(p.data.some((m) => m.id === 'opencode-free/big-pickle'))
})

test('serializeMessages converts tool-result blocks to tool role', () => {
  const wire = serializeMessages([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'thinking' }, { type: 'tool-call', id: 'c1', name: 'fn', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: 'result' }] },
  ])
  assert.equal(wire[0].role, 'user')
  assert.equal(wire[0].content, 'hi')
  assert.equal(wire[1].role, 'assistant')
  assert.deepEqual(wire[1].tool_calls, [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }])
  assert.equal(wire[2].role, 'tool')
  assert.equal(wire[2].tool_call_id, 'c1')
  assert.equal(wire[2].content, 'result')
})

test('serializeMessages injects system prompt', () => {
  const wire = serializeMessages([{ role: 'user', content: 'hi' }], 'be nice')
  assert.deepEqual(wire[0], { role: 'system', content: 'be nice' })
})

test('serializeTools maps to openai functions', () => {
  const t = serializeTools([{ name: 'f', description: 'd', parameters: { type: 'object' } }])
  assert.deepEqual(t, [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }])
  assert.equal(serializeTools(undefined), undefined)
  assert.equal(serializeTools([]), undefined)
})

test('buildRequestBody forces stream:true and includes the four fingerprint names', () => {
  // Even when the agent asks for non-streaming, upstream must receive stream:true.
  const b = buildRequestBody({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], stream: false })
  assert.equal(b.model, 'big-pickle')
  assert.equal(b.stream, true, 'upstream only accepts stream:true')
  assert.equal(b.stream_options.include_usage, true)
  assert.equal(b.top_p, 0.95)
  const names = b.tools.map((t) => t.function.name).sort()
  // The four mandatory names must be present, but must NOT be duplicated if the
  // agent already supplied them (duplicate names -> upstream 403 -> 'Tool not found').
  assert.deepEqual(names, ['bash', 'glob', 'grep', 'read'], 'mandatory fingerprint names present exactly once')
  assert.equal(b.tool_choice, 'auto')
})

test('mergeTools keeps caller tools and appends the missing fingerprint tools', () => {
  // caller supplies only one, the other three must be appended
  const out = mergeTools([{ type: 'function', function: { name: 'grep', description: 'grep', parameters: {} } }])
  const names = out.map((t) => t.function.name).sort()
  assert.deepEqual(names, ['bash', 'glob', 'grep', 'read'])
  assert.equal(out.length, 4)
})

// Regression test for the "Tool not found" failure: OpenCode sends its OWN
// bash/glob/grep/read tools (with real schemas: command/path/pattern). The
// fingerprint tools must NOT be appended again, otherwise the upstream free
// tier rejects the request (403 FreeTierError) because of duplicate names, and
// the corrupted tool namespace made the model emit tool_calls the agent could
// not resolve. The caller's real tools must be preserved verbatim.
test('mergeTools never duplicates OpenCode built-in tool names', () => {
  const opencodeTools = [
    { type: 'function', function: { name: 'bash', description: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'glob', description: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
    { type: 'function', function: { name: 'grep', description: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
    { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  ]
  const out = mergeTools(opencodeTools)
  // Exactly 4 tools, no duplicates, caller schemas preserved.
  assert.equal(out.length, 4)
  const names = out.map((t) => t.function.name)
  assert.deepEqual([...new Set(names)].sort(), ['bash', 'glob', 'grep', 'read'])
  const bash = out.find((t) => t.function.name === 'bash')
  assert.equal(bash.function.parameters.properties.command !== undefined, true, 'caller bash schema preserved')
  assert.equal(bash.function.parameters.properties.p, undefined, 'fingerprint p-param NOT injected over caller tool')
})

test('mergeTools dedupes by name', () => {
  const caller = { type: 'function', function: { name: 'bash', description: 'custom', parameters: {} } }
  const out = mergeTools([caller])
  const bash = out.filter((t) => t.function.name === 'bash')
  assert.equal(bash.length, 1, 'caller-supplied bash not duplicated')
  assert.equal(out.length, 4)
})

test('shapeCompletion normalizes a non-streaming payload', () => {
  const out = shapeCompletion({ id: 'x', model: 'big-pickle', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }, 'big-pickle')
  assert.equal(out.object, 'chat.completion')
  assert.equal(out.choices[0].finish_reason, 'stop')
  assert.equal(out.usage.completion_tokens, 2)
})

test('parseSse yields objects and stops at [DONE]', async () => {
  // Build a fake SSE response stream.
  const chunks = [
    'data: {"a":1}\n\n',
    ': comment\n\n',
    'data: {"a":2}\n\n',
    'data: [DONE]\n\n',
  ]
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  const fakeRes = { body: stream }
  const out = []
  for await (const o of parseSse(fakeRes)) out.push(o)
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }])
})

test('translateStream forwards content and appends usage + finish', async function () {
  async function* src() {
    yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'big-pickle', choices: [{ index: 0, delta: { content: 'Hi' } }] }
    yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'big-pickle', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }
  }
  const out = []
  for await (const c of translateStream(src(), () => 'estimate')) out.push(c)
  // upstream already sent usage; the proxy must NOT append a duplicate usage chunk
  const withUsage = out.filter((c) => c.usage)
  assert.equal(withUsage.length, 0)
  const withFinish = out.filter((c) => c.choices && c.choices[0] && c.choices[0].finish_reason)
  assert.ok(withFinish.length >= 1)
  assert.equal(withFinish[withFinish.length - 1].choices[0].finish_reason, 'stop')
})

test('callerToolNames collects the agent-registered tool names', function () {
  const set = callerToolNames([
    { type: 'function', function: { name: 'bash', parameters: {} } },
    { type: 'function', function: { name: 'read' } },
  ])
  assert.deepEqual([...set].sort(), ['bash', 'read'])
})

test('buildWireBody keeps pre-serialized wire messages verbatim', function () {
  const wire = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok', tool_calls: [{ id: '1', type: 'function', function: { name: 'glob', arguments: '{}' } }] }, { role: 'tool', tool_call_id: '1', content: 'x' }]
  const body = buildWireBody({ model: 'big-pickle', wireMessages: wire, maxTokens: 1000 })
  assert.equal(body.stream, true)
  assert.deepEqual(body.messages, wire)
  // fingerprint tools must still be present
  assert.deepEqual(body.tools.map((t) => t.function.name).sort(), ['bash', 'glob', 'grep', 'read'])
})

test('serializeMessages handles standard OpenAI tool_calls + role:tool', function () {
  // The agent (and the proxy round-trip) use standard OpenAI format, not just
  // pi-agent content blocks. Verify both are preserved.
  const wire = serializeMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file.txt' },
  ])
  assert.equal(wire[0].role, 'assistant')
  assert.deepEqual(wire[0].tool_calls, [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }])
  assert.equal(wire[1].role, 'tool')
  assert.equal(wire[1].tool_call_id, 'c1')
  assert.equal(wire[1].content, 'file.txt')
})

test('encode/decode of translated ids is reversible', function () {
  const id = encodeTranslatedId('call_9', 'glob', '{"pattern":"*.js"}')
  assert.ok(id.startsWith('tr:'))
  const decoded = decodeTranslatedId(id)
  assert.deepEqual(decoded, { i: 'call_9', n: 'glob', a: '{"pattern":"*.js"}' })
  assert.equal(decodeTranslatedId('normal-id'), null)
})

test('serializeMessages restores translated tool_calls + tool results for upstream', function () {
  const id = encodeTranslatedId('call_9', 'glob', '{"pattern":"*.js"}')
  const wire = serializeMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: id, type: 'function', function: { name: 'bash', arguments: '{"command":"shopt ..."}' } }] },
    { role: 'tool', tool_call_id: id, content: 'a.js\nb.js' },
  ])
  // The assistant tool_call is mapped back to the original fingerprint name/id.
  assert.deepEqual(wire[0].tool_calls, [{ id: 'call_9', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.js"}' } }])
  // The tool result is mapped back to the original tool_call_id.
  assert.equal(wire[1].tool_call_id, 'call_9')
  assert.equal(wire[1].content, 'a.js\nb.js')
})

test('translateFingerprintCall maps glob -> bash when bash is available', function () {
  const tr = translateFingerprintCall('glob', { pattern: 'src/**/*.js' }, new Set(['bash', 'grep', 'read']))
  assert.equal(tr.name, 'bash')
  assert.ok(tr.arguments.command.includes('globstar'))
  assert.ok(tr.arguments.command.includes('src/**/*.js'))
})

test('translateFingerprintCall prefers bash, falls back to find', function () {
  const tr = translateFingerprintCall('glob', { pattern: '*.ts' }, new Set(['find']))
  assert.equal(tr.name, 'find')
})

test('translateFingerprintCall returns null when no agent tool can stand in', function () {
  assert.equal(translateFingerprintCall('glob', { pattern: '*' }, new Set(['edit', 'write'])), null)
  assert.equal(translateFingerprintCall('grep', { pattern: 'x' }, new Set(['edit', 'write'])), null)
})

test('translateFingerprintCall maps grep -> bash grep', function () {
  const tr = translateFingerprintCall('grep', { pattern: 'foo', path: 'src' }, new Set(['bash']))
  assert.equal(tr.name, 'bash')
  assert.ok(tr.arguments.command.includes('grep'))
})

test('isFingerprintTool identifies the gate-required names', function () {
  assert.equal(isFingerprintTool('glob'), true)
  assert.equal(isFingerprintTool('bash'), true)
  assert.equal(isFingerprintTool('read'), true)
  assert.equal(isFingerprintTool('grep'), true)
  assert.equal(isFingerprintTool('weirdtool'), false)
})

test('normalizeToolArguments keeps valid JSON object strings', function () {
  assert.equal(normalizeToolArguments('{"x":1}'), '{"x":1}')
})

test('normalizeToolArguments falls back to {} for empty/whitespace', function () {
  assert.equal(normalizeToolArguments(''), '{}')
  assert.equal(normalizeToolArguments('   '), '{}')
  assert.equal(normalizeToolArguments(undefined), '{}')
})

test('normalizeToolArguments falls back to {} for malformed JSON', function () {
  assert.equal(normalizeToolArguments('{not json'), '{}')
  assert.equal(normalizeToolArguments('{"x":'), '{}')
})

test('normalizeToolArguments falls back to {} for non-object JSON', function () {
  assert.equal(normalizeToolArguments('[1,2,3]'), '{}')
  assert.equal(normalizeToolArguments('"hi"'), '{}')
  assert.equal(normalizeToolArguments('42'), '{}')
  assert.equal(normalizeToolArguments('null'), '{}')
})

test('normalizeToolArguments stringifies object args', function () {
  assert.equal(normalizeToolArguments({ command: 'ls' }), '{"command":"ls"}')
})

test('sanitizeWireMessages drops assistant tool_calls missing a function name', function () {
  const wire = [
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'orphan' },
  ]
  const out = sanitizeWireMessages(wire)
  // c1 kept, c2 (no name) dropped
  assert.equal(out.length, 2)
  assert.equal(out[0].role, 'assistant')
  assert.equal(out[0].tool_calls.length, 1)
  assert.equal(out[0].tool_calls[0].id, 'c1')
  // The assistant message that only had the bad call is kept (without tool_calls)
  assert.equal(out[1].role, 'assistant')
  assert.equal(out[1].tool_calls, undefined)
})

test('sanitizeWireMessages drops orphan tool results whose call was removed', function () {
  const wire = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'kept' },
    { role: 'tool', tool_call_id: 'missing', content: 'dropped' },
  ]
  const out = sanitizeWireMessages(wire)
  assert.equal(out.length, 2)
  assert.equal(out[0].role, 'assistant')
  assert.equal(out[1].role, 'tool')
  assert.equal(out[1].content, 'kept')
})

test('sanitizeWireMessages keeps valid names and passes through non-tool messages', function () {
  const wire = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'a', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'glob', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r' },
  ]
  const out = sanitizeWireMessages(wire)
  assert.equal(out.length, 4)
  assert.equal(out[2].tool_calls[0].function.name, 'glob')
  assert.equal(out[3].content, 'r')
})

test('translateStream emits a non-null finish_reason even when upstream drops it', async function () {
  // Simulate an upstream stream that ends with NO finish_reason chunk
  // (truncated by a network glitch / timeout). The proxy must still emit a
  // terminal chunk with a concrete finish_reason, otherwise the caller throws
  // "Stream ended without finish_reason".
  async function* src() {
    yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'big-pickle', choices: [{ index: 0, delta: { content: 'Hi' } }] }
    // no finish_reason chunk at all
  }
  const out = []
  for await (const c of translateStream(src(), () => 'estimate')) out.push(c)
  const last = out[out.length - 1]
  assert.equal(last.choices[0].finish_reason, 'stop', 'terminal chunk must carry a non-null finish_reason')
})

test('translateStream passes through a real upstream finish_reason', async function () {
  async function* src() {
    yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'big-pickle', choices: [{ index: 0, delta: { content: 'Hi' } }] }
    yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'big-pickle', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }
  }
  const out = []
  for await (const c of translateStream(src(), () => 'estimate')) out.push(c)
  const last = out[out.length - 1]
  assert.equal(last.choices[0].finish_reason, 'length')
})

test('sanitizeWireMessages handles empty/null/undefined input', function () {
  assert.deepEqual(sanitizeWireMessages(undefined), [])
  assert.deepEqual(sanitizeWireMessages(null), [])
  assert.deepEqual(sanitizeWireMessages([]), [])
})

test('serializeMessages normalizes malformed tool-call arguments to {}', function () {
  const wire = serializeMessages([{
    role: 'assistant',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '' } }],
  }])
  assert.equal(wire[0].tool_calls[0].function.arguments, '{}')
})

// ---------------------------------------------------------------------------
// OpenCode system-prompt fingerprint (the free tier's second gate)
// ---------------------------------------------------------------------------
// The free tier rejects a request with 429 FreeUsageLimitError when the system
// prompt does not carry OpenCode's environment block, even on an IP that still
// has free quota. These tests pin the injection contract: additive, idempotent,
// and only applied when the caller opted in (systemEnv).

test('injectOpencodeSystemEnv appends the <env> block to the caller system prompt', function () {
  const wire = [
    { role: 'system', content: 'be nice' },
    { role: 'user', content: 'hi' },
  ]
  const out = injectOpencodeSystemEnv(wire, { directory: '/work' })
  assert.equal(out.length, 2)
  assert.equal(out[0].role, 'system')
  assert.ok(out[0].content.startsWith('be nice\n\n'), 'caller instructions are preserved')
  assert.match(out[0].content, /Here is some useful information about the environment you are running in:/)
  assert.match(out[0].content, /<env>/)
  assert.match(out[0].content, /Working directory: \/work/)
  assert.match(out[0].content, /Workspace root folder: \/work/)
  assert.match(out[0].content, /Is directory a git repo: /)
  assert.match(out[0].content, /Platform: /)
  assert.match(out[0].content, /<\/env>/)
  assert.equal(out[1].content, 'hi', 'other messages are untouched')
})

test('injectOpencodeSystemEnv is idempotent when the caller is OpenCode itself', function () {
  const wire = [{ role: 'system', content: 'x\n<env>\n  Working directory: /a\n</env>' }]
  assert.deepEqual(injectOpencodeSystemEnv(wire, { directory: '/b' }), wire)
})

test('injectOpencodeSystemEnv prepends a system message when the caller sent none', function () {
  const out = injectOpencodeSystemEnv([{ role: 'user', content: 'hi' }], { directory: '/work' })
  assert.equal(out.length, 2)
  assert.equal(out[0].role, 'system')
  assert.match(out[0].content, /Working directory: \/work/)
  assert.equal(out[1].role, 'user')
})

test('opencodeEnvBlock falls back to OPENCODE_ENV_CWD and never throws', function () {
  const prev = process.env.OPENCODE_ENV_CWD
  process.env.OPENCODE_ENV_CWD = '/fallback'
  try {
    assert.match(opencodeEnvBlock(), /Working directory: \/fallback/)
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_ENV_CWD
    else process.env.OPENCODE_ENV_CWD = prev
  }
})

test('buildRequestBody injects the env block only when systemEnv is provided', function () {
  const without = buildRequestBody({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(without.messages.some((m) => m.role === 'system'), false, 'no opt-in, no injection')

  const withEnv = buildRequestBody({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'hi' }],
    systemEnv: { directory: '/work' },
  })
  assert.equal(withEnv.messages[0].role, 'system')
  assert.match(withEnv.messages[0].content, /<env>/)
  assert.match(withEnv.messages[0].content, /Working directory: \/work/)
})
