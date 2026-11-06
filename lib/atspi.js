/**
 * atspi.js —— AT-SPI 无障碍桥接（Node 侧）。
 *
 * 为什么需要这一层：AT-SPI 的应用清单只在 libatspi 的内部路径暴露，
 * 裸 D-Bus（gdbus / busctl）调 `org.a11y.atspi.Accessible.GetChildren` 恒返回空数组。
 * 所以 Node 侧不自己实现 AT-SPI 协议，而是 spawn 一个 python3 辅助脚本
 * （`lib/atspi.py`，用系统自带的 gi / Atspi 绑定），双方用 JSON 交换数据。
 *
 * 分层原则：**Python 只做「遍历 + 调接口」，一切可测试的判定逻辑都放在这里**，
 * 因此本文件的纯函数不依赖 X 会话，也不依赖 python3，可以直接单元测试。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 采集脚本的绝对路径（与本文件同目录）。 */
export const ATSPI_SCRIPT_PATH = fileURLToPath(new URL('./atspi.py', import.meta.url))

/** 默认的树深度上限。 */
export const DEFAULT_MAX_DEPTH = 8

/** 树深度上限的硬顶，防止在超大树上卡住。 */
export const MAX_MAX_DEPTH = 20

/**
 * 拼装运行采集脚本所需的环境变量。
 *
 * 采集脚本要连上 a11y 总线，必须同时具备：
 * - `DISPLAY` / `XAUTHORITY`：指向目标桌面；
 * - `DBUS_SESSION_BUS_ADDRESS`：会话总线地址，a11y 总线由它激活。
 *
 * @param {Record<string,string>} baseEnv 基础环境。
 * @param {{display?:string,xauthority?:string,dbusAddress?:string}} options 覆盖项。
 * @returns {Record<string,string>} 新的环境变量副本。
 */
export function buildA11yEnv(baseEnv = {}, options = {}) {
  const env = { ...baseEnv }
  const display = typeof options.display === 'string' ? options.display.trim() : ''
  const xauthority = typeof options.xauthority === 'string' ? options.xauthority.trim() : ''
  const dbusAddress = typeof options.dbusAddress === 'string' ? options.dbusAddress.trim() : ''

  if (display) env.DISPLAY = display
  else delete env.DISPLAY

  if (xauthority) env.XAUTHORITY = xauthority
  else delete env.XAUTHORITY

  // 显式传入的会话地址优先于环境里可能残留的旧值。
  if (dbusAddress) env.DBUS_SESSION_BUS_ADDRESS = dbusAddress
  else delete env.DBUS_SESSION_BUS_ADDRESS

  return env
}

/**
 * 构造发给采集脚本的请求。
 * @param {string} op 操作名（ping / tree / setValue）。
 * @param {object} params 附加参数。
 * @returns {string} JSON 文本。
 */
export function buildA11yRequest(op, params = {}) {
  return JSON.stringify({ op, ...params })
}

/**
 * 解析采集脚本的响应。
 * @param {string} text 脚本 stdout 的原始文本。
 * @returns {object} 解析后的响应对象。
 */
export function parseA11yResponse(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? '').trim())
  } catch {
    throw new Error('AT-SPI 脚本返回了无法解析的内容')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AT-SPI 脚本返回了无法解析的内容')
  }
  if (parsed.ok === false) {
    throw new Error(String(parsed.error ?? 'AT-SPI 脚本执行失败'))
  }
  return parsed
}

/**
 * 把一段文本里出现的 AT-SPI 依赖缺失 / 总线未就绪的迹象识别出来。
 * @param {string} text 错误文本。
 * @returns {boolean} 是否属于「AT-SPI 不可用」类错误。
 */
export function isA11yUnavailable(text) {
  const value = String(text ?? '')
  if (!value) return false
  const markers = [
    "Couldn't connect to accessibility bus",
    'No module named',
    'ModuleNotFoundError',
    'at-spi-bus-launcher',
    'at-spi2-registryd',
    'Atspi.init',
  ]
  return markers.some(marker => value.includes(marker))
}

/**
 * 把「AT-SPI 不可用」的原始错误翻译成可操作的中文提示。
 * @param {string} text 原始错误文本。
 * @returns {string} 中文提示。
 */
export function describeA11yUnavailable(text) {
  return [
    'AT-SPI 不可用：无障碍树与控件赋值功能需要额外的系统依赖。',
    '请先安装：sudo apt-get install -y at-spi2-core libatk-adaptor',
    '另外，目标应用必须在安装之后重新启动才会注册到无障碍总线。',
    `原始错误：${String(text ?? '').trim()}`,
  ].join('\n')
}

/**
 * 按深度裁剪一棵节点树。
 * @param {object} node 根节点。
 * @param {number} maxDepth 保留的最大深度（0 表示只留根节点）。
 * @returns {object} 裁剪后的树（不修改入参）。
 */
