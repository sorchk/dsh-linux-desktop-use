import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../lib/tools.js'
import { WRITE_TOOLS } from '../lib/guard.js'

const tools = createTools({ get: () => null }, {})
const names = tools.map(tool => tool.name)

test('注册了 6 个 P0 新工具', () => {
  for (const name of [
    'linux_apps',
    'linux_launch_app',
    'linux_activate_app',
    'linux_displays',
    'linux_set_window_frame',
    'linux_verify_state',
  ]) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
  }
})

test('原有工具全部保留', () => {
  for (const name of [
    'linux_screenshot',
    'linux_click',
    'linux_move_mouse',
    'linux_drag',
    'linux_type',
    'linux_key',
    'linux_scroll',
    'linux_windows',
    'linux_activate_window',
    'linux_desktop_status',
    'linux_check_env',
  ]) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
  }
})

test('三个新写工具进入写操作集合', () => {
  assert.ok(WRITE_TOOLS.has('linux_launch_app'))
  assert.ok(WRITE_TOOLS.has('linux_activate_app'))
  assert.ok(WRITE_TOOLS.has('linux_set_window_frame'))
})

test('只读工具不在写操作集合', () => {
  assert.equal(WRITE_TOOLS.has('linux_apps'), false)
  assert.equal(WRITE_TOOLS.has('linux_displays'), false)
  assert.equal(WRITE_TOOLS.has('linux_verify_state'), false)
})

test('每个工具都声明了描述、参数与输出 schema', () => {
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string', `${tool.name} 缺少描述`)
    assert.ok(tool.description.length > 0, `${tool.name} 描述为空`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} 参数 schema 无效`)
    assert.ok(Array.isArray(tool.parameters.required), `${tool.name} 缺少 required 数组`)
    assert.equal(tool.output.schema.type, 'object', `${tool.name} 输出 schema 无效`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺少 render`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺少 execute`)
  }
})

test('新工具的输出 schema 至少包含关键字段', () => {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  assert.ok(byName.get('linux_apps').output.schema.properties.applications)
  assert.ok(byName.get('linux_displays').output.schema.properties.monitors)
  assert.ok(byName.get('linux_set_window_frame').output.schema.properties.window_id)
  assert.ok(byName.get('linux_verify_state').output.schema.properties.checks)
})

test('注册了 2 个 P2 无障碍工具', () => {
  for (const name of ['linux_app_state', 'linux_set_value']) {
    assert.ok(names.includes(name), `缺少工具 ${name}`)
  }
})

test('linux_set_value 进入写操作集合，linux_app_state 保持只读', () => {
  assert.ok(WRITE_TOOLS.has('linux_set_value'))
  assert.equal(WRITE_TOOLS.has('linux_app_state'), false)
})

test('P2 工具的输出 schema 至少包含关键字段', () => {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  assert.ok(byName.get('linux_app_state').output.schema.properties.apps)
  assert.ok(byName.get('linux_app_state').output.schema.properties.nodes)
  assert.ok(byName.get('linux_set_value').output.schema.properties.changed)
  assert.ok(byName.get('linux_set_value').output.schema.properties.before)
  assert.ok(byName.get('linux_set_value').output.schema.properties.after)
})

test('linux_set_value 把 value 声明为必填参数', () => {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const params = byName.get('linux_set_value').parameters
  assert.ok(params.required.includes('value'))
  assert.equal(params.properties.value.type, 'string')
})
