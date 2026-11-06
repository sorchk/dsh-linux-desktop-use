// .desktop 桌面条目解析：纯函数实现，不触碰文件系统，便于单元测试。
// 解析规则参考 freedesktop.org 的 Desktop Entry Specification。

const DESKTOP_ENTRY_GROUP = 'Desktop Entry'

/** 把 LANG/LC_ALL 之类的值规整成候选语言标签列表，如 zh_CN.UTF-8 → ['zh_CN', 'zh'] */
export function localeCandidates(locale) {
  const raw = String(locale || '').trim()
  if (!raw) return []
  const normalized = raw.replace(/@.*$/, '').replace(/\..*$/, '')
  const candidates = [normalized]
  const idx = normalized.indexOf('_')
  if (idx > 0) candidates.push(normalized.slice(0, idx))
  return candidates.filter(Boolean)
}

function unescapeValue(value) {
  return String(value)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function parseBoolean(value, fallback = false) {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return fallback
}

/**
 * 解析 .desktop 文件文本。
 * @param {string} text 文件内容
 * @param {string} filename 文件名，用于推导 id
 * @param {{locale?: string}} options locale 用于挑选本地化名称
 * @returns {object|null} 解析结果；缺少 [Desktop Entry] 组时返回 null
 */
export function parseDesktopEntry(text, filename = '', options = {}) {
  if (typeof text !== 'string') return null

  const lines = text.split(/\r?\n/)
  const groups = new Map()
  let current = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const groupMatch = /^\[(.+)\]$/.exec(line)
    if (groupMatch) {
      current = groupMatch[1].trim()
      if (!groups.has(current)) groups.set(current, new Map())
      continue
    }
    if (!current) continue
    const sep = line.indexOf('=')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    const bucket = groups.get(current)
    if (!bucket.has(key)) bucket.set(key, value)
  }

  const main = groups.get(DESKTOP_ENTRY_GROUP)
  if (!main) return null

  const get = (key) => (main.has(key) ? main.get(key) : undefined)

  // 统计 [Desktop Action xxx] 子组数量（不覆盖主条目）
  let actionCount = 0
  for (const name of groups.keys()) {
    if (name.startsWith('Desktop Action')) actionCount += 1
  }

  // 收集所有本地化名称键：Name[zh_CN] 等
  const localized = new Map()
  for (const [key, value] of main) {
    const m = /^Name\[(.+)\]$/.exec(key)
    if (m) localized.set(m[1].trim(), value)
  }

  const locale = options.locale ?? process.env.LC_ALL ?? process.env.LANG ?? ''
  let nameLocal = get('Name')
  for (const candidate of localeCandidates(locale)) {
    if (localized.has(candidate)) {
      nameLocal = localized.get(candidate)
      break
    }
  }

  const categoriesRaw = get('Categories')
  const categories = categoriesRaw
    ? categoriesRaw.split(';').map((s) => s.trim()).filter(Boolean)
    : []

  const id = String(filename || '').replace(/\.desktop$/i, '')

  return {
    id,
    type: get('Type') ?? 'Application',
    name: get('Name') ?? '',
    nameLocal: nameLocal ?? '',
    exec: get('Exec') ?? '',
    icon: get('Icon') ?? '',
    terminal: parseBoolean(get('Terminal'), false),
    noDisplay: parseBoolean(get('NoDisplay'), false),
    hidden: parseBoolean(get('Hidden'), false),
    categories,
    startupWmClass: get('StartupWMClass') ?? '',
    tryExec: get('TryExec') ?? '',
    actionCount,
  }
}

/**
 * 解析 Exec 行：按 shell 风格拆分参数，并剔除字段码（%f %F %u %U %i %c %k 等）。
 */
export function parseExecLine(execLine) {
  const text = String(execLine || '')
  const args = []
  let current = ''
  let quote = null
  let hasContent = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        i += 1
        current += text[i]
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasContent = true
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      i += 1
      current += text[i]
      hasContent = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasContent) {
        args.push(current)
        current = ''
        hasContent = false
      }
      continue
    }
    current += ch
    hasContent = true
  }
  if (hasContent) args.push(current)

  // 剔除字段码占位符
  return args.filter((arg) => !/^%[fFuUirckd]$/.test(arg))
}

/**
 * 提取 Exec 行里的可执行文件名（用于与 WM_CLASS 做匹配）。
 */
export function desktopEntryBasename(execLine) {
  const parts = parseExecLine(execLine)
  if (!parts.length) return ''
  const bin = parts[0]
  const idx = bin.lastIndexOf('/')
  return idx >= 0 ? bin.slice(idx + 1) : bin
}

export { unescapeValue }
