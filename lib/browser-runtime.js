/**
 * browser-runtime.js —— 「不用 CDP」的浏览器运行时（会真的碰桌面的部分）。
 *
 * 与 lib/browser.js 的分工：
 * - browser.js：纯逻辑，可单测（找页面根节点、挑目标控件、汇总页面）；
 * - browser-runtime.js：跑子进程、读 AX 树、激活窗口、发 XTEST 事件。
 *
 * 整条链路：**AT-SPI 读页面 + AT-SPI 定位/动作 + XTEST 键入**，
 * 刻意不开启任何 CDP（--remote-debugging-port）端口。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import {
  activateWindow,
  click,
  findBinary,
  listWindowsWithClass,
  moveMouse,
  pressKey,
  typeText,
} from './x11.js'
import { findSessionBusAddress } from './apps.js'
import {
  ATSPI_SCRIPT_PATH,
  buildA11yRequest,
  nodeBox,
  nodeCenter,
  runA11y,
  trimTree,
} from './atspi.js'
import {
  ADDRESS_BAR_NAME,
  BROWSER_ACTION_PREFERENCES,
  BROWSER_BINARIES,
  CLICKABLE_ROLES,
  INPUT_ROLES,
  collectPageElements,
  findAddressBar,
  findPageRoot,
  pickPreferredAction,
  readBrowserState,
} from './browser.js'
import { buildA11yEnvironment } from './a11y-env.js'

/** AX 树里浏览器应用名一般长这样（Chromium / Google Chrome / Chrome）。 */
const BROWSER_APP_PATTERN = /chrom(e|ium)/i

/** 窗口类名里带 chromium / chrome 的都算浏览器窗口。 */
const BROWSER_CLASS_PATTERN = /chrom(e|ium)/i

/**
 * 判断一个 AX 应用是不是浏览器。
 * @param {{name?:string}} app 应用条目。
 * @returns {boolean} 是否浏览器。
 */
export function isBrowserApp(app) {
  return BROWSER_APP_PATTERN.test(String(app?.name ?? ''))
}

/**
 * 在 AX 总线上挑出要操作的浏览器实例。
 *
 * 多个 Chromium 实例的 AX 应用名都叫 "Chromium"，只能靠 pid 区分，
 * 因此调用方应当优先给出 pid（插件自己启动的实例会记在状态文件里）。
 *
 * @param {object[]} apps ping 返回的应用列表。
 * @param {{pid?:number,app?:string}} options 限定条件。
 * @returns {{app:object|null,candidates:object[]}} 选中的应用与候选列表。
 */
export function pickBrowserApp(apps, options = {}) {
  const list = Array.isArray(apps) ? apps : []
  const pid = Number.isInteger(options.pid) ? options.pid : null
  const wanted = String(options.app ?? '').trim().toLowerCase()

  let candidates = list.filter(isBrowserApp)
  if (wanted) {
    const filtered = candidates.filter(app => String(app.name ?? '').toLowerCase().includes(wanted))
    if (filtered.length) candidates = filtered
  }

  if (pid) {
    const hit = candidates.find(app => Number(app.pid) === pid)
    if (hit) return { app: hit, candidates }
    // pid 指定的实例还没注册到总线：仍然返回候选，交由调用方报错。
    return { app: null, candidates }
  }

  return { app: candidates[0] ?? null, candidates }
}

/**
 * 在窗口列表里找出属于某个浏览器进程的窗口。
 * @param {object[]} windows listWindowsWithClass 的结果。
 * @param {{pid?:number}} options 限定条件。
 * @returns {object|null} 窗口；没有则 null。
 */
export function pickBrowserWindow(windows, options = {}) {
  const list = Array.isArray(windows) ? windows : []
  const pid = Number.isInteger(options.pid) ? options.pid : null
  if (pid) {
    const hit = list.find(win => Number(win.pid) === pid && BROWSER_CLASS_PATTERN.test(String(win.wmClass ?? '')))
    if (hit) return hit
  }
  return list.find(win => BROWSER_CLASS_PATTERN.test(String(win.wmClass ?? ''))) ?? null
}

