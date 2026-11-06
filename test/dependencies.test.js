/**
 * 依赖目录（lib/dependencies.js）的单元测试。
 *
 * 目录是「检查依赖」与「一键安装」的唯一事实来源，所以这里断言：
 *   - 目录覆盖 README 运行依赖表里的每一项（一个都不能漏），
 *   - 每一条都有可安装的软件包名，
 *   - 安装计划只会出现缺失项，且只会出现目录里的软件包名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEPENDENCIES,
  NEED,
  allPackages,
  dependencyById,
  planInstall,
  summarizeDependencies,
} from '../lib/dependencies.js'

/** README「运行依赖」表里出现的每一项。 */
const README_ROWS = [
  'xdotool',
  'scrot',
  'ffmpeg',
  'wmctrl',
  'xrandr',
  'xprop',
  'python3',
  'python3-gi',
  'gir1.2-atspi-2.0',
  'at-spi2-core',
  'libatk-adaptor',
]

test('依赖目录覆盖 README 运行依赖表的每一项', () => {
  for (const id of README_ROWS) {
    const entry = dependencyById(id)
    assert.ok(entry, `依赖目录缺少 ${id}`)
    assert.equal(entry.id, id)
    assert.ok(entry.label, `${id} 缺少显示名`)
    assert.ok(entry.purpose, `${id} 缺少用途说明`)
    assert.ok(['binary', 'package'].includes(entry.kind), `${id} 的 kind 非法`)
    assert.ok(
      [NEED.REQUIRED, NEED.RECOMMENDED, NEED.OPTIONAL].includes(entry.need),
      `${id} 的 need 非法`,
    )
    assert.ok(Array.isArray(entry.packages) && entry.packages.length > 0, `${id} 没有可安装的软件包`)
  }
})

test('依赖目录的 id 唯一', () => {
  const ids = DEPENDENCIES.map(entry => entry.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('allPackages() 去重且排序，并覆盖每个条目的软件包', () => {
  const packages = allPackages()
  assert.deepEqual(packages, [...packages].sort())
  assert.equal(new Set(packages).size, packages.length)
  for (const entry of DEPENDENCIES) {
    for (const name of entry.packages) {
      assert.ok(packages.includes(name), `${name} 没有出现在 allPackages() 中`)
    }
  }
})

test('dependencyById 对未知 id 返回 null', () => {
  assert.equal(dependencyById('not-a-real-dependency'), null)
})

test('planInstall 只安装缺失项', () => {
  const states = [
    { id: 'xdotool', present: true },
    { id: 'scrot', present: false },
    { id: 'wmctrl', present: false },
  ]
  const plan = planInstall(states)
  assert.deepEqual(plan.dependencies, ['scrot', 'wmctrl'])
  assert.deepEqual(plan.packages, ['scrot', 'wmctrl'])
  assert.match(plan.command, /^sudo apt-get install -y scrot wmctrl$/)
})

test('planInstall 忽略未知 id（浏览器无法夹带任意包名）', () => {
  const plan = planInstall([{ id: 'evil-package', present: false }])
  assert.deepEqual(plan.dependencies, [])
  assert.deepEqual(plan.packages, [])
  assert.equal(plan.command, '')
})

test('planInstall 支持只处理选中的 id', () => {
  const states = [
    { id: 'scrot', present: false },
    { id: 'wmctrl', present: false },
  ]
  const plan = planInstall(states, { ids: ['wmctrl'] })
  assert.deepEqual(plan.dependencies, ['wmctrl'])
  assert.deepEqual(plan.packages, ['wmctrl'])
})

test('planInstall 在没有缺失项时不给出安装命令', () => {
  const plan = planInstall([{ id: 'xdotool', present: true }])
  assert.equal(plan.needed ?? plan.packages.length > 0, false)
  assert.equal(plan.packages.length, 0)
  assert.equal(plan.command, '')
})

test('planInstall 对同一软件包去重', () => {
  // xrandr 与 xprop 都由 x11-utils 提供。
  const plan = planInstall([
    { id: 'xrandr', present: false },
    { id: 'xprop', present: false },
  ])
  assert.deepEqual(plan.packages, ['x11-utils', 'x11-xserver-utils'])
})

test('summarizeDependencies 统计存在/缺失与分级数量', () => {
  const summary = summarizeDependencies([
    { id: 'a', need: NEED.REQUIRED, present: true },
    { id: 'b', need: NEED.REQUIRED, present: false },
    { id: 'c', need: NEED.RECOMMENDED, present: false },
    { id: 'd', need: NEED.OPTIONAL, present: false },
  ])
  assert.equal(summary.total, 4)
  assert.equal(summary.present, 1)
  assert.equal(summary.missing, 3)
  assert.equal(summary.missingRequired, 1)
  assert.equal(summary.missingRecommended, 1)
  assert.equal(summary.missingOptional, 1)
})
