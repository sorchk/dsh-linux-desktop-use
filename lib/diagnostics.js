/**
 * Dependency and permission self-check for the Linux computer-use plugin.
 *
 * One implementation, two callers: the `linux_check_env` agent tool and the
 * "检查依赖" button on the plugin detail page both come through here, so the
 * model and the operator always read the same report.
 */
import { existsSync, statSync } from 'node:fs'
import { readSettingsFile, resolveSettings } from './settings.js'
import { buildEnv, exec, findBinary } from './x11.js'

/** What each helper binary is needed for, and how badly it is needed. */
const REQUIREMENTS = [
  {
    name: 'xdotool',
    required: true,
    versionArgs: ['--version'],
    purpose: '鼠标与键盘输入注入（XTEST）',
  },
  {
    name: 'scrot',
    required: false,
    versionArgs: ['--version'],
    purpose: '屏幕截图（首选）',
  },
  {
    name: 'ffmpeg',
    required: false,
    versionArgs: ['-version'],
    purpose: '截图兜底（x11grab）与缩略图缩放',
  },
  {
    name: 'wmctrl',
    required: false,
    versionArgs: ['--version'],
    purpose: '窗口列举与激活（EWMH）',
  },
  {
    name: 'xrandr',
    required: false,
    versionArgs: ['--version'],
    purpose: '屏幕几何信息兜底',
  },
  {
    name: 'xprop',
    required: false,
    versionArgs: ['--version'],
    purpose: '窗口管理器（EWMH）探测',
  },
  {
    name: 'xdpyinfo',
    required: false,
    versionArgs: ['-version'],
    purpose: 'XTEST 扩展能力探测',
  },
]

function firstLine(text) {
  const line = String(text ?? '').split('\n').map(entry => entry.trim()).find(entry => entry.length > 0)
  return line ?? ''
}

async function probeVersion(name, args, env) {
  try {
    const { text } = await exec(name, args, { env, timeoutMs: 4000 })
    return firstLine(text)
  } catch {
    return ''
  }
}

function fileState(path) {
  if (!path) return { path: '', exists: false, readable: false, writable: false }
  try {
    const stats = statSync(path)
    return {
      path,
      exists: true,
      readable: true,
      writable: true,
      size: stats.size,
      mode: (stats.mode & 0o777).toString(8),
    }
  } catch {
    return { path, exists: existsSync(path), readable: false, writable: false }
  }
}

/**
 * 汇总 AT-SPI（无障碍）能力的可用性。
 *
 * AT-SPI 是**可选增强**：它只影响 linux_app_state / linux_set_value，
 * 缺失时只是这两个工具不可用，其余功能完全不受影响，所以这里只做状态汇总，
 * 判定逻辑单独抽出来是为了能单元测试。
 *
 * @param {{python3:{present:boolean,path:string},gi:{ready:boolean,detail:string},bus:{exists:boolean,path:string}}} probe 探测结果。
 * @returns {object} a11y 段。
 */
export function describeA11yState(probe = {}) {
  const python3 = probe.python3 ?? { present: false, path: '' }
  const gi = probe.gi ?? { ready: false, detail: '' }
  const bus = probe.bus ?? { exists: false, path: '' }

  const reasons = []
  if (!python3.present) reasons.push('缺少 python3 可执行文件')
  if (!gi.ready) reasons.push(`python3 的 gi/Atspi 绑定不可用${gi.detail ? `：${gi.detail}` : ''}`)
  if (!bus.exists) reasons.push(`无障碍总线 socket 不存在（${bus.path}）`)

  return {
    available: reasons.length === 0,
    python3: Boolean(python3.present),
    python3Path: python3.path ?? '',
    gi: Boolean(gi.ready),
    bus: Boolean(bus.exists),
    busPath: bus.path ?? '',
    detail: reasons.join('；'),
  }
}

/**
 * 探测 AT-SPI 相关的依赖是否就绪。
 * @param {object} options.env 探测用的环境。
 * @returns {Promise<object>} 探测结果。
 */
