/**
 * guard.js —— 写操作的统一前置守卫。
 *
 * 每一件会改变桌面状态的事情，都必须先过这道门：
 *
 *   1. **观察门禁**：必须有一张新鲜的观察截图（见 observe.js），否则拒绝；
 *   2. **作用域限制**：配置了 allowedWindows 时，只允许操作白名单里的窗口；
 *   3. **危险目标识别**：文本 / 快捷键 / 窗口标题命中危险语义时记录风险项；
 *   4. **分级审批**：
 *        - `approvalMode: 'all'`       → 所有写操作都要人工批准（最严）；
 *        - `approvalMode: 'dangerous'` → 只有命中危险语义的目标才要批准；
 *        - `approvalMode: 'off'`       → 不审批（仅建议在受信任场景使用）。
 *      审批通过的唯一凭据是 `'allowed-once'`，其余结果一律失败关闭。
 */
import { requireFreshObservation } from './observe.js'

/** 会改变桌面状态、必须过守卫的工具。 */
export const WRITE_TOOLS = new Set([
  'linux_click',
  'linux_drag',
  'linux_type',
  'linux_key',
  'linux_scroll',
  'linux_activate_window',
  'linux_launch_app',
  'linux_activate_app',
  'linux_set_window_frame',
  'linux_set_value',
  'linux_browser_launch',
  'linux_browser_click',
  'linux_browser_type',
  'linux_browser_navigate',
])

/**
 * 危险语义规则。命中任意一条即视为高风险目标。
 * 词表保持克制：宁可漏判也不要把正常操作误伤成弹窗噪音。
 */