export function trimTree(node, maxDepth = DEFAULT_MAX_DEPTH) {
  if (!node || typeof node !== 'object') return node
  const limit = Math.max(0, Math.floor(Number(maxDepth) || 0))
  const children = Array.isArray(node.children) ? node.children : []
  if (limit <= 0) {
    return { ...node, children: [] }
  }
  return {
    ...node,
    children: children
      .slice(0, 200)
      .map(child => trimTree(child, limit - 1)),
  }
}

/**
 * 把树扁平化成节点列表，并按角色 / 名称过滤。
 *
 * 名称匹配同时看节点的 name、description 与 text —— 输入框这类控件的
 * 可读标识通常在文本内容里而不在名称里。
 *
 * @param {object} tree 节点树。
 * @param {{role?:string,nameContains?:string,maxDepth?:number}} options 过滤条件。
 * @returns {object[]} 命中的节点列表。
 */
export function collectNodes(tree, options = {}) {
  const role = typeof options.role === 'string' ? options.role.trim().toLowerCase() : ''
  const nameContains = typeof options.nameContains === 'string' ? options.nameContains.trim().toLowerCase() : ''
  const maxDepth = Math.max(0, Math.floor(Number(options.maxDepth ?? DEFAULT_MAX_DEPTH) || 0))
  const result = []

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > maxDepth) return
    const nodeRole = String(node.role ?? '').toLowerCase()
    const haystack = [
      String(node.name ?? ''),
      String(node.description ?? ''),
      typeof node.text === 'string' ? node.text : '',
    ].join('\n').toLowerCase()

    const roleHit = role === '' || nodeRole === role
    const nameHit = nameContains === '' || haystack.includes(nameContains)
    if (roleHit && nameHit) result.push(node)

    const children = Array.isArray(node.children) ? node.children : []
    for (const child of children) walk(child, depth + 1)
  }

  walk(tree, 0)
  return result
}

/**
 * 从候选节点里挑出要赋值的那个控件。
 *
 * 只认实现了 EditableText 的节点——赋值接口对不可编辑控件没有意义，
 * 硬写会静默失败，让模型误以为写成功了。
 *
 * @param {object[]} nodes 候选节点。
 * @param {{role?:string,nameContains?:string}} options 限定条件。
 * @returns {object|null} 选中的可编辑节点；没有则 null。
 */
export function pickEditableNode(nodes, options = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const role = typeof options.role === 'string' ? options.role.trim().toLowerCase() : ''
  const nameContains = typeof options.nameContains === 'string' ? options.nameContains.trim().toLowerCase() : ''

  const matched = list.filter(node => {
    if (!node) return false
    if (role && String(node.role ?? '').toLowerCase() !== role) return false
    if (nameContains) {
      const haystack = [
        String(node.name ?? ''),
        String(node.description ?? ''),
        typeof node.text === 'string' ? node.text : '',
      ].join('\n').toLowerCase()
      if (!haystack.includes(nameContains)) return false
    }
    return true
  })

  const editable = matched.find(node => node.editable === true)
  return editable ?? null
}

/**
 * 取节点的屏幕绝对坐标矩形。
 * @param {object} node 节点。
 * @returns {{x:number,y:number,width:number,height:number}|null} 矩形；没有则 null。
 */
export function nodeBox(node) {
  const box = node?.box
  if (!box || typeof box !== 'object') return null
  const { x, y, width, height } = box
  if (![x, y, width, height].every(value => Number.isFinite(value))) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/**
 * 取节点外接矩形的中心点（点击目标）。
 * @param {object} node 节点。
 * @returns {{x:number,y:number}|null} 中心点；没有坐标则 null。
 */
export function nodeCenter(node) {
  const box = nodeBox(node)
  if (!box) return null
  return {
    x: box.x + Math.floor(box.width / 2),
    y: box.y + Math.floor(box.height / 2),
  }
}

/**
 * 运行采集脚本。
 *
 * @param {Record<string,string>} env 子进程环境。
 * @param {string} request 请求 JSON 文本。
 * @param {{timeoutMs?:number,scriptPath?:string}} options 选项。
 * @returns {Promise<object>} 解析后的响应。
 */
export async function runA11y(env, request, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const scriptPath = options.scriptPath ?? ATSPI_SCRIPT_PATH

  const stdout = await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('python3', [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`无法启动 AT-SPI 采集脚本：${error.message}`))
      return
    }

    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已经退出
      }
      reject(new Error(`AT-SPI 采集脚本超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      out += chunk
    })
    child.stderr.on('data', chunk => {
      err += chunk
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法启动 python3：${error.message}`))
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(out)
    })

    try {
      child.stdin.write(request)
      child.stdin.end()
    } catch (error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法向 AT-SPI 采集脚本写入请求：${error.message}`))
    }

    // stderr 只在脚本异常退出时用于诊断。
    child.stderrText = () => err
  })

  try {
    return parseA11yResponse(stdout)
  } catch (error) {
    if (isA11yUnavailable(error.message)) {
      throw new Error(describeA11yUnavailable(error.message))
    }
    throw error
  }
}
