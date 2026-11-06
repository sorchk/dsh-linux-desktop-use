/**
 * X11 / Linux session helpers.
 *
 * The DSH host process does not inherit DISPLAY / XAUTHORITY from the desktop
 * session, so every helper here resolves the display itself:
 *   1. explicit override (config file or DSH_LINUX_* environment variable)
 *   2. process environment
 *   3. /tmp/.X11-unix/X* sockets
 *   4. ~/.vnc/xdev:<n>.pid leftovers of a KasmVNC/Xvnc server
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Locate an executable inside PATH. */
export function findBinary(name, env = process.env) {
  const dirs = String(env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Resolve the X display of the running desktop session. */
export function detectDisplay(env = process.env) {
  if (env.DISPLAY) return env.DISPLAY
  const socketDir = '/tmp/.X11-unix'
  if (existsSync(socketDir)) {
    const sockets = readdirSync(socketDir)
      .filter(name => /^X\d+$/.test(name))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    if (sockets.length > 0) return `:${sockets[0].slice(1)}`
  }
  const home = env.HOME
  if (home) {
    const vncDir = join(home, '.vnc')
    if (existsSync(vncDir)) {
      const pidFile = readdirSync(vncDir).find(name => /^xdev:\d+\.pid$/.test(name))
      if (pidFile) return `:${pidFile.match(/^xdev:(\d+)\.pid$/)[1]}`
    }
  }
  return ''
}

/** Resolve the MIT-MAGIC-COOKIE file used to authenticate against the X server. */
export function detectXauthority(env = process.env) {
  if (env.XAUTHORITY) return env.XAUTHORITY
  const home = env.HOME
  if (!home) return ''
  for (const candidate of [join(home, '.Xauthority'), join(home, '.vnc', '.Xauthority')]) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/** Build the child-process environment for every X11 helper. */
export function buildEnv(settings) {
  const env = { ...process.env }
  if (settings.display) env.DISPLAY = settings.display
  if (settings.xauthority) env.XAUTHORITY = settings.xauthority
  return env
}

/** Run a helper binary and return its raw stdout bytes. */
export function exec(command, args, { env = process.env, timeoutMs = 20000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const out = stdout ?? Buffer.alloc(0)
        const err = (stderr ?? Buffer.alloc(0)).toString('utf8').trim()
        if (error) {
          const failure = new Error(
            err.length > 0 ? err : (error.message ?? `${command} failed`),
          )
          failure.command = `${command} ${args.join(' ')}`
          failure.exitCode = typeof error.code === 'number' ? error.code : undefined
          reject(failure)
          return
        }
        resolve({ stdout: out, text: out.toString('utf8'), stderr: err })
      },
    )
    if (input !== undefined) {
      child.stdin?.end(input)
    } else {
      child.stdin?.end()
    }
  })
}

/** Downscale PNG bytes with ffmpeg; returns the original bytes on any failure. */
export async function scaleImage(env, data, maxWidth, { timeoutMs = 20000 } = {}) {
  const ffmpeg = findBinary('ffmpeg', env)
  if (!ffmpeg || !Number.isFinite(maxWidth) || maxWidth <= 0) return data
  try {
    const { stdout } = await exec(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vf', `scale=${Math.round(maxWidth)}:-1:flags=lanczos`,
        '-f', 'image2pipe',
        '-vcodec', 'png',
        'pipe:1',
      ],
      { env, timeoutMs, input: data },
    )
    return stdout.length > 0 ? stdout : data
  } catch {
    return data
  }
}

/** Parse `KEY=value` output produced by `xdotool ... --shell`. */
export function parseShell(text) {
  const result = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.includes('=')) continue
    const index = trimmed.indexOf('=')
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1)
  }
  return result
}

