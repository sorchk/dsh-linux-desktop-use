/**
 * browser.js —— 「不用 CDP」的浏览器驱动逻辑。
 *
 * 背景：Chromium 在 Linux 上把无障碍树（AX tree）通过 **AT-SPI / atk-bridge**
 * 暴露给桌面，而不是只能通过 CDP（Chrome DevTools Protocol）拿到。
 * 插件因此可以用一条完全本地、无需开启远程调试端口的路径操作浏览器：
 *
 *   1. **读页面**   —— AT-SPI 遍历 AX 树，得到标题、URL、链接、按钮、输入框与正文；
 *   2. **定位控件** —— 按 role + name 在 AX 树里精确命中（拿到屏幕坐标与 path）；
 *   3. **触发动作** —— 优先用 AT-SPI 的 action 接口（link=jump / button=click / press），
 *                      没有 action 时回退到 XTEST 点击节点中心；
 *   4. **输入文本** —— AT-SPI grab_focus 拿到焦点后，用 XTEST 真实键入
 *                      （Chromium 的网页输入框与地址栏都不暴露 EditableText，无法直接写值）。
 *
 * 分层原则与 atspi.js 一致：**本文件只放可单测的纯逻辑**，
 * 凡是「跑子进程」「碰真实桌面」的动作都留在 tools.js 里。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 常见的 Chromium / Chrome 可执行文件名，按优先级排列。 */
export const BROWSER_BINARIES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
]

/**
 * 启动时必须加上的开关。
 *
 * `--force-renderer-accessibility` 是硬性条件：没有它，Chromium 只暴露
 * application + frame 两个空节点，网页内容完全读不到。
 */
export const REQUIRED_BROWSER_FLAGS = ['--force-renderer-accessibility']

/** 让「首次启动」不弹出各种向导的开关。 */
export const QUIET_BROWSER_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--disable-infobars',
]

/**
 * Chromium 里不同控件的动作名。
 * AX tree 实测：链接是 jump，网页按钮是 click，工具栏按钮是 press/click，地址栏是 activate。
 */
export const BROWSER_ACTION_PREFERENCES = ['jump', 'click', 'press', 'doDefault', 'activate']

/** 页面里常见的「可点击」角色。 */
export const CLICKABLE_ROLES = ['link', 'push button', 'button', 'toggle button', 'check box', 'radio button', 'menu item']

/** 页面里常见的「可输入」角色。 */
export const INPUT_ROLES = ['entry', 'text', 'password text', 'search box', 'spin button', 'combo box']

/** 地址栏在 AX 树里的名字片段（Chromium 英文界面）。 */
export const ADDRESS_BAR_NAME = 'Address and search bar'

/** AX 树里「网页正文根节点」的角色。 */
export const PAGE_ROOT_ROLE = 'document web'

/**
 * 浏览器实例状态文件的位置：记录插件自己启动的那个专用实例（pid 等）。
 * @param {Record<string,string>} env 环境变量。
 * @returns {string} 状态文件路径。
 */
export function browserStatePath(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME ?? homedir(), '.local', 'state')
  return join(base, 'dsh-linux-desktop-use', 'browser.json')
}

/**
 * 读取浏览器实例状态。
 * @param {Record<string,string>} env 环境变量。
 * @returns {{pid?:number,profileDir?:string,url?:string,launchedAt?:string}} 状态对象。
 */
