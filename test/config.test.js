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
