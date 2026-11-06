import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectDesktopEntryDirs,
  buildAppIndex,
  findApp,
  matchAppToClass,
  scoreAppToClass,
  groupWindowsByClass,
  parseWMClass,
  buildLaunchPlan,
  buildTerminalArgv,
  parseEnvironText,
  extractSessionBusAddress,
  matchRunningGroups,
  findTerminalEmulator,
  findSessionBusAddress,
  buildApplicationCatalog,
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

test('终端参数按模拟器差异生成：xfce4-terminal 用 --command=，xterm 用 -e', () => {
  assert.deepEqual(buildTerminalArgv('xfce4-terminal', ['htop']), ['--command=htop'])
  assert.deepEqual(buildTerminalArgv('/usr/bin/xfce4-terminal', ['htop']), ['--command=htop'])
  assert.deepEqual(buildTerminalArgv('xterm', ['htop']), ['-e', 'htop'])
  assert.deepEqual(buildTerminalArgv('gnome-terminal', ['htop']), ['--', 'htop'])
  assert.deepEqual(buildTerminalArgv('konsole', ['htop']), ['-e', 'htop'])
  // 参数里带空格时要加引号，避免被终端再拆一次。
  assert.deepEqual(buildTerminalArgv('xfce4-terminal', ['python3', '-c', 'print(1 2)']), [
    '--command=python3 -c "print(1 2)"',
  ])
})

test('启动计划：缺少 Exec 时返回错误信息', () => {
  const plan = buildLaunchPlan({ ...entries[0], exec: '' })
  assert.equal(plan.error, '桌面条目没有 Exec 字段，无法启动')
})

test('进程环境文本按 NUL 分隔解析', () => {
  const parsed = parseEnvironText('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus\0DISPLAY=:1\0\0BROKEN')
  assert.equal(parsed.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus')
  assert.equal(parsed.DISPLAY, ':1')
  assert.equal(parsed.BROKEN, undefined)
})

test('从环境里提取 D-Bus 会话地址', () => {
  assert.equal(extractSessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-abc' }), 'unix:path=/tmp/dbus-abc')
  assert.equal(extractSessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: '  ' }), '')
  assert.equal(extractSessionBusAddress({}), '')
})

test('窗口分组兼容字符串形式的 WM_CLASS', () => {
  const groups = groupWindowsByClass([
    { id: '0x1', title: 'A', wmClass: 'code.code' },
    { id: '0x2', title: 'B', wmClass: 'chromium.Chromium' },
  ])
  assert.equal(groups.length, 2)
  const code = groups.find(g => g.class === 'code')
  assert.equal(code.instance, 'code')
  assert.equal(code.windows.length, 1)
})

test('匹配打分：优先主条目而不是同可执行名的辅助条目', () => {
  const scored = scoreAppToClass({ ...entries[0], id: 'thunar', exec: 'thunar %U' }, 'Thunar', 'Thunar')
  const bulk = scoreAppToClass({ ...entries[0], id: 'thunar-bulk-rename', exec: 'thunar --bulk-rename %F' }, 'Thunar', 'Thunar')
  assert.ok(scored > bulk, '主条目的得分必须高于同可执行名的辅助条目')
  assert.equal(scoreAppToClass(null, 'x', 'x'), 0)
  assert.equal(scoreAppToClass({ id: 'nope', exec: 'zzz' }, 'x', 'x'), 0)
})

test('运行中的窗口分组可关联到桌面条目并按关键字过滤', () => {
  const groups = groupWindowsByClass([
    { id: '0x1', title: 'A', wmClass: 'code.code' },
    { id: '0x2', title: 'B', wmClass: 'chromium.Chromium' },
    { id: '0x3', title: 'C', wmClass: 'Thunar.Thunar' },
  ])
  const all = matchRunningGroups(groups, entries)
  assert.equal(all.length, 3)
  const thunar = all.find(g => g.class === 'Thunar')
  assert.equal(thunar.entryId, 'thunar')
  assert.equal(thunar.windowCount, 1)
  const filtered = matchRunningGroups(groups, entries, 'chromium')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].class, 'Chromium')
})

test('终端模拟器按候选顺序查找', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-term-'))
  const fake = path.join(dir, 'gnome-terminal')
  fs.writeFileSync(fake, '#!/bin/sh\n')
  fs.chmodSync(fake, 0o755)
  assert.equal(findTerminalEmulator({ PATH: dir }), fake)
  assert.equal(findTerminalEmulator({ PATH: '/nonexistent-dir' }), '')
})

test('应用目录把已安装条目与运行中的窗口关联起来', () => {
  const groups = groupWindowsByClass([
    { id: '0x1', title: 'A', wmClass: 'code.code' },
    { id: '0x2', title: 'B', wmClass: 'code.code' },
    { id: '0x3', title: 'C', wmClass: 'chromium.Chromium' },
  ])
  const catalog = buildApplicationCatalog({ entries, groups })
  const vscode = catalog.applications.find(item => item.id === 'vscode')
  assert.equal(vscode.running, true)
  assert.equal(vscode.windowCount, 2)
  assert.equal(vscode.wmClass, 'code')
  const thunar = catalog.applications.find(item => item.id === 'thunar')
  assert.equal(thunar.running, false)
  assert.equal(thunar.windowCount, 0)
  assert.equal(catalog.applications.length, 5)
  assert.equal(catalog.running.length, 2)
})

test('应用目录支持关键字过滤并默认隐藏 NoDisplay 条目', () => {
  const hiddenEntries = [...entries, { ...entries[0], id: 'secret', noDisplay: true }]
  const filtered = buildApplicationCatalog({ entries: hiddenEntries, groups: [], query: 'thunar' })
  assert.equal(filtered.applications.length, 1)
  assert.equal(filtered.applications[0].id, 'thunar')

  const withoutHidden = buildApplicationCatalog({ entries: hiddenEntries, groups: [] })
  assert.equal(withoutHidden.applications.some(item => item.id === 'secret'), false)

  const withHidden = buildApplicationCatalog({ entries: hiddenEntries, groups: [], includeHidden: true })
  assert.equal(withHidden.applications.some(item => item.id === 'secret'), true)
})

test('D-Bus 会话地址优先取自环境，其次取自进程环境文件', () => {
  assert.equal(
    findSessionBusAddress({ env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }, pids: [] }),
    'unix:path=/run/user/1000/bus',
  )

  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proc-'))
  const pidDir = path.join(procRoot, '4242')
  fs.mkdirSync(pidDir)
  fs.writeFileSync(path.join(pidDir, 'environ'), 'DISPLAY=:1\0DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-test\0')

  assert.equal(findSessionBusAddress({ env: {}, pids: [4242], procRoot }), 'unix:path=/tmp/dbus-test')
  assert.equal(findSessionBusAddress({ env: {}, pids: [], procRoot }), '')
})
