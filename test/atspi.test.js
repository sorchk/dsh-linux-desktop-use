import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildA11yEnv,
  buildA11yRequest,
  parseA11yResponse,
  trimTree,
  collectNodes,
  pickEditableNode,
  nodeBox,
  nodeCenter,
  isA11yUnavailable,
} from '../lib/atspi.js'

/** 造一棵典型的 AX 树（application → frame → 控件）。 */
function sampleTree() {
  return {
    role: 'application',
    name: 'demo-app',
    description: '',
    states: ['showing'],
    box: { x: 0, y: 0, width: 400, height: 200 },
    text: null,
    editable: false,
    actions: [],
    children: [
      {
        role: 'frame',
        name: 'atspi-demo',
        description: '',
        states: ['showing'],
        box: { x: 0, y: 0, width: 400, height: 200 },
        text: null,
        editable: false,
        actions: [],
        children: [
          {
            role: 'text',
            name: '',
            description: '',
            states: ['editable', 'focusable'],
            box: { x: 10, y: 20, width: 200, height: 24 },
            text: 'hello',
            editable: true,
            actions: [{ name: 'click', description: 'Clicks the button' }],
            children: [],
          },
          {
            role: 'push button',
            name: 'Click Me',
            description: '',
            states: ['enabled', 'sensitive'],
            box: { x: 10, y: 60, width: 120, height: 26 },
            text: null,
            editable: false,
            actions: [{ name: 'click', description: 'Clicks the button' }],
            children: [],
          },
          {
            role: 'text',
            name: '',
            description: '',
            states: [],
            box: null,
            text: 'line1\nline2',
            editable: false,
            actions: [],
            children: [],
          },
        ],
      },
    ],
  }
}

test('buildA11yEnv 带上 DISPLAY / XAUTHORITY / DBUS 会话地址', () => {
  const env = buildA11yEnv({ PATH: '/usr/bin' }, {
    display: ':1',
    xauthority: '/home/sorc/.Xauthority',
    dbusAddress: 'unix:path=/tmp/dbus-abc,guid=1',
  })
  assert.equal(env.DISPLAY, ':1')
  assert.equal(env.XAUTHORITY, '/home/sorc/.Xauthority')
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/tmp/dbus-abc,guid=1')
  assert.equal(env.PATH, '/usr/bin')
})

test('buildA11yEnv 缺少会话地址时不写入空串', () => {
  const env = buildA11yEnv({ PATH: '/usr/bin' }, { display: ':1', xauthority: '' })
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined)
  assert.equal(env.XAUTHORITY, undefined)
})

test('buildA11yEnv 显式传入的会话地址优先于环境里的旧值', () => {
  const env = buildA11yEnv({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/old' }, {
    display: ':1',
    dbusAddress: 'unix:path=/new',
  })
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/new')
})

test('buildA11yRequest 输出可解析的 JSON 文本', () => {
  const text = buildA11yRequest('setValue', { value: 'hi', role: 'text' })
  const parsed = JSON.parse(text)
  assert.equal(parsed.op, 'setValue')
  assert.equal(parsed.value, 'hi')
  assert.equal(parsed.role, 'text')
})

test('parseA11yResponse 解析合法响应', () => {
  const parsed = parseA11yResponse('{"ok":true,"apps":[]}')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.apps, [])
})

test('parseA11yResponse 对非法 JSON 抛可读错误', () => {
  assert.throws(
    () => parseA11yResponse('not json at all'),
    /AT-SPI 脚本返回了无法解析的内容/,
  )
})

test('parseA11yResponse 把 ok:false 转成错误', () => {
  assert.throws(
    () => parseA11yResponse('{"ok":false,"error":"没有找到目标"}'),
    /没有找到目标/,
  )
})

test('trimTree 按深度裁剪子树', () => {
  const trimmed = trimTree(sampleTree(), 1)
  assert.equal(trimmed.role, 'application')
  assert.equal(trimmed.children.length, 1)
  assert.equal(trimmed.children[0].role, 'frame')
  assert.equal(trimmed.children[0].children.length, 0)
})

test('trimTree 深度为 0 时只保留根节点', () => {
  const trimmed = trimTree(sampleTree(), 0)
  assert.equal(trimmed.children.length, 0)
})

test('collectNodes 扁平化整棵树', () => {
  const nodes = collectNodes(sampleTree(), {})
  const roles = nodes.map(node => node.role)
  assert.ok(roles.includes('push button'))
  assert.ok(roles.includes('frame'))
})

test('collectNodes 按 role 过滤', () => {
  const nodes = collectNodes(sampleTree(), { role: 'push button' })
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].name, 'Click Me')
})

test('collectNodes 按名称关键字过滤（不区分大小写）', () => {
  const nodes = collectNodes(sampleTree(), { nameContains: 'click me' })
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].role, 'push button')
})

test('collectNodes 名称过滤也能命中控件文本', () => {
  const nodes = collectNodes(sampleTree(), { nameContains: 'hello' })
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].editable, true)
})

test('pickEditableNode 优先选可编辑控件', () => {
  const nodes = collectNodes(sampleTree(), {})
  const picked = pickEditableNode(nodes, {})
  assert.ok(picked)
  assert.equal(picked.editable, true)
  assert.equal(picked.text, 'hello')
})

test('pickEditableNode 没有可编辑控件时返回 null', () => {
  const nodes = collectNodes(sampleTree(), { role: 'push button' })
  assert.equal(pickEditableNode(nodes, {}), null)
})

test('pickEditableNode 按 role 限定目标', () => {
  const nodes = collectNodes(sampleTree(), {})
  const picked = pickEditableNode(nodes, { role: 'text' })
  assert.ok(picked)
  assert.equal(picked.text, 'hello')
})

test('nodeBox 返回屏幕坐标矩形', () => {
  const nodes = collectNodes(sampleTree(), { role: 'push button' })
  assert.deepEqual(nodeBox(nodes[0]), { x: 10, y: 60, width: 120, height: 26 })
})

test('nodeBox 对没有坐标的节点返回 null', () => {
  const nodes = collectNodes(sampleTree(), { nameContains: 'line1' })
  assert.equal(nodeBox(nodes[0]), null)
  assert.equal(nodeCenter(nodes[0]), null)
})

test('nodeCenter 返回控件中心点', () => {
  const nodes = collectNodes(sampleTree(), { role: 'push button' })
  assert.deepEqual(nodeCenter(nodes[0]), { x: 70, y: 73 })
})

test('isA11yUnavailable 识别依赖缺失与总线未就绪', () => {
  assert.equal(isA11yUnavailable("AT-SPI: Couldn't connect to accessibility bus."), true)
  assert.equal(isA11yUnavailable("No module named 'gi'"), true)
  assert.equal(isA11yUnavailable('at-spi-bus-launcher is not running'), true)
  assert.equal(isA11yUnavailable('找不到目标控件'), false)
})