/**
 * 组装浏览器子进程需要的环境变量。
 *
 * 关键点是 DBUS_SESSION_BUS_ADDRESS：Chromium 要通过它找到 a11y 总线，
 * 否则即使加了 --force-renderer-accessibility 也不会注册 AX 树。
 *
 * @param {object} current 生效配置。
 * @param {object} env X11 环境。
 * @param {number[]} pids 桌面上运行中的进程号（用于借总线地址）。
 * @returns {Record<string,string>} 子进程环境。
 */
export function buildBrowserEnv(current, env, pids = []) {
  const launchEnv = { ...env }
  let address = ''
  try {
    address = findSessionBusAddress({ env: process.env, pids })
  } catch {
    address = ''
  }
  if (address) launchEnv.DBUS_SESSION_BUS_ADDRESS = address
  // a11y 总线 socket 位于 /run/user/<uid>/at-spi/，缺了这个变量会找不到。
  if (!launchEnv.XDG_RUNTIME_DIR) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
    launchEnv.XDG_RUNTIME_DIR = `/run/user/${uid}`
  }
  return launchEnv
}

/**
 * 读取 AX 总线上注册的所有应用。
 * @param {object} a11yEnv 子进程环境。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<object[]>} 应用列表。
 */
export async function listA11yApps(a11yEnv, timeoutMs) {
  const response = await runA11y(a11yEnv, buildA11yRequest('ping'), {
    timeoutMs,
    scriptPath: ATSPI_SCRIPT_PATH,
  })
  return Array.isArray(response.apps) ? response.apps : []
}

/**
 * 读取某个浏览器实例的 AX 树。
 * @param {object} a11yEnv 子进程环境。
 * @param {number} pid 浏览器进程号。
 * @param {number} maxDepth 深度上限。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<object|null>} 树根节点（找不到则 null）。
 */
export async function readBrowserTree(a11yEnv, pid, maxDepth, timeoutMs) {
  const response = await runA11y(
    a11yEnv,
    buildA11yRequest('tree', { pid, maxDepth }),
    { timeoutMs, scriptPath: ATSPI_SCRIPT_PATH },
  )
  const apps = Array.isArray(response.apps) ? response.apps : []
  if (!apps.length) return null
  return trimTree(apps[0].nodes, maxDepth)
}

/**
 * 在 AX 树里按角色 / 名称收集候选控件。
 *
 * 名称匹配同时看 name、description 与 text —— 网页里很多按钮的 name 是空的，
 * 真正的标识在文本内容里（例如「提交」按钮的 text）。
 *
 * @param {object} tree AX 树。
 * @param {{role?:string,nameContains?:string,exact?:boolean,roles?:string[],maxDepth?:number}} options 过滤条件。
 * @returns {object[]} 命中的节点列表。
 */
export function collectTargets(tree, options = {}) {
  const role = String(options.role ?? '').trim().toLowerCase()
  const nameContains = String(options.nameContains ?? '').trim().toLowerCase()
  const exact = Boolean(options.exact)
  const allowed = Array.isArray(options.roles) && options.roles.length > 0
    ? options.roles.map(entry => String(entry).toLowerCase())
    : null
  const maxDepth = Number(options.maxDepth ?? 20)

  const result = []
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > maxDepth) return
    const nodeRole = String(node.role ?? '').toLowerCase()
    const name = String(node.name ?? '')
    const description = String(node.description ?? '')
    const text = typeof node.text === 'string' ? node.text : ''

    const roleHit = role ? nodeRole === role : allowed ? allowed.includes(nodeRole) : true
    let nameHit = true
    if (nameContains) {
      if (exact) {
        nameHit = [name, description, text].some(value => String(value).trim().toLowerCase() === nameContains)
      } else {
        nameHit = `${name}\n${description}\n${text}`.toLowerCase().includes(nameContains)
      }
    }
    if (roleHit && nameHit) result.push(node)

    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) walk(child, depth + 1)
  }

  walk(tree, 0)
  return result
}

