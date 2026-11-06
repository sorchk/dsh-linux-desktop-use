/**
 * DSH plugin: control the local Linux desktop from the model.
 *
 * Registers a set of desktop tools (screenshot, mouse, keyboard, scrolling,
 * window list/activate, session status, dependency check) that drive the X11
 * session the desktop is running in (KasmVNC/Xvnc + Linux on this host).
 *
 * The same plugin also serves two HTTP routes so the Plugins detail page can
 * run the dependency check and edit the configuration:
 *   GET  /dsh-linux-desktop-use/check   → the dependency report
 *   GET  /dsh-linux-desktop-use/config  → the effective settings
 *   POST /dsh-linux-desktop-use/config  → persist settings
 */
import { createTools } from './lib/tools.js'
import { registerRoutes } from './lib/http.js'

export const name = 'dsh-linux-desktop-use'

/** The plugin needs the tool registry; the attachment store is injected separately. */
export const inject = ['tools']

/**
 * Register every desktop tool and the plugin's HTTP routes.
 * @param ctx - the plugin context.
 * @param config - optional configuration handed over by the bundle patch.
 */
export function apply(ctx, config) {
  ctx.effect(() => {
    const disposers = []
    const tools = createTools(ctx, config)
    for (const tool of tools) {
      // The screenshot tool hands an image to the model, so it only exists
      // while a durable attachment store is mounted.
      if (tool.name === 'linux_screenshot') continue
      disposers.push(ctx.tools.register(tool))
    }
    ctx.inject(['attachments'], (imageCtx) => {
      const screenshot = tools.find(tool => tool.name === 'linux_screenshot')
      if (screenshot) disposers.push(imageCtx.tools.register(screenshot))
    })
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  // The detail page talks to the plugin over HTTP; the web server is optional,
  // so the plugin still works on a host that does not serve the Web UI.
  ctx.inject(['webServer'], (serverCtx) => {
    const dispose = registerRoutes(serverCtx, config)
    return () => dispose()
  })
}
