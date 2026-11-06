/**
 * 「一键安装」HTTP 路由的安全边界测试。
 *
 * 只测试**不会真的安装东西**的路径：
 *   - GET 轮询安装任务的状态，
 *   - 跨站 / 无 Origin 的 POST 一律被拒绝（第三方页面不能让宿主装包）。
 *
 * 同源 POST 会真正触发 apt-get，因此不在单元测试里触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes } from '../lib/http.js'

/** 收集注册进来的路由，模拟宿主的 webServer 服务。 */
function fakeHost() {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  return { routes, ctx: { webServer } }
}

/** 构造一个假请求。 */
function makeRequest({ method = 'GET', headers = {}, body = '' } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body)
    },
  }
}

/** 构造一个假响应，记录状态码与响应体。 */
function makeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers = {}) {
      state.status = status
      state.headers = headers
    },
    end(payload = '') {
      state.body = typeof payload === 'string' ? payload : String(payload)
    },
  }
}

test('安装路由已注册', () => {
  const host = fakeHost()
  const dispose = registerRoutes(host.ctx, {})
  const paths = host.routes.map(route => route.path)
  assert.ok(paths.includes('/dsh-linux-desktop-use/install'), '缺少 /install 路由')
  assert.ok(paths.includes('/dsh-linux-desktop-use/check'), '缺少 /check 路由')
  dispose()
})

test('GET /install 返回当前任务状态', async () => {
  const host = fakeHost()
  const dispose = registerRoutes(host.ctx, {})
  const route = host.routes.find(entry => entry.path === '/dsh-linux-desktop-use/install')
  const response = makeResponse()
  await route.handler(makeRequest({ headers: { host: '127.0.0.1:3080' } }), response)
  assert.equal(response.state.status, 200)
  const payload = JSON.parse(response.state.body)
  assert.equal(typeof payload.running, 'boolean')
  dispose()
})

test('POST /install 拒绝跨站请求', async () => {
  const host = fakeHost()
  const dispose = registerRoutes(host.ctx, {})
  const route = host.routes.find(entry => entry.path === '/dsh-linux-desktop-use/install')
  const response = makeResponse()
  await route.handler(
    makeRequest({
      method: 'POST',
      headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' },
      body: '{}',
    }),
    response,
  )
  assert.equal(response.state.status, 403)
  dispose()
})

test('POST /install 拒绝 sec-fetch-site: cross-site 的请求', async () => {
  const host = fakeHost()
  const dispose = registerRoutes(host.ctx, {})
  const route = host.routes.find(entry => entry.path === '/dsh-linux-desktop-use/install')
  const response = makeResponse()
  await route.handler(
    makeRequest({
      method: 'POST',
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    }),
    response,
  )
  assert.equal(response.state.status, 403)
  dispose()
})

test('POST /install 拒绝缺少 Origin 的请求', async () => {
  const host = fakeHost()
  const dispose = registerRoutes(host.ctx, {})
  const route = host.routes.find(entry => entry.path === '/dsh-linux-desktop-use/install')
  const response = makeResponse()
  await route.handler(
    makeRequest({ method: 'POST', headers: { host: '127.0.0.1:3080' }, body: '{}' }),
    response,
  )
  assert.equal(response.state.status, 403)
  dispose()
})

test('POST /install 不接受任意软件包名（只认目录 id）', async () => {
  const host = fakeHost()
  const dispose = registerRoutes(host.ctx, {})
  const route = host.routes.find(entry => entry.path === '/dsh-linux-desktop-use/install')
  const response = makeResponse()
  await route.handler(
    makeRequest({
      method: 'POST',
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      body: JSON.stringify({ ids: ['definitely-not-a-catalog-id'] }),
    }),
    response,
  )
  // 目录里没有这个 id → 没有可安装的包 → 直接拒绝，不会安装任何东西。
  assert.equal(response.state.status, 400)
  assert.match(JSON.parse(response.state.body).error, /没有缺失的依赖/)
  dispose()
})
