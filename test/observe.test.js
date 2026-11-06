import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordObservation,
  getObservation,
  invalidateObservation,
  clearObservation,
  requireFreshObservation,
  updateFingerprint,
} from '../lib/observe.js'

test('观察记录保存指纹与指纹区域', () => {
  clearObservation()
  const fingerprint = Buffer.alloc(16, 7)
  recordObservation({
    target: 'screen',
    label: 'entire screen',
    origin: { x: 0, y: 0 },
    width: 800,
    height: 600,
    scale: 1,
    fingerprint,
    fingerprintRegion: { x: 0, y: 0, width: 1882, height: 1040 },
  })
  const observation = getObservation()
  assert.equal(observation.fingerprint, fingerprint)
  assert.deepEqual(observation.fingerprintRegion, { x: 0, y: 0, width: 1882, height: 1040 })
})

test('作废观察时保留指纹，仅标记 stale', () => {
  clearObservation()
  const fingerprint = Buffer.alloc(16, 9)
  recordObservation({
    target: 'screen',
    label: 'entire screen',
    origin: { x: 0, y: 0 },
    width: 800,
    height: 600,
    scale: 1,
    fingerprint,
  })
  invalidateObservation()
  const observation = getObservation()
  assert.equal(observation.stale, true)
  assert.equal(observation.fingerprint, fingerprint)
  assert.throws(() => requireFreshObservation(30000, 'linux_click'), /已作废/)
})

test('没有指纹时字段为 null', () => {
  clearObservation()
  recordObservation({ target: 'screen', label: 'x', origin: { x: 0, y: 0 }, width: 1, height: 1, scale: 1 })
  assert.equal(getObservation().fingerprint, null)
})

test('updateFingerprint 只更新指纹，不改变观察的新鲜度', () => {
  clearObservation()
  recordObservation({
    target: 'screen',
    label: 'entire screen',
    origin: { x: 0, y: 0 },
    width: 800,
    height: 600,
    scale: 1,
    fingerprint: Buffer.alloc(16, 1),
  })
  const before = getObservation()
  const at = before.at
  const next = Buffer.alloc(16, 2)
  assert.equal(updateFingerprint(next, { x: 0, y: 0, width: 100, height: 100 }), true)
  const after = getObservation()
  assert.equal(after.fingerprint, next)
  assert.deepEqual(after.fingerprintRegion, { x: 0, y: 0, width: 100, height: 100 })
  // 观察时间不变，观察依旧新鲜：写操作的观察门禁没有被 verify_state 放开。
  assert.equal(after.at, at)
  assert.equal(after.stale, false)
  assert.doesNotThrow(() => requireFreshObservation(30000, 'linux_click'))
})

test('没有观察时 updateFingerprint 返回 false', () => {
  clearObservation()
  assert.equal(updateFingerprint(Buffer.alloc(4, 3)), false)
})