/** Screen size in pixels. */
export async function displayGeometry(env, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (xdotool) {
    try {
      const { text } = await exec(xdotool, ['getdisplaygeometry'], { env, timeoutMs })
      const [width, height] = text.trim().split(/\s+/).map(Number)
      if (width > 0 && height > 0) return { width, height }
    } catch {
      // fall through to xrandr
    }
  }
  const xrandr = findBinary('xrandr', env)
  if (xrandr) {
    try {
      const { text } = await exec(xrandr, ['--current'], { env, timeoutMs })
      const match = text.match(/current\s+(\d+)\s+x\s+(\d+)/)
      if (match) return { width: Number(match[1]), height: Number(match[2]) }
    } catch {
      // fall through
    }
  }
  throw new Error('无法读取屏幕尺寸：xdotool 与 xrandr 均不可用')
}

/**
 * Capture the screen (or a region) as PNG bytes.
 * Primary backend is scrot; ffmpeg x11grab is the fallback.
 */
export async function captureScreen(env, { region, timeoutMs = 20000 } = {}) {
  const failures = []
  const scrot = findBinary('scrot', env)
  if (scrot) {
    let file
    try {
      // scrot cannot write to a pipe, so capture into a temporary file.
      file = join(tmpdir(), `dsh-linux-shot-${process.pid}-${Date.now()}.png`)
      const args = ['-z', '-o']
      if (region) {
        args.push('-a', `${region.x},${region.y},${region.width},${region.height}`)
      }
      args.push(file)
      await exec(scrot, args, { env, timeoutMs })
      const data = readFileSync(file)
      if (data.length > 0) return { data, tool: 'scrot' }
      failures.push('scrot 返回空数据')
    } catch (error) {
      failures.push(`scrot: ${error.message}`)
    } finally {
      if (file) {
        try {
          rmSync(file, { force: true })
        } catch {
          // best effort cleanup
        }
      }
    }
  }
  const ffmpeg = findBinary('ffmpeg', env)
  if (ffmpeg) {
    try {
      const size = await displayGeometry(env, { timeoutMs })
      const args = [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'x11grab',
        '-video_size', `${size.width}x${size.height}`,
        '-i', env.DISPLAY ?? '',
      ]
      if (region) {
        args.push('-vf', `crop=${region.width}:${region.height}:${region.x}:${region.y}`)
      }
      args.push('-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-')
      const { stdout } = await exec(ffmpeg, args, { env, timeoutMs })
      if (stdout.length > 0) return { data: stdout, tool: 'ffmpeg' }
      failures.push('ffmpeg 返回空数据')
    } catch (error) {
      failures.push(`ffmpeg: ${error.message}`)
    }
  }
  throw new Error(`截图失败：${failures.join('；') || '系统未安装 scrot 或 ffmpeg'}`)
}

/**
 * 解析 `wmctrl -l -G -p` / `wmctrl -lx -G -p` 的输出。
 *
 * 字段布局：
 *   不带 -x：id desktop pid x y w h host title…
 *   带  -x：id desktop pid x y w h WM_CLASS host title…
 *
 * @param {string} text wmctrl 输出。
 * @param {{host?: string, withClass?: boolean}} options 主机名与是否含 WM_CLASS。
 * @returns {object[]} 窗口列表。
 */
export function parseWindowList(text, { host = '', withClass = false } = {}) {
  const windows = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 7) continue
    let rest = parts.slice(7)
    let wmClass = ''
    if (withClass) {
      wmClass = rest.shift() ?? ''
    }
    if (host && rest[0] === host) rest.shift()
    windows.push({
      id: parts[0],
      desktop: Number(parts[1]),
      pid: Number(parts[2]),
      x: Number(parts[3]),
      y: Number(parts[4]),
      width: Number(parts[5]),
      height: Number(parts[6]),
      wmClass,
      title: rest.join(' '),
    })
  }
  return windows
}

/** List every X11 window managed by the window manager. */
export async function listWindows(env, { timeoutMs = 20000 } = {}) {
  const wmctrl = findBinary('wmctrl', env)
  if (!wmctrl) throw new Error('系统缺少 wmctrl，无法列出窗口')
  const { text } = await exec(wmctrl, ['-l', '-G', '-p'], { env, timeoutMs })
  return parseWindowList(text, { host: hostname() })
}

