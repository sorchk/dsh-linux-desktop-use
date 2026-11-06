import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeA11yState } from '../lib/diagnostics.js'

test('AT-SPI 状态：三项齐备时判定为可用', () => {
  const state = describeA11yState({
    python3: { present: true, path: '/usr/bin/python3' },
    gi: { ready: true, detail: '' },
    bus: { exists: true, path: '/run/user/1000/at-spi/bus' },
  })
  assert.equal(state.available, true)
  assert.equal(state.detail, '')
  assert.equal(state.python3, true)
  assert.equal(state.gi, true)
  assert.equal(state.bus, true)
})

test('AT-SPI 状态：缺 python3 时不可用并说明原因', () => {
  const state = describeA11yState({
    python3: { present: false, path: '' },
    gi: { ready: true, detail: '' },
    bus: { exists: true, path: '/run/user/1000/at-spi/bus' },
  })
  assert.equal(state.available, false)
  assert.match(state.detail, /python3/)
})

test('AT-SPI 状态：gi 不可用时带上原始原因', () => {
  const state = describeA11yState({
    python3: { present: true, path: '/usr/bin/python3' },
    gi: { ready: false, detail: "No module named 'gi'" },
    bus: { exists: true, path: '/run/user/1000/at-spi/bus' },
  })
  assert.equal(state.available, false)
  assert.equal(state.gi, false)
  assert.match(state.detail, /No module named/)
})

test('AT-SPI 状态：总线 socket 不存在时不可用', () => {
  const state = describeA11yState({
    python3: { present: true, path: '/usr/bin/python3' },
    gi: { ready: true, detail: '' },
    bus: { exists: false, path: '/run/user/1000/at-spi/bus' },
  })
  assert.equal(state.available, false)
  assert.equal(state.bus, false)
  assert.match(state.detail, /at-spi|无障碍总线/)
})

test('AT-SPI 状态：总路径会被原样带出', () => {
  const state = describeA11yState({
    python3: { present: true, path: '/usr/bin/python3' },
    gi: { ready: true, detail: '' },
    bus: { exists: true, path: '/run/user/1000/at-spi/bus' },
  })
  assert.equal(state.busPath, '/run/user/1000/at-spi/bus')
})
