// 应用索引与启动相关逻辑。
// 纯逻辑部分（匹配、分组、启动计划）不碰文件系统，可直接单元测试；
// 扫描 .desktop 与真正启动应用的部分依赖 fs/child_process。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseDesktopEntry,
  parseExecLine,
  desktopEntryBasename,
} from './desktop-entries.js'

/**
 * 列出需要扫描的 .desktop 目录（去重）。
 */
export function collectDesktopEntryDirs(env = process.env) {
  const dirs = []
  const push = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }

  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  push(path.join(dataHome, 'applications'))

  const dataDirs = env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'
  for (const dir of String(dataDirs).split(':')) {
    if (!dir.trim()) continue
    push(path.join(dir.trim(), 'applications'))
  }

  push('/usr/local/share/applications')
  push('/usr/share/applications')
  return dirs
}

/**
 * 扫描磁盘上的 .desktop 文件，返回可作为应用启动的条目。
 */
export function loadDesktopEntries(env = process.env) {
  const dirs = collectDesktopEntryDirs(env)
  const seen = new Set()
  const entries = []

  for (const dir of dirs) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.desktop')) continue
      const key = name.replace(/\.desktop$/i, '')
      if (seen.has(key)) continue
      let text = ''
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8')
      } catch {
        continue
      }
      const entry = parseDesktopEntry(text, name, { locale: env.LC_ALL || env.LANG })
      if (!entry) continue
      if (entry.type && entry.type !== 'Application') continue
      seen.add(key)
      entries.push(entry)
    }
  }
  return entries
}

/**
 * 建立 id / 名称索引。
 */
export function buildAppIndex(entries) {
  const byId = new Map()
  const byName = []
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry)
    byName.push(entry)
  }
  return { byId, byName }
}

/**
 * 按 id、显示名（本地化优先）、StartupWMClass 模糊匹配应用。
 */
export function findApp(entries, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []

  const exact = []
  const fuzzy = []
  for (const entry of entries) {
    if (entry.id?.toLowerCase() === q) {
      exact.push(entry)
      continue
    }
    const names = [entry.name, entry.nameLocal, entry.startupWmClass]
      .filter(Boolean)
      .map((s) => s.toLowerCase())
    if (names.some((n) => n === q)) {
      exact.push(entry)
      continue
    }
    if (names.some((n) => n.includes(q))) fuzzy.push(entry)
  }
  return exact.length ? exact : fuzzy
}

/**
 * 判断窗口的 WM_CLASS 是否属于某个桌面条目。
 * 判定顺序：StartupWMClass → 桌面条目 id → Exec 可执行名。
 */
export function matchAppToClass(entry, instance, className) {
  return scoreAppToClass(entry, instance, className) > 0
}

/**
 * 给「窗口 WM_CLASS ↔ 桌面条目」的匹配打分，分数越高越可能是主程序。
 *
 * 同一个可执行名往往有多个桌面条目（例如 thunar / thunar-bulk-rename、
 * xfce4-terminal / xfce4-terminal-settings），如果只取第一个命中项就会把
 * 主程序错认成辅助条目。这里按可信度排序：
 *
 * - 100：StartupWMClass 精确命中（这是 .desktop 里声明的正式窗口类名）
 * - 80：桌面条目 id 与类名/实例名一致
 * - 60：Exec 可执行名与类名/实例名一致，且没有额外子命令（主程序）
 * - 40：Exec 可执行名一致，但带了额外子命令（辅助条目，如 --bulk-rename）
 */
export function scoreAppToClass(entry, instance, className) {
  if (!entry) return 0
  const instanceKey = String(instance || '').toLowerCase()
  const classKey = String(className || '').toLowerCase()
  const candidates = [instanceKey, classKey].filter(Boolean)
  if (!candidates.length) return 0

  const startup = String(entry.startupWmClass || '').toLowerCase()
  if (startup) {
    // StartupWMClass 允许写 "实例.类" 形式
    const startupKeys = startup.split('.').map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (candidates.some((c) => startupKeys.includes(c))) return 100
  }

  const idKey = String(entry.id || '').toLowerCase()
  if (idKey && candidates.includes(idKey)) return 80

  const binKey = desktopEntryBasename(entry.exec || '').toLowerCase()
  if (binKey && candidates.includes(binKey)) {
    // Exec 里除可执行名外还有参数（--bulk-rename 之类）时，这是辅助条目。
    const parts = parseExecLine(entry.exec || '')
    const hasExtraArgs = parts.length > 1
    return hasExtraArgs ? 40 : 60
  }

  return 0
}

/**
 * 解析 wmctrl -x 输出的 WM_CLASS 字段（形如 `instance.class`）。
 */
export function parseWMClass(raw) {
  const text = String(raw || '').trim()
  if (!text) return { instance: '', class: '' }
  const idx = text.indexOf('.')
  if (idx < 0) return { instance: text, class: text }
  return {
    instance: text.slice(0, idx),
    class: text.slice(idx + 1),
  }
}

