/**
 * a11y-env.js —— AT-SPI 子进程环境的统一拼装与错误翻译。
 *
 * 采集脚本（lib/atspi.py）要连上 a11y 总线，必须同时具备：
 * - `DISPLAY` / `XAUTHORITY`：指向目标桌面；
 * - `DBUS_SESSION_BUS_ADDRESS`：会话总线地址（a11y 总线由它激活）。
 *
 * 宿主进程通常没继承这些变量，因此会话总线地址从运行中的桌面进程借——
 * 与 linux_launch_app 用的是同一套办法。抽出本文件是因为浏览器工具
 * （lib/browser-runtime.js）也需要同一套环境，重复一遍容易走样。
 */
import { listWindowsWithClass } from './x11.js'
import { findSessionBusAddress } from './apps.js'
import { buildA11yEnv, isA11yUnavailable } from './atspi.js'

/**
 * 为 AT-SPI 采集脚本拼装运行环境。
 *
 * @param {object} current 生效配置。
 * @param {object} env X11 环境。
 * @returns {Promise<Record<string,string>>} 子进程环境。
 */
export async function buildA11yEnvironment(current, env) {
  let dbusAddress = ''
  try {
    const windows = await listWindowsWithClass(env, { timeoutMs: current.timeoutMs })
    const pids = windows.map(win => win.pid).filter(pid => Number.isInteger(pid) && pid > 0)
    dbusAddress = findSessionBusAddress({ env: process.env, pids })
  } catch {
    // 拿不到总线地址也照常尝试，剩下的交给脚本报错
  }
  return buildA11yEnv(env, {
    display: current.display,
    xauthority: current.xauthority,
    dbusAddress,
  })
}

/**
 * 把 AT-SPI 的原始错误翻译成可操作的中文提示。
 * @param {Error} error 原始错误。
 * @returns {Error} 新的错误对象。
 */
export function translateA11yError(error) {
  if (error && isA11yUnavailable(error.message)) {
    return new Error([
      'AT-SPI 不可用：无障碍树与控件赋值功能需要额外的系统依赖。',
      '请先安装：sudo apt-get install -y at-spi2-core libatk-adaptor python3-gi gir1.2-atspi-2.0',
      '另外，目标应用必须在安装之后重新启动才会注册到无障碍总线。',
      `原始错误：${error.message}`,
    ].join('\n'))
  }
  return error
}