/**
 * 从候选里挑出唯一目标；命中多个且没给 index 时标记为歧义。
 * @param {object[]} nodes 候选节点。
 * @param {{index?:number}} options 选项。
 * @returns {{node:object|null,ambiguous:boolean,candidates:object[]}} 定位结果。
 */
export function resolveTarget(nodes, options = {}) {
  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : []
  const index = Number.isInteger(options.index) ? options.index : -1
  if (index >= 0) return { node: list[index] ?? null, ambiguous: false, candidates: list }
  if (list.length === 1) return { node: list[0], ambiguous: false, candidates: list }
  if (list.length > 1) return { node: null, ambiguous: true, candidates: list }
  return { node: null, ambiguous: false, candidates: [] }
}

/**
 * 在页面里按 role / 名称定位一个控件。
 * @param {object} tree AX 树。
 * @param {{role?:string,nameContains?:string,index?:number,exact?:boolean}} options 限定条件。
 * @returns {{node:object|null,ambiguous:boolean,candidates:object[]}} 定位结果。
 */
export function locateInTree(tree, options = {}) {
  const nodes = collectTargets(tree, options)
  return resolveTarget(nodes, options)
}

/**
 * 定位一个网页控件。
 *
 * 优先在**网页正文子树**里找（避免把浏览器工具栏的按钮当成页面按钮），
 * 找不到再退回整棵树——这样「点地址栏」这类目标也能命中。
 *
 * @param {object} tree AX 树。
 * @param {{role?:string,nameContains?:string,index?:number,exact?:boolean,roles?:string[]}} options 限定条件。
 * @returns {{node:object|null,ambiguous:boolean,candidates:object[],scope:string}} 定位结果。
 */
export function locateTarget(tree, options = {}) {
  const root = findPageRoot(tree)
  if (root) {
    const scoped = locateInTree(root, options)
    if (scoped.node || scoped.ambiguous) return { ...scoped, scope: 'page' }
  }
  const whole = locateInTree(tree, options)
  return { ...whole, scope: 'window' }
}

/**
 * 定位一个「可点击」的网页控件（链接 / 按钮 / 勾选框…）。
 * @param {object} tree AX 树。
 * @param {{role?:string,nameContains?:string,index?:number,exact?:boolean}} options 限定条件。
 * @returns {{node:object|null,ambiguous:boolean,candidates:object[],scope:string}} 定位结果。
 */
export function locateClickable(tree, options = {}) {
  const roles = options.role ? undefined : CLICKABLE_ROLES
  return locateTarget(tree, { ...options, roles })
}

/**
 * 定位一个「可输入」的网页控件（文本框 / 密码框 / 搜索框…）。
 * @param {object} tree AX 树。
 * @param {{role?:string,nameContains?:string,index?:number,exact?:boolean}} options 限定条件。
 * @returns {{node:object|null,ambiguous:boolean,candidates:object[],scope:string}} 定位结果。
 */
export function locateInput(tree, options = {}) {
  const roles = options.role ? undefined : INPUT_ROLES
  return locateTarget(tree, { ...options, roles })
}

/**
 * 页面里所有「可输入」控件（不区分是地址栏还是网页表单）。
 * @param {object} tree AX 树。
 * @returns {object[]} 输入控件列表。
 */
export function listInputNodes(tree) {
  return collectTargets(tree, { roles: INPUT_ROLES })
}

/**
 * 找到地址栏节点。
 * @param {object} tree AX 树。
 * @returns {object|null} 地址栏节点。
 */
export function locateAddressBar(tree) {
  const bar = findAddressBar(tree)
  if (bar) return bar
  const entries = listInputNodes(tree).filter(node =>
    String(node.role ?? '').toLowerCase() === 'entry',
  )
  const hit = entries.find(node =>
    String(node.name ?? '').toLowerCase().includes(ADDRESS_BAR_NAME.toLowerCase()),
  )
  return hit ?? entries[0] ?? null
}

