# dsh-linux-desktop-use

用 DeepSeek Harness（DSH）直接操控**本机 Linux 桌面**的插件。

> [!WARNING]
> **风险提示：AI Agent 操作电脑具有真实的破坏力。**
> 本插件把**真实的鼠标与键盘控制权**交给 AI Agent。模型的一次误判就可能误删文件、覆盖未保存的文档、
> 误触破坏性命令、泄露凭据或误发消息/误下单——这些后果直接发生在**你的真实桌面**上，多数不可撤销。
> **强烈建议在沙盒 / 隔离环境中使用**：独立的虚拟机、容器化桌面（Docker + Xvfb）、
> KasmVNC/Xvnc 独立 X 会话或一次性容器；沙盒内不要放真实数据与真实登录态，
> 并保持 `approvalMode = all`（默认）逐次审批写操作。详见
> [「使用风险与沙盒建议」](#️-使用风险与沙盒建议)。

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
| `linux_apps` | 列出已安装应用与正在运行的应用（按窗口类名关联） | 只读 |
| `linux_launch_app` | 按应用 id 或显示名启动应用 | 写 |
| `linux_activate_app` | 按应用名或窗口标题聚焦正在运行的窗口 | 写 |
| `linux_displays` | 列出显示器与输出设备（分辨率、位置、主屏标记） | 只读 |
| `linux_set_window_frame` | 移动 / 缩放窗口（自动解除最大化） | 写 |
| `linux_verify_state` | 断言窗口标题、焦点窗口、窗口数量，并判断画面是否变化 | 只读 |
| `linux_app_state` | 读取运行中 GUI 应用的无障碍树（控件角色、名称、坐标、文本） | 只读 |
| `linux_set_value` | 直接给某个可编辑控件写入文本（不走逐键模拟） | 写 |

> **写操作必须先观察**：任何写工具执行前都需要一次新鲜的 `linux_screenshot`
> （默认 TTL 30 秒）；写操作完成后快照作废（界面可能已变），下一次写需重新观察。

### 应用与窗口的新增能力（v1.6.0 起）

| 工具 | 输入 | 输出要点 | 备注 |
| --- | --- | --- | --- |
| `linux_apps` | `query?`、`include_hidden?` | `applications`（已安装）、`running`（正在运行，含窗口标题）、`counts` | 读取 `/usr/share/applications` 与 `~/.local/share/applications` 的 `.desktop` 条目，并按 `WM_CLASS` 关联运行中的窗口 |
| `linux_launch_app` | `app`（必填）、`args?` | `command`、`argv`、`pid` | `Terminal=true` 的条目会自动套用终端模拟器（`xfce4-terminal --command=`、`gnome-terminal --`、`xterm -e` 等） |
| `linux_activate_app` | `app`（必填）、`title_contains?` | `id`、`title`、`activatedBy`、`candidates` | 应用名先经 `.desktop` 条目解析出候选类名，再按类名或标题子串挑窗口 |
| `linux_displays` | 无 | `monitors`、`outputs`、`count` | 主屏以 `monitors[].primary` 为准（`xrandr --current` 不带 `primary` 关键字） |
| `linux_set_window_frame` | `window_id?` / `title_contains?`、`x`+`y`、`width`+`height` | `before`、`after`、`unmaximized` | 最大化窗口会先解除最大化；窗口装饰边框带来的位置偏移会自动按实际坐标收敛修正 |
| `linux_verify_state` | `window_title_contains?`、`active_title_contains?`、`window_count?` | `checks`、`summary`、`screen_changed`、`changed_ratio` | 只读，不解除观察门禁；画面比对基于截图时记录的灰度指纹 |

> `linux_launch_app` / `linux_activate_app` / `linux_set_window_frame` 属于写操作：
> 纳入作用域白名单、危险语义识别与分级审批，动作后同样作废观察快照。

### AT-SPI 无障碍能力（v1.7.0 起）

有了无障碍树（AX tree）之后，「找到某个控件」不再依赖截图上猜像素。

| 工具 | 输入 | 输出要点 | 备注 |
| --- | --- | --- | --- |
| `linux_app_state` | `app?`、`role?`、`name_contains?`、`max_depth?` | `apps`（应用名 + pid + 控件节点）、`nodes`、`counts` | 每个节点带 `role`、`name`、`states`、`box`（屏幕绝对坐标）、`text`（文本直读）、`editable`、`actions` |
| `linux_set_value` | `value`（必填）、`app?`、`role?`、`name_contains?` | `before`、`after`、`changed` | 写操作：走观察门禁 + 作用域白名单 + 分级审批，写后作废观察快照 |

两条顺带解决的能力：

* **元素级定位**：控件的 `box` 是屏幕绝对坐标，可以直接喂给 `linux_click`，
  不必再从截图里目测位置；
* **控件文本直读**：直接读 `Text` 接口，**不需要 OCR**，也不用把整屏文本灌进模型上下文。

安装依赖（**可选增强**，不装不影响其余工具）：

```bash
sudo apt-get install -y at-spi2-core libatk-adaptor python3-gi gir1.2-atspi-2.0
```

> **两个硬约束**：
> 1. **目标应用必须在安装依赖之后重启**才会注册到无障碍总线——旧进程不会自动补注册；
> 2. 依赖装好后要**重新加载宿主**（重装一次 bundle）才会看到新工具。
>
> `linux_check_env` 体检报告新增 `a11y` 段，逐项列出 `python3` / `gi` / 无障碍总线是否就绪；
> 缺失时记一条 info 级提示，不会让体检判失败。

## 插件详情页：检查依赖 + 配置项

插件自带客户端半，在 DSH「插件 → Linux 电脑控制」详情页提供：

* 顶部 **「检查依赖」** 按钮：一键体检，列出依赖清单里**每一条**依赖（辅助程序 + 系统包）是否安装/版本、
  X11 会话的 XTEST（输入注入）与 EWMH（窗口管理）能力、DISPLAY 套接字、Xauthority 凭据、配置文件状态，
  以及所有需要处理的问题（含修复提示）。
* 体检结果下方按需出现 **「一键安装缺失依赖」** 按钮：只列出并安装真正缺失的软件包，
  需二次确认后才执行；没有免密提权能力时不会尝试任何密码，而是给出可手动执行的命令。
* 页面下方 **「桌面控制依赖与配置」** 面板：可直接编辑 DISPLAY、XAUTHORITY、审批策略、
  观察快照有效期、允许的窗口标题、命令超时，并保存到配置文件。
* 同样的体检结果，模型侧通过 `linux_check_env` 工具读取——**同一份实现，两个入口**。

实现方式：宿主提供两条受同源保护的 HTTP 路由，客户端半只调用它们。

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/dsh-linux-desktop-use/check` | GET | 依赖体检报告（只读） |
| `/dsh-linux-desktop-use/install` | GET / POST | 轮询安装任务 / 启动缺失依赖安装（POST 需同源 Origin） |
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

## ⚠️ 使用风险与沙盒建议

本插件把**真实的鼠标与键盘控制权**交给 AI Agent，风险等级等同于「让一个可能犯错、且没有责任心的
操作者坐在你的电脑前」。内置的四道安全机制（观察门禁、分级审批、作用域白名单、坐标语义统一）
只能**降低**误操作概率，**不能消除**后果：

| 风险 | 典型场景 | 后果 |
| --- | --- | --- |
| 误删 / 误覆盖 | 在文件管理器误点「删除」、在编辑器误按 `ctrl+s` 覆盖未保存内容 | 数据丢失，多半不可撤销 |
| 误触破坏性命令 | 在终端里执行 `rm -rf`、改写系统配置 | 桌面或系统损坏 |
| 凭据泄露 | 截图把密码、token、验证码拍进模型上下文并随请求上传 | 账号失窃 |
| 误发消息 / 误支付 | 在 IM、网页表单、支付页面误触「发送」「付款」 | 不可撤回的信息或资金损失 |
| 坐标 / 窗口误判 | 截图缩放、坐标换算偏差或多屏错位导致点错位置 | 误操作到另一个窗口 |
| 失控循环 | Agent 反复执行写操作而无人盯梢 | 桌面被持续破坏 |

**强烈建议在沙盒 / 隔离环境中使用**：

1. **用独立的虚拟机或容器化桌面**：VirtualBox / VMware / QEMU 虚机、Docker + Xvfb、
   KasmVNC 下的 `Xvnc :N` 独立会话、或一次性容器。本插件按 `DISPLAY` / `XAUTHORITY` 定位会话，
   天然适配「另一个 X 会话」这一隔离方式。
2. **沙盒内不放真实数据**：不要在沙盒桌面里登录真实账号、挂载生产目录、打开含敏感信息的文件。
3. **保持 `approvalMode = all`（默认）**：每个写操作都需人工逐次批准；
   不要在承载真实数据的环境里把审批模式设为 `off`。
4. **用 `allowedWindows` 缩小作用域**：只允许操作指定标题的窗口，点到其他程序会被直接拒绝。
5. **缩短观察快照有效期**：适当调小 `ttlMs`，避免「看的是旧画面、点的是新界面」。
6. **真实日常桌面不要接 Agent**：把 Agent 留在沙盒，真人在真实桌面办公；
   需要在真实桌面使用时，先用只读工具观察，确有必要再逐次批准写操作。

## 运行依赖

| 依赖 | 用途 | 必需 |
| --- | --- | --- |
| `xdotool` | XTEST 注入鼠标/键盘事件、读取指针与窗口几何 | 是 |
| `scrot` | 屏幕/区域截图（失败时回退 `ffmpeg x11grab`） | 建议 |
| `ffmpeg` | 截图回退实现 + 截图缩放 | 可选 |
| `wmctrl` | 列出窗口、激活窗口（EWMH） | 建议 |
| `xrandr` / `xprop` | 屏幕尺寸兜底 + 显示器枚举（`linux_displays`） | 建议 |
| `ffmpeg` | 截图回退实现、截图缩放 + 画面指纹计算（`linux_verify_state`） | 建议 |
| `python3` + `python3-gi` + `gir1.2-atspi-2.0` | 无障碍树采集脚本（`linux_app_state` / `linux_set_value`） | 可选 |
| `at-spi2-core` + `libatk-adaptor` | 无障碍总线与 ATK 桥接（让 GUI 应用暴露无障碍树） | 可选 |
| `xdpyinfo` | XTEST 扩展能力探测（缺失时回退用 xdotool 探测） | 可选 |

安装：

```bash
sudo apt-get install -y xdotool scrot wmctrl ffmpeg
# 可选：启用无障碍树能力
sudo apt-get install -y at-spi2-core libatk-adaptor python3-gi gir1.2-atspi-2.0
```

### 检查与一键安装（v1.8.0 起）

上表每一项都登记在依赖目录 `lib/dependencies.js` 里，目录是**唯一事实来源**：

* 详情页的「检查依赖」按钮与 `linux_check_env` 工具读同一份报告，逐条给出
  **类型（程序 / 系统包）、级别（必需 / 建议 / 可选）、用途、状态、提供者软件包**，
  缺失项按级别上报为 error / warning / info。
* 报告里的 `install` 段给出待安装软件包与等价命令：

  ```bash
  sudo apt-get install -y scrot wmctrl
  ```

* 详情页随后出现 **「一键安装缺失依赖」** 按钮 → 二次确认 → 后台执行 `apt-get install -y`，
  页面轮询进度并显示安装输出尾部。

安装环节的安全边界：

| 边界 | 行为 |
| --- | --- |
| 只装目录登记的包 | 浏览器只能提交目录 **id**，不能提交任意包名；包名由目录查表决定 |
| 同源要求 | `POST /install` 必须带匹配主机名的 `Origin`，跨站或缺 Origin 一律 403 |
| 不索取密码 | 提权只用「已是 root → 免密 `sudo -n` → `pkexec`」三条路径；都没有时任务直接失败并给出手动命令 |
| 后台 + 轮询 | apt-get 可能耗时数分钟，安装在后台跑，HTTP 请求不阻塞 |
| 审计留痕 | 每次尝试追加到 `~/.local/state/dsh/linux-desktop-use-install.log` |
| 安装后复检 | 任务结束后自动重新体检，状态同步回依赖清单 |

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

本机已写入的备注：*操控本机 Linux 图形桌面：截图、点击/拖拽/滚动、键盘输入、窗口列举与激活，
应用枚举/启动/聚焦、显示器枚举、窗口移动缩放、界面状态断言。
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

# 单元测试 + 集成冒烟（node:test，集成部分需要真实 X 会话，否则自动跳过）
npm test

# 确认宿主已注册工具
cordis_inspect_query host Tool listTools   # 应看到 17 个 linux_* 工具
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

## 许可证

本项目采用 [MIT 许可证](./LICENSE)，版权所有者：sorc。

```text
MIT License

Copyright (c) 2026 sorchk
```

完整协议文本见仓库根目录的 [`LICENSE`](./LICENSE) 文件（随 npm 包一同分发）。
