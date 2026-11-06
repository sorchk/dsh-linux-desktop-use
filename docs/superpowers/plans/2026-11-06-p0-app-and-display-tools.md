# P0：应用管理 / 显示器 / 窗口几何 / 状态校验 工具

## Goal

在本插件（DSH 插件 `dsh-linux-desktop-use`，当前 v1.5.4）上补齐 6 个工具，让模型具备
「找到应用 → 启动应用 → 切到应用 → 调整窗口 → 确认结果」这一整条闭环能力：

| 工具名 | 作用 | 对标参考工具 |
| --- | --- | --- |
| `linux_apps` | 列出已安装应用与正在运行的应用（按 WM_CLASS 分组） | `computer_app_list` |
| `linux_launch_app` | 按应用 id / 显示名启动应用 | `computer_app_launch` |
| `linux_activate_app` | 聚焦某个正在运行的应用（按 WM_CLASS / 标题匹配） | `computer_app_activate` |
| `linux_displays` | 列出显示器（名称、主屏、几何、物理尺寸） | `computer_display_list` |
| `linux_set_window_frame` | 设置窗口位置/尺寸（必要时先解除最大化） | `computer_window_set_frame` |
| `linux_verify_state` | 校验界面状态（窗口标题/焦点窗口/画面是否变化） | `computer_verify_state` |

约束：**零新依赖**（只用已装的 xdotool / wmctrl / xrandr / scrot / ffmpeg + Node 内置模块）。

## Architecture

```
lib/
  desktop-entries.js   ← 新增：纯函数，解析 .desktop 文本（无 I/O，可单测）
  apps.js              ← 新增：扫描/索引 .desktop、WM_CLASS 匹配、Exec→argv、启动应用
  verify.js            ← 新增：灰度指纹比较 + 状态断言求值（纯逻辑可单测）
  x11.js               ← 扩展：listWindowsWithClass / setWindowFrame / listDisplays / captureFingerprint
  observe.js           ← 扩展：观察记录里附带屏幕指纹（灰度 64x36），供 verify 比对
  guard.js             ← 扩展：3 个新写工具进 WRITE_TOOLS；describeAction 补充文案
  tools.js             ← 扩展：注册 6 个新工具
test/
  *.test.js            ← 新增：node:test 单测（纯逻辑，无 X 依赖）+ 可选集成测试
```

分层原则：**纯逻辑放可单测模块，I/O 放 x11.js/apps.js**。
`desktop-entries.js` / `verify.js` 不碰文件系统与子进程，因此单测不需要 X 会话。

## Tech Stack

- Node.js ≥ 20（ESM，`"type": "module"`），内置 `node:test` + `node:assert/strict`
- X11 辅助二进制：xdotool（必需）、wmctrl、xrandr、scrot、ffmpeg
- 无新增 npm 依赖；`package.json` 新增 `scripts.test = "node --test test/"`

## Spec

### S1 `lib/desktop-entries.js`（纯函数）

```js
export function parseDesktopEntry(text) -> Entry | null
export function parseExecLine(exec) -> string[]   // 去掉 %f/%F/%u/%U/%i/%c/%k 字段码
export function desktopEntryBasename(execLine) -> string  // Exec 里的可执行文件名
```

`Entry` 字段：`id`（文件名去掉 `.desktop`）、`name`、`nameLocal`、`exec`、`icon`、
`terminal`、`noDisplay`、`hidden`、`type`、`categories[]`、`startupWmClass`、`tryExec`、`actionCount`。

规则：
- 只认 `[Desktop Entry]` 组；`[Desktop Action]` 子组不作为主条目，但统计 `actionCount`。
- `nameLocal` 取 `Name[zh_CN]` → `Name[zh]` → `Name`（按 `LANG`/`LC_ALL` 的语言前缀降序匹配）。
- `Type` 非 `Application` 的条目不作为应用（`parseDesktopEntry` 仍返回，由调用方过滤）。
- `parseExecLine` 按 shell 风格拆分引号，丢弃所有 `%` 字段码（本次不传文件参数）。

### S2 `lib/apps.js`

```js
export function collectDesktopEntryDirs(env) -> string[]
export function loadDesktopEntries(env) -> Entry[]
export function buildAppIndex(entries) -> { byId, byName }
export function matchAppToClass(entry, instance, className) -> boolean
export function groupWindowsByClass(windows) -> Group[]
export function findApp(entries, query) -> Entry[]   // id / 显示名 / WM_CLASS 模糊匹配
export function buildLaunchPlan(entry, args) -> { command, argv, wrapper }
```

