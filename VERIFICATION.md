# 验证记录（VERIFICATION）

本文件记录 `@local/dsh-linux-desktop-use` 在**本机实机环境**上的验证步骤与实测结果。
验证脚本：`scripts/smoke-test.mjs`（用假 `ctx` 驱动**真实**工具实现，直连真实 X 会话）。

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
| 工具注册 | `cordis_inspect_query(host, Tool, listTools)` | 11 个 `linux_*` 工具全部可见：`linux_screenshot`、`linux_click`、`linux_move_mouse`、`linux_drag`、`linux_type`、`linux_key`、`linux_scroll`、`linux_windows`、`linux_activate_window`、`linux_desktop_status`、`linux_check_env` |
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