/**
 * 把窗口列表按 WM_CLASS 分组。
 * 兼容两种 WM_CLASS 形态：对象 `{instance, class}` 与字符串 `instance.class`。
 */
export function groupWindowsByClass(windows) {
  const groups = new Map()
  for (const win of windows || []) {
    const wmClass = typeof win.wmClass === 'string'
      ? parseWMClass(win.wmClass)
      : (win.wmClass || parseWMClass(win.wmClassRaw))
    const instance = wmClass.instance || ''
    const className = wmClass.class || ''
    const key = className || instance || 'unknown'
    if (!groups.has(key)) {
      groups.set(key, { instance, class: key, windows: [] })
    }
    groups.get(key).windows.push(win)
  }
  return [...groups.values()]
}

/**
 * 解析 `/proc/<pid>/environ` 的内容：NUL 分隔的 KEY=VALUE。
 * @param {string} text 进程环境文本。
 * @returns {Record<string,string>} 环境变量字典。
 */
export function parseEnvironText(text) {
  const result = {}
  for (const part of String(text ?? '').split('\0')) {
    if (!part) continue
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    result[part.slice(0, idx)] = part.slice(idx + 1)
  }
  return result
}

/**
 * 从环境变量字典里取出 D-Bus 会话总线地址。
 * @param {Record<string,string>} env 环境变量字典。
 * @returns {string} 地址；没有则返回空串。
 */
export function extractSessionBusAddress(env) {
  const address = env?.DBUS_SESSION_BUS_ADDRESS
  if (typeof address !== 'string') return ''
  return address.trim()
}

/**
 * 把运行中的窗口分组与桌面条目关联起来，并可按关键字过滤。
 * @param {Array} groups groupWindowsByClass 的结果。
 * @param {Array} entries 桌面条目。
 * @param {string} query 可选关键字（匹配实例名、类名或桌面条目 id/名称）。
 * @returns {Array} 关联后的分组，附带 entryId / entryName / windowCount。
 */
export function matchRunningGroups(groups, entries, query = '') {
  const needle = String(query ?? '').trim().toLowerCase()
  const list = Array.isArray(entries) ? entries : []
  const result = []

  for (const group of groups || []) {
    const instance = group.instance || ''
    const className = group.class || ''
    let entry = null
    let bestScore = 0
    let hiddenEntry = null
    let hiddenScore = 0
    for (const candidate of list) {
      const score = scoreAppToClass(candidate, instance, className)
      if (score <= 0) continue
      // NoDisplay/Hidden 条目只是内部辅助程序，优先展示可见的主条目。
      if (candidate.noDisplay || candidate.hidden) {
        if (score > hiddenScore) {
          hiddenScore = score
          hiddenEntry = candidate
        }
        continue
      }
      if (score > bestScore) {
        bestScore = score
        entry = candidate
      }
    }
    if (!entry) entry = hiddenEntry

    if (needle) {
      const haystack = [instance, className, entry?.id, entry?.name, entry?.nameLocal]
        .filter(Boolean)
        .map(value => String(value).toLowerCase())
      if (!haystack.some(value => value.includes(needle))) continue
    }

    result.push({
      instance,
      class: className,
      entryId: entry?.id ?? '',
      entryName: entry?.nameLocal || entry?.name || '',
      windowCount: group.windows?.length ?? 0,
      windows: group.windows ?? [],
    })
  }
  return result
}

/**
 * 生成应用目录：把「已安装的桌面条目」与「正在运行的窗口分组」合并成一份清单。
 *
 * 这是 `linux_apps` 工具的核心逻辑，纯函数，便于单元测试。
 *
 * @param {object} params 输入。
 * @param {Array} params.entries 桌面条目。
 * @param {Array} params.groups groupWindowsByClass 的结果。
 * @param {string} [params.query] 关键字过滤（对应用 id / 名称做包含匹配）。
 * @param {boolean} [params.includeHidden] 是否包含 NoDisplay / Hidden 条目。
 * @returns {{applications: object[], running: object[]}} 应用清单与运行中分组。
 */
export function buildApplicationCatalog({ entries = [], groups = [], query = '', includeHidden = false } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const groupList = Array.isArray(groups) ? groups : []
  const needle = String(query ?? '').trim().toLowerCase()

  // 1. 先算出「运行中」的分组：窗口 WM_CLASS ↔ 桌面条目。
  const running = matchRunningGroups(groupList, list)

  // 2. 按条目 id 统计运行中的窗口数与 WM_CLASS。
  const runningById = new Map()
  for (const group of running) {
    if (!group.entryId) continue
    const previous = runningById.get(group.entryId)
    if (previous) {
      previous.windowCount += group.windowCount
      previous.wmClass = previous.wmClass || group.class
    } else {
      runningById.set(group.entryId, { windowCount: group.windowCount, wmClass: group.class })
    }
  }

  // 3. 输出应用清单。
  const applications = []
  for (const entry of list) {
    if (!includeHidden && (entry.noDisplay || entry.hidden)) continue
    const haystack = [entry.id, entry.name, entry.nameLocal, entry.startupWmClass]
      .filter(Boolean)
      .map(value => String(value).toLowerCase())
    if (needle && !haystack.some(value => value.includes(needle))) continue
    const state = runningById.get(entry.id)
    applications.push({
      id: entry.id,
      name: entry.name,
      nameLocal: entry.nameLocal || entry.name,
      exec: entry.exec,
      icon: entry.icon,
      terminal: Boolean(entry.terminal),
      hidden: Boolean(entry.noDisplay || entry.hidden),
      running: Boolean(state),
      windowCount: state?.windowCount ?? 0,
      wmClass: state?.wmClass ?? '',
    })
  }

  return { applications, running }
}

