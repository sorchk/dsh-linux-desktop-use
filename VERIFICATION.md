# 验证记录（VERIFICATION）

本文件记录 `dsh-linux-desktop-use`（原名 `@local/dsh-linux-desktop-use`）在**本机实机环境**上的验证步骤与实测结果。
验证脚本：`scripts/smoke-test.mjs`（用假 `ctx` 驱动**真实**工具实现，直连真实 X 会话）。

> 验证环境本身就是**隔离的 X 会话**（KasmVNC → `Xvnc :1`），未涉及生产环境或真实账号数据。
> 这也是本插件的推荐使用方式：AI Agent 只在沙盒 / 隔离桌面中接管真实输入事件，
> 详见 [`PERMISSIONS.md` 第 0 节](./PERMISSIONS.md) 与 README 的「使用风险与沙盒建议」。

## 0. 验证环境

| 项 | 实测值 |
| --- | --- |
| 操作系统 | Ubuntu 24.04 (arm64) |
| 桌面环境 | Linux 图形桌面（实测为 XFCE 4.18），运行在 KasmVNC → `Xvnc :1`（1882x1040） |
| X 显示 | `DISPLAY=:1`，`XAUTHORITY=/home/sorc/.Xauthority`（245 bytes, mode 600） |
| X 扩展 | `xdpyinfo` 报告 22 个扩展，含 **XTEST**（输入注入依赖它） |
| 辅助程序 | xdotool 3.20160805.1 / scrot 1.10 / ffmpeg 6.1.1 / wmctrl 1.07 / xrandr |
| DSH | 0.2.1-rc.5，profile `web`，模型 `MiniMax-M3.1-Flash`（支持图片输入） |

## 1. 冒烟测试结果（`node scripts/smoke-test.mjs`）

结论：**all smoke-test steps passed**。

| # | 步骤 | 断言 | 实测 |
| --- | --- | --- | --- |
| 1 | `linux_desktop_status` | 返回显示/分辨率/审批模式/快照状态 | `display=:1`、`screen=1882x1040`、`pointer=500,500`、`active_window=13928718 sorc - Thunar` |
| 2 | `linux_screenshot`（整屏） | 产出 PNG 并交给模型 | 122801 bytes |
| 3 | `linux_screenshot`（区域） | 按 `region=x,y,w,h` 裁剪 | 400x300 区域图 |
| 4 | `linux_windows` | 列出窗口 | 11 个窗口 |
| 5 | **P0-1 无观察写操作** | 未截图直接 `linux_click` 必须被拒 | 抛错「尚未观察桌面：请先调用 linux_screenshot…」 |
| 6 | **P0-1 写后作废** | 写操作成功后快照作废，再写必须被拒 | 抛错「上次观察已作废…」 |
| 7 | **P0-1 TTL 过期** | `DSH_LINUX_TTL_MS=1` 后再写必须被拒 | 抛错「观察快照已过期（约 N 秒 > 1 秒）…」 |
| 8 | **P0-2 普通文本** | `approvalMode=dangerous` 时普通文本**不**触发审批 | approvalLog 长度 0 |
| 9 | **P0-2 危险文本** | 文本含「删除所有文件」触发审批 | approvalLog 长度 1，`risks` 含 `delete` |
| 10 | **P0-2 审批拒绝** | 审批返回 `rejected` 时写操作被拒 | 抛错「桌面操作未获批准（审批结果：rejected）」 |
| 11 | **P0-2 作用域限制** | `allowedWindows` 不含目标窗口时拒绝 | 抛错并说明窗口不在允许范围 |
| 12 | 真实输入 | `linux_type` + `linux_key` 写入 xterm 里的文件 | 文件内容 `hello-from-dsh-linux-plugin删除所有文件hello-from-dsh-linux-plugin`（含中文逐字符输入，无丢字） |
| 13 | **P0-3 坐标换算** | `space=local` 时按快照原点换算 | region `0,33,400,300` → local(10,10)=screen(10,43)；`max_width=200` 缩略后 scale=2 → local(10,10)=screen(20,53)，与真实指针位置一致 |
| 14 | `linux_drag` | 拖拽不改坏桌面 | 通过 |

