// 状态校验：画面指纹比较 + 窗口状态断言。
// 全部为纯逻辑，便于单元测试（不依赖 X 会话）。

const DEFAULT_CHANGE_THRESHOLD = 0.01

/**
 * 比较两份灰度指纹。
 * @param {Buffer|Uint8Array|null} a 旧指纹
 * @param {Buffer|Uint8Array|null} b 新指纹
 * @param {{threshold?: number}} options 变化阈值，低于该比例视为未变化
 * @returns {{identical: boolean, changed: boolean, changedRatio: number, changedBytes: number, totalBytes: number}|null}
 */
export function compareFingerprints(a, b, options = {}) {
  if (!a || !b) return null
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a)
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b)
  const threshold = options.threshold ?? DEFAULT_CHANGE_THRESHOLD

  if (bufA.length !== bufB.length) {
    return {
      identical: false,
      changed: true,
      changedRatio: 1,
      changedBytes: Math.min(bufA.length, bufB.length),
      totalBytes: Math.min(bufA.length, bufB.length),
    }
  }

  if (!bufA.length) {
    return {
      identical: true,
      changed: false,
      changedRatio: 0,
      changedBytes: 0,
      totalBytes: 0,
    }
  }

  let diffSum = 0
  let changedBytes = 0
  for (let i = 0; i < bufA.length; i += 1) {
    const diff = Math.abs(bufA[i] - bufB[i])
    diffSum += diff
    if (diff !== 0) changedBytes += 1
  }

  const changedRatio = diffSum / (bufA.length * 255)
  const identical = changedBytes === 0
  return {
    identical,
    changed: !identical && changedRatio >= threshold,
    changedRatio,
    changedBytes,
    totalBytes: bufA.length,
  }
}

/**
 * 汇总断言结果。
 */
export function evaluateChecks(checks) {
  const list = Array.isArray(checks) ? checks : []
  const failed = list.filter((c) => !c.passed).length
  return {
    total: list.length,
    passed: list.length - failed,
    failed,
    allPassed: failed === 0,
  }
}

/**
 * 依据期望值生成窗口相关断言。
 * @param {{windows: Array, active: object|null, expected: object}} params
 */
export function buildWindowChecks(params) {
  const { windows = [], active = null, expected = {} } = params || {}
  const checks = []

  if (expected.windowTitleContains) {
    const needle = String(expected.windowTitleContains)
    const matched = windows.filter((w) => String(w.title || '').includes(needle))
    checks.push({
      name: '窗口标题包含',
      passed: matched.length > 0,
      expected: needle,
      actual: matched.map((w) => w.title),
    })
  }

  if (expected.activeTitleContains) {
    const needle = String(expected.activeTitleContains)
    const title = String(active?.title || '')
    checks.push({
      name: '焦点窗口标题包含',
      passed: title.includes(needle),
      expected: needle,
      actual: title,
    })
  }

  if (expected.windowCount !== undefined && expected.windowCount !== null) {
    const want = Number(expected.windowCount)
    checks.push({
      name: '窗口数量',
      passed: windows.length === want,
      expected: want,
      actual: windows.length,
    })
  }

  return checks
}

/**
 * 生成断言的可读描述。
 */
export function describeCheck(check) {
  if (!check) return ''
  const actual = Array.isArray(check.actual) ? check.actual.join('、') : check.actual
  const mark = check.passed ? '通过' : '失败'
  return `${check.name}：${mark}（期望 ${JSON.stringify(check.expected)}，实际 ${JSON.stringify(actual ?? '')}）`
}