/** List windows together with their WM_CLASS (instance.class). */
export async function listWindowsWithClass(env, { timeoutMs = 20000 } = {}) {
  const wmctrl = findBinary('wmctrl', env)
  if (!wmctrl) throw new Error('系统缺少 wmctrl，无法列出窗口')
  const { text } = await exec(wmctrl, ['-lx', '-G', '-p'], { env, timeoutMs })
  return parseWindowList(text, { host: hostname(), withClass: true })
}

/** Geometry + title of the focused window. */
export async function activeWindow(env, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法读取活动窗口')
  const [idResult, nameResult, geometryResult] = await Promise.all([
    exec(xdotool, ['getactivewindow'], { env, timeoutMs }),
    exec(xdotool, ['getactivewindow', 'getwindowname'], { env, timeoutMs }),
    exec(xdotool, ['getactivewindow', 'getwindowgeometry', '--shell'], { env, timeoutMs }),
  ])
  const geometry = parseShell(geometryResult.text)
  return {
    id: idResult.text.trim(),
    title: nameResult.text.trim(),
    x: Number(geometry.X ?? 0),
    y: Number(geometry.Y ?? 0),
    width: Number(geometry.WIDTH ?? 0),
    height: Number(geometry.HEIGHT ?? 0),
  }
}

/** Geometry of one window id. */
export async function windowGeometry(env, windowId, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法读取窗口几何信息')
  const { text } = await exec(xdotool, ['getwindowgeometry', '--shell', windowId], { env, timeoutMs })
  const geometry = parseShell(text)
  return {
    x: Number(geometry.X ?? 0),
    y: Number(geometry.Y ?? 0),
    width: Number(geometry.WIDTH ?? 0),
    height: Number(geometry.HEIGHT ?? 0),
  }
}

/** Current pointer position. */
export async function pointerLocation(env, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法读取鼠标位置')
  const { text } = await exec(xdotool, ['getmouselocation', '--shell'], { env, timeoutMs })
  const shell = parseShell(text)
  return { x: Number(shell.X ?? 0), y: Number(shell.Y ?? 0), screen: Number(shell.SCREEN ?? 0) }
}

/** Raise and focus a window. */
export async function activateWindow(env, windowId, { timeoutMs = 20000 } = {}) {
  const wmctrl = findBinary('wmctrl', env)
  if (wmctrl) {
    try {
      await exec(wmctrl, ['-i', '-a', windowId], { env, timeoutMs })
      return 'wmctrl'
    } catch {
      // fall through to xdotool
    }
  }
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 wmctrl 与 xdotool，无法切换窗口')
  await exec(xdotool, ['windowactivate', '--sync', windowId], { env, timeoutMs })
  return 'xdotool'
}

/** Move the pointer to an absolute position. */
export async function moveMouse(env, x, y, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法移动鼠标')
  await exec(xdotool, ['mousemove', '--sync', String(x), String(y)], { env, timeoutMs })
}

/** Click at the current pointer position. */
export async function click(env, button, clicks = 1, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法点击')
  const args = ['click']
  if (clicks > 1) args.push('--repeat', String(clicks))
  args.push(String(button))
  await exec(xdotool, args, { env, timeoutMs })
}

/** Press, move and release the mouse for a drag gesture. */
export async function drag(env, fromX, fromY, toX, toY, button = 1, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法拖拽')
  await exec(xdotool, ['mousemove', '--sync', String(fromX), String(fromY)], { env, timeoutMs })
  await exec(xdotool, ['mousedown', String(button)], { env, timeoutMs })
  await exec(xdotool, ['mousemove', '--sync', String(toX), String(toY)], { env, timeoutMs })
  await exec(xdotool, ['mouseup', String(button)], { env, timeoutMs })
}

/** Type a literal string. */
export async function typeText(env, text, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法输入文本')
  if (!/[^\x00-\x7f]/.test(text)) {
    await exec(xdotool, ['type', '--delay', '12', '--', text], { env, timeoutMs })
    return
  }
  // 含非 ASCII 时，xdotool 需要临时重映射键位才能打出中文等字符；
  // 一次输入多个字符会互相覆盖重映射，从而丢字。
  // 因此：ASCII 连续段一次输入，非 ASCII 字符逐个单独输入并留出重映射时间。
  const isAscii = (char) => char.codePointAt(0) < 0x80
  let asciiRun = ''
  const flushAscii = async () => {
    if (!asciiRun) return
    await exec(xdotool, ['type', '--delay', '12', '--', asciiRun], { env, timeoutMs })
    asciiRun = ''
  }
  for (const char of Array.from(text)) {
    if (isAscii(char)) {
      asciiRun += char
      continue
    }
    await flushAscii()
    await exec(xdotool, ['type', '--delay', '30', '--', char], { env, timeoutMs })
    await new Promise(resolve => setTimeout(resolve, 90))
  }
  await flushAscii()
}