- 扫描目录：`$XDG_DATA_HOME/applications`、`$XDG_DATA_DIRS/applications`、`/usr/share/applications`。
- `matchAppToClass` 判定顺序：`StartupWMClass`（忽略大小写）→ 桌面文件名 → `Exec` 可执行名。
- `buildLaunchPlan`：`Terminal=true` 时用 `xfce4-terminal -e` 包裹（存在则用，否则 `x-terminal-emulate`）；
  否则直接执行 `Exec` 的可执行文件 + 参数。**不经 shell 拼接**，避免注入。
- 启动用 `child_process.spawn`（detached、stdio 忽略、`DISPLAY`/`XAUTHORITY`/`DBUS_SESSION_BUS_ADDRESS` 就绪）。

### S3 `lib/verify.js`（纯逻辑）

```js
export function compareFingerprints(a, b) -> { identical, changedRatio, changedBytes, totalBytes }
export function evaluateChecks(checks) -> { passed, failed, results }
export function buildWindowChecks({ windows, active, expected }) -> Check[]
```

- `compareFingerprints` 对等长字节做平均绝对差 / 255，得 `changedRatio ∈ [0,1]`；
  长度不同直接判定 `identical=false`。
- `buildWindowChecks` 支持三种断言：`window_title_contains`（存在标题包含子串的窗口）、
  `active_title_contains`（焦点窗口标题包含子串）、`window_count`（窗口数量等于期望值）。

### S4 `lib/x11.js` 扩展

```js
export async function listWindowsWithClass(env) -> Window[]  // wmctrl -lx -G -p，多出 wmClass/instance/class
export async function setWindowFrame(env, windowId, { x, y, width, height }, opts) -> { before, after, unmaximized }
export async function listDisplays(env) -> Display[]           // xrandr --listmonitors + --current
export async function captureFingerprint(env, data) -> Buffer|null  // ffmpeg 灰度 64x36
```

- `listWindowsWithClass` 字段顺序（实测）：`id desktop pid x y w h WM_CLASS host title…`，
  `WM_CLASS` 形如 `instance.class`。
- `setWindowFrame`：若窗口处于最大化（`wmctrl -i -r <id> -b remove,maximized_vert,maximized_horz`），
  先解除最大化再改几何，否则 WM 会忽略几何请求；返回前后几何。
- `listDisplays`：解析 `xrandr --listmonitors` 的 `Monitors: N` 与
  ` 0: +VNC-0 1882/498x1040/275+0+0  VNC-0`（`+` 表示主屏），并补 `xrandr --current` 的连接状态。

### S5 `lib/observe.js` 扩展

`recordObservation` 增加可选字段 `fingerprint`（灰度字节）与 `fingerprintRegion`；
作废观察时**保留**指纹（`invalidateObservation` 只置 `stale`），使「动作前后画面是否变化」可判定。

### S6 工具定义（`lib/tools.js`）

| 工具 | 参数 | 写操作 | 需要新鲜观察 |
| --- | --- | --- | --- |
| `linux_apps` | `query?`, `include_hidden?` | 否 | 否 |
| `linux_launch_app` | `app`(必填), `args?[]` | 是 | 是 |
| `linux_activate_app` | `app`(必填), `title_contains?` | 是 | 是 |
| `linux_displays` | — | 否 | 否 |
| `linux_set_window_frame` | `window_id?`, `title_contains?`, `x?`, `y?`, `width?`, `height?` | 是 | 是 |
| `linux_verify_state` | `window_title_contains?`, `active_title_contains?`, `window_count?` | 否（但会刷新观察） | 否 |

- 三个写工具加入 `guard.js` 的 `WRITE_TOOLS`，因此自动获得：作用域白名单、
  危险语义识别、分级审批、动作后作废观察。
- `linux_verify_state` 会重新截图并**记录一次新观察**（等价于一次新的 `linux_screenshot`），
  同时返回与上一观察的画面差异（`changedRatio` / `identical`）。

## Global Constraints

- 零新依赖：不装 npm 包，不装系统包。
- 不改安全模型的语义：新写工具一律走 `guardAction`，审批只认 `allowed-once`。
- 所有中文错误文案沿用现有风格（说明原因 + 下一步动作）。
- 注释、文档、提交信息全部中文（AGENTS.md）。
- 单元测试必须能在**没有 X 会话**的环境下跑通（纯逻辑）；集成测试检测不到 X 时自动跳过。
- 同步更新 `README.md`、`CHANGELOG.md`、`PERMISSIONS.md`、`VERIFICATION.md`、`package.json`。
- 版本号：新增完整模块 → 次版本号 `1.6.0`，并打同名 tag `v1.6.0`（AGENTS.md）。