/**
 * 生成启动计划：返回要执行的命令与参数（不经过 shell，避免注入）。
 */
export function buildLaunchPlan(entry, options = {}) {
  const { args = [], emulator = '' } = options
  const parts = parseExecLine(entry?.exec || '')
  if (!parts.length) {
    return { error: '桌面条目没有 Exec 字段，无法启动' }
  }

  const [command, ...rest] = parts
  const extra = Array.isArray(args) ? args.map(String) : []

  if (entry.terminal) {
    if (!emulator) {
      return { error: '该应用需要终端运行，但未找到可用的终端模拟器' }
    }
    return {
      command: emulator,
      argv: buildTerminalArgv(emulator, [command, ...rest, ...extra]),
      terminal: true,
      inner: { command, argv: [...rest, ...extra] },
    }
  }

  return {
    command,
    argv: [...rest, ...extra],
    terminal: false,
    inner: { command, argv: [...rest, ...extra] },
  }
}

/**
 * 按终端模拟器的差异生成启动参数。
 *
 * 各家终端传递「要执行的命令」的方式并不一致：
 * - `xfce4-terminal` 用 `--command=<cmd>`（等价于 `-e`，但要写成 `=` 形式）；
 * - `xterm` / `konsole` / `mate-terminal` 用 `-e <cmd...>`；
 * - `gnome-terminal` 用 `-- <cmd...>`。
 *
 * @param {string} emulator 终端模拟器路径或名字。
 * @param {string[]} argv 需要在终端里执行的命令与参数。
 * @returns {string[]} 传给终端模拟器的参数数组。
 */
export function buildTerminalArgv(emulator, argv = []) {
  const parts = Array.isArray(argv) ? argv.map(String) : []
  const name = path.basename(String(emulator || ''))
  if (name === 'xfce4-terminal') {
    return [`--command=${parts.map(quoteShellArg).join(' ')}`]
  }
  if (name === 'gnome-terminal') {
    return ['--', ...parts]
  }
  return ['-e', ...parts]
}

/**
 * 给终端模拟器用的参数加引号：含空格或特殊字符时用双引号包起来。
 */
function quoteShellArg(value) {
  const text = String(value)
  if (text && !/[\s"'\\$`]/.test(text)) return text
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`
}

/**
 * 启动应用：使用 spawn 直接执行，不经过 shell。
 */
export function launchApp(plan, options = {}) {
  const { env = process.env, cwd = os.homedir() } = options
  if (plan.error) return { ok: false, error: plan.error }

  const child = spawn(plan.command, plan.argv, {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return { ok: true, pid: child.pid, command: plan.command, argv: plan.argv }
}

/** 终端模拟器候选（按优先级排列）。 */
const TERMINAL_EMULATORS = ['xfce4-terminal', 'gnome-terminal', 'konsole', 'mate-terminal', 'xterm']

/**
 * 在 PATH 里查找可用的终端模拟器（用于 Terminal=true 的桌面条目）。
 * @param {Record<string,string>} env 环境变量。
 * @returns {string} 可执行文件路径；找不到返回空串。
 */
export function findTerminalEmulator(env = process.env) {
  const dirs = String(env.PATH ?? '').split(':').filter(Boolean)
  for (const name of TERMINAL_EMULATORS) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
  }
  return ''
}

/**
 * 查找图形会话的 D-Bus 会话总线地址。
 *
 * DSH 宿主进程通常是从一个非图形会话启动的，拿不到 DBUS_SESSION_BUS_ADDRESS；
 * 此时可以从桌面会话里已在运行的进程（例如窗口管理器）的 /proc/<pid>/environ 中读取。
 *
 * @param {{env?: Record<string,string>, pids?: number[], procRoot?: string}} options
 * @returns {string} 地址；找不到返回空串。
 */
export function findSessionBusAddress({ env = process.env, pids = [], procRoot = '/proc' } = {}) {
  const direct = extractSessionBusAddress(env)
  if (direct) return direct

  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue
    let text = ''
    try {
      text = fs.readFileSync(path.join(procRoot, String(pid), 'environ'), 'utf8')
    } catch {
      continue
    }
    const address = extractSessionBusAddress(parseEnvironText(text))
    if (address) return address
  }
  return ''
}