/**
 * 对 AX 节点执行一个动作。
 * @param {object} a11yEnv 子进程环境。
 * @param {number} pid 浏览器进程号。
 * @param {string} path 节点路径。
 * @param {string} action 动作名（空则由脚本挑默认动作）。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<object>} 动作结果。
 */
export async function performNodeAction(a11yEnv, pid, path, action, timeoutMs) {
  return runA11y(
    a11yEnv,
    buildA11yRequest('action', { pid, path, action }),
    { timeoutMs, scriptPath: ATSPI_SCRIPT_PATH },
  )
}

/**
 * 让 AX 节点获得焦点（网页输入框与地址栏都靠它 + XTEST 键入）。
 * @param {object} a11yEnv 子进程环境。
 * @param {number} pid 浏览器进程号。
 * @param {string} path 节点路径。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<object>} 焦点结果。
 */
export async function focusNode(a11yEnv, pid, path, timeoutMs) {
  return runA11y(
    a11yEnv,
    buildA11yRequest('focus', { pid, path }),
    { timeoutMs, scriptPath: ATSPI_SCRIPT_PATH },
  )
}

/**
 * 激活浏览器窗口（XTEST 的键盘事件只发给当前 X 焦点窗口）。
 * @param {object} env X11 环境。
 * @param {object} window 窗口条目。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<boolean>} 是否激活成功。
 */
export async function activateBrowserWindow(env, window, timeoutMs) {
  if (!window?.id) return false
  try {
    await activateWindow(env, window.id, { timeoutMs })
    return true
  } catch {
    return false
  }
}

/**
 * 在坐标上做一次真实点击。
 * @param {object} env X11 环境。
 * @param {{x:number,y:number}} point 屏幕绝对坐标。
 * @param {number} timeoutMs 超时。
 */
export async function clickPoint(env, point, timeoutMs) {
  await moveMouse(env, point.x, point.y, { timeoutMs })
  await click(env, 'left', 1, { timeoutMs })
}

/**
 * 用 XTEST 往当前焦点控件里敲字。
 * @param {object} env X11 环境。
 * @param {string} text 文本。
 * @param {{clear?:boolean,submit?:boolean}} options 选项。
 * @param {number} timeoutMs 超时。
 */
export async function typeIntoFocus(env, text, options = {}, timeoutMs) {
  if (options.clear) {
    await pressKey(env, 'ctrl+a', { timeoutMs })
  }
  await typeText(env, text, { timeoutMs })
  if (options.submit) {
    await pressKey(env, 'Return', { timeoutMs })
  }
}

/**
 * 启动一个专用浏览器实例（detached，父进程退出也不影响它）。
 * @param {{command:string,argv:string[]}} plan 启动计划。
 * @param {object} env 子进程环境。
 * @returns {{ok:boolean,pid?:number,error?:string}} 启动结果。
 */
