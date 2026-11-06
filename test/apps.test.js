import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectDesktopEntryDirs,
  buildAppIndex,
  findApp,
  matchAppToClass,
  groupWindowsByClass,
  parseWMClass,
  buildLaunchPlan,
} from '../lib/apps.js'

const entries = [
  {
    id: 'thunar',
    type: 'Application',
    name: 'Thunar File Manager',
    nameLocal: 'Thunar 文件管理器',
    exec: 'thunar %U',
    icon: 'org.xfce.thunar',
    terminal: false,
    noDisplay: false,
    hidden: false,
    categories: ['System'],
    startupWmClass: '',
    tryExec: 'thunar',
    actionCount: 0,
  },
  {
    id: 'chromium',
    type: 'Application',
    name: 'Chromium Web Browser',
    nameLocal: 'Chromium 网页浏览器',
    exec: '/usr/bin/chromium-browser %U',
    icon: 'chromium',
    terminal: false,
    noDisplay: false,
    hidden: false,
    categories: ['Network'],
    startupWmClass: 'chromium',
    tryExec: 'chromium-browser',
    actionCount: 0,
  },
  {
    id: 'vscode',
    type: 'Application',
    name: 'Visual Studio Code',
    nameLocal: 'Visual Studio Code',
    exec: '/home/sorc/.local/vscode/code %F',
    icon: 'vscode',
    terminal: false,
    noDisplay: false,
    hidden: false,
    categories: ['Development'],
    startupWmClass: 'Code',
    tryExec: 'code',
    actionCount: 0,
  },
  {
    id: 'tilda-dbus',
    type: 'Application',
    name: 'Tilda',
    nameLocal: 'Tilda 终端',
    exec: '/usr/bin/tilda --dbus',
    icon: 'utilities-terminal',
    terminal: false,
    noDisplay: false,
    hidden: false,
    categories: ['System'],
    startupWmClass: '',
    tryExec: 'tilda',
    actionCount: 0,
  },
  {
    id: 'htop',
    type: 'Application',
    name: 'Htop',
    nameLocal: 'Htop',
    exec: 'htop',
    icon: 'utilities-system-monitor',
    terminal: true,
    noDisplay: false,
    hidden: false,
    categories: ['System'],
    startupWmClass: '',
    tryExec: 'htop',
    actionCount: 0,
  },
]

test('收集 .desktop 目录并去重', () => {
  const dirs = collectDesktopEntryDirs({
    XDG_DATA_HOME: '/home/sorc/.local/share',
    XDG_DATA_DIRS: '/usr/share:/usr/local/share',
  })
  assert.ok(dirs.includes('/home/sorc/.local/share/applications'))
  assert.ok(dirs.includes('/usr/share/applications'))
  assert.ok(dirs.includes('/usr/local/share/applications'))
  assert.equal(new Set(dirs).size, dirs.length)
})

test('索引可按 id 与显示名检索', () => {
  const index = buildAppIndex(entries)
  assert.equal(index.byId.get('thunar').nameLocal, 'Thunar 文件管理器')
  const found = findApp(entries, 'thunar')
  assert.equal(found.length, 1)
  assert.equal(found[0].id, 'thunar')
  const byLocalName = findApp(entries, '文件管理器')
  assert.equal(byLocalName[0].id, 'thunar')
  const byName = findApp(entries, 'visual studio')
  assert.equal(byName[0].id, 'vscode')
})

test('WM_CLASS 与桌面条目按 StartupWMClass/可执行名/桌面 id 匹配', () => {
  assert.equal(matchAppToClass(entries[0], 'Thunar', 'Thunar'), true)
  assert.equal(matchAppToClass(entries[1], 'chromium', 'Chromium'), true)
  assert.equal(matchAppToClass(entries[2], 'code', 'code'), true)
  assert.equal(matchAppToClass(entries[3], 'tilda', 'Tilda'), true)
  assert.equal(matchAppToClass(entries[0], 'chromium', 'Chromium'), false)
})

test('WM_CLASS 字符串被拆成实例名与类名', () => {
  assert.deepEqual(parseWMClass('code.code'), { instance: 'code', class: 'code' })
  assert.deepEqual(parseWMClass('chromium.Chromium'), { instance: 'chromium', class: 'Chromium' })
  assert.deepEqual(parseWMClass('solo'), { instance: 'solo', class: 'solo' })
})

test('窗口按 WM_CLASS 分组', () => {
  const groups = groupWindowsByClass([
    { id: '0x1', title: 'A', wmClass: { instance: 'code', class: 'code' } },
    { id: '0x2', title: 'B', wmClass: { instance: 'code', class: 'code' } },
    { id: '0x3', title: 'C', wmClass: { instance: 'chromium', class: 'Chromium' } },
  ])
  assert.equal(groups.length, 2)
  const code = groups.find((g) => g.class === 'code')
  assert.equal(code.windows.length, 2)
  assert.equal(code.instance, 'code')
})

test('启动计划：普通应用直接执行并附加参数', () => {
  const plan = buildLaunchPlan(entries[1], { args: ['https://example.com'] })
  assert.equal(plan.command, '/usr/bin/chromium-browser')
  assert.deepEqual(plan.argv, ['https://example.com'])
  assert.equal(plan.terminal, false)
})

test('启动计划：Terminal=true 时用终端模拟器包裹', () => {
  const plan = buildLaunchPlan(entries[4], { emulator: 'xfce4-terminal' })
  assert.equal(plan.command, 'xfce4-terminal')
  assert.equal(plan.terminal, true)
  assert.match(plan.argv.join(' '), /htop/)
})

test('启动计划：缺少 Exec 时返回错误信息', () => {
  const plan = buildLaunchPlan({ ...entries[0], exec: '' })
  assert.equal(plan.error, '桌面条目没有 Exec 字段，无法启动')
})