## 2. 宿主侧验证（运行中的 DSH 进程）

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 工具注册 | `cordis_inspect_query(host, Tool, listTools)` | v1.5.x 为 11 个 `linux_*` 工具；v1.6.0 起增加 `linux_apps`、`linux_launch_app`、`linux_activate_app`、`linux_displays`、`linux_set_window_frame`、`linux_verify_state`，共 17 个 |
| 审批闸门（真实会话） | 子代理会话调用 `linux_scroll`（会走 `approve()`） | 返回 `Error: 桌面操作未获批准（审批结果：rejected）` → 闸门真实生效 |
| 审批豁免对照 | 同会话调用 `linux_move_mouse` | 直接成功（该工具只读+不审批，符合设计） |
| 服务依赖 | `cordis_inspect_query(host, Service, listService)` | `tools`、`attachments`、`approval`、`computerUse`、`hmr`、`webServer` 等在线 |
| 客户端半进入 boot 清单 | 浏览器 `window.__DSH_BOOT__.entries` | 84 条，其中含 `@local/dsh-linux-desktop-use`；刷新后详情页按钮与面板可见 |

> 注意：验证审批必须使用**真正调用 `approve()`** 的写工具（click/drag/type/key/scroll/activate_window）；
> `linux_move_mouse` 免审批，用它验证会得到假阳性。

## 3. 已知边界

* `scrot` 不能把 PNG 写到管道（`Saving to file /dev/stdout failed`），因此截图先落 `${TMPDIR:-/tmp}` 临时文件再读回并删除。
* 宿主进程通常没有 `DISPLAY`/`XAUTHORITY` 环境变量，插件按 `DISPLAY → /tmp/.X11-unix/X* → ~/.vnc/xdev:<n>.pid` 顺序探测；换机器部署建议显式设置 `DSH_LINUX_DISPLAY` / `DSH_LINUX_XAUTHORITY`。
* `scrot` 缩略（`max_width`）会让 `scale > 1`，动作坐标必须用 `space=local` 换算，直接用图上像素会点偏。
* 写操作会让观察快照作废（界面可能已变），因此连续写操作之间需要重新 `linux_screenshot`。
* 宿主以链接方式安装本包时，代码改动需要宿主重新加载模块（`plugin_manager` 重装 → `hmr.reconcileProfile` 驱逐旧 ESM 缓存），仅改磁盘文件不会自动生效。
* 冒烟测试偶发不稳：`type + key 写入文件` 与 `P0-3 缩略坐标换算` 两步依赖真实桌面的窗口焦点与指针位置，若此时有别的窗口抢焦点或人移动鼠标，会出现一次假失败；重跑即恢复（已连续 3 次全绿）。

## 4. 改名记录（xfce → linux）

| 项 | 改名前 | 改名后 |
| --- | --- | --- |
| 插件目录 | `dsh-xfce-computer-use/` | `dsh-linux-desktop-use/` |
| 包名 | `@local/dsh-xfce-computer-use` | `@local/dsh-linux-desktop-use`（v1.4.0，因缓存键需要再改一次） |
| 包名（npm 发布用） | `@local/dsh-linux-desktop-use` | `dsh-linux-desktop-use`（v1.5.0，去掉 scope 便于发布到 npm 公共区） |
| 补丁 id | `dsh-xfce-computer-use` | `dsh-linux-desktop-use` |
| 工具前缀 | `xfce_*`（10 个） | `linux_*`（11 个，含 `linux_check_env`） |
| 配置文件 | `~/.config/dsh/xfce-computer-use.json` | `~/.config/dsh/linux-computer-use.json` |
| 环境变量 | `DSH_XFCE_*` | `DSH_LINUX_*`（DISPLAY / XAUTHORITY / APPROVAL_MODE / TTL_MS / ALLOWED_WINDOWS / TIMEOUT_MS / CONFIG / REQUIRE_APPROVAL） |
| 截图临时文件 | `${TMPDIR}/dsh-xfce-shot-*.png` | `${TMPDIR}/dsh-linux-shot-*.png` |

> 工作区目录名 `/home/sorc/workspaces/dsh-xfce-use` 按要求保持不变（仅其下的插件目录改名）。

## 5. 说明文字在 GUI 中的显示验证（v1.2.0）

| 展示面 | 机制 | 实测 |
| --- | --- | --- |
| DSH 核心「插件 → 已安装」 | `readPluginMeta` 扫描包内 `locale/*.json` 的 `meta.title` / `meta.description` | 卡片标题「Linux 电脑控制」，描述全文显示（适用范围 + 依赖 + 审批说明） |
| 「插件 → 插件市场 → 已安装」行 | 市场目录 `authored` 描述 **或** 用户「备注」 | 本包为 `link:` 本地开发安装、未进市场目录 ⇒ 走备注通道；`POST /dsh-market/note` 写入 161 字备注后，该行描述位立即显示该文字 |

