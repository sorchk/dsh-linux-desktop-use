/**
 * 真实 X 会话下的集成测试。
 *
 * 与单元测试不同，这里跑的是真正的 X11 管道：wmctrl / xrandr / scrot / ffmpeg / xdotool。
 * 检测不到 X 会话时整组用例自动跳过，不影响无头环境下的 CI。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createTools } from '../lib/tools.js'
import { clearObservation } from '../lib/observe.js'
import { buildEnv, detectDisplay, detectXauthority } from '../lib/x11.js'

const display = detectDisplay()
const xauthority = detectXauthority()

/** 没有 X 会话时跳过整组集成用例。 */
const hasX = Boolean(display) && Boolean(xauthority)

/** 读取 PNG 头里的真实像素尺寸。 */
function pngSize(data) {
  if (!data || data.length < 24) return { width: 0, height: 0 }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  }
}

const approvalLog = []
const ctx = {
  get(name) {
    if (name === 'attachments') {
      return {
        async saveImage({ data, mediaType, name }) {
          const { width, height } = pngSize(data)
          return {
            attachmentId: `att-${Math.random().toString(36).slice(2, 10)}`,
            mediaType,
            bytes: data.length,
            width,
            height,
            name,
          }
        },
      }
    }
    if (name === 'approval') {
      return {
        async request(payload) {
          approvalLog.push(payload)
          return 'allowed-once'
        },
      }
    }
    return undefined
  },
}

const tools = new Map(createTools(ctx, {}).map(tool => [tool.name, tool]))
const execCtx = {
  signal: new AbortController().signal,
  agent: { id: 'integration-agent' },
  callId: 'integration-1',
}

async function call(name, args = {}) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`工具 ${name} 未注册`)
  return tool.execute(args, execCtx)
}

/** 采一张新观察，写操作的前置条件。 */
async function observe() {
  return call('linux_screenshot', { target: 'screen' })
}

test('集成：真实 X 会话', { skip: hasX ? false : '没有可用的 X 会话' }, async (t) => {
  await t.test('linux_displays 列出显示器与输出接口', async () => {
    const value = await call('linux_displays')
    assert.ok(value.monitors.length >= 1, '至少要有一个显示器')
    const monitor = value.monitors[0]
    assert.ok(monitor.width > 0 && monitor.height > 0, '显示器尺寸应当有效')
    assert.ok(Array.isArray(value.outputs) && value.outputs.length >= 1, '至少要有一个输出接口')
    assert.equal(value.count, value.monitors.length)
    // 渲染层不能抛错。
    const blocks = tools.get('linux_displays').output.render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
  })

  await t.test('linux_apps 列出已安装应用并标出正在运行的窗口', async () => {
    const value = await call('linux_apps')
    assert.ok(value.applications.length > 0, '至少要列出一些桌面条目')
    assert.ok(typeof value.counts.installed === 'number')
    assert.ok(Array.isArray(value.running))
    // 正在运行的应用必须带窗口明细。
    for (const group of value.running) {
      assert.ok(group.window_count >= 1, '运行中的分组至少有一个窗口')
      assert.ok(Array.isArray(group.windows))
    }
    // 关键字过滤必须生效。
    const filtered = await call('linux_apps', { query: 'thunar' })
    assert.ok(filtered.applications.length <= value.applications.length)
  })

  await t.test('linux_verify_state 报告窗口数量与焦点窗口', async () => {
    const value = await call('linux_verify_state')
    assert.ok(value.window_count >= 1, '至少要看到一个窗口')
    assert.equal(value.summary.total, value.summary.passed + value.summary.failed)
    // 没有观察时不做画面比较。
    clearObservation()
    const withoutObservation = await call('linux_verify_state')
    assert.equal(withoutObservation.screen_changed, null)
  })

  await t.test('linux_screenshot 记录观察并让 verify_state 比较画面', async () => {
    const shot = await observe()
    assert.ok(shot.image.attachmentId, '截图要有附件 id')
    assert.ok(shot.bytes > 0)
    const value = await call('linux_verify_state')
    assert.notEqual(value.screen_changed, null, '有观察指纹时必须给出画面比较结论')
    assert.ok(value.changed_ratio >= 0 && value.changed_ratio <= 1)
  })

  await t.test('linux_set_window_frame 移动并缩放窗口后还原', async () => {
    // 用自己的 xterm 窗口做实验，不打扰用户当前的窗口。
    const title = 'dsh-p0-frame-test'
    const child = spawn('xterm', ['-T', title, '-e', 'sleep 120'], {
      detached: true,
      stdio: 'ignore',
      env: buildEnv({ display, xauthority }),
    })
    child.unref()

    try {
      let target = null
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
        const windows = await call('linux_windows')
        target = windows.windows.find(win => String(win.title || '').includes(title))
        if (target) break
      }
      assert.ok(target, '测试用的 xterm 窗口应当出现')

      const original = { x: target.x, y: target.y, width: target.width, height: target.height }

      await observe()
      const moved = await call('linux_set_window_frame', {
        title_contains: title,
        x: original.x + 40,
        y: original.y + 30,
        width: 640,
        height: 420,
      })
      assert.equal(moved.window_id, target.id)
      assert.ok(moved.after, '必须回报调整后的几何')
      assert.equal(moved.after.width, 640)
      assert.equal(moved.after.height, 420)
      assert.equal(moved.after.x, original.x + 40)
      assert.equal(moved.after.y, original.y + 30)
      assert.ok(Array.isArray(moved.risks))

      // 写操作之后观察应当作废。
      await assert.rejects(() => call('linux_click', { x: 1, y: 1 }), /已作废/)

      // 还原窗口几何。
      await observe()
      await call('linux_set_window_frame', {
        window_id: target.id,
        x: original.x,
        y: original.y,
        width: original.width,
        height: original.height,
      })
    } finally {
      try {
        process.kill(-child.pid)
      } catch {
        // 测试进程可能已经退出
      }
    }
  })

  await t.test('linux_set_window_frame 参数校验', async () => {
    await assert.rejects(() => call('linux_set_window_frame', { x: 10 }), /x 与 y 必须同时提供/)
    await assert.rejects(() => call('linux_set_window_frame', { width: 100 }), /width 与 height 必须同时提供/)
    await assert.rejects(() => call('linux_set_window_frame', {}), /至少要提供 x\+y 或 width\+height 之一/)
    await assert.rejects(
      () => call('linux_set_window_frame', { title_contains: 'no-such-window-xyz', x: 1, y: 1 }),
      /没有标题包含/,
    )
  })

  await t.test('linux_activate_app 能聚焦正在运行的应用', async () => {
    const catalog = await call('linux_apps')
    const running = catalog.running.find(group => group.entry_id)
    assert.ok(running, '当前应当有能关联到桌面条目的运行中应用')

    await observe()
    const value = await call('linux_activate_app', { app: running.entry_id })
    assert.equal(value.id, running.windows[0].id)
    assert.ok(value.activatedBy)
    assert.equal(value.candidates, running.windows.length)
  })

  await t.test('linux_activate_app 找不到应用时给出明确报错', async () => {
    await assert.rejects(
      () => call('linux_activate_app', { app: 'no-such-app-xyz' }),
      /没有找到正在运行的应用/,
    )
  })
})
