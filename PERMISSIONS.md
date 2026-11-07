# 权限声明（PERMISSIONS）

本文件逐项说明 `dsh-linux-desktop-use` 在运行时会用到哪些系统能力、为什么需要、以及它**不需要**什么。
声明同时以 `package.json → dsh.permissions` 的形式随包发布，便于宿主或审计工具直接读取。

## 0. 风险提示（务必先读）

**AI Agent 操控电脑具有真实的破坏力。** 本插件通过 XTEST 注入**真实的**鼠标与键盘事件，
效果与真人操作等价；模型的一次误判就可能造成不可逆后果：

* 误删文件、覆盖未保存的文档、覆盖系统配置；
* 在终端执行破坏性命令；
* 截图把密码 / token / 验证码送进模型上下文；
* 误发消息、误触支付；
* 反复写操作导致桌面被持续破坏。

四道内置安全机制（观察门禁、危险语义分级审批、作用域白名单、坐标语义统一）只能**降低**误操作概率，
**不能消除**后果；其中 `approvalMode = off` 会连人工闸门一并关闭，**只在隔离沙盒中才可考虑**。

> **强烈建议在沙盒 / 隔离环境中使用本插件**：独立虚拟机、容器化桌面（Docker + Xvfb）、
> KasmVNC 下的独立 `Xvnc :N` 会话或一次性容器。沙盒内不要放真实数据与真实登录态；
> 承载真实数据的桌面不要交给 Agent。

## 1. 能力总览

| 能力 | 需要什么 | 用途 | 缺了会怎样 |
| --- | --- | --- | --- |
| 连接 X server | `DISPLAY`（本机 `:1`）+ `XAUTHORITY`（`~/.Xauthority`） | 所有截图与输入注入都发生在同一个 X 会话里 | 所有工具报错，提示检查桌面会话 |
| 读取屏幕像素 | `scrot`（或 `ffmpeg -f x11grab` 兜底） | 生成模型可看的截图 | `linux_screenshot` 报错 |
| 注入鼠标/键盘事件 | `xdotool`（走 XTEST 扩展） | 点击、拖拽、输入、按键、滚动 | 所有写工具报错 |
| 枚举/激活窗口 | `wmctrl`（EWMH） | `linux_windows`、`linux_activate_window`、`linux_activate_app` | 相关工具报错，其余工具不受影响 |
| 读取屏幕几何 | `xrandr`（或 `xdotool getdisplaygeometry`） | 换算坐标、判断边界 | 退化为 `xdotool` 取值 |
| 枚举显示器 | `xrandr --listmonitors` / `--current` | `linux_displays` 输出分辨率、位置与主屏标记 | 该工具报错，其余工具不受影响 |
| 移动/缩放窗口 | `xdotool windowmove` / `windowsize`，必要时 `wmctrl -b remove,maximized_*` | `linux_set_window_frame` | 该工具报错，其余工具不受影响 |
| 读取桌面条目 | `/usr/share/applications`、`~/.local/share/applications` 下的 `*.desktop`（只读） | `linux_apps` / `linux_launch_app` 的应用来源 | 没有条目时 `linux_apps` 返回空列表 |
| 启动应用 | `child_process.spawn`（固定 argv，不经 shell），从 `.desktop` 的 `Exec` 字段取值 | `linux_launch_app` | 该工具报错 |
| 读取宿主 D-Bus 地址 | `/proc/<pid>/environ`（只读，仅取 `DBUS_SESSION_BUS_ADDRESS`） | 让依赖会话总线的应用（文件管理器等）能正常启动 | 应用可能因缺少会话总线而启动失败 |
| 启动子进程 | 宿主允许 `child_process`（本插件用 `execFile`，固定 argv，不经 shell） | 调用上述命令行工具 | 所有工具报错 |
| 读取无障碍树 | `python3` + `python3-gi` + `gir1.2-atspi-2.0`（子进程，只读遍历 AX 树） | `linux_app_state` 读取控件角色、名称、坐标与文本 | 该工具报可读错误，其余工具不受影响 |
| 写入控件文本 | 同上，走 `EditableText.set_text_contents` | `linux_set_value` 直接给控件赋值 | 该工具报可读错误，其余工具不受影响 |
| 读取无障碍总线 | `/run/user/<uid>/at-spi/bus`（socket，只读） | 让 python 子进程连上 AT-SPI 总线 | 无障碍功能整体不可用 |
| 启动浏览器实例 | `child_process.spawn`（固定 argv，不经 shell），独立 profile 目录 | `linux_browser_launch` 起一个带 `--force-renderer-accessibility` 的 Chromium | 浏览器工具报错，其余工具不受影响 |
| 触发控件动作 / 聚焦控件 | AT-SPI `Action.do_action` / `Component.grab_focus`（经 `lib/atspi.py` 子进程） | `linux_browser_click` / `linux_browser_type` / `linux_browser_navigate` | 相关浏览器工具报错，其余工具不受影响 |
| 读取浏览器进程命令行 | `/proc/<pid>/cmdline`（只读） | 判断实例是否带 `--force-renderer-accessibility`、是否占用同一 profile | 体检的 `browser` 段信息不全 |
| 读取桌面条目（AT-SPI 侧） | 无需额外权限：`lib/atspi.py` 只做遍历与接口调用 | 采集控件树 | — |
| 写临时文件 | `${TMPDIR:-/tmp}` 可写 | `scrot` 不能写管道，先落临时 PNG 再读回 | `linux_screenshot` 报错 |
| 交图给模型 | `ctx.attachments.saveImage` | 把 PNG 转成模型可见的图片块 | 截图工具不注册 |
| 人工审批 | `ctx.approval.request`（只认 `allowed-once`） | 写操作前的授权闸门 | 审批不可用时写操作一律拒绝 |
| 详情页体检与配置 | 宿主 `webServer` 的两条 exact 路由（`/dsh-linux-desktop-use/check`、`/config`） | 插件详情页的「检查依赖」按钮与配置面板；同源校验 | 无 webServer 的宿主上这两项不可用，其余工具不受影响 |