export function spawnBrowser(plan, env) {
  if (!plan?.command) return { ok: false, error: '启动计划缺少可执行文件' }
  try {
    const child = spawn(plan.command, plan.argv, {
      env,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return { ok: true, pid: child.pid }
  } catch (error) {
    return { ok: false, error: `启动浏览器失败：${error.message}` }
  }
}

/**
 * 等待某个进程在 AX 总线上注册（Chromium 启动后需要一两秒）。
 * @param {object} a11yEnv 子进程环境。
 * @param {number} pid 浏览器进程号。
 * @param {number} timeoutMs 总超时。
 * @returns {Promise<boolean>} 是否在超时前注册成功。
 */
export async function waitForA11yRegistration(a11yEnv, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const apps = await listA11yApps(a11yEnv, Math.min(timeoutMs, 10000))
      if (apps.some(app => Number(app.pid) === pid)) return true
    } catch {
      // 总线还没就绪，继续等
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

/**
 * 等待「一个新的浏览器实例」注册到 AX 总线。
 *
 * Chromium 的 zygote / renderer 会另起进程，AX 总线上报的应用进程号未必
 * 等于我们 spawn 出来的那个 pid，因此除了按 pid 匹配，还要能识别
 * 「启动后新出现的浏览器实例」。
 *
 * @param {object} a11yEnv 子进程环境。
 * @param {number} pid 我们 spawn 出来的进程号。
 * @param {number[]} beforePids 启动前已经在总线上的浏览器进程号。
 * @param {number} timeoutMs 总超时。
 * @returns {Promise<{ok:boolean,pid:number}>} 找到的实例。
 */
export async function waitForBrowserRegistration(a11yEnv, pid, beforePids, timeoutMs) {
  const known = new Set((beforePids ?? []).map(Number))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const apps = await listA11yApps(a11yEnv, Math.min(timeoutMs, 10000))
      const browsers = apps.filter(isBrowserApp)
      const byPid = browsers.find(app => Number(app.pid) === pid)
      if (byPid) return { ok: true, pid: Number(byPid.pid) }
      const fresh = browsers.find(app => !known.has(Number(app.pid)))
      if (fresh) return { ok: true, pid: Number(fresh.pid) }
    } catch {
      // 总线还没就绪，继续等
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { ok: false, pid: Number(pid) }
}

/**
 * 看某个浏览器实例是不是用了指定的 profile 目录。
 *
 * Chromium 同一个 user-data-dir 只能有一个实例在跑：第二次启动会把请求转交给
 * 已有进程然后自己退出。因此插件要先认准「这个 profile 已经有人在用」。
 *
 * @param {number|string} pid 进程号。
 * @param {string} profileDir profile 目录。
 * @returns {boolean} 是否使用了该 profile。
 */
export function browserInstanceUsesProfile(pid, profileDir) {
  if (!pid || !profileDir) return false
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return cmdline.includes(profileDir)
  } catch {
    return false
  }
}

/**
 * 在已注册的浏览器实例里找出正在用某个 profile 的那个。
 *
 * @param {object[]} apps 无障碍总线上的应用列表。
 * @param {string} profileDir profile 目录。
 * @returns {object|null} 命中的应用节点；没有则 null。
 */
export function findBrowserInstanceByProfile(apps, profileDir) {
  for (const app of Array.isArray(apps) ? apps : []) {
    if (!isBrowserApp(app)) continue
    if (browserInstanceUsesProfile(app.pid, profileDir)) return app
  }
  return null
}

/**
 * 扫 /proc，找出任何正在使用指定 profile 目录的浏览器进程（不管有没有注册到无障碍总线）。
 *
 * @param {string} profileDir profile 目录。
 * @param {object} options.procRoot proc 根目录（测试可注入）。
 * @returns {{pid:number,accessible:boolean}|null} 命中的进程。
 */
export function findProcessByProfile(profileDir, options = {}) {
  if (!profileDir) return null
  const procRoot = options.procRoot ?? '/proc'
  let entries = []
  try {
    entries = readdirSync(procRoot)
  } catch {
    return null
  }
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0) continue
    try {
      const cmdline = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8')
      if (!cmdline.includes(profileDir)) continue
      if (!/chrom(e|ium)/i.test(cmdline)) continue
      return { pid, accessible: cmdline.includes('--force-renderer-accessibility') }
    } catch {
      // 进程可能刚好退出
    }
  }
  return null
}

/**
 * 让某个浏览器实例导航到指定网址。
 *
 * 做法是「地址栏 grab_focus → 全选 → 键入 → 回车」：
 * Chromium 的地址栏不暴露可写的文本接口，只能靠真实键盘输入。
 *
 * @param {object} a11yEnv AT-SPI 子进程环境。
 * @param {object} env X11 环境。
 * @param {{pid:number,url:string,timeoutMs?:number}} options 选项。
 * @returns {Promise<{ok:boolean,error?:string}>} 结果。
 */