/** Send a key combination such as `ctrl+s` or `Return`. */
export async function pressKey(env, keys, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法发送按键')
  await exec(xdotool, ['key', '--clearmodifiers', keys], { env, timeoutMs })
}

/** Scroll wheel gesture. */
export async function scroll(env, direction, amount = 3, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法滚动')
  const button = { up: 4, down: 5, left: 6, right: 7 }[direction]
  if (!button) throw new Error(`未知的滚动方向：${direction}`)
  await exec(xdotool, ['click', '--repeat', String(Math.max(1, amount)), String(button)], { env, timeoutMs })
}

/**
 * 解析 `xrandr --listmonitors` 输出。
 * 形如：` 0: +VNC-0 1882/498x1040/275+0+0  VNC-0`（`+` 表示主屏）。
 */
export function parseXrandrMonitors(text) {
  const monitors = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+):\s*([+*]?)(\S+)\s+(\d+)\/(\d+)x(\d+)\/(\d+)([+-]\d+)([+-]\d+)\s*(.*)$/.exec(line)
    if (!match) continue
    monitors.push({
      index: Number(match[1]),
      name: match[3],
      primary: match[2] === '+',
      width: Number(match[4]),
      widthMm: Number(match[5]),
      height: Number(match[6]),
      heightMm: Number(match[7]),
      x: Number(match[8]),
      y: Number(match[9]),
      outputs: match[10] ?? '',
    })
  }
  return monitors
}

/**
 * 解析 `xrandr --current` 输出，取每个输出接口的连接状态与可用模式。
 */
export function parseXrandrCurrent(text) {
  const outputs = []
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const header = /^(\S+)\s+(connected|disconnected)(\s+primary)?\s*(\d+)x(\d+)\+(-?\d+)\+(-?\d+)?/.exec(trimmed)
    if (header && !trimmed.startsWith('Screen')) {
      current = {
        name: header[1],
        connected: header[2] === 'connected',
        primary: Boolean(header[3]),
        width: Number(header[4]),
        height: Number(header[5]),
        x: Number(header[6]),
        y: Number(header[7] ?? 0),
        modes: [],
      }
      outputs.push(current)
      continue
    }
    const disconnected = /^(\S+)\s+disconnected/.exec(trimmed)
    if (disconnected) {
      current = {
        name: disconnected[1],
        connected: false,
        primary: false,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        modes: [],
      }
      outputs.push(current)
      continue
    }
    const mode = /^\d+x\d+/.exec(trimmed)
    if (mode && current) {
      current.modes.push(trimmed.split(/\s+/)[0])
    }
  }
  return outputs
}

/** 列出显示器（含 xrandr 未安装时的空列表）。 */
export async function listDisplays(env, { timeoutMs = 20000 } = {}) {
  const xrandr = findBinary('xrandr', env)
  if (!xrandr) throw new Error('系统缺少 xrandr，无法列出显示器')
  const monitors = []
  const outputs = []
  try {
    const listed = await exec(xrandr, ['--listmonitors'], { env, timeoutMs })
    monitors.push(...parseXrandrMonitors(listed.text))
  } catch {
    // 某些 xrandr 版本不支持 --listmonitors
  }
  try {
    const current = await exec(xrandr, ['--current'], { env, timeoutMs })
    outputs.push(...parseXrandrCurrent(current.text))
  } catch {
    // 忽略
  }
  return { monitors, outputs }
}

