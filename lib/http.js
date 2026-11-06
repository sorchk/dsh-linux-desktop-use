/**
 * HTTP surface for the plugin detail page.
 *
 * The "检查依赖" button and the configuration form in the DSH Plugins page call
 * these routes; the same logic backs the `linux_check_env` agent tool, so the
 * operator and the model always read one report.
 */
import { checkEnvironment } from './diagnostics.js'
import { readSettingsFile, resolveSettings, writeSettingsFile } from './settings.js'

const BASE_PATH = '/dsh-linux-desktop-use'

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
 */
export function sameOrigin(request) {
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
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