export async function navigateBrowser(a11yEnv, env, options = {}) {
  const { pid, url } = options
  const timeoutMs = Number(options.timeoutMs ?? 15000)
  try {
    const tree = await readBrowserTree(a11yEnv, pid, 12, timeoutMs)
    if (!tree) return { ok: false, error: '读不到浏览器实例的无障碍树。' }
    const addressBar = locateAddressBar(tree)
    if (!addressBar) {
      return { ok: false, error: '找不到地址栏：无法定位可输入的地址栏控件。' }
    }
    await focusBrowserWindow(env, pid, timeoutMs)
    const focused = await focusNode(a11yEnv, pid, addressBar.path, timeoutMs)
    if (focused && focused.focused === false) {
      return { ok: false, error: '无法把焦点交给地址栏，导航失败。' }
    }
    await typeIntoFocus(env, url, { clear: true, submit: true }, timeoutMs)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 解析「要操作哪个浏览器实例」。
 *
 * 多个 Chromium 实例在 AX 总线上的应用名都叫 "Chromium"，只能靠 pid 区分，
 * 因此优先级是：**显式 pid > 插件自己启动的那个（状态文件里的 pid）> 第一个候选**。
 *
 * @param {object} a11yEnv AT-SPI 子进程环境。
 * @param {{pid?:number,app?:string,state?:object,timeoutMs?:number}} options 选项。
 * @returns {Promise<{app:object|null,candidates:object[],apps:object[]}>} 解析结果。
 */
export async function resolveBrowserTarget(a11yEnv, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 15000)
  const apps = await listA11yApps(a11yEnv, timeoutMs)
  const browsers = apps.filter(isBrowserApp)

  const wanted = String(options.app ?? '').trim().toLowerCase()
  let candidates = browsers
  if (wanted) {
    const filtered = browsers.filter(app => String(app.name ?? '').toLowerCase().includes(wanted))
    if (filtered.length) candidates = filtered
  }

  const wantedPid = Number(options.pid) > 0 ? Number(options.pid) : 0
  if (wantedPid) {
    return {
      app: candidates.find(app => Number(app.pid) === wantedPid) ?? null,
      candidates,
      apps,
    }
  }

  const statePid = Number(options.state?.pid) > 0 ? Number(options.state.pid) : 0
  if (statePid) {
    const hit = candidates.find(app => Number(app.pid) === statePid)
    if (hit) return { app: hit, candidates, apps }
  }

  return { app: candidates[0] ?? null, candidates, apps }
}

/**
 * 找到浏览器窗口并返回它的标题（用作作用域判定与风险信号）。
 *
 * 刻意 **不** 激活窗口：这一步只读，用来在审批之前拿到窗口标题。
 *
 * @param {object} env X11 环境。
 * @param {number} pid 浏览器进程号。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<{window:object|null,title:string}>} 结果。
 */
export async function browserWindowTitle(env, pid, timeoutMs) {
  let windows = []
  try {
    windows = await listWindowsWithClass(env, { timeoutMs })
  } catch {
    windows = []
  }
  const window = pickBrowserWindow(windows, { pid })
  return { window, title: String(window?.title ?? '') }
}

/**
 * 找到浏览器窗口并激活它。
 * @param {object} env X11 环境。
 * @param {number} pid 浏览器进程号。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<{window:object|null,activated:boolean}>} 结果。
 */
export async function focusBrowserWindow(env, pid, timeoutMs) {
  let windows = []
  try {
    windows = await listWindowsWithClass(env, { timeoutMs })
  } catch {
    windows = []
  }
  const window = pickBrowserWindow(windows, { pid })
  if (!window) return { window: null, activated: false }
  const activated = await activateBrowserWindow(env, window, timeoutMs)
  return { window, activated }
}

/**
 * 在 PATH 里找一个可用的浏览器可执行文件。
 * @param {object} env X11 环境。
 * @param {string} [preferred] 首选二进制名（来自工具参数）。
 * @returns {{name:string,path:string}|null} 找到的二进制。
 */
export function findBrowserBinary(env, preferred = '') {
  const wanted = String(preferred ?? '').trim()
  if (wanted) {
    if (wanted.includes('/')) {
      return existsSync(wanted) ? { name: wanted, path: wanted } : null
    }
    const direct = findBinary(wanted, env)
    if (direct) return { name: wanted, path: direct }
  }
  for (const name of BROWSER_BINARIES) {
    const found = findBinary(name, env)
    if (found) return { name, path: found }
  }
  return null
}

/**
 * 一次性把「要操作哪个浏览器 + 它的 AX 树」准备好。
 *
 * 浏览器只暴露 AX 树这一条通路（没有 CDP），所以每次操作前都要重新读树，
 * 保证拿到的页面状态是最新的。
 *
 * @param {object} a11yEnv AT-SPI 子进程环境。
 * @param {{pid?:number,app?:string,state?:object,maxDepth?:number,timeoutMs?:number}} options 选项。
 * @returns {Promise<{pid:number,app:string,tree:object,candidates:object[]}>} 会话信息。
 */
export async function resolveBrowserSession(a11yEnv, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 15000)
  const maxDepth = Number(options.maxDepth ?? 20)
  const resolved = await resolveBrowserTarget(a11yEnv, { ...options, timeoutMs })
  if (!resolved.app) {
    const known = resolved.candidates.map(app => `${app.name}(pid ${app.pid})`).join('、')
    throw new Error(
      known
        ? `没有找到 pid 为 ${options.pid ?? '(未指定)'} 的浏览器实例。当前在线：${known}`
        : 'AX 总线上没有注册任何浏览器实例。请先用 linux_browser_launch 启动一个带 --force-renderer-accessibility 的浏览器。',
    )
  }
  const tree = await readBrowserTree(a11yEnv, resolved.app.pid, maxDepth, timeoutMs)
  if (!tree) {
    throw new Error(`浏览器实例 ${resolved.app.name}(pid ${resolved.app.pid}) 没有返回 AX 树，可能未开启 --force-renderer-accessibility。`)
  }
  return {
    pid: Number(resolved.app.pid),
    app: String(resolved.app.name ?? 'Chromium'),
    tree,
    candidates: resolved.candidates,
  }
}

