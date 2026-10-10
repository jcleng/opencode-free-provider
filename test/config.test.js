import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newSessionId,
  newRequestId,
  currentSession,
  ZEN_SESSION_MODE,
} from '../src/config.js'

test('newSessionId produces ses_<12hex><14hex> (26 chars, upstream-accepted shape)', () => {
  const s = newSessionId()
  assert.match(s, /^ses_[0-9a-f]{26}$/)
})

test('newRequestId produces msg_<hex> form', () => {
  const s = newRequestId()
  assert.match(s, /^msg_[0-9a-fA-F]{26}$/)
})

test('currentSession returns a valid session id per-request by default', () => {
  if (ZEN_SESSION_MODE !== 'per-request') return
  const a = currentSession()
  const b = currentSession()
  assert.match(a, /^ses_[0-9a-f]{26}$/)
  assert.notEqual(a, b, 'per-request mode yields a fresh session each call')
})

test('filterModels keeps only big-pickle / *-free ids', async () => {
  const { filterModels } = await import('../src/config.js')
  const models = filterModels({
    object: 'list',
    data: [
      { id: 'big-pickle' },
      { id: 'jev-1.13-free' },
      { id: 'muse-spark-1.3-contributor-free' },
      { id: 'claude-opus-5' },
      { id: 'gpt-5.5' },
      { id: 'gemini-3-flash' },
      { id: 'jev-1.13-free' }, // duplicate
    ],
  })
  assert.deepEqual(models.map((m) => m.id), ['big-pickle', 'jev-1.13-free', 'muse-spark-1.3-contributor-free'])
  assert.ok(models.every((m) => m.name && m.contextWindow > 0))
})

test('filterModels accepts a bare array and tolerates junk', async () => {
  const { filterModels } = await import('../src/config.js')
  assert.deepEqual(filterModels(['big-pickle', 'nope', null, 42]).map((m) => m.id), ['big-pickle'])
  assert.deepEqual(filterModels(null), [])
})
