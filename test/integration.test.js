/**
 * 真实 X 会话下的集成测试。
 *
 * 与单元测试不同，这里跑的是真正的 X11 管道：wmctrl / xrandr / scrot / ffmpeg / xdotool。
 * 检测不到 X 会话时整组用例自动跳过，不影响无头环境下的 CI。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTools } from '../lib/tools.js'
import { clearObservation } from '../lib/observe.js'
import { buildEnv, detectDisplay, detectXauthority, findBinary } from '../lib/x11.js'
import { BROWSER_BINARIES } from '../lib/browser.js'

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

/**
 * 判断 AT-SPI 依赖是否就绪：python3 的 gi/Atspi 绑定能导入，
 * 且无障碍总线 socket 存在。
 * @returns {Promise<{ok:boolean,reason:string}>} 检测结果。
 */
async function checkA11yReady() {
  const busPath = `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 0}/at-spi/bus`
  if (!existsSync(busPath)) {
    return { ok: false, reason: '无障碍总线不存在（需要 at-spi2-core）' }
  }
  return new Promise(resolve => {
    execFile(
      'python3',
      ['-c', 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi; print("ok")'],
      { timeout: 10000 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: 'python3 缺少 gi/Atspi 绑定' })
          return
        }
        resolve(/ok/.test(stdout) ? { ok: true, reason: '' } : { ok: false, reason: 'python3 缺少 gi/Atspi 绑定' })
      },
    )
  })
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

/**
 * AT-SPI 集成用例。
 *
 * 依赖系统装了 at-spi2-core / libatk-adaptor 与 python3-gi，缺任一项时整组跳过。
 */
test('集成：AT-SPI 无障碍树', { skip: hasX ? false : '没有可用的 X 会话' }, async (t) => {
  const a11yReady = await checkA11yReady()
  if (!a11yReady.ok) {
    t.skip(a11yReady.reason)
    return
  }

  // 起一个自己的 GTK 应用作为被测对象，避免打扰用户正在使用的窗口。
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-a11y-'))
  const scriptPath = path.join(dir, 'dsh-a11y-app.py')
  writeFileSync(
    scriptPath,
    [
      'import gi',
      "gi.require_version('Gtk', '3.0')",
      'from gi.repository import Gtk, GLib',
      "w = Gtk.Window(title='dsh-a11y-test')",
      "e = Gtk.Entry()",
      "e.set_text('original-value')",
      "b = Gtk.Button(label='Target Button')",
      'box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)',
      'box.pack_start(e, False, False, 0)',
      'box.pack_start(b, False, False, 0)',
      'w.add(box)',
      'w.show_all()',
      'GLib.timeout_add(60000, Gtk.main_quit)',
      'Gtk.main()',
    ].join('\n'),
  )

  const child = spawn('python3', [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: buildEnv({ display, xauthority }),
  })
  child.unref()

  try {
    const appName = 'dsh-a11y-app.py'

    await t.test('linux_app_state 列出应用与控件', async () => {
      let state = null
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
        state = await call('linux_app_state', { app: appName })
        if (state.apps.length > 0) break
      }
      assert.ok(state, '必须返回结果')
      assert.equal(state.apps.length, 1, '应当只列出测试应用')
      assert.equal(state.apps[0].name, appName)
      assert.ok(state.apps[0].nodes.length > 0, '应用应当有控件节点')
      assert.ok(state.counts.nodes > 0)
    })

    await t.test('linux_app_state 能按角色与名字过滤控件', async () => {
      const byRole = await call('linux_app_state', { app: appName, role: 'push button' })
      assert.equal(byRole.nodes.length, 1)
      assert.equal(byRole.nodes[0].name, 'Target Button')
      assert.ok(byRole.nodes[0].box.width > 0, '控件必须带屏幕坐标')

      const byName = await call('linux_app_state', { app: appName, name_contains: 'Target' })
      assert.equal(byName.nodes.length, 1)
    })

    await t.test('linux_app_state 能直读控件文本', async () => {
      const text = await call('linux_app_state', { app: appName, role: 'text' })
      assert.equal(text.nodes.length, 1)
      assert.equal(text.nodes[0].text, 'original-value')
    })

    await t.test('linux_set_value 写入控件文本', async () => {
      await observe()
      const value = await call('linux_set_value', {
        app: appName,
        role: 'text',
        value: 'written-by-tool',
      })
      assert.equal(value.before, 'original-value')
      assert.equal(value.after, 'written-by-tool')
      assert.equal(value.changed, true)
      assert.ok(Array.isArray(value.risks))

      // 复读确认真的写进去了。
      const after = await call('linux_app_state', { app: appName, role: 'text' })
      assert.equal(after.nodes[0].text, 'written-by-tool')
    })

    await t.test('linux_set_value 参数校验', async () => {
      await assert.rejects(() => call('linux_set_value', { app: appName }), /value|必须/i)
      await assert.rejects(
        () => call('linux_set_value', { app: 'no-such-app-xyz', value: 'x' }),
        /没有找到应用/,
      )
    })

    await t.test('linux_app_state 找不到应用时返回空列表', async () => {
      // 计划里的约定：应用可能还没注册到总线，此时返回空列表而不是报错。
      const value = await call('linux_app_state', { app: 'no-such-app-xyz' })
      assert.equal(value.apps.length, 0)
      assert.equal(value.counts.apps, 0)
      assert.equal(value.counts.nodes, 0)
    })

    await t.test('linux_app_state 的 summary 模式只报数量', async () => {
      const value = await call('linux_app_state', { app: appName, summary: true })
      assert.equal(value.summary, true)
      assert.equal(value.nodes.length, 0, 'summary 模式不逐个列出控件')
      assert.equal(value.apps.length, 1)
      assert.ok(value.apps[0].count > 0, '仍要报出控件总数')
      assert.ok(Array.isArray(value.roles) && value.roles.length > 0, '要按角色汇总')
    })
  } finally {
    try {
      process.kill(-child.pid)
    } catch {
      // 测试进程可能已经退出
    }
  }
})

