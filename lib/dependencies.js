/**
 * The plugin's dependency catalog.
 *
 * One list drives three things, so an operator never sees a dependency listed
 * in one place and missing from another:
 *   - the detail page's dependency table (and the install button),
 *   - the `linux_check_env` report,
 *   - the one-click installer.
 *
 * Every entry maps one runtime requirement to the Debian/Ubuntu package that
 * provides it. This catalog is the **only** source of package names the
 * installer may install: the HTTP route never accepts a package name from the
 * browser, it only accepts catalog ids.
 *
 * This module is pure (no I/O) so it can be unit tested directly.
 */

/** How badly a dependency is needed. */
export const NEED = {
  REQUIRED: 'required',
  RECOMMENDED: 'recommended',
  OPTIONAL: 'optional',
}

/**
 * The catalog.
 *
 * - `kind: 'binary'`  → checked by looking the executable up in PATH.
 * - `kind: 'package'` → checked with dpkg (the Debian/Ubuntu package state).
 * - `need`            → how badly the plugin misses it.
 * - `packages`        → the apt package(s) that provide it.
 */
export const DEPENDENCIES = [
  {
    id: 'xdotool',
    label: 'xdotool',
    kind: 'binary',
    need: NEED.REQUIRED,
    binary: 'xdotool',
    versionArgs: ['--version'],
    packages: ['xdotool'],
    purpose: 'XTEST 注入鼠标/键盘事件、读取指针与窗口几何',
  },
  {
    id: 'scrot',
    label: 'scrot',
    kind: 'binary',
    need: NEED.RECOMMENDED,
    binary: 'scrot',
    versionArgs: ['--version'],
    packages: ['scrot'],
    purpose: '屏幕/区域截图（失败时回退 ffmpeg x11grab）',
  },
  {
    id: 'ffmpeg',
    label: 'ffmpeg',
    kind: 'binary',
    need: NEED.RECOMMENDED,
    binary: 'ffmpeg',
    versionArgs: ['-version'],
    packages: ['ffmpeg'],
    purpose: '截图回退实现 + 截图缩放 + 画面指纹计算',
  },
  {
    id: 'wmctrl',
    label: 'wmctrl',
    kind: 'binary',
    need: NEED.RECOMMENDED,
    binary: 'wmctrl',
    versionArgs: ['--version'],
    packages: ['wmctrl'],
    purpose: '列出窗口、激活窗口（EWMH）',
  },
  {
    id: 'xrandr',
    label: 'xrandr',
    kind: 'binary',
    need: NEED.RECOMMENDED,
    binary: 'xrandr',
    versionArgs: ['--version'],
    packages: ['x11-xserver-utils'],
    purpose: '屏幕尺寸兜底 + 显示器枚举（linux_displays）',
  },
  {
    id: 'xprop',
    label: 'xprop',
    kind: 'binary',
    need: NEED.RECOMMENDED,
    binary: 'xprop',
    versionArgs: ['--version'],
    packages: ['x11-utils'],
    purpose: '窗口管理器（EWMH）探测',
  },
  {
    id: 'xdpyinfo',
    label: 'xdpyinfo',
    kind: 'binary',
    need: NEED.OPTIONAL,
    binary: 'xdpyinfo',
    versionArgs: ['-version'],
    packages: ['x11-utils'],
    purpose: 'XTEST 扩展能力探测',
  },
  {
    id: 'python3',
    label: 'python3',
    kind: 'binary',
    need: NEED.RECOMMENDED,
    binary: 'python3',
    versionArgs: ['--version'],
    packages: ['python3'],
    purpose: '无障碍树采集脚本的运行时',
  },
  {
    id: 'python3-gi',
    label: 'python3-gi',
    kind: 'package',
    need: NEED.OPTIONAL,
    packages: ['python3-gi'],
    purpose: 'python3 的 GObject introspection 绑定（gi）',
  },
  {
    id: 'gir1.2-atspi-2.0',
    label: 'gir1.2-atspi-2.0',
    kind: 'package',
    need: NEED.OPTIONAL,
    packages: ['gir1.2-atspi-2.0'],
    purpose: 'AT-SPI 2.0 的 GIR 绑定',
  },
  {
    id: 'at-spi2-core',
    label: 'at-spi2-core',
    kind: 'package',
    need: NEED.OPTIONAL,
    packages: ['at-spi2-core'],
    purpose: '无障碍总线守护进程（a11y bus）',
  },
  {
    id: 'libatk-adaptor',
    label: 'libatk-adaptor',
    kind: 'package',
    need: NEED.OPTIONAL,
    packages: ['libatk-adaptor'],
    purpose: 'ATK 桥接，让 GUI 应用暴露无障碍树',
  },
]

/** Look one dependency up by its catalog id. */
export function dependencyById(id) {
  return DEPENDENCIES.find(entry => entry.id === id) ?? null
}

/** Every apt package the catalog mentions, de-duplicated and sorted. */
export function allPackages() {
  const packages = new Set()
  for (const entry of DEPENDENCIES) {
    for (const name of entry.packages ?? []) packages.add(name)
  }
  return [...packages].sort()
}

/**
 * Build the install plan for a set of dependency states.
 *
 * Only packages that are actually missing are proposed, and only catalog
 * package names ever appear in the plan — the caller cannot smuggle in an
 * arbitrary package name.
 *
 * @param {Array<{id:string,present:boolean,packages?:string[]}>} states 依赖状态。
 * @param {{ids?:string[]}} options 可选：只处理这些目录 id；缺省处理全部缺失项。
 * @returns {{dependencies:string[],packages:string[],command:string}}
 */
export function planInstall(states = [], { ids } = {}) {
  const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null
  const selected = states.filter(state => {
    if (wanted && !wanted.has(state.id)) return false
    if (state.present) return false
    const entry = dependencyById(state.id)
    return Boolean(entry && (entry.packages ?? []).length > 0)
  })

  const packages = new Set()
  for (const state of selected) {
    for (const name of dependencyById(state.id)?.packages ?? []) packages.add(name)
  }
  const list = [...packages].sort()
  return {
    dependencies: selected.map(state => state.id),
    packages: list,
    command: list.length > 0 ? `sudo apt-get install -y ${list.join(' ')}` : '',
  }
}

/**
 * Summarise dependency states for the report header.
 * @param {Array<{need:string,present:boolean}>} states
 */
export function summarizeDependencies(states = []) {
  const missing = states.filter(state => !state.present)
  return {
    total: states.length,
    present: states.length - missing.length,
    missing: missing.length,
    missingRequired: missing.filter(state => state.need === NEED.REQUIRED).length,
    missingRecommended: missing.filter(state => state.need === NEED.RECOMMENDED).length,
    missingOptional: missing.filter(state => state.need === NEED.OPTIONAL).length,
  }
}
