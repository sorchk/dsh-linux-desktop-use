/**
 * The one-click installer behind the detail page's "安装缺失依赖" button.
 *
 * What it does:
 *   1. asks dpkg which of the catalog's packages are actually installed,
 *   2. works out how it may become root (already root / passwordless sudo /
 *      pkexec), and
 *   3. runs `apt-get install -y` for the packages the catalog says are missing.
 *
 * Guardrails:
 *   - The package list comes from `lib/dependencies.js` only; the browser may
 *     pick *which* catalog ids to install, never *what* package to install.
 *   - Nothing is installed without a password: if no non-interactive privilege
 *     escalation is available the call fails with the exact command the
 *     operator has to run in a terminal.
 *   - Every attempt is appended to an audit log so a privileged action is
 *     always attributable.
 *
 * This module never handles passwords and never asks for them.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exec, findBinary } from './x11.js'

/** Where the audit log lives. */
export function auditLogPath(env = process.env) {
  const home = env.HOME || homedir()
  return join(home, '.local', 'state', 'dsh', 'linux-desktop-use-install.log')
}

/** Append one audit line. Never throws — auditing must not break the install. */
export function audit(env, line) {
  try {
    const path = auditLogPath(env)
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // A missing audit log must never abort the actual work.
  }
}

function firstLine(text) {
  return String(text ?? '')
    .split('\n')
    .map(entry => entry.trim())
    .find(entry => entry.length > 0)
}

/**
 * Ask dpkg about one package.
 *
 * @param {string} name 包名。
 * @param {object} options.env 探测用的环境。
 * @returns {Promise<{name:string,state:'installed'|'missing'|'unknown',version:string,detail:string}>}
 */
export async function probePackage(name, { env = process.env } = {}) {
  const dpkgQuery = findBinary('dpkg-query', env)
  if (!dpkgQuery) {
    const dpkg = findBinary('dpkg', env)
    if (!dpkg) {
      return { name, state: 'unknown', version: '', detail: '本机没有 dpkg，无法查询系统包状态' }
    }
    try {
      const { text } = await exec(dpkg, ['-s', name], { env, timeoutMs: 5000 })
      const version = /^Version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
      return { name, state: 'installed', version, detail: '' }
    } catch (error) {
      return { name, state: 'missing', version: '', detail: firstLine(error?.message) }
    }
  }

  try {
    const { text } = await exec(dpkgQuery, ['-W', '-f', '${Status}\t${Version}', name], {
      env,
      timeoutMs: 5000,
    })
    const [status = '', version = ''] = text.trim().split('\t')
    if (status === 'install ok installed') {
      return { name, state: 'installed', version: version.trim(), detail: '' }
    }
    return { name, state: 'missing', version: '', detail: status.trim() }
  } catch (error) {
    // dpkg-query exits non-zero for an unknown package.
    return { name, state: 'missing', version: '', detail: firstLine(error?.message) }
  }
}

/**
 * Probe several packages at once.
 * @param {string[]} names
 * @returns {Promise<Array<{name:string,state:string,version:string,detail:string}>>}
 */
export async function probePackages(names = [], { env = process.env } = {}) {
  const results = []
  for (const name of names) {
    results.push(await probePackage(name, { env }))
  }
  return results
}

/**
 * Find out how (or whether) this process may become root.
 *
 * `sudo -n` never prompts: if a password would be needed it fails, and the
 * installer then refuses instead of hanging on a hidden prompt.
 *
 * @returns {Promise<{mode:'root'|'sudo'|'pkexec'|'none',label:string,detail:string}>}
 */