/**
 * 浏览器工具（linux_browser_*）的集成用例。
 *
 * 全程走 AT-SPI 无障碍树 + XTEST，不使用 CDP：插件自己起一个带
 * --force-renderer-accessibility 的 Chromium 实例，然后读页面、导航、点击、输入。
 * 环境缺 Chromium 或无障碍总线时整组跳过。
 */
test('集成：浏览器工具（AT-SPI + XTEST，不走 CDP）', { skip: hasX ? false : '没有可用的 X 会话' }, async (t) => {
  const a11yReady = await checkA11yReady()
  if (!a11yReady.ok) {
    t.skip(a11yReady.reason)
    return
  }
  const browserBinary = BROWSER_BINARIES.map(name => findBinary(name, buildEnv({ display, xauthority })))
    .find(Boolean)
  if (!browserBinary) {
    t.skip('没有安装 Chromium / Chrome')
    return
  }

  await t.test('linux_browser_launch 起实例并注册到无障碍总线', async () => {
    const value = await call('linux_browser_launch', { url: 'about:blank' })
    assert.ok(value.pid > 0, '要拿到进程号')
    assert.ok(value.profile_dir, '要报告独立 profile 目录')
    assert.equal(value.registered, true, '实例应当注册到无障碍总线')
    assert.ok(!value.binary.includes('remote-debugging'), '不得开启 CDP 端口')
  })

  await t.test('linux_browser_state 读出页面标题、地址与控件', async () => {
    const launched = await call('linux_browser_launch', { url: 'data:text/html,<h1>BrowserToolTest</h1><p>hello</p>' })
    await new Promise(resolve => setTimeout(resolve, 1500))
    const value = await call('linux_browser_state', { pid: launched.pid })
    assert.ok(value.pid > 0)
    assert.match(value.text, /BrowserToolTest/)
    assert.match(value.text, /hello/)
    assert.ok(typeof value.url === 'string')
  })

  await t.test('linux_browser_navigate 换页并读回新地址', async () => {
    const launched = await call('linux_browser_launch', { url: 'about:blank' })
    await new Promise(resolve => setTimeout(resolve, 1200))
    const value = await call('linux_browser_navigate', {
      pid: launched.pid,
      url: 'data:text/html,<h1>Navigated</h1>',
    })
    assert.equal(value.url, 'data:text/html,<h1>Navigated</h1>')
    assert.ok(value.final_url.length > 0, '要读回地址栏里的内容')
  })

  await t.test('linux_browser_type 向输入框输入，linux_browser_click 点按钮', async () => {
    const form = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-browser-')), 'form.html')
    writeFileSync(
      form,
      [
        '<!doctype html><html><body>',
        '<h1>Form</h1>',
        '<input aria-label="Name field" type="text">',
        '<button type="button">Submit</button>',
        '<p id="out">idle</p>',
        '<script>document.querySelector("button").onclick=()=>{document.getElementById("out").textContent="done:"+document.querySelector("input").value}</script>',
        '</body></html>',
      ].join('\n'),
    )

    const launched = await call('linux_browser_launch', { url: `file://${form}` })
    await new Promise(resolve => setTimeout(resolve, 1500))

    const state = await call('linux_browser_state', { pid: launched.pid })
    assert.ok(state.inputs.some(item => item.name === 'Name field'), '要能读出输入框')
    assert.ok(state.buttons.some(item => item.name === 'Submit'), '要能读出按钮')

    const typed = await call('linux_browser_type', {
      pid: launched.pid,
      name_contains: 'Name field',
      text: '插件测试',
    })
    assert.equal(typed.typed, 4)
    assert.equal(typed.clear, true)

    const clicked = await call('linux_browser_click', {
      pid: launched.pid,
      name_contains: 'Submit',
    })
    assert.equal(clicked.method, 'atspi-action')
    assert.equal(clicked.action, 'press')

    await new Promise(resolve => setTimeout(resolve, 1000))
    const after = await call('linux_browser_state', { pid: launched.pid })
    assert.match(after.text, /done:插件测试/, '输入的内容要真的进了页面')
  })
})
