/**
 * HTTP surface for the plugin detail page.
 *
 * The "检查依赖" button and the configuration form in the DSH Plugins page call
 * these routes; the same logic backs the `linux_check_env` agent tool, so the
 * operator and the model always read one report.
 */
import { checkEnvironment } from './diagnostics.js'
import { planInstall } from './dependencies.js'
import { audit, detectPrivilege, installPackages, tailOutput } from './installer.js'
import { readSettingsFile, resolveSettings, writeSettingsFile } from './settings.js'

const BASE_PATH = '/dsh-linux-desktop-use'

/**
 * The running install job, if any.
 *
 * The install is a long privileged operation, so it runs in the background and
 * the page polls for the result — the HTTP request itself never blocks on
 * apt-get.
 */
const installJob = {
  current: null,
}

function loopbackAuthority(host) {
  const lower = String(host ?? '').toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * A same-origin guard for the routes below.
 *
 * The host serves the Web UI on loopback, so a page on another origin must not
 * be able to read the desktop's environment or rewrite its configuration.
 *
 * @param request - the incoming request.
 * @param {boolean} requireOrigin - demand an explicit matching Origin header.
 *   The privileged install route uses it: a cross-site form post carries no
 *   trustworthy Origin, and must not be able to make the host install packages.
 */
export function sameOrigin(request, { requireOrigin = false } = {}) {
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return !requireOrigin
  try {
    const originUrl = new URL(origin)
    if (originUrl.host === host) return true
    if (originUrl.port === '' && host !== undefined && loopbackAuthority(host)) {
      const hostname = host.startsWith('[')
        ? host.slice(0, host.indexOf(']') + 1)
        : host.split(':')[0]
      return originUrl.hostname === hostname
    }
    return false
  } catch {
    return false
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Register the plugin's HTTP routes on the Host web server.
 * @param ctx - the plugin context (needs the `webServer` service).
 * @param config - the bundle configuration object, if any.
 * @returns a disposer that removes the routes.
 */
export function registerRoutes(ctx, config = {}) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (!webServer) return () => {}

  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE_PATH}/check`,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'cross-origin request refused' })
        return
      }
      try {
        sendJson(response, 200, await checkEnvironment({ config }))
      } catch (error) {
        sendJson(response, 500, { error: String(error?.message ?? error) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE_PATH}/config`,
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'cross-origin request refused' })
        return
      }
      if (request.method === 'GET') {
        const file = readSettingsFile()
        sendJson(response, 200, {
          settings: resolveSettings(config),
          path: file.path,
          values: file.values,
        })
        return
      }
      try {
        const body = await readJsonBody(request)
        const values = body && typeof body.values === 'object' && body.values !== null ? body.values : {}
        const stored = writeSettingsFile(values)
        sendJson(response, 200, {
          settings: resolveSettings(config),
          path: stored.path,
          values: stored.values,
          rejected: stored.rejected,
        })
      } catch (error) {
        sendJson(response, 400, { error: String(error?.message ?? error) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE_PATH}/install`,
    handler: async (request, response) => {
      // GET → poll the running job; POST → start one.
      if (request.method === 'GET') {
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin request refused' })
          return
        }
        const job = installJob.current
        if (!job) {
          sendJson(response, 200, { running: false, job: null })
          return
        }
        sendJson(response, 200, { running: job.status === 'running', job })
        return
      }

      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
        return
      }
      // This route installs system packages: it demands a real same-origin
      // request, so a third-party page cannot make the host install anything.
      if (!sameOrigin(request, { requireOrigin: true })) {
        sendJson(response, 403, { error: 'cross-origin request refused' })
        return
      }
      if (installJob.current && installJob.current.status === 'running') {
        sendJson(response, 409, { error: '已有安装任务在执行', job: installJob.current })
        return
      }

      let ids = []
      try {
        const body = await readJsonBody(request)
        if (Array.isArray(body?.ids)) {
          ids = body.ids.filter(id => typeof id === 'string')
        }
      } catch {
        ids = []
      }

      let plan
      try {
        const report = await checkEnvironment({ config })
        plan = planInstall(report.dependencies, { ids })
      } catch (error) {
        sendJson(response, 500, { error: String(error?.message ?? error) })
        return
      }

      if (plan.packages.length === 0) {
        sendJson(response, 400, { error: '没有缺失的依赖，无需安装' })
        return
      }

      const job = {
        id: `install-${Date.now().toString(36)}`,
        status: 'running',
        packages: plan.packages,
        dependencies: plan.dependencies,
        command: plan.command,
        method: '',
        output: '',
        error: '',
        startedAt: new Date().toISOString(),
        finishedAt: '',
      }
      installJob.current = job
      audit(process.env, `start job=${job.id} packages=${plan.packages.join(',')}`)

      // Run in the background: apt-get may take minutes, the page polls.
      void (async () => {
        try {
          const privilege = await detectPrivilege()
          job.method = privilege.label
          if (privilege.mode === 'none') {
            job.status = 'failed'
            job.error = `无法自动提权：${privilege.detail}`
            job.output = `请在终端手动执行：${plan.command}`
          } else {
            const result = await installPackages(plan.packages, { privilege })
            job.status = result.ok ? 'done' : 'failed'
            job.method = result.method
            job.output = tailOutput(result.output, 20)
            job.error = result.ok ? '' : result.output
          }
        } catch (error) {
          job.status = 'failed'
          job.error = String(error?.message ?? error)
        } finally {
          job.finishedAt = new Date().toISOString()
          audit(
            process.env,
            `finish job=${job.id} status=${job.status} method=${job.method} packages=${plan.packages.join(',')}`,
          )
        }
      })()

      sendJson(response, 202, { running: true, job })
    },
  }))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A route already removed by the Host must not break teardown.
      }
    }
  }
}