export async function detectPrivilege({ env = process.env } = {}) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return { mode: 'root', label: 'root', detail: '宿主进程已经是 root' }
  }
  const sudo = findBinary('sudo', env)
  if (sudo) {
    try {
      await exec(sudo, ['-n', '-v'], { env, timeoutMs: 5000 })
      return { mode: 'sudo', label: 'sudo（免密）', detail: 'sudo 可在无需密码的情况下提权' }
    } catch (error) {
      const detail = firstLine(error?.message) ?? ''
      if (/password/i.test(detail)) {
        return { mode: 'none', label: '需要 sudo 密码', detail: 'sudo 需要密码，插件不会索取密码' }
      }
    }
  }
  if (findBinary('pkexec', env)) {
    return {
      mode: 'pkexec',
      label: 'pkexec',
      detail: '将通过 polkit 授权弹窗提权（需要图形授权代理）',
    }
  }
  return { mode: 'none', label: '无法提权', detail: '本机没有可用的非交互提权方式' }
}

/**
 * Install packages with apt-get.
 *
 * @param {string[]} packages 包名（必须来自依赖目录）。
 * @param {object} options.env 子进程环境。
 * @param {number} options.timeoutMs 单次 apt-get 的超时。
 * @param {object} options.privilege 预探测的提权方式。
 * @returns {Promise<{ok:boolean,method:string,output:string,exitCode:number,command:string}>}
 */
export async function installPackages(packages = [], {
  env = process.env,
  timeoutMs = 300000,
  privilege,
} = {}) {
  const list = packages.filter(name => typeof name === 'string' && name.length > 0)
  if (list.length === 0) {
    return { ok: true, method: 'none', output: '没有需要安装的包', exitCode: 0, command: '' }
  }

  const apt = findBinary('apt-get', env)
  if (!apt) {
    return {
      ok: false,
      method: 'none',
      output: '本机没有 apt-get，无法自动安装（Debian/Ubuntu 之外请手动安装对应软件包）',
      exitCode: -1,
      command: '',
    }
  }

  const priv = privilege ?? (await detectPrivilege({ env }))
  if (priv.mode === 'none') {
    return {
      ok: false,
      method: 'none',
      output: `无法自动提权：${priv.detail}。请在终端手动执行：sudo apt-get install -y ${list.join(' ')}`,
      exitCode: -1,
      command: `sudo apt-get install -y ${list.join(' ')}`,
    }
  }

  const childEnv = { ...env, DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' }
  const aptArgs = ['install', '-y', '-o', 'Dpkg::Use-Pty=0', ...list]

  const run = async (command, args) => {
    try {
      const { text, stderr } = await exec(command, args, { env: childEnv, timeoutMs })
      return { ok: true, output: [text, stderr].filter(Boolean).join('\n').trim(), exitCode: 0 }
    } catch (error) {
      return {
        ok: false,
        output: String(error?.message ?? error).trim(),
        exitCode: typeof error?.exitCode === 'number' ? error.exitCode : -1,
      }
    }
  }

  const invoke = async () => {
    if (priv.mode === 'root') return run(apt, aptArgs)
    if (priv.mode === 'sudo') return run(findBinary('sudo', env) ?? 'sudo', ['-n', apt, ...aptArgs])
    return run(findBinary('pkexec', env) ?? 'pkexec', aptArgs)
  }

  let result = await invoke()
  const commandLine = priv.mode === 'sudo'
    ? `sudo -n ${apt} ${aptArgs.join(' ')}`
    : `${priv.mode === 'pkexec' ? 'pkexec ' : ''}${apt} ${aptArgs.join(' ')}`

  // The package lists may be stale or empty on a fresh image: refresh once.
  if (!result.ok && /Unable to locate package|no installation candidate|NO_PUBKEY/i.test(result.output)) {
    await run(apt, ['update'])
    result = await invoke()
  }

  if (!result.ok && /password is required|a password is required/i.test(result.output)) {
    result = {
      ...result,
      output: `sudo 需要密码，插件不会索取密码。请在终端执行：sudo -v 后重试，或手动执行：${commandLine}\n${result.output}`,
    }
  }

  return { ...result, method: priv.mode, command: commandLine }
}

/**
 * Tail the interesting part of an apt-get log for the UI.
 * @param {string} output
 * @param {number} lines
 */
export function tailOutput(output, lines = 12) {
  return String(output ?? '')
    .split('\n')
    .map(entry => entry.trimEnd())
    .filter(entry => entry.length > 0)
    .slice(-lines)
    .join('\n')
}