/** 窗口当前是否处于最大化状态。 */
export async function isWindowMaximized(env, windowId, { timeoutMs = 20000 } = {}) {
  const xprop = findBinary('xprop', env)
  if (!xprop) return false
  try {
    const { text } = await exec(xprop, ['-id', windowId, '_NET_WM_STATE'], { env, timeoutMs })
    return /_NET_WM_STATE_MAXIMIZED_(VERT|HORZ)/.test(text)
  } catch {
    return false
  }
}

/**
 * 设置窗口位置与尺寸。
 * 最大化状态下窗口管理器会忽略几何请求，因此先解除最大化再改几何。
 */
export async function setWindowFrame(env, windowId, frame = {}, { timeoutMs = 20000 } = {}) {
  const xdotool = findBinary('xdotool', env)
  if (!xdotool) throw new Error('系统缺少 xdotool，无法调整窗口几何')

  let before = null
  try {
    before = await windowGeometry(env, windowId, { timeoutMs })
  } catch {
    before = null
  }

  let unmaximized = false
  if (await isWindowMaximized(env, windowId, { timeoutMs })) {
    const wmctrl = findBinary('wmctrl', env)
    if (wmctrl) {
      await exec(wmctrl, ['-i', '-r', windowId, '-b', 'remove,maximized_vert,maximized_horz'], { env, timeoutMs })
      unmaximized = true
    }
  }

  if (Number.isFinite(frame.width) && Number.isFinite(frame.height)) {
    await exec(xdotool, ['windowsize', windowId, String(Math.round(frame.width)), String(Math.round(frame.height))], { env, timeoutMs })
  }
  if (Number.isFinite(frame.x) && Number.isFinite(frame.y)) {
    await moveWindowTo(env, xdotool, windowId, frame.x, frame.y, { timeoutMs })
  }

  let after = null
  try {
    after = await windowGeometry(env, windowId, { timeoutMs })
  } catch {
    after = null
  }
  return { before, after, unmaximized }
}

/**
 * 把窗口移动到目标坐标。
 *
 * 带边框的窗口管理器（实测 XFCE 4.18）会在重绘装饰边框时给客户端窗口加一个固定偏移，
 * 一次 windowmove 落不到目标点上。这里读取实际位置后按差值二次修正，最多尝试 3 次。
 */
async function moveWindowTo(env, xdotool, windowId, targetX, targetY, { timeoutMs = 20000, attempts = 3, tolerance = 2 } = {}) {
  let requestX = Math.round(targetX)
  let requestY = Math.round(targetY)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await exec(xdotool, ['windowmove', windowId, String(requestX), String(requestY)], { env, timeoutMs })

    let actual = null
    try {
      actual = await windowGeometry(env, windowId, { timeoutMs })
    } catch {
      break
    }
    const deltaX = Math.round(targetX) - actual.x
    const deltaY = Math.round(targetY) - actual.y
    if (Math.abs(deltaX) <= tolerance && Math.abs(deltaY) <= tolerance) break
    // 差值来自窗口装饰边框，把差值补到下一次请求里即可对齐。
    requestX = requestX + deltaX
    requestY = requestY + deltaY
  }
}

/**
 * 把 PNG 截图转成 64x36 的灰度指纹（2304 字节），用于快速比较画面是否变化。
 * @returns {Promise<Buffer|null>} 指纹字节；ffmpeg 不可用或转换失败时返回 null。
 */
export async function captureFingerprint(env, data, { timeoutMs = 20000, width = 64, height = 36 } = {}) {
  const ffmpeg = findBinary('ffmpeg', env)
  if (!ffmpeg || !data || !data.length) return null
  try {
    const { stdout } = await exec(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vf', `scale=${width}:${height},format=gray`,
        '-f', 'rawvideo',
        '-pix_fmt', 'gray',
        'pipe:1',
      ],
      { env, timeoutMs, input: data },
    )
    return stdout.length > 0 ? stdout : null
  } catch {
    return null
  }
}

/** Report which helper binaries are installed. */
export function binaryStatus(env) {
  const names = ['xdotool', 'wmctrl', 'scrot', 'ffmpeg', 'xrandr', 'xprop', 'xclip']
  const status = {}
  for (const name of names) status[name] = findBinary(name, env) ?? null
  return status
}
