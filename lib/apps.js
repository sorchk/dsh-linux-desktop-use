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
  if (!entry) return false
  const instanceKey = String(instance || '').toLowerCase()
  const classKey = String(className || '').toLowerCase()
  const candidates = [instanceKey, classKey].filter(Boolean)
  if (!candidates.length) return false

  const startup = String(entry.startupWmClass || '').toLowerCase()
  if (startup) {
    // StartupWMClass 允许写 "实例.类" 形式
    const startupKeys = startup.split('.').map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (candidates.some((c) => startupKeys.includes(c))) return true
  }

  const idKey = String(entry.id || '').toLowerCase()
  if (idKey && candidates.includes(idKey)) return true

  const binKey = desktopEntryBasename(entry.exec || '').toLowerCase()
  if (binKey && candidates.includes(binKey)) return true

  return false
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
 */
export function groupWindowsByClass(windows) {
  const groups = new Map()
  for (const win of windows || []) {
    const wmClass = win.wmClass || parseWMClass(win.wmClassRaw)
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
    const inner = [command, ...rest, ...extra].join(' ')
    return {
      command: emulator,
      argv: ['-e', inner],
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
