import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareFingerprints,
  evaluateChecks,
  buildWindowChecks,
  describeCheck,
} from '../lib/verify.js'

test('相同指纹判定为完全一致', () => {
  const buf = Buffer.alloc(64, 128)
  const result = compareFingerprints(buf, Buffer.from(buf))
  assert.equal(result.identical, true)
  assert.equal(result.changedRatio, 0)
  assert.equal(result.changedBytes, 0)
  assert.equal(result.totalBytes, 64)
})

test('部分字节变化时给出变化比例', () => {
  const a = Buffer.alloc(100, 0)
  const b = Buffer.alloc(100, 0)
  b.fill(255, 0, 50)
  const result = compareFingerprints(a, b)
  assert.equal(result.identical, false)
  assert.equal(result.changedBytes, 50)
  assert.equal(result.totalBytes, 100)
  assert.ok(Math.abs(result.changedRatio - 0.5) < 1e-9)
})

test('长度不同的指纹直接判定为不一致', () => {
  const result = compareFingerprints(Buffer.alloc(10, 0), Buffer.alloc(20, 0))
  assert.equal(result.identical, false)
  assert.equal(result.totalBytes, 10)
  assert.equal(result.changedRatio, 1)
})

test('指纹缺失时不比较', () => {
  assert.equal(compareFingerprints(null, Buffer.alloc(4)), null)
  assert.equal(compareFingerprints(Buffer.alloc(4), null), null)
})

test('断言求值汇总通过与失败数量', () => {
  const checks = [
    { name: 'a', passed: true, expected: 1, actual: 1 },
    { name: 'b', passed: false, expected: 2, actual: 3 },
  ]
  const summary = evaluateChecks(checks)
  assert.equal(summary.passed, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.total, 2)
  assert.equal(summary.allPassed, false)
})

test('空断言列表视为全部通过', () => {
  const summary = evaluateChecks([])
  assert.equal(summary.allPassed, true)
  assert.equal(summary.total, 0)
})

test('窗口断言：标题包含、焦点窗口标题、窗口数量', () => {
  const windows = [
    { id: '0x1', title: 'Terminal - ' },
    { id: '0x2', title: '文件管理器' },
  ]
  const active = { id: '0x2', title: '文件管理器' }
  const checks = buildWindowChecks({
    windows,
    active,
    expected: {
      windowTitleContains: '文件',
      activeTitleContains: '文件',
      windowCount: 2,
    },
  })
  assert.equal(checks.length, 3)
  assert.ok(checks.every((c) => c.passed))
})

test('窗口断言不满足时给出失败结论', () => {
  const checks = buildWindowChecks({
    windows: [{ id: '0x1', title: 'Terminal - ' }],
    active: { id: '0x1', title: 'Terminal - ' },
    expected: { activeTitleContains: '不存在' },
  })
  assert.equal(checks.length, 1)
  assert.equal(checks[0].passed, false)
})

test('断言描述可读', () => {
  const text = describeCheck({
    name: '窗口标题包含',
    passed: false,
    expected: 'abc',
    actual: 'xyz',
  })
  assert.match(text, /窗口标题包含/)
  assert.match(text, /abc/)
  assert.match(text, /xyz/)
})