export function readBrowserState(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(browserStatePath(env), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * 写入浏览器实例状态（失败不抛错——状态只是提示，不是权威来源）。
 * @param {object} state 状态对象。
 * @param {Record<string,string>} env 环境变量。
 */
export function writeBrowserState(state = {}, env = process.env) {
  try {
    const path = browserStatePath(env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // 状态写不进去也不影响使用
  }
}

/**
 * 专用实例使用的默认 profile 目录（与用户日常浏览器的 profile 完全隔离）。
 * @param {Record<string,string>} env 环境变量。
 * @returns {string} 目录路径。
 */
export function defaultProfileDir(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME ?? homedir(), '.local', 'state')
  return join(base, 'dsh-linux-desktop-use', 'browser-profile')
}

/**
 * 组装启动命令。
 *
 * 刻意 **不** 加 `--remote-debugging-port`：整条链路走 AT-SPI + XTEST，
 * 不开启任何 CDP 端口。
 *
 * @param {{binary:string,profileDir?:string,url?:string,extraArgs?:string[],noSandbox?:boolean}} options 选项。
 * @returns {{command:string,argv:string[],profileDir:string,flags:string[]}} 启动计划。
 */
export function buildBrowserLaunchPlan(options = {}) {
  const binary = String(options.binary ?? '').trim()
  if (!binary) return { error: '找不到可用的 Chromium / Chrome 可执行文件' }

  const profileDir = String(options.profileDir ?? '').trim() || defaultProfileDir()
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs.map(String) : []

  const flags = [
    ...REQUIRED_BROWSER_FLAGS,
    ...QUIET_BROWSER_FLAGS,
    `--user-data-dir=${profileDir}`,
  ]
  if (options.noSandbox) flags.push('--no-sandbox')

  const url = String(options.url ?? '').trim()
  const argv = [...flags, ...extraArgs]
  if (url) argv.push(url)

  return { command: binary, argv, profileDir, flags }
}

/**
 * 在 AX 树里找到网页正文根节点（role = document web）。
 * @param {object} tree 节点树。
 * @returns {object|null} 根节点；没有则 null。
 */
export function findPageRoot(tree) {
  let found = null
  const walk = node => {
    if (found || !node || typeof node !== 'object') return
    if (String(node.role ?? '').toLowerCase() === PAGE_ROOT_ROLE) {
      found = node
      return
    }
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
  }
  walk(tree)
  return found
}

/**
 * 深度优先收集满足条件的节点。
 * @param {object} tree 节点树。
 * @param {(node:object)=>boolean} predicate 判定函数。
 * @param {number} limit 最多收集多少个。
 * @returns {object[]} 节点列表。
 */
export function collectByPredicate(tree, predicate, limit = 200) {
  const result = []
  const walk = node => {
    if (result.length >= limit || !node || typeof node !== 'object') return
    if (predicate(node)) result.push(node)
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
  }
  walk(tree)
  return result
}

/**
 * 从整棵树里找出地址栏（entry / name 包含 Address and search bar）。
 * @param {object} tree 节点树。
 * @returns {object|null} 地址栏节点；没有则 null。
 */
export function findAddressBar(tree) {
  const needle = ADDRESS_BAR_NAME.toLowerCase()
  const hits = collectByPredicate(tree, node => {
    if (String(node.role ?? '').toLowerCase() !== 'entry') return false
    const haystack = `${node.name ?? ''} ${node.description ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  }, 5)
  return hits[0] ?? null
}

/**
 * 页面标题：优先取网页正文根节点的名称，去掉末尾的「 - 浏览器名」后缀。
 * @param {object} tree 节点树。
 * @returns {string} 标题；取不到则空串。
 */
export function extractPageTitle(tree) {
  const root = findPageRoot(tree)
  const raw = String(root?.name ?? '').trim()
  if (!raw) return ''
  return raw.replace(/\s+-\s+(Chromium|Google Chrome|Chrome)\s*$/i, '').trim()
}

/**
 * 页面 URL：取地址栏里的文本（Chromium 的 omnibox 文本就是当前 URL）。
 * @param {object} tree 节点树。
 * @returns {string} URL；取不到则空串。
 */
export function extractPageUrl(tree) {
  const bar = findAddressBar(tree)
  const text = String(bar?.text ?? '').trim()
  return text
}

/**
 * 把页面正文整理成一段纯文本（供模型阅读）。
 * @param {object} pageRoot 网页正文根节点。
 * @param {number} limit 最多保留多少字符。
 * @returns {string} 正文文本。
 */
export function extractPageText(pageRoot, limit = 1200) {
  if (!pageRoot) return ''
  const parts = []
  const seen = new Set()
  const walk = node => {
    if (!node || typeof node !== 'object') return
    const role = String(node.role ?? '').toLowerCase()
    if (role === 'static' || role === 'paragraph' || role === 'heading' || role === 'list item') {
      const text = String(node.text ?? '').trim()
      if (text && text !== '￼' && !seen.has(text)) {
        seen.add(text)
        parts.push(text)
      }
    }
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child)
  }
  walk(pageRoot)
  const joined = parts.join('\n').trim()
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined
}

/**
 * 汇总页面上的可交互元素（链接 / 按钮 / 输入框）。
 * 只看网页正文子树，避免把浏览器工具栏（后退、前进、书签…）混进来。
 * @param {object} tree 节点树。
 * @returns {{links:object[],buttons:object[],inputs:object[]}} 元素列表。
 */
export function collectPageElements(tree) {
  const root = findPageRoot(tree)
  if (!root) return { links: [], buttons: [], inputs: [] }

  const make = node => ({
    role: String(node.role ?? ''),
    name: String(node.name ?? ''),
    description: String(node.description ?? ''),
    text: typeof node.text === 'string' ? node.text : '',
    path: String(node.path ?? ''),
    box: node.box ?? null,
    actions: Array.isArray(node.actions) ? node.actions.map(a => String(a?.name ?? '')) : [],
  })

  const links = collectByPredicate(root, node => String(node.role ?? '').toLowerCase() === 'link', 60).map(make)
  const buttons = collectByPredicate(root, node => {
    const role = String(node.role ?? '').toLowerCase()
    return role === 'push button' || role === 'button' || role === 'toggle button' || role === 'check box'
  }, 60).map(make)
  const inputs = collectByPredicate(root, node => {
    const role = String(node.role ?? '').toLowerCase()
    return role === 'entry' || role === 'text' || role === 'password text' || role === 'search box' || role === 'spin button'
  }, 40).map(make)

  return { links, buttons, inputs }
}

/**
 * 生成页面的语义摘要（模型读这个就够了，不必读整棵树）。
 * @param {object} tree 节点树。
 * @param {{textLimit?:number}} options 选项。
 * @returns {{title:string,url:string,links:object[],buttons:object[],inputs:object[],text:string}} 摘要。
 */
export function summarizePage(tree, options = {}) {
  const root = findPageRoot(tree)
  const { links, buttons, inputs } = collectPageElements(tree)
  return {
    title: extractPageTitle(tree),
    url: extractPageUrl(tree),
    links,
    buttons,
    inputs,
    text: extractPageText(root, options.textLimit ?? 1200),
  }
}

/**
 * 按 role + name 在候选节点里挑出唯一目标。
 *
 * 命中规则：
 * - 同时给了 role 与 name：两者都要满足；
 * - 只给 name：在所有角色里按名称匹配；
 * - 命中多个且没给 index：返回 ambiguous，让调用方要求更精确的描述。
 *
 * @param {object[]} nodes 候选节点。
 * @param {{role?:string,nameContains?:string,index?:number,exact?:boolean}} options 限定条件。
 * @returns {{node:object|null,ambiguous:boolean,candidates:object[]}} 定位结果。
 */
export function pickTargetNode(nodes, options = {}) {
  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : []
  const role = String(options.role ?? '').trim().toLowerCase()
  const nameContains = String(options.nameContains ?? '').trim().toLowerCase()
  const exact = Boolean(options.exact)

  let matched = list.filter(node => {
    if (role && String(node.role ?? '').toLowerCase() !== role) return false
    if (nameContains) {
      const haystack = `${node.name ?? ''} ${node.description ?? ''}`.toLowerCase()
      if (exact) {
        if (haystack.trim() !== nameContains) return false
      } else if (!haystack.includes(nameContains)) {
        return false
      }
    }
    return true
  })

  const index = Number.isInteger(options.index) ? options.index : -1
  if (index >= 0) {
    const node = matched[index] ?? null
    return { node, ambiguous: false, candidates: matched }
  }

  if (matched.length === 1) return { node: matched[0], ambiguous: false, candidates: matched }
  if (matched.length > 1) return { node: null, ambiguous: true, candidates: matched }
  return { node: null, ambiguous: false, candidates: [] }
}

/**
 * 从节点的动作列表里挑出最合适的一个来执行。
 *
 * **刻意不返回 showContextMenu 之类的兜底动作**：上下文菜单不是「点击」，
 * 误触发只会弹出菜单并挡住界面。找不到合适动作时返回空串，
 * 由调用方改用坐标点击。
 *
 * @param {object} node 节点。
 * @returns {string} 动作名；没有可用动作则空串。
 */
export function pickPreferredAction(node) {
  const actions = Array.isArray(node?.actions)
    ? node.actions.map(action => String(action?.name ?? action ?? ''))
    : []
  for (const preferred of BROWSER_ACTION_PREFERENCES) {
    const hit = actions.find(name => name.toLowerCase() === preferred.toLowerCase())
    if (hit) return hit
  }
  return ''
}

/**
 * 从候选里选出「最像地址栏」的节点。
 * @param {object[]} nodes 候选节点。
 * @returns {object|null} 地址栏节点。
 */
export function pickAddressBar(nodes) {
  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : []
  const needle = ADDRESS_BAR_NAME.toLowerCase()
  const hit = list.find(node => String(node.name ?? '').toLowerCase().includes(needle))
  if (hit) return hit
  return list.find(node => String(node.role ?? '').toLowerCase() === 'entry') ?? null
}

/**
 * 判断某个 profile 目录是否已经存在（用于「复用已启动的实例」）。
 * @param {string} profileDir 目录路径。
 * @returns {boolean} 是否存在。
 */
export function profileExists(profileDir) {
  if (!profileDir) return false
  try {
    return existsSync(profileDir)
  } catch {
    return false
  }
}
