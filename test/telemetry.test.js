import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordBytes, recordRequest, statsSnapshot, flushPersist } from '../src/egress.js'

test('recordBytes / recordRequest accumulate on the snapshot', () => {
  const before = statsSnapshot()
  recordBytes(1024, 2048)
  recordBytes(100, 50)
  recordRequest({ viaProxy: true, outcome: 'ok' })
  recordRequest({ viaProxy: true, outcome: 'quota', rotated: true })
  recordRequest({ viaProxy: false, outcome: 'ok' })
  const after = statsSnapshot()
  console.log('before', JSON.stringify(before).slice(0, 160))
  console.log('after ', JSON.stringify(after).slice(0, 160))
  assert.ok(after.bytesIn >= before.bytesIn + 1124, `bytesIn expected ≥ ${before.bytesIn + 1124}, got ${after.bytesIn}`)
  assert.ok(after.bytesOut >= before.bytesOut + 2098, `bytesOut expected ≥ ${before.bytesOut + 2098}, got ${after.bytesOut}`)
  assert.equal(after.requests - before.requests, 3)
  assert.ok(after.rotations - before.rotations >= 1, `rotations expected ≥ ${before.rotations + 1}`)
})

test('flushPersist is idempotent', () => {
  flushPersist()
  flushPersist()
})
