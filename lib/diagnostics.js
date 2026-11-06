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
import { DEPENDENCIES, NEED, allPackages, planInstall, summarizeDependencies } from './dependencies.js'
import { probePackages } from './installer.js'

/** How a missing dependency is reported in the issue list. */
const NEED_LEVEL = {
  [NEED.REQUIRED]: 'error',
  [NEED.RECOMMENDED]: 'warning',
  [NEED.OPTIONAL]: 'info',
}

/** How a missing dependency is worded in the issue list. */
const NEED_LABEL = {
  [NEED.REQUIRED]: '必需',
  [NEED.RECOMMENDED]: '建议',
  [NEED.OPTIONAL]: '可选',
}

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

  // 1. The dependency catalog: every helper binary **and** every system
  //    package the plugin relies on (python3-gi, gir1.2-atspi-2.0,
  //    at-spi2-core, libatk-adaptor …).
  const packageStates = await probePackages(allPackages(), { env })
  const packageStateByName = new Map(packageStates.map(entry => [entry.name, entry]))

  // AT-SPI 的功能可用性（gi 绑定 + 无障碍总线）决定 python3-gi 与
  // gir1.2-atspi-2.0 是否真的能用，因此先探测一次 a11y。
  const a11y = describeA11yState(await probeA11y(childEnv))

  const binaries = []
  const dependencies = []
  for (const entry of DEPENDENCIES) {
    const packages = entry.packages ?? []
    const entryPackages = packages
      .map(name => packageStateByName.get(name))
      .filter(Boolean)
    const packageInstalled =
      entryPackages.length > 0 && entryPackages.every(state => state.state === 'installed')

    let present = false
    let path = ''
    let version = ''
    let detail = ''

    if (entry.kind === 'binary') {
      path = findBinary(entry.binary, env) ?? ''
      present = Boolean(path)
      version = path ? await probeVersion(entry.binary, entry.versionArgs, childEnv) : ''
      if (!present && packageInstalled) {
        detail = '系统包已安装，但可执行文件不在 PATH 中'
      }
    } else {
      present = packageInstalled
      version = entryPackages.find(state => state.version)?.version ?? ''
      if (present && !a11y.gi && (entry.id === 'python3-gi' || entry.id === 'gir1.2-atspi-2.0')) {
        present = false
        detail = `软件包已安装，但 gi/Atspi 绑定导入失败：${a11y.detail || '未知原因'}`
      } else if (!present) {
        detail = entryPackages.map(state => state.detail).filter(Boolean).join('；')
      }
    }

    dependencies.push({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      need: entry.need,
      purpose: entry.purpose,
      present,
      path,
      version,
      detail,
      packages,
      packageStates: entryPackages.map(state => ({
        name: state.name,
        state: state.state,
        version: state.version,
      })),
    })

    if (entry.kind === 'binary') {
      binaries.push({
        name: entry.binary,
        required: entry.need === NEED.REQUIRED,
        need: entry.need,
        purpose: entry.purpose,
        present,
        path,
        version,
      })
    }

    if (!present) {
      issues.push({
        level: NEED_LEVEL[entry.need] ?? 'info',
        code: `missing-dependency:${entry.id}`,
        message: `缺少${NEED_LABEL[entry.need] ?? '可选'}依赖 ${entry.label}（${entry.purpose}）。`
          + (packages.length > 0 ? `安装命令：sudo apt-get install -y ${packages.join(' ')}` : ''),
      })
    }
  }

  const install = planInstall(dependencies)

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

  // 4. AT-SPI（可选增强）。a11y 已在第 1 步探测过。
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
    dependencies,
    packages: packageStates,
    install: {
      needed: install.packages.length > 0,
      packages: install.packages,
      dependencies: install.dependencies,
      command: install.command,
    },
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      binariesPresent: binaries.filter(entry => entry.present).length,
      binariesTotal: binaries.length,
      dependenciesPresent: summarizeDependencies(dependencies).present,
      dependenciesTotal: dependencies.length,
      dependenciesMissing: summarizeDependencies(dependencies).missing,
    },
    issues,
  }
}