async function probeA11y(env) {
  const python3Path = findBinary('python3', env)
  const busPath = `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 0}/at-spi/bus`

  let giReady = false
  let giDetail = ''
  if (python3Path) {
    try {
      const { text } = await exec(
        python3Path,
        ['-c', 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi; print("ok")'],
        { env, timeoutMs: 6000 },
      )
      giReady = /ok/.test(text)
      if (!giReady) giDetail = firstLine(text)
    } catch (error) {
      giReady = false
      giDetail = firstLine(error?.text ?? error?.message ?? '')
    }
  } else {
    giDetail = '未找到 python3'
  }

  return {
    python3: { present: Boolean(python3Path), path: python3Path ?? '' },
    gi: { ready: giReady, detail: giDetail },
    bus: { exists: existsSync(busPath), path: busPath },
  }
}

/**
 * Run the full self-check.
 * @param options.config - the bundle configuration object, if any.
 * @param options.env - the environment to probe (defaults to the process env).
 * @returns a structured report; `ok` is true when no error-level issue was found.
 */
export async function checkEnvironment({ config = {}, env = process.env } = {}) {
  const settings = resolveSettings(config, env)
  const childEnv = buildEnv(settings)
  const issues = []

  // 1. Helper binaries.
  const binaries = []
  for (const requirement of REQUIREMENTS) {
    const path = findBinary(requirement.name, env)
    const version = path ? await probeVersion(requirement.name, requirement.versionArgs, childEnv) : ''
    binaries.push({
      name: requirement.name,
      required: requirement.required,
      purpose: requirement.purpose,
      present: Boolean(path),
      path: path ?? '',
      version,
    })
    if (!path && requirement.required) {
      issues.push({
        level: 'error',
        code: `missing-binary:${requirement.name}`,
        message: `缺少必需工具 ${requirement.name}（${requirement.purpose}），请先安装。`,
      })
    } else if (!path) {
      issues.push({
        level: 'info',
        code: `optional-binary:${requirement.name}`,
        message: `未安装可选工具 ${requirement.name}（${requirement.purpose}）。`,
      })
    }
  }

  // 2. The X session itself.
  const display = settings.display
  const displayNumber = /^:(\d+)$/.exec(display)?.[1] ?? ''
  const socketPath = displayNumber ? `/tmp/.X11-unix/X${displayNumber}` : ''
  const socketExists = socketPath ? existsSync(socketPath) : false
  if (!display) {
    issues.push({
      level: 'error',
      code: 'no-display',
      message: '未找到 X display，请设置 DISPLAY 或 DSH_LINUX_DISPLAY。',
    })
  } else if (!socketExists) {
    issues.push({
      level: 'error',
      code: 'display-socket-missing',
      message: `X socket ${socketPath} 不存在，目标桌面 ${display} 未运行。`,
    })
  }

  const xauthority = fileState(settings.xauthority)
  if (!settings.xauthority) {
    issues.push({
      level: 'warning',
      code: 'no-xauthority',
      message: '未找到 Xauthority 文件，X11 连接可能因鉴权失败。',
    })
  } else if (!xauthority.exists) {
    issues.push({
      level: 'error',
      code: 'xauthority-missing',
      message: `Xauthority 文件不存在：${settings.xauthority}`,
    })
  }

  let xtest = false
  let wm = false
  let geometry = ''
  if (display && socketExists) {
    if (findBinary('xdpyinfo', env)) {
      try {
        const { text } = await exec('xdpyinfo', [], { env: childEnv, timeoutMs: 5000 })
        xtest = /\bXTEST\b/.test(text)
      } catch {
        xtest = false
      }
    }
    if (!xtest && findBinary('xdotool', env)) {
      try {
        await exec('xdotool', ['getmouselocation'], { env: childEnv, timeoutMs: 5000 })
        xtest = true
      } catch {
        xtest = false
      }
    }
    if (findBinary('xprop', env)) {
      try {
        const { text } = await exec('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], {
          env: childEnv,
          timeoutMs: 5000,
        })
        wm = /window id #\s*0x[0-9a-f]+/i.test(text)
      } catch {
        wm = false
      }
    }
    if (findBinary('xdotool', env)) {
      try {
        const { text } = await exec('xdotool', ['getdisplaygeometry'], { env: childEnv, timeoutMs: 5000 })
        geometry = firstLine(text)
      } catch {
        geometry = ''
      }
    }
    if (!xtest) {
      issues.push({
        level: 'error',
        code: 'no-xtest',
        message: '目标会话未启用 XTEST，鼠标与键盘注入不可用。',
      })
    }
    if (!wm) {
      issues.push({
        level: 'warning',
        code: 'no-ewmh',
        message: '未检测到 EWMH 窗口管理器，窗口列举与激活可能不可用。',
      })
    }
  }

  // 3. The plugin's own configuration.
  const file = readSettingsFile(env)
  const configState = fileState(file.path)
  if (!configState.exists) {
    issues.push({
      level: 'info',
      code: 'config-missing',
      message: `配置文件 ${file.path} 尚不存在，当前使用自动探测的默认值。`,
    })
  } else if (!configState.writable) {
    issues.push({
      level: 'warning',
      code: 'config-readonly',
      message: `配置文件 ${file.path} 不可写，界面上的配置修改将无法保存。`,
    })
  }

  const hostHasDisplay = Boolean(env.DISPLAY)
  if (!hostHasDisplay) {
    issues.push({
      level: 'info',
      code: 'host-without-display',
      message: 'DSH 宿主进程自身没有 DISPLAY，插件使用自动探测结果（可手动指定覆盖）。',
    })
  }

  // 4. AT-SPI（可选增强）。
  const a11y = describeA11yState(await probeA11y(childEnv))
  if (!a11y.available) {
    issues.push({
      level: 'info',
      code: 'a11y-unavailable',
      message: `无障碍树功能不可用（${a11y.detail}）。安装命令：sudo apt-get install -y at-spi2-core libatk-adaptor python3-gi gir1.2-atspi-2.0；其余工具不受影响。`,
    })
  }

  const errors = issues.filter(issue => issue.level === 'error')
  const warnings = issues.filter(issue => issue.level === 'warning')

  return {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    settings: {
      display: settings.display,
      xauthority: settings.xauthority,
      approvalMode: settings.approvalMode,
      requireApproval: settings.requireApproval,
      ttlMs: settings.ttlMs,
      allowedWindows: settings.allowedWindows,
      timeoutMs: settings.timeoutMs,
      configPath: settings.configPath,
    },
    binaries,
    x11: {
      display,
      socketPath,
      socketExists,
      xauthority: xauthority.path,
      xauthorityExists: xauthority.exists,
      xauthorityMode: xauthority.mode ?? '',
      xtest,
      ewmh: wm,
      geometry,
    },
    config: {
      path: file.path,
      exists: configState.exists,
      writable: configState.writable,
      mode: configState.mode ?? '',
      values: file.values,
    },
    a11y,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      binariesPresent: binaries.filter(entry => entry.present).length,
      binariesTotal: binaries.length,
    },
    issues,
  }
}