/**
 * 把候选控件列表描述成给人看的几行文本（歧义报错时用）。
 * @param {object[]} nodes 候选节点。
 * @param {number} limit 最多列几条。
 * @returns {string} 文本。
 */
export function describeCandidates(nodes, limit = 8) {
  const list = Array.isArray(nodes) ? nodes : []
  if (!list.length) return '（没有候选）'
  return list
    .slice(0, limit)
    .map(node => {
      const name = String(node.name ?? '').trim()
      const text = typeof node.text === 'string' ? node.text.trim() : ''
      const label = name || text || '(无名称)'
      return `${node.role} "${label}"`
    })
    .join('、')
}

/**
 * 从 AX 树里挑出「最合适的一个动作」。
 * @param {object} node 节点。
 * @returns {string} 动作名。
 */
export function preferredActionOf(node) {
  return pickPreferredAction(node)
}

/**
 * 页面里当前可交互元素（链接 / 按钮 / 输入框）的轻量清单。
 * @param {object} tree AX 树。
 * @returns {{links:object[],buttons:object[],inputs:object[]}} 元素清单。
 */
export function pageElements(tree) {
  return collectPageElements(tree)
}

/**
 * 网页正文根节点。
 * @param {object} tree AX 树。
 * @returns {object|null} 根节点。
 */
export function pageRoot(tree) {
  return findPageRoot(tree)
}

/**
 * 节点中心坐标。
 * @param {object} node 节点。
 * @returns {{x:number,y:number}|null} 坐标。
 */
export function centerOf(node) {
  return nodeCenter(node)
}

/**
 * 节点外接矩形。
 * @param {object} node 节点。
 * @returns {object|null} 矩形。
 */
export function boxOf(node) {
  return nodeBox(node)
}

/**
 * 动作偏好顺序（供文档与测试引用）。
 * @returns {string[]} 动作名列表。
 */
export function actionPreferences() {
  return [...BROWSER_ACTION_PREFERENCES]
}