export const DANGEROUS_RULES = [
  {
    id: 'delete',
    label: '删除/清空',
    re: /删除|移除|清空|清倒|格式化|卸载|永久|trash|wipe/,
  },
  {
    id: 'payment',
    label: '支付/交易',
    re: /支付|付款|购买|下单|结账|转账|汇款|提交订单|确认交易|checkout/,
  },
  {
    id: 'credential',
    label: '账号/凭据变更',
    re: /退出登录|注销|登出|登入|修改密码|重置密码|api[\s_-]?key|token/,
  },
  {
    id: 'destructive',
    label: '破坏性命令',
    re: /rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|:\(\)\{/,
  },
]

/**
 * 在一段文本里找出命中的危险语义。
 * @param {string} text 待检查文本。
 * @returns {{id:string,label:string,match:string}[]} 命中列表（可能为空）。
 */
export function detectRisks(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const risks = []
  for (const rule of DANGEROUS_RULES) {
    const match = text.match(rule.re)
    if (match) risks.push({ id: rule.id, label: rule.label, match: match[0] })
  }
  return risks
}

/**
 * 依据工具与参数，收集本次动作的风险信号来源。
 * @param {string} toolName 工具名。
 * @param {object} args 工具参数。
 * @param {object|null} observation 最近一次观察。
 */
export function collectRiskSignals(toolName, args = {}, observation = null) {
  const signals = []
  if (toolName === 'linux_type' && typeof args.text === 'string') {
    signals.push({ source: 'typed-text', text: args.text })
  }
  if (toolName === 'linux_key' && typeof args.keys === 'string') {
    signals.push({ source: 'key-combo', text: args.keys })
  }
  if (observation && typeof observation.label === 'string' && observation.label.length > 0) {
    signals.push({ source: 'window-title', text: observation.label })
  }
  if (toolName === 'linux_activate_window' && typeof args.title_contains === 'string') {
    signals.push({ source: 'target-title', text: args.title_contains })
  }
  if (toolName === 'linux_activate_app' && typeof args.app === 'string') {
    signals.push({ source: 'target-app', text: args.app })
  }
  if (toolName === 'linux_launch_app' && typeof args.app === 'string') {
    signals.push({ source: 'target-app', text: args.app })
  }
  if (toolName === 'linux_set_window_frame' && typeof args.title_contains === 'string') {
    signals.push({ source: 'target-title', text: args.title_contains })
  }
  // 控件赋值是「直接写值」，语义风险与逐键输入同等级。
  if (toolName === 'linux_set_value' && typeof args.value === 'string') {
    signals.push({ source: 'set-value', text: args.value })
  }
  if (toolName === 'linux_set_value' && typeof args.name_contains === 'string') {
    signals.push({ source: 'target-title', text: args.name_contains })
  }
  // 浏览器工具：键入的文本与目标控件名同样带语义风险。
  if (toolName === 'linux_browser_type' && typeof args.text === 'string') {
    signals.push({ source: 'typed-text', text: args.text })
  }
  if (toolName === 'linux_browser_type' && typeof args.name_contains === 'string') {
    signals.push({ source: 'target-title', text: args.name_contains })
  }
  if (toolName === 'linux_browser_click' && typeof args.name_contains === 'string') {
    signals.push({ source: 'target-title', text: args.name_contains })
  }
  if (toolName === 'linux_browser_navigate' && typeof args.url === 'string') {
    signals.push({ source: 'typed-text', text: args.url })
  }
  if (toolName === 'linux_browser_launch' && typeof args.url === 'string') {
    signals.push({ source: 'typed-text', text: args.url })
  }
  return signals
}

/**
 * 是否需要人工审批。
 * @param {'all'|'dangerous'|'off'} mode 审批模式。
 * @param {{id:string,label:string}[]} risks 已识别的风险项。
 */
export function needsApproval(mode, risks) {
  if (mode === 'off') return false
  if (mode === 'dangerous') return risks.length > 0
  return true
}

/** 生成人类可读的审批理由。 */
function describeAction(toolName, args = {}) {
  switch (toolName) {
    case 'linux_click':
      return `点击桌面坐标 (${args.x}, ${args.y})`
    case 'linux_drag':
      return `从 (${args.from_x}, ${args.from_y}) 拖拽到 (${args.to_x}, ${args.to_y})`
    case 'linux_type':
      return `向当前窗口输入 ${String(args.text ?? '').length} 个字符`
    case 'linux_key':
      return `发送按键组合 ${args.keys ?? ''}`
    case 'linux_scroll':
      return `向 ${args.direction ?? ''} 滚动 ${args.amount ?? ''} 格`
    case 'linux_activate_window':
      return `激活窗口 ${args.window_id ?? args.title_contains ?? ''}`
    case 'linux_launch_app':
      return `启动应用 ${args.app ?? ''}`
    case 'linux_activate_app':
      return `激活应用 ${args.app ?? ''}`
    case 'linux_set_window_frame':
      return `调整窗口 ${args.window_id ?? args.title_contains ?? ''} 的位置与尺寸`
    case 'linux_set_value':
      return `设置控件 ${args.role ?? ''}${args.name_contains ? `（名称包含 "${args.name_contains}"）` : ''} 的值为 ${String(args.value ?? '').length} 个字符`
    case 'linux_browser_launch':
      return `启动浏览器专用实例${args.url ? ` 并打开 ${args.url}` : ''}`
    case 'linux_browser_click':
      return `点击网页控件 ${args.role ?? ''}${args.name_contains ? `（名称包含 "${args.name_contains}"）` : ''}`
    case 'linux_browser_type':
      return `向网页控件 ${args.role ?? ''}${args.name_contains ? `（名称包含 "${args.name_contains}"）` : ''} 输入 ${String(args.text ?? '').length} 个字符`
    case 'linux_browser_navigate':
      return `让浏览器导航到 ${args.url ?? ''}`
    default:
      return toolName
  }
}

/**
 * 请求审批。只认 `'allowed-once'`。
 * @returns {Promise<string>} 审批结果。
 */
export async function requestApproval(ctx, execCtx, toolName, reason) {
  const approval = ctx.get?.('approval') ?? ctx.approval
  if (!approval) {
    throw new Error('需要审批，但当前会话没有挂载 approval 服务')
  }
  const agent = execCtx?.agent
  if (!agent) {
    throw new Error('需要审批，但当前调用缺少 agent 上下文')
  }
  return approval.request({
    agent,
    toolName,
    callId: execCtx?.callId,
    reason,
    displayReason: { en: reason, zh: reason },
    signal: execCtx?.signal,
  })
}

/**
 * 写操作统一守卫。
 * @param ctx 插件上下文（用于取 approval 服务）。
 * @param cfg 生效配置（approvalMode / ttlMs / allowedWindows）。
 * @param execCtx 工具执行上下文（agent / callId / signal）。
 * @param options 工具名、参数、是否需要观察门禁、是否跳过作用域限制。
 * @returns {Promise<{observation:object|null,risks:object[],approval:string}>}
 */
export async function guardAction(ctx, cfg, execCtx, { toolName, args = {}, requireObservation = true, observation = null, requireApproval, ignoreScope = false }) {
  // 1. 观察门禁
  let current = observation
  if (requireObservation) {
    current = requireFreshObservation(cfg.ttlMs, toolName)
  }

  // 2. 作用域限制（只约束写操作；观察类工具不受限）
  //    ignoreScope 用于「创建新窗口」的动作（如启动浏览器实例）：
  //    它不是在操作某个已有窗口，因此不该被已有窗口的白名单拦下。
  const allowed = Array.isArray(cfg.allowedWindows) ? cfg.allowedWindows : []
  if (WRITE_TOOLS.has(toolName) && allowed.length > 0 && !ignoreScope) {
    const title = (current?.label ?? '').toLowerCase()
    const hit = allowed.some(entry => title.includes(String(entry).toLowerCase()))
    if (!hit) {
      throw new Error(
        `作用域限制：当前窗口 "${current?.label ?? '未知'}" 不在允许操作列表（${allowed.join(' / ')}）中，已拒绝。`,
      )
    }
  }

  // 3. 风险识别
  const signals = collectRiskSignals(toolName, args, current)
  const risks = []
  for (const signal of signals) {
    for (const risk of detectRisks(signal.text)) {
      if (!risks.some(existing => existing.id === risk.id)) {
        risks.push({ ...risk, source: signal.source })
      }
    }
  }

  // 4. 分级审批
  //    只有真正改变桌面状态的动作（WRITE_TOOLS）才需要人工批准；
  //    纯指针移动（linux_move_mouse）不改变界面，不产生审批噪音。
  const wantsApproval = requireApproval ?? WRITE_TOOLS.has(toolName)
  let approval = 'not-required'
  if (wantsApproval && needsApproval(cfg.approvalMode, risks)) {
    const action = describeAction(toolName, args)
    const reason = risks.length > 0
      ? `${toolName}：命中${risks.map(risk => risk.label).join('、')}（${risks.map(risk => risk.match).join('、')}）——${action}`
      : `${toolName}：${action}`
    const outcome = await requestApproval(ctx, execCtx, toolName, reason)
    if (outcome !== 'allowed-once') {
      throw new Error(`桌面操作未获批准（审批结果：${outcome}）`)
    }
    approval = outcome
  }

  return { observation: current, risks, approval }
}