## Review Focus

1. `linux_launch_app` 是否真的绕开 shell（`spawn(argv0, argv)`），避免命令注入。
2. `linux_set_window_frame` 在最大化窗口上是否先解除最大化，否则几何静默不生效。
3. `linux_verify_state` 的指纹比较是否区分「长度不同」（不同分辨率/区域）而不是误判。
4. `linux_apps` 的 WM_CLASS ↔ `.desktop` 匹配是否会漏配（chromium/code/tilda/Thunar 四个实测样本必须命中）。
5. 三个新写工具是否都经过 `guardAction`（审批 + 作用域 + 观察门禁）。
6. `recordObservation` 增字段后，既有 `requireFreshObservation` 语义未被破坏。

---

## Tasks

### Task 1：`lib/desktop-entries.js` + 单测

- [x] 写失败测试 `test/desktop-entries.test.js`（解析 zh_CN 本地化名、Terminal/NoDisplay、Action 计数、Exec 字段码剥离）
- [x] `node --test test/desktop-entries.test.js` → 确认失败（模块不存在）
- [x] 实现 `lib/desktop-entries.js`
- [x] `node --test test/desktop-entries.test.js` → 全绿
- [x] commit：`新增 .desktop 解析模块与单元测试`

### Task 2：`lib/apps.js` 索引与匹配 + 单测

- [x] 写失败测试 `test/apps.test.js`（扫描目录、WM_CLASS 匹配四样本、findApp、buildLaunchPlan 的 Terminal 包裹与字段码清理）
- [x] 跑测试确认失败
- [x] 实现 `lib/apps.js`（不含 spawn 启动，spawn 放 Task 4）
- [x] 跑测试确认通过
- [x] commit：`新增应用索引与 WM_CLASS 匹配模块`

### Task 3：`lib/verify.js` 指纹与断言 + 单测

- [x] 写失败测试 `test/verify.test.js`（相同/不同指纹的 changedRatio、长度不同、窗口断言求值）
- [x] 跑测试确认失败
- [x] 实现 `lib/verify.js`
- [x] 跑测试确认通过
- [x] commit：`新增画面指纹比对与状态断言模块`

### Task 4：`lib/x11.js` 扩展 + `lib/observe.js` 指纹

- [x] 写失败测试 `test/x11-parse.test.js`（wmctrl -lx 输出解析、xrandr --listmonitors 解析）
- [x] 跑测试确认失败
- [x] 实现 `listWindowsWithClass` / `listDisplays` / `setWindowFrame` / `captureFingerprint`
- [x] `recordObservation` 增加 `fingerprint` / `fingerprintRegion`，作废时保留
- [x] 跑测试确认通过
- [x] commit：`扩展 X11 层：窗口类名、显示器、窗口几何与屏幕指纹`

### Task 5：注册 6 个工具 + guard 接入

- [x] 写失败测试 `test/tools.test.js`（工具注册表包含 6 个新名字；3 个写工具在 `WRITE_TOOLS` 中）
- [x] 跑测试确认失败
- [x] `lib/guard.js`：加入 `WRITE_TOOLS` 与 `describeAction` 文案
- [x] `lib/tools.js`：实现 6 个工具（`linux_launch_app` 用 `spawn` 启动，注入 DISPLAY/XAUTHORITY/DBUS）
- [x] 跑测试确认通过
- [x] commit：`新增应用管理、显示器、窗口几何与状态校验工具`

### Task 6：集成冒烟（真实 X 会话）

- [x] 写 `test/integration.test.js`：检测不到 X 时自动跳过；覆盖 `linux_apps` / `linux_displays` / `linux_set_window_frame` / `linux_verify_state` 的真实调用
- [x] 在本机 X 会话（DISPLAY=:1）下跑通
- [x] commit：`新增 X 会话集成测试`

### Task 7：文档与版本

- [x] `README.md`：工具表补 6 行、安全机制说明补新写工具、依赖说明补 xrandr/wmctrl 用途
- [x] `CHANGELOG.md`：新增 `v1.6.0` 条目
- [x] `PERMISSIONS.md`：补新增命令（wmctrl -lx / xrandr --listmonitors / xdotool windowmove / spawn 的 Exec）
- [x] `VERIFICATION.md`：补 6 项实机验证记录
- [x] `package.json`：版本 `1.6.0`、`scripts.test`、permissions.commands 补齐
- [x] commit：`同步文档并将版本升至 1.6.0`
- [x] 打 tag `v1.6.0` 并提交