## 2. 不需要什么

* **不需要 root**。插件与 DSH 宿主同用户运行，X server 的访问控制由 Xauthority cookie 决定。
* **不需要**额外授权工具（无 polkit / dbus 提权），也**不修改**系统设置。
* **不需要网络**。全部为本地进程调用与本地文件读写，`dsh.permissions.externalServices` 为空。
* **不接管**键盘/剪贴板之外的系统设施，不做窗口注入或抓包。

## 3. 四道内置安全机制（P0）

| 机制 | 实现位置 | 行为 |
| --- | --- | --- |
| 观察门禁 + 快照 TTL | `lib/observe.js` | 写操作前必须有一次新鲜的 `linux_screenshot`；默认 TTL 30 秒，过期/作废一律拒绝并提示重新观察 |
| 危险语义分级审批 | `lib/guard.js` | 文本/按键/窗口标题命中删除、支付、凭据、破坏性命令四类语义时强制审批；`approvalMode` 可选 `all` / `dangerous` / `off` |
| 坐标语义统一 | `lib/observe.js` + `lib/tools.js` | 截图返回 `origin_x/origin_y/scale/coordinate_space`；动作可用 `space=screen`（屏幕绝对像素）或 `space=local`（截图局部像素，自动换算） |
| 打包权限声明 | `package.json → dsh.permissions` + 本文件 + `VERIFICATION.md` | 权限、命令、读写路径、失败边界、验证证据随包可审计 |

## 4. 写操作与只读操作

* 只读（不触发审批、不改桌面）：`linux_screenshot`、`linux_windows`、`linux_desktop_status`、`linux_check_env`、
  `linux_apps`、`linux_displays`、`linux_verify_state`、`linux_app_state`、`linux_browser_state`。