* 备注通道细节：路由 `POST /dsh-market/note`（`dshmarket/lib/routes.js:3770`），`sameOrigin` 校验，
  文本 `trim().slice(0, MAX_NOTE=200)`，写入 profile 市场状态文件的 `notes` 字段。
* 无 DSH 登录态的 `curl` 调用 `/dsh-market/installed`、`/dsh-market/registry` 会被拒绝（需登录），
  因此该通道的验证在带会话的浏览器中完成。

## 6. 缺陷修复记录

| 问题 | 现象 | 修复 |
| --- | --- | --- |
| 非 ASCII 输入丢字符 | `xdotool type` 一次输入中英文混排时，中文被丢（`删除所有文件` → `删所有文件`） | `lib/x11.js` `typeText` 改为：ASCII 连续段一次输入（delay 12ms），非 ASCII 字符**逐个**单独输入（delay 30ms，间隔 90ms），避免键位重映射互相覆盖 |
| 链接安装的代码不生效 | 改完磁盘文件，运行中的宿主仍用旧模块 | `plugin_manager` 先 `remove_bundle` 再 `install_bundle`，触发 `hmr.reconcileProfile` 驱逐旧 ESM 缓存（无需重启 dsh web） |
| 客户端半永远不进 boot 清单 | v1.3.0 加上 `dsh.client` 后，详情页仍无「检查依赖」按钮 | 宿主的包元数据缓存以「基址 + 包名」为键（`dsh-client-modules/lib/index.js` 的 `pkgMeta` + `sourceKey`），**缓存的 null 永不失效**；v1.2.0（无 `dsh.client`）扫描过一次后，同名再也无法被重新解析。修复：包改名（v1.4.0 → `@local/dsh-linux-desktop-use`）换掉缓存键，无需重启宿主 |

## 7. 插件详情页功能验证（v1.4.0）

| 功能 | 验证方式 | 结果 |
| --- | --- | --- |
| 「检查依赖」按钮 | 浏览器进入「插件 → Linux 电脑控制」详情页并点击 | 报告显示「依赖齐备，可以正常控制桌面」，列出 7 个辅助程序（xdotool/scrot/ffmpeg/wmctrl/xrandr/xprop/xdpyinfo）及版本、X11 会话段、1 条 info 级提示（宿主自身无 DISPLAY） |
| 配置面板 | 详情页面板直接改「审批策略」为 `dangerous`、「观察快照有效期」为 45000 并点「保存配置」 | 写盘成功，`GET /config` 回显 `approvalMode:"dangerous"`、`ttlMs:45000`；已恢复为 `all` / 30000 |
| 跨源防护 | `POST /config` 带 `Origin: http://evil.example` | 403 `{"error":"cross-origin request refused"}` |
| 同源写入 | `POST /config` 带 `Origin: http://127.0.0.1:3080` | 200，配置落盘 |
| 模型侧一致性 | `linux_check_env` 工具 | 与详情页按钮读同一份 `checkEnvironment` 实现 |

## 8. 打包发布流程验证（v1.5.0）

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 工作流文件存在且仅手动触发 | `.github/workflows/publish.yml` 的 `on:` 只含 `workflow_dispatch` | 无 push / tag / schedule 触发器，**不会自动打包或发布** |
| 语法检查步骤可通过 | 本机 `node --check index.js client.js lib/*.js` | 全部通过（CI 中为同一条命令） |
| 打包可产出 tarball | 本机 `npm pack --pack-destination dist` | 生成 `dsh-linux-desktop-use-1.5.0.tgz`（17 个文件，压缩后 38.7 kB） |
| 包内容完整 | `tar -tzf` 列出 tarball | 含 `index.js`、`client.js`、`lib/*`、`locale/*.json`、`icon.svg`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`PERMISSIONS.md`、`VERIFICATION.md` |
| 包元数据可发布 | `package.json` | 已去掉 `private: true`，含 `publishConfig.access: public`、`repository`、`engines.node >= 20` |

> 实际发布需要仓库 Secret `NPM_TOKEN`，只能在 GitHub Actions 页面手动触发后验证。

