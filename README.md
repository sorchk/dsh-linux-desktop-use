# dsh-linux-desktop-use

用 DeepSeek Harness（DSH）直接操控**本机 Linux 桌面**的插件。

适用于**原生 X11 + XTEST 会话**（XFCE / GNOME / KDE 等任意 X11 桌面；本机实测为 KasmVNC 下的 Xvnc `:1`）。
Wayland 原生会话不适用（根窗口不合成、XTEST 无法注入原生 Wayland 窗口）。

插件把一组桌面工具注册进 `ctx.tools`，模型即可自行截图、点击、输入、滚动、切换窗口：

| 工具 | 作用 | 类型 |
| --- | --- | --- |
| `linux_screenshot` | 截取整屏 / 活动窗口 / 指定窗口 / 指定区域，图片直接进入模型上下文 | 只读 |
| `linux_click` | 点击（left/right/middle，支持双击；`space=screen\|local`） | 写 |
| `linux_move_mouse` | 移动指针（悬停菜单） | 指针（不审批） |
| `linux_drag` | 按下—移动—释放的拖拽（`space=screen\|local`） | 写 |
| `linux_type` | 向当前焦点窗口输入文本 | 写 |
| `linux_key` | 发送组合键（`ctrl+s`、`Return`、`alt+Tab`…） | 写 |
| `linux_scroll` | 滚轮滚动（可先移动指针；`space=screen\|local`） | 写 |
| `linux_windows` | 列出窗口与当前焦点窗口 | 只读 |
| `linux_activate_window` | 按 id 或标题子串激活窗口 | 写 |
| `linux_desktop_status` | 显示屏、分辨率、指针位置、审批模式、观察快照状态等 | 只读 |
| `linux_check_env` | 依赖体检：辅助程序、XTEST/EWMH、DISPLAY/XAUTHORITY、配置文件 | 只读 |

> **写操作必须先观察**：任何写工具执行前都需要一次新鲜的 `linux_screenshot`
> （默认 TTL 30 秒）；写操作完成后快照作废（界面可能已变），下一次写需重新观察。

## 插件详情页：检查依赖 + 配置项

插件自带客户端半，在 DSH「插件 → Linux 电脑控制」详情页提供：

* 顶部 **「检查依赖」** 按钮：一键体检，列出每个辅助程序是否安装/版本、X11 会话的
  XTEST（输入注入）与 EWMH（窗口管理）能力、DISPLAY 套接字、Xauthority 凭据、配置文件状态，
  以及所有需要处理的问题（含修复提示）。
* 页面下方 **「桌面控制依赖与配置」** 面板：可直接编辑 DISPLAY、XAUTHORITY、审批策略、
  观察快照有效期、允许的窗口标题、命令超时，并保存到配置文件。
* 同样的体检结果，模型侧通过 `linux_check_env` 工具读取——**同一份实现，两个入口**。