* 写（触发门禁 + 审批）：`linux_click`、`linux_drag`、`linux_type`、`linux_key`、`linux_scroll`、`linux_activate_window`、
  `linux_launch_app`、`linux_activate_app`、`linux_set_window_frame`、`linux_set_value`、
  `linux_browser_launch`、`linux_browser_click`、`linux_browser_type`、`linux_browser_navigate`。
* 浏览器工具的观察门禁由**无障碍树**满足（读树即是一次对目标页面的新鲜观察），
  不需要额外的 `linux_screenshot`；作用域白名单与风险判定改用**浏览器窗口标题**。
  `linux_browser_launch` 属于「新建窗口」，用 `ignoreScope` 跳过已有窗口白名单，但仍需审批。
* `linux_move_mouse` 只移动指针，不改变任何应用状态，因此不触发审批，但仍需要新鲜的观察快照。
* `linux_verify_state` 保持只读：它会刷新观察快照里的画面指纹基线，但不会解除观察门禁本身。

## 4.1 详情页路由的写入面

| 路由 | 会不会改东西 |
| --- | --- |
| `GET /dsh-linux-desktop-use/check` | 只读体检：不写任何文件，不触碰桌面 |
| `GET /dsh-linux-desktop-use/install` | 只读：读取当前安装任务的状态与输出 |
| `POST /dsh-linux-desktop-use/install` | **会以 root 权限安装系统软件包**（仅限依赖目录登记的包）；路由要求带匹配主机名的 `Origin`，跨站或缺 Origin 一律 403 |
| `GET /dsh-linux-desktop-use/config` | 只读：读取配置文件与生效值 |
| `POST /dsh-linux-desktop-use/config` | **会写** `~/.config/dsh/linux-computer-use.json`（仅接受白名单内的键）；路由带同源校验，跨源请求 403 |

## 4.2 一键安装依赖的提权路径与审计

详情页的「一键安装缺失依赖」按钮会真的调用 `apt-get install -y`，这是本插件唯一会写到
**系统目录**的操作，因此提权路径被严格限定：

| 顺序 | 方式 | 条件 | 行为 |
| --- | --- | --- | --- |
| 1 | 已是 root | 宿主进程 uid = 0 | 直接 `apt-get install -y` |
| 2 | 免密 sudo | `sudo -n -v` 成功 | `sudo -n apt-get install -y` |
| 3 | pkexec | 存在 `pkexec` | `pkexec apt-get install -y`（弹 polkit 授权框） |
| 4 | 都没有 | — | **拒绝安装**，任务标记失败并给出手动命令 |

约束：

* **绝不索取、绝不代填密码**：探测只用 `sudo -n`（非交互），失败即放弃。
* **只装目录登记的包**：包名由 `lib/dependencies.js` 查表决定，浏览器只能提交目录 id。
* **同源要求**：POST 必须带匹配主机名的 `Origin`，`sec-fetch-site: cross-site` 一律拒绝。
* **二次确认**：页面上的安装按钮先要点「确认安装」才会发起请求。
* **审计留痕**：每次尝试追加到 `~/.local/state/dsh/linux-desktop-use-install.log`
  （时间戳 + 任务 id + 包列表 + 结果 + 提权方式）。
* **安装后复检**：任务结束后自动重新体检，依赖清单状态同步刷新。

## 5. 审批模式取值

| `approvalMode` | 含义 |
| --- | --- |
| `all`（默认） | 所有写操作都申请一次审批 |
| `dangerous` | 仅命中危险语义的写操作申请审批 |
| `off` | 不申请审批（**仅限隔离沙盒环境**；承载真实数据/真实账号的桌面切勿关闭审批） |

旧字段 `requireApproval` 仍兼容：`true` 等价 `all`，`false` 等价 `off`。