## 9. 应用 / 显示器 / 窗口几何能力验证（v1.6.0）

验证方式：`node --test "test/*.test.js"`（单元测试 + X 会话集成冒烟，`test/integration.test.js`）。

### 9.1 自动化测试

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 全部用例 | `npm test` | 60 个用例全部通过（单元 51 + 集成冒烟 9）：apps 18、desktop-entries 7、integration 9、observe 5、tools 6、verify 9、x11-parse 6 |
| 桌面条目解析 | `test/desktop-entries.test.js` | 本地化名称、`Terminal`、`NoDisplay`、`StartupWMClass`、`[Desktop Action]` 子组、`Exec` 字段码剥离均正确 |
| 应用索引与匹配 | `test/apps.test.js` | 同可执行名时优先匹配主条目（`thunar` 优于 `thunar-bulk-rename`）；隐藏条目只在无可见匹配时兜底 |
| 终端参数 | `test/apps.test.js` | `xfce4-terminal` → `--command=htop`；`gnome-terminal` → `-- htop`；`xterm` / `konsole` → `-e htop` |
| 指纹比对 | `test/verify.test.js` | 相同画面 `changedRatio = 0`；不同画面给出非零比例 |
| 工具契约 | `test/tools.test.js` | 17 个工具齐全；三个新写工具在 `WRITE_TOOLS` 内；只读工具不在；每个工具具备参数 schema 与输出 schema |
| 集成冒烟 | `test/integration.test.js` | 显示器枚举、应用列表与过滤、窗口断言、截图指纹比对、窗口移动缩放、参数校验、应用聚焦共 9 项全通过 |

### 9.2 实机观测

| 观测项 | 实测值 |
| --- | --- |
| `xrandr --listmonitors` | `Monitors: 1`，` 0: +VNC-0 1882/498x1040/275+0+0  VNC-0`（`+` 表示主屏） |
| `xrandr --current` | `VNC-0 connected 1882x1040+0+0 0mm x 0mm` + 14 个模式；**不含 `primary` 关键字** → 主屏以 `monitors[].primary` 为准 |
| `wmctrl -lx -G -p` | 行格式 `id desktop pid x y w h WM_CLASS host title…`，`WM_CLASS` 形如 `chromium.Chromium`、`Thunar.Thunar` |
| 已安装 `.desktop` | `/usr/share/applications` 52 个 + `~/.local/share/applications` 5 个；其中 `NoDisplay=true` 9 个、`Terminal=true` 3 个 |
| 运行中应用关联 | 修复打分前 `Thunar` 被误配到 `thunar-bulk-rename`、`Xfce4-terminal` 被误配到 `xfce4-terminal-settings`；修复后分别正确关联 `thunar`、`xfce4-terminal` |
| 窗口位置偏移 | XFCE 4.18 装饰边框使实际位置比请求值大 `(+2, +56)`；`xprop -id <id> _NET_FRAME_EXTENTS` → `1, 1, 28, 1`；尺寸（宽高）完全准确。`lib/x11.js` 的 `moveWindowTo` 会读回实际坐标并按差值二次修正，最多 3 次收敛 |
| 启动应用 | `linux_launch_app app=xterm` 成功（`{"app":"debian-xterm","command":"xterm"}`，窗口出现）；`linux_launch_app app=htop` 生成 `{"command":"/usr/bin/xfce4-terminal","argv":["--command=htop"],"terminal":true}` |

### 9.3 已知限制

* `linux_apps` 的运行中应用按 `WM_CLASS` 关联 `.desktop` 条目：桌面组件类窗口（`Xfce4-panel`、`Xfdesktop`）没有对应的主条目，会显示为无匹配条目。
* 区域截图是**屏幕区域**而非窗口原生内容：被遮挡时拍到的是上层窗口（`xwd` 未安装，无法做窗口原生截取）。
* `linux_launch_app` 对依赖 D-Bus 会话总线的应用（文件管理器、系统设置等）需要宿主进程具备
  `DBUS_SESSION_BUS_ADDRESS`。插件会先从自身环境读取，再从运行中窗口的 `/proc/<pid>/environ` 兜底查找；
  若两者都取不到，应用可能因无法连接会话总线而启动失败。
* `linux_verify_state` 的画面比对基于 64×36 灰度指纹，适合判断「界面是否变化」，不适合判断细微差异。

## 10. AT-SPI 无障碍能力验证（v1.7.0）

