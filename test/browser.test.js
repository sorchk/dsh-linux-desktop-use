/**
 * 浏览器工具（linux_browser_*）的单元测试。
 *
 * 这里只测纯逻辑部分：AX 树解析、目标定位、启动计划。
 * 需要真实 X 会话与 Chromium 的部分放在 integration.test.js 里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADDRESS_BAR_NAME,
  BROWSER_ACTION_PREFERENCES,
  BROWSER_BINARIES,
  CLICKABLE_ROLES,
  INPUT_ROLES,
  PAGE_ROOT_ROLE,
  REQUIRED_BROWSER_FLAGS,
  buildBrowserLaunchPlan,
  collectPageElements,
  extractPageText,
  extractPageTitle,
  extractPageUrl,
  findAddressBar,
  findPageRoot,
  pickPreferredAction,
  summarizePage,
} from '../lib/browser.js'
import {
  collectTargets,
  describeCandidates,
  locateClickable,
  locateInput,
  locateTarget,
  resolveTarget,
} from '../lib/browser-runtime.js'
import { createTools } from '../lib/tools.js'
import { WRITE_TOOLS } from '../lib/guard.js'

/**
 * 造一棵模拟 Chromium 的 AX 树。
 * @param {object} options 覆盖项。
 * @returns {object} 树根节点。
 */
function makeTree(options = {}) {
  const {
    title = 'Example Domain',
    url = 'https://example.com/',
    linkName = 'Learn more',
    inputName = 'Search',
  } = options
  return {
    role: 'application',
    name: 'Chromium',
    path: '',
    children: [
      {
        role: 'frame',
        name: `${title} - Chromium`,
        path: '0',
        children: [
          {
            role: 'entry',
            name: ADDRESS_BAR_NAME,
            text: url,
            path: '0.0',
            actions: ['activate', 'showContextMenu'],
            children: [],
          },
          {
            role: PAGE_ROOT_ROLE,
            name: title,
            text: '￼￼',
            path: '0.1',
            children: [
              {
                role: 'heading',
                name: title,
                text: title,
                path: '0.1.0',
                children: [],
              },
              {
                role: 'static',
                name: 'body text',
                text: 'body text',
                path: '0.1.1',
                children: [],
              },
              {
                role: 'link',
                name: linkName,
                text: linkName,
                path: '0.1.2',
                actions: ['jump', 'showContextMenu'],
                children: [],
              },
              {
                role: 'entry',
                name: inputName,
                text: '',
                path: '0.1.3',
                actions: ['activate'],
                children: [],
              },
              {
                role: 'push button',
                name: 'Go',
                text: '',
                path: '0.1.4',
                actions: ['press'],
                children: [],
              },
            ],
          },
        ],
      },
    ],
  }
}

test('浏览器常量符合预期', () => {
  assert.ok(BROWSER_BINARIES.includes('chromium'))
  assert.ok(BROWSER_BINARIES.includes('google-chrome'))
  assert.deepEqual(REQUIRED_BROWSER_FLAGS, ['--force-renderer-accessibility'])
  assert.equal(ADDRESS_BAR_NAME, 'Address and search bar')
  assert.equal(PAGE_ROOT_ROLE, 'document web')
  assert.ok(CLICKABLE_ROLES.includes('link'))
  assert.ok(INPUT_ROLES.includes('entry'))
  assert.equal(BROWSER_ACTION_PREFERENCES[0], 'jump')
})

test('启动计划带上无障碍参数，但绝不带 CDP 端口', () => {
  const plan = buildBrowserLaunchPlan({
    binary: '/usr/bin/chromium',
    profileDir: '/tmp/profile',
    url: 'https://example.com',
    extraArgs: ['--window-size=800,600'],
  })
  assert.equal(plan.command, '/usr/bin/chromium')
  assert.ok(plan.argv.includes('--force-renderer-accessibility'))
  assert.ok(plan.argv.includes('--user-data-dir=/tmp/profile'))
  assert.ok(plan.argv.includes('--window-size=800,600'))
  assert.ok(plan.argv.includes('https://example.com'))
  assert.ok(!plan.argv.some(arg => arg.includes('remote-debugging-port')), '不得开启 CDP 端口')
  assert.ok(!plan.argv.includes('--remote-debugging-port'))
})

test('启动计划在找不到浏览器时给出明确错误', () => {
  const plan = buildBrowserLaunchPlan({ binary: '', profileDir: '/tmp/profile' })
  assert.ok(plan.error)
  assert.match(plan.error, /浏览器|可执行文件/)
})

test('能从 AX 树里取出页面标题、地址与正文', () => {
  const tree = makeTree()
  assert.equal(extractPageTitle(tree), 'Example Domain')
  assert.equal(extractPageUrl(tree), 'https://example.com/')
  const root = findPageRoot(tree)
  assert.ok(root)
  const text = extractPageText(root)
  assert.match(text, /Example Domain/)
  assert.match(text, /body text/)
  assert.ok(!text.includes('￼'), '占位符不该出现在正文里')
})

test('页面元素按类别分组，链接与按钮能定位到', () => {
  const tree = makeTree()
  const { links, buttons, inputs } = collectPageElements(tree)
  assert.equal(links.length, 1)
  assert.equal(links[0].name, 'Learn more')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].name, 'Go')
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].name, 'Search')
})