## 6. 可配置项

配置文件 `~/.config/dsh/linux-computer-use.json`（每次调用重新读取）：

```json
{
  "display": ":1",
  "xauthority": "/home/sorc/.Xauthority",
  "approvalMode": "dangerous",
  "ttlMs": 30000,
  "allowedWindows": ["Thunar", "xterm"],
  "timeoutMs": 20000
}
```

环境变量优先级更高：`DSH_LINUX_DISPLAY`、`DSH_LINUX_XAUTHORITY`、`DSH_LINUX_APPROVAL_MODE`、
`DSH_LINUX_TTL_MS`、`DSH_LINUX_ALLOWED_WINDOWS`、`DSH_LINUX_TIMEOUT_MS`、`DSH_LINUX_CONFIG`。

## 7. AT-SPI（无障碍）能力是可选增强

`linux_app_state` / `linux_set_value` 与 5 个 `linux_browser_*` 依赖系统级的 AT-SPI 栈。
**缺失或不可用时，只有这些工具报错，其余 19 个工具完全不受影响**，
依赖体检也只记一条 info 级提示（`a11y-unavailable`），不会判失败。

### 7.1 浏览器工具不使用 CDP

浏览器这一块**刻意不走 CDP**（Chrome DevTools Protocol）：

* **不开启** `--remote-debugging-port`，启动命令行里根本没有调试端口；
* 页面内容通过 **AT-SPI 无障碍树**读取——和读屏软件看到的是同一份数据；
* 输入通过 **XTEST** 注入真实键盘事件，和真人打字等价；
* 因此不需要额外的网络端口暴露，也不需要在浏览器上开任何调试开关。

生效需要三个条件同时满足：

| 条件 | 不满足时 |
| --- | --- |
| 无障碍总线在跑（`at-spi2-core`） | 浏览器工具报「AT-SPI 不可用」并给安装命令 |
| 屏幕阅读器开关打开（`gsettings set org.gnome.desktop.a11y.applications screen-reader-enabled true`） | 浏览器能起来但无障碍树是空的，读不到网页内容 |
| 浏览器带 `--force-renderer-accessibility`（`linux_browser_launch` 自动加） | 无障碍树里只剩一个空壳窗口；`linux_check_env` 的 `browser` 段会标出来 |

> **注册进程重启后，已在运行的浏览器会从无障碍总线上掉线**，需要重启浏览器才能重新注册。
> `linux_browser_launch` 使用独立 profile 目录，不会影响你正在用的浏览器窗口；
> 同一个 profile 目录只允许一个实例在跑，第二次启动会自动复用已有实例。

安装依赖：

```bash
sudo apt-get install -y at-spi2-core libatk-adaptor python3-gi gir1.2-atspi-2.0
```

| 失败边界 | 表现 | 处理 |
| --- | --- | --- |
| `python3` 缺失 | 报「AT-SPI 不可用」，并附安装命令 | 安装 `python3` |
| `gi` / `Atspi` 绑定缺失 | 同上，错误里带原始原因 | 安装 `python3-gi` + `gir1.2-atspi-2.0` |
| 无障碍总线未起 | 同上 | 安装 `at-spi2-core` + `libatk-adaptor` |
| 目标应用没注册到总线 | `linux_app_state` 返回**空列表**（不报错）；`linux_set_value` 报「没有找到应用」 | 重启目标应用——**装依赖前启动的进程不会补注册** |
| 子进程超时 | 报「AT-SPI 采集脚本超时（Nms）」 | 调大 `timeoutMs` |
| 脚本返回非法 JSON | 报解析错误，并把 stderr 线索一并带出 | 检查 `lib/atspi.py` 是否被改动 |

> **数据最小化**：控件文本默认截断（`MAX_TEXT_LENGTH = 400`），单节点子节点数上限 200，
> 避免把整屏文本一次性灌进模型上下文。