实现方式：宿主提供两条受同源保护的 HTTP 路由，客户端半只调用它们。

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/dsh-linux-desktop-use/check` | GET | 依赖体检报告（只读） |
| `/dsh-linux-desktop-use/config` | GET / POST | 读取 / 保存配置 |

> 改完代码需要让宿主重新加载模块：重装一次 bundle 会触发 `hmr.reconcileProfile`
> 驱逐旧 ESM 缓存；只改磁盘文件不会自动生效。包名变更时必须换新名字（见 VERIFICATION.md
> 第 7 节），因为宿主的包元数据缓存以「基址 + 包名」为键，旧名字的解析结果会被永久缓存。

## 四道内置安全机制

| 机制 | 实现位置 | 行为 |
| --- | --- | --- |
| 观察门禁 + 快照 TTL | `lib/observe.js` | 无快照 / 快照作废 / 快照过期（默认 30s）→ 拒绝执行并提示先观察 |
| 危险语义分级审批 | `lib/guard.js` | 文本、按键、窗口标题命中「删除 / 支付 / 凭据 / 破坏性命令」四类语义时强制审批；`approvalMode` = `all` / `dangerous` / `off` |
| 坐标语义统一 | `lib/observe.js` + `lib/tools.js` | 截图返回 `origin_x` / `origin_y` / `scale` / `coordinate_space`；动作可用 `space=screen`（屏幕绝对像素）或 `space=local`（按截图局部像素自动换算） |
| 打包权限声明 | `package.json → dsh.permissions` + `PERMISSIONS.md` + `VERIFICATION.md` | 权限、命令、读写路径、失败边界、验证证据随包可审计 |

## 运行依赖

| 依赖 | 用途 | 必需 |
| --- | --- | --- |
| `xdotool` | XTEST 注入鼠标/键盘事件、读取指针与窗口几何 | 是 |
| `scrot` | 屏幕/区域截图（失败时回退 `ffmpeg x11grab`） | 建议 |
| `ffmpeg` | 截图回退实现 + 截图缩放 | 可选 |
| `wmctrl` | 列出窗口、激活窗口（EWMH） | 建议 |
| `xrandr` / `xprop` | 屏幕尺寸兜底 | 可选 |

安装：

```bash
sudo apt-get install -y xdotool scrot wmctrl ffmpeg
```

## 权限与运行环境

* 插件以**运行 DSH 的同一个用户**身份执行 X11 调用，因此必须能访问该用户的 X server：
  * `DISPLAY` 指向桌面的 X server（本机为 `:1`）；
  * `XAUTHORITY` 指向 `~/.Xauthority`（KasmVNC 的 magic cookie）。
* DSH 宿主进程通常没有继承 `DISPLAY`/`XAUTHORITY`，插件会自动探测：
  `DISPLAY` 环境变量 → `/tmp/.X11-unix/X*` → `~/.vnc/xdev:<n>.pid`；
  `XAUTHORITY` 环境变量 → `~/.Xauthority` → `~/.vnc/.Xauthority`。
* 权限由 X server 的访问控制决定：同一用户 + 正确 cookie 即可，无需 root，
  **不需要**额外授权，也不需要 root 权限的输入注入工具。
* 写操作通过 `ctx.approval.request` 申请一次授权，只认 `allowed-once`；
  未获批准即拒绝执行。会话的审批策略必须是 `ask`，否则请求会被判为 `unavailable`。

逐项权限来源见 [`PERMISSIONS.md`](./PERMISSIONS.md)，实机验证记录见 [`VERIFICATION.md`](./VERIFICATION.md)。

## 在「插件市场 → 已安装」里显示说明文字

DSH 有两个不同的展示面，说明文字来源也不同：

| 展示面 | 说明文字来源 | 本插件如何生效 |
| --- | --- | --- |
| DSH 核心「插件 → 已安装」页 | 包内 `locale/*.json` 的 `meta.title` / `meta.description` | 已随包提供 `locale/zh.json` + `locale/en.json`，页面自动显示标题与描述 |
| 「插件 → 插件市场 → 已安装」列表 | 市场目录条目（`authored`）或用户**备注**（`note`） | 目录条目需要发布到 npm 并登记进 `dsh-plugin-catalog`；本地开发包用官方**备注**通道 |

本地开发包（`link:` 安装）默认匹配不到市场目录条目，因此该行原本没有描述文字。
解决办法是写入一条备注（≤200 字符，存于 profile 的市场状态文件）：

```bash
# 需要 DSH 登录态；也可在 GUI 里点该行的「添加备注」
curl -sS -X POST http://127.0.0.1:3080/dsh-market/note \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:3080' -H 'Host: 127.0.0.1:3080' \
  -d '{"name":"dsh-linux-desktop-use","text":"操控本机 Linux 图形桌面…"}'
```

本机已写入的备注：*操控本机 Linux 图形桌面：截图、点击/拖拽/滚动、键盘输入、窗口列举与激活。
适用于原生 X11+XTEST 会话（XFCE/GNOME/KDE 等任意 X11 桌面，Wayland 不适用）。
依赖 xdotool、scrot、ffmpeg、wmctrl，需与桌面同用户的 DISPLAY/XAUTHORITY。*

> 若以后把本包发布到 npm 并登记进市场目录，目录里的 `description.zh/en` 会成为「作者描述」，
> 此时备注降级为可切换的「我的备注」（`noteToggle`），两者共存互不覆盖。

## 配置

上面的详情页面板是这份配置文件的图形界面；也可以直接编辑文件
`~/.config/dsh/linux-computer-use.json`（每次调用都会重新读取）：

```json
{
  "display": ":1",
  "xauthority": "/home/sorc/.Xauthority",
  "approvalMode": "all",
  "ttlMs": 30000,
  "allowedWindows": ["Thunar", "xterm"],
  "timeoutMs": 20000
}
```

| 键 | 取值 | 含义 |
| --- | --- | --- |
| `display` | `":1"` | X 显示号 |
| `xauthority` | 路径 | Xauthority cookie 文件 |
| `approvalMode` | `all` / `dangerous` / `off` | 写操作的审批策略，默认 `all` |
| `ttlMs` | 毫秒，默认 30000 | 观察快照有效期 |
| `allowedWindows` | 标题子串数组 | 允许写入的窗口白名单（空=不限制） |
| `timeoutMs` | 毫秒，默认 20000 | 单条外部命令超时 |

环境变量优先级更高：`DSH_LINUX_DISPLAY`、`DSH_LINUX_XAUTHORITY`、`DSH_LINUX_APPROVAL_MODE`、
`DSH_LINUX_TTL_MS`、`DSH_LINUX_ALLOWED_WINDOWS`、`DSH_LINUX_TIMEOUT_MS`、`DSH_LINUX_CONFIG`。
旧字段 `requireApproval` 仍兼容：`true` 等价 `all`，`false` 等价 `off`。

## 安装与验证

```bash
# 从 npm 安装（发布后可用，支持指定版本）
plugin_manager install_bundle dsh-linux-desktop-use
plugin_manager install_bundle dsh-linux-desktop-use@1.5.2

# 本地开发：以链接方式安装到 DSH profile
plugin_manager install_bundle /home/sorc/workspaces/dsh-xfce-use/dsh-linux-desktop-use

# 冒烟测试（假 ctx + 真实 X 会话）
node /home/sorc/workspaces/dsh-xfce-use/scripts/smoke-test.mjs

# 确认宿主已注册工具
cordis_inspect_query host Tool listTools   # 应看到 10 个 linux_* 工具
```

> 本包以链接方式安装时，**改完代码需要让宿主重新加载模块**（重装一次 bundle 触发
> `hmr.reconcileProfile` 驱逐旧的 ESM 缓存）；只改磁盘文件不会自动生效。

> 包名从 `@local/dsh-linux-desktop-use` 改为 `dsh-linux-desktop-use`（见 CHANGELOG v1.5.0）。
> 宿主的包元数据缓存以「基址 + 包名」为键，**改名后需要重新 `install_bundle` 一次**，
> 否则宿主机仍会使用旧名字的缓存结果。

## 发布到 npm（GitHub Actions 手动触发）

仓库内置 [`.github/workflows/publish.yml`](./.github/workflows/publish.yml)，
**只在 GitHub Actions 页面点击「Run workflow」时执行**，没有任何自动触发器
（不打 tag、不随 push 构建、不定时发布）。

### 前置配置（一次性）

1. 在 npm 上确认包名 `dsh-linux-desktop-use` 可用（未被占用）。
2. 在仓库 **Settings → Secrets and variables → Actions** 新建 secret：

   | Secret | 值 | 用途 |
   | --- | --- | --- |
   | `NPM_TOKEN` | npm 的 Automation Token（Classic Token 勾选 publish） | 发布权限 |

3. npm 账号需要开通 **Two-factor authentication**（npm 现在强制要求）。

### 执行方式

在 GitHub 仓库页 → **Actions** → 左侧选择「打包并发布到 npm」→ 右侧 **Run workflow**，
勾选输入项：

| 输入项 | 默认 | 说明 |
| --- | --- | --- |
| `publish` | `false` | 是否真正发布到 npm；`false` 时只打包并产出 `dsh-linux-desktop-use-<version>.tgz` 供下载 |
| `dry_run` | `false` | 发布演练：`npm publish --dry-run`，不真正上传（需同时勾选 `publish`）；演练模式不会回查 npm 上的版本，因为演练不会真的发布 |
| `provenance` | `false` | 启用 npm provenance 签名（需仓库为公开仓库，且工作流已申请 `id-token: write`） |

### 工作流做了什么

| 阶段 | 步骤 |
| --- | --- |
| 打包 | 检出代码 → Node.js 20 → `node --check` 语法检查 → 校验 `package.json`（无 `private`、有 `version`）→ `npm pack` → 上传 tarball artifact |
| 发布 | 仅当 `publish = true`：校验 `NPM_TOKEN` 存在 → 下载 tarball → 检查该版本是否已发布（已发布则报错退出）→ `npm publish --access public` → 回查 npm 上的版本与 tarball 地址（最多重试 5 次；`dry_run` 模式跳过回查） |

> 版本号来自 `package.json`。重复发布同一版本会被 npm 拒绝，工作流也会提前拦截，
> 因此每次发布前请先提升 `package.json` 的版本号并打上同名 tag。

> **注意**：发布时传给 npm 的 tarball 路径必须以 `./` 开头（如 `./dist/dsh-linux-desktop-use-1.5.2.tgz`）。
> npm 会把 `dist/xxx.tgz` 这种「斜杠分隔」参数当成 GitHub 简写（`owner/repo`），
> 转成 `ssh://git@github.com/dist/xxx.tgz.git` 去克隆；CI 没有 SSH key 时会报
> `Permission denied (publickey)`、`npm error code 128`。这是 v1.5.0 首次发布失败的原因。

发布后即可通过 `plugin_manager install_bundle dsh-linux-desktop-use` 安装。
