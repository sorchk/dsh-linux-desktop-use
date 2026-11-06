import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordObservation,
  getObservation,
  invalidateObservation,
  clearObservation,
  requireFreshObservation,
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