验证方式：`node --test "test/*.test.js"`（单元测试 + X 会话集成冒烟），
并在真实会话里用自建的 GTK3 测试应用做端到端验证。

### 10.1 自动化测试

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 全部用例 | `npm test` | 96 个用例全部通过（单元 80 + 集成冒烟 16）：apps 18、atspi 20、desktop-entries 7、diagnostics 5、integration 16、observe 5、tools 10、verify 9、x11-parse 6 |
| 桥接层纯逻辑 | `test/atspi.test.js` | 环境拼装、请求构造、响应解析、树裁剪、角色/名称筛选、可编辑节点挑选、坐标计算、错误映射共 20 项全通过（不需要 X 会话与 python3） |
| 依赖体检 | `test/diagnostics.test.js` | `a11y` 段的 `available` 判定：三项齐备 → 可用；缺 `python3` / `gi` / 总线 socket → 不可用并说明原因 |
| 工具契约 | `test/tools.test.js` | 19 个工具齐全；`linux_set_value` 在 `WRITE_TOOLS` 内、`linux_app_state` 不在；两个工具的参数与输出 schema 齐全 |
| 集成冒烟 | `test/integration.test.js` 的 AT-SPI 组 | 起一个 GTK3 测试应用，验证列树、按角色与名字过滤、直读文本、写入文本、参数校验共 6 项全通过 |

### 10.2 实机观测

| 观测项 | 实测值 |
| --- | --- |
| 依赖安装 | `sudo apt-get install -y at-spi2-core libatk-adaptor` 只需 2 个包；`python3-gi`、`gir1.2-atspi-2.0`、`libatspi2.0-0t64` 本机已有 |
| 总线位置 | a11y 总线 socket 在 `/run/user/1000/at-spi/bus`；进程 `at-spi-bus-launcher` + `at-spi2-registryd` + 一个 `dbus-daemon(--config-file=/usr/share/defaults/at-spi2/accessibility.conf)` |
| 会话总线对象路径 | 无障碍总线地址由**会话总线**的 `org.a11y.Bus.GetAddress` 提供，对象路径是 `/org/a11y/bus`（`/org/a11y/atspi/bus` 会报 "Object does not exist at path"） |
| `linux_app_state` 输出 | 对 GTK3 测试应用返回 5 个节点；按 `role='push button'` 过滤得到 `push button "Target Button" box={"x":858,"y":554,"width":166,"height":26} path=0.0.1` |
| `linux_set_value` 输出 | `{"app":"dsh-a11y-app.py","role":"text","path":"0.0.0","before":"original-value","after":"written-by-tool","changed":true}`；复读 AX 树确认文本已变 |
| 体检输出 | `a11y.available = true`，`python3Path=/usr/bin/python3`，`busPath=/run/user/1000/at-spi/bus`，无 `a11y-unavailable` 提示 |

### 10.3 已知限制

* **目标应用必须在安装依赖之后重启**才会注册到无障碍总线：装依赖前启动的进程
  （本机 11 月 1 日启动的 chromium、11 月 5 日启动的 xfce4-terminal）不会自动补注册。
* **`select_text` 不可行**：GTK3 的 `TextView` 的 `get_selection_iface()` 返回 `None`，
  缺少 `Selection` 接口，无法直接读取或设置选区。
* **原生右键菜单不可行**：AX 树里没有 `menu` / `menu item` 角色，
  只有控件自带的 `Action`（`do_action(0)` 可用，实测返回 `True`，动作名 `click`）。
* **裸 D-Bus 拿不到应用清单**：直接用 `gdbus` / `busctl` 调
  `org.a11y.atspi.Accessible.GetChildren` 恒返回空数组（`GetRoleName` 却能正确返回
  `desktop frame`），应用清单只在 libatspi 内部路径暴露 —— 这也是桥接走
  `python3` + `gi/Atspi` 子进程而不是裸 D-Bus 的原因。
* **子进程必须有 `DISPLAY`**：只给 `DBUS_SESSION_BUS_ADDRESS` 而不给 `DISPLAY` 时，
  `Atspi.get_desktop(0)` 返回 0 个应用。
* 节点文本默认截断到 400 字符、子节点上限 200，避免整屏文本一次性进入模型上下文。
* `python3 -c <script>` 启动的应用在总线上的应用名是 `-c` 而不是 `python3`，
  按应用名过滤时要用真实应用名（写成脚本文件时即为脚本文件名）。