test('summarizePage 汇总标题、地址与控件', () => {
  const summary = summarizePage(makeTree(), { textLimit: 400 })
  assert.equal(summary.title, 'Example Domain')
  assert.equal(summary.url, 'https://example.com/')
  assert.ok(summary.links.length > 0)
  assert.ok(summary.buttons.length > 0)
  assert.ok(summary.inputs.length > 0)
})

test('地址栏能按名字找到', () => {
  const bar = findAddressBar(makeTree())
  assert.ok(bar)
  assert.equal(bar.text, 'https://example.com/')
})

test('链接优先选 jump 动作，不兜底成 showContextMenu', () => {
  const link = { actions: ['jump', 'showContextMenu'] }
  assert.equal(pickPreferredAction(link), 'jump')
  // 只有 showContextMenu 时不该返回它——那会弹出右键菜单。
  assert.equal(pickPreferredAction({ actions: ['showContextMenu'] }), '')
  assert.equal(pickPreferredAction({ actions: [] }), '')
})

test('collectTargets 按角色与名称过滤，名称同时看 name/description/text', () => {
  const tree = makeTree()
  const links = collectTargets(tree, { roles: ['link'] })
  assert.equal(links.length, 1)
  assert.equal(links[0].name, 'Learn more')

  const byText = collectTargets(tree, { nameContains: 'body text' })
  assert.ok(byText.length >= 1)

  const byRole = collectTargets(tree, { role: 'push button' })
  assert.equal(byRole.length, 1)
  assert.equal(byRole[0].name, 'Go')
})

test('resolveTarget 在命中多个时报告歧义', () => {
  const nodes = [{ name: 'a' }, { name: 'b' }]
  assert.equal(resolveTarget(nodes, {}).ambiguous, true)
  assert.equal(resolveTarget(nodes, {}).node, null)
  assert.equal(resolveTarget(nodes, {}).candidates.length, 2)
  assert.equal(resolveTarget(nodes, { index: 1 }).node.name, 'b')
  assert.equal(resolveTarget([{ name: 'only' }], {}).node.name, 'only')
  assert.equal(resolveTarget([], {}).node, null)
})

test('locateTarget 先在网页正文里找，找不到再退回整棵树', () => {
  const tree = makeTree()
  const inPage = locateTarget(tree, { roles: ['link'], nameContains: 'Learn more' })
  assert.equal(inPage.scope, 'page')
  assert.equal(inPage.node.name, 'Learn more')

  // 地址栏在窗口层，不在网页正文里。
  const inWindow = locateTarget(tree, { roles: ['entry'], nameContains: ADDRESS_BAR_NAME })
  assert.equal(inWindow.scope, 'window')
})

test('locateClickable 与 locateInput 各自使用默认角色白名单', () => {
  const tree = makeTree()
  const clickable = locateClickable(tree, { nameContains: 'Learn more' })
  assert.equal(clickable.node.name, 'Learn more')

  const input = locateInput(tree, { nameContains: 'Search' })
  assert.equal(input.node.name, 'Search')

  // push button 不是可输入角色。
  assert.equal(locateInput(tree, { nameContains: 'Go' }).node, null)
})

test('describeCandidates 把候选节点列成 role "name"', () => {
  const text = describeCandidates([
    { role: 'link', name: 'A' },
    { role: 'link', name: '', text: 'B' },
    { role: 'link', name: '', text: '' },
  ])
  assert.match(text, /link "A"/)
  assert.match(text, /link "B"/)
  assert.match(text, /无名称/)
})

test('注册了 5 个浏览器工具', () => {
  const names = createTools({ get: () => null }, {}).map(tool => tool.name)
  for (const name of [
    'linux_browser_launch',
    'linux_browser_state',
    'linux_browser_click',
    'linux_browser_type',
    'linux_browser_navigate',
  ]) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
  }
})

test('浏览器写工具进入写操作集合，state 保持只读', () => {
  for (const name of [
    'linux_browser_launch',
    'linux_browser_click',
    'linux_browser_type',
    'linux_browser_navigate',
  ]) {
    assert.ok(WRITE_TOOLS.has(name), `${name} 应当属于写操作`)
  }
  assert.equal(WRITE_TOOLS.has('linux_browser_state'), false)
})

test('浏览器工具的输出 schema 至少包含关键字段', () => {
  const byName = new Map(createTools({ get: () => null }, {}).map(tool => [tool.name, tool]))
  assert.ok(byName.get('linux_browser_launch').output.schema.properties.pid)
  assert.ok(byName.get('linux_browser_launch').output.schema.properties.registered)
  assert.ok(byName.get('linux_browser_state').output.schema.properties.title)
  assert.ok(byName.get('linux_browser_state').output.schema.properties.url)
  assert.ok(byName.get('linux_browser_state').output.schema.properties.links)
  assert.ok(byName.get('linux_browser_click').output.schema.properties.method)
  assert.ok(byName.get('linux_browser_type').output.schema.properties.typed)
  assert.ok(byName.get('linux_browser_navigate').output.schema.properties.final_url)
})

test('浏览器工具把 url 与 text 声明为必填参数', () => {
  const byName = new Map(createTools({ get: () => null }, {}).map(tool => [tool.name, tool]))
  assert.ok(byName.get('linux_browser_navigate').parameters.required.includes('url'))
  assert.ok(byName.get('linux_browser_type').parameters.required.includes('text'))
})

test('浏览器工具描述里写明不涉及 CDP', () => {
  for (const tool of createTools({ get: () => null }, {})) {
    if (!tool.name.startsWith('linux_browser_')) continue
    assert.match(tool.description, /CDP/i, `${tool.name} 描述应说明与 CDP 无关`)
  }
})
