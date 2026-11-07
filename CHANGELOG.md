# 更新日志

### v1.8.1  2026-11-07

精简插件详情页的文档区：新增独立的精简详情文档，详情页不再渲染整篇 README，配置项无需滚动即可看到。

1. 新增 `docs/detail.md` / `docs/detail.en.md`：详情页专用精简文档，只保留简介、风险提示、
   工具概述、运行依赖与配置指引，工具明细与完整说明改为链接到 README。
2. `locale/zh.json` / `locale/en.json` 的 `meta.detail` 指向新的精简文档，
   宿主优先读取该文件，不再回退到包内 README.md 全文。
3. README 工具表格前新增 `## 工具一览` 标题，便于从详情页直接锚点跳转。
4. 详情页文档区由整篇 README（约 100+ 行）压缩到 959 字符 / 8 段，依赖体检、组件、来源等
   区块与配置面板保持原顺序。

### v1.8.0  2026-11-07

依赖检查覆盖 README「运行依赖」表的**全部**依赖，并在缺依赖时提供一键安装按钮。

1. 新增依赖目录 `lib/dependencies.js`：把 8 个辅助程序（xdotool / scrot / ffmpeg / wmctrl /
   xrandr / xprop / xdpyinfo / python3）与 4 个系统包（python3-gi / gir1.2-atspi-2.0 /
   at-spi2-core / libatk-adaptor）连同**级别**（必需 / 建议 / 可选）、**用途**与
   **提供者软件包名**登记成一份目录，成为「检查」「安装」「文档」的唯一事实来源。
2. 依赖体检改为逐条判定目录里的每一项：程序看 PATH，系统包看 dpkg 数据库
   （`dpkg-query -W -f '${Status}\t${Version}'`，缺失时回退 `dpkg -s`）；
   `python3-gi` / `gir1.2-atspi-2.0` 额外验证 gi/Atspi 绑定能否导入，
   装了包但绑定不可用时仍判为缺失并给出说明。缺失项按级别上报为 error / warning / info
   （此前只有 error / info 两档）。
3. 新增 `lib/installer.js`：探测 dpkg 包状态 → 决定提权路径（已是 root → 免密 `sudo -n` →
   `pkexec`）→ 执行 `apt-get install -y`；遇到 `Unable to locate package` 会先刷新一次包索引再重试。
   **绝不索取或代填密码**：没有非交互提权能力时直接失败，并给出可手动执行的命令。
4. 新增 `POST/GET /dsh-linux-desktop-use/install` 路由与详情页 **「一键安装缺失依赖」** 按钮：
   安装在后台执行、页面轮询进度并显示输出尾部，结束后自动重新体检。
   安全边界：浏览器只能提交目录 **id**、不能提交任意包名；POST 必须带匹配主机名的 `Origin`，
   跨站或缺 Origin 一律 403；每次尝试写入 `~/.local/state/dsh/linux-desktop-use-install.log` 审计日志。
5. 详情页依赖清单重做：从「只列辅助程序」改为**完整依赖清单**（类型 / 级别 / 状态 / 提供者软件包 /
   版本 / 用途），并显示「已装 x/y · 缺失 z」汇总；安装需二次确认才真正执行。
6. `linux_check_env` 工具的输出 schema 新增 `dependencies` 与 `install` 段，
   `summary` 新增 `dependenciesPresent` / `dependenciesTotal` / `dependenciesMissing`，
   渲染文本里给出缺失依赖与等价安装命令。
7. 新增测试 `test/dependencies.test.js`、`test/installer.test.js`、`test/http-install.test.js`
   （目录完整性、安装计划只含缺失项与目录内包名、未知 id 被忽略、无提权能力时拒绝安装并给出手动命令、
   安装路由的跨站 / 缺 Origin / 任意包名拒绝），测试总数从 96 个增加到 120 个。
8. 文档同步：README 新增「检查与一键安装」小节与安装安全边界表；PERMISSIONS.md 补提权路径与审计日志；
   VERIFICATION.md 补第 11 节实机验证记录；package.json 版本升到 1.8.0 并补充权限声明。

### v1.7.0  2026-11-06

新增 AT-SPI 无障碍树能力，工具总数从 17 个增加到 19 个。

1. 新增 `linux_app_state`：读取运行中 GUI 应用的无障碍树，每个控件带角色、名称、状态标记、
   **屏幕绝对坐标**与**文本内容**。顺带解决两个此前缺失的能力：元素级定位（坐标可直接喂给
   `linux_click`，不必在截图上目测）与控件文本直读（**不需要 OCR**）。
2. 新增 `linux_set_value`：按角色 / 名称定位到可编辑控件后**直接写入文本**，不走逐键模拟；
   写前走观察门禁 + 作用域白名单 + 分级审批，写后作废观察快照，写入内容参与危险语义识别。
3. 新增 `lib/atspi.py` 采集脚本与 `lib/atspi.js` 桥接层：Python 只负责遍历与调用接口
   （`tree` / `setValue` / `ping` 三个操作），所有可测试的判定逻辑（树裁剪、角色与名称筛选、
   控件匹配、错误映射）都放在 Node 侧纯函数里；**零新 npm 依赖、零新 PyPI 依赖**。
4. 依赖体检新增 `a11y` 段：逐项列出 `python3`、`gi`/Atspi 绑定、无障碍总线 socket
   （`/run/user/<uid>/at-spi/bus`）是否就绪；缺失时记一条 info 级提示，
   **AT-SPI 是可选增强，不影响其余工具，体检也不会因此判失败**。
5. 新增 `test/atspi.test.js`（20 个纯逻辑用例）与 `test/integration.test.js` 的 AT-SPI 冒烟组
   （真实会话下起一个 GTK 测试应用，验证列树、按角色 / 名字过滤、读文本、写文本与参数校验），
   测试总数从 60 个增加到 96 个。
6. README 新增「AT-SPI 无障碍能力」小节与依赖说明；PERMISSIONS.md 补 python3 子进程、
   无障碍总线读取路径与失败边界；VERIFICATION.md 补第 10 节实机验证记录。
7. 已知限制（实测结论）：`select_text` 不可行（GTK3 的 `Selection` 接口缺失）、
   原生右键菜单不可行（AX 树里没有 `menu` / `menu item` 角色）；
   另外**目标应用必须在安装依赖之后重启**才会注册到无障碍总线。

### v1.6.1  2026-11-06

补充 AI Agent 操作电脑的风险提示，明确建议在沙盒 / 隔离环境中使用本插件。

1. README 顶部新增醒目警告块：AI Agent 拥有**真实**鼠标与键盘控制权，一次误判就可能误删文件、
   覆盖未保存文档、误触破坏性命令、泄露凭据或误发消息 / 误支付，且多数不可撤销。
2. README 新增「⚠️ 使用风险与沙盒建议」一节：用表格列出六类典型风险与后果
   （误删 / 误覆盖、破坏性命令、凭据泄露、误发消息 / 误支付、坐标与窗口误判、失控循环），
   并给出六条收敛建议（独立虚机 / 容器 / 独立 X 会话、沙盒不放真实数据、保持 `approvalMode=all`、
   用 `allowedWindows` 缩小作用域、缩短 `ttlMs`、真实日常桌面不接 Agent）。
3. PERMISSIONS.md 新增第 0 节「风险提示（务必先读）」，说明内置四道安全机制只能降低概率、
   不能消除后果；第 5 节 `approvalMode=off` 的说明收紧为「仅限隔离沙盒环境」。
4. VERIFICATION.md 顶部补充说明：验证环境本身即隔离的 X 会话（KasmVNC → `Xvnc :1`），
   并指向沙盒建议。
5. `lib/tools.js` 新增常量 `WRITE_SAFETY_NOTE`，为 9 个写操作工具（`linux_click`、`linux_drag`、
   `linux_type`、`linux_key`、`linux_scroll`、`linux_activate_window`、`linux_launch_app`、
   `linux_activate_app`、`linux_set_window_frame`）的描述统一追加 CAUTION 提示，
   让模型在调用前就意识到「真实变更、不可逆、应运行在沙盒并保留逐次审批」。
6. `package.json` 的 `description` 与 `dsh.permissions.summary`、`locale/zh.json` 与 `locale/en.json`
   的插件描述均补充风险与沙盒说明；版本号升到 `1.6.1`。

### v1.6.0  2026-11-06

新增应用、显示器与窗口几何控制能力，工具总数从 11 个增加到 17 个。

1. 新增 `linux_apps`：读取 `/usr/share/applications` 与 `~/.local/share/applications` 下的
   `.desktop` 条目，按 `WM_CLASS` 与运行中的窗口关联，输出已安装应用、正在运行的应用与窗口标题。
2. 新增 `linux_launch_app`：按应用 id 或显示名启动应用。`Terminal=true` 的条目自动套用终端模拟器
   参数（`xfce4-terminal --command=`、`gnome-terminal --`、`xterm -e` 等），并从宿主进程环境注入
   `DBUS_SESSION_BUS_ADDRESS`，保证依赖会话总线的应用（文件管理器、设置程序等）能正常启动。
3. 新增 `linux_activate_app`：按应用名或窗口标题子串聚焦正在运行的窗口。
4. 新增 `linux_displays`：列出显示器与输出设备的分辨率、位置与主屏标记。
5. 新增 `linux_set_window_frame`：移动 / 缩放窗口；最大化窗口会先解除最大化，
   并按读取到的实际坐标收敛修正窗口装饰边框带来的偏移。
6. 新增 `linux_verify_state`：断言窗口标题、焦点窗口与窗口数量，并基于截图时记录的灰度指纹
   判断画面是否发生变化。
7. 安全门禁扩展：`linux_launch_app` / `linux_activate_app` / `linux_set_window_frame` 纳入写操作
   集合，自动获得作用域白名单、危险语义识别、分级审批与「动作后作废观察快照」；
   `linux_verify_state` 保持只读，不解除观察门禁。
8. `linux_screenshot` 在记录观察快照的同时记录画面指纹，供 `linux_verify_state` 比对。
9. 新增 `lib/desktop-entries.js`（`.desktop` 解析）、`lib/apps.js`（应用索引与启动）、
   `lib/verify.js`（指纹比对与断言求值）三个模块，并补充单元测试与 X 会话集成冒烟测试；
   `package.json` 增加 `npm test` 脚本。
10. 文档同步：README 补充新工具表格与说明，PERMISSIONS.md 与 VERIFICATION.md 补充新命令、
    新读写路径与实机验证记录；`package.json` 版本升到 `1.6.0`。

### v1.5.4  2026-11-06

补充 MIT 许可证。

1. 新增根目录 `LICENSE` 文件，采用标准 MIT 协议文本，版权归属 `Copyright (c) 2026 sorchk`。
2. `package.json` 的 `files` 白名单加入 `LICENSE`，随 npm 包一起分发；
   `license` 字段原本就是 `MIT`，本次补齐实际的协议文件。
3. README 新增「许可证」一节，指向 `LICENSE` 并附版权声明。

### v1.5.3  2026-11-06

为插件市场收录补充资源。

1. 新增 `assets/icon-180.png`（180×180 位图，由 `icon.svg` 导出）：插件市场（dshmarket / awesome-dsh-plugin）
   的条目 `icon` 字段只接受 GitHub 托管的位图，SVG 会被 CI 拒绝，因此额外提供 PNG 版本。
2. `package.json` 的 `files` 白名单加入 `assets/icon-180.png`，随 npm 包一起分发。

### v1.5.2  2026-11-06

修复 `dry_run`（发布演练）模式下工作流必然失败的问题。

1. `dry_run = true` 时 `npm publish --dry-run` 并不会真正上传到 npm，但原来的「校验发布结果」
   步骤仍会执行 `npm view dsh-linux-desktop-use@<version>` 回查，必然得到
   `npm error code 404 / 'dsh-linux-desktop-use@x.y.z' is not in this registry`，导致演练被判为失败。
   现在该步骤加上 `if: ${{ inputs.dry_run != true }}`，演练模式跳过回查。
2. 新增「演练结果提示」步骤：演练模式下输出 `::notice::` 说明 tarball 已通过 dry-run 校验、
   但未真正上传，避免误以为已发布。
3. 「校验发布结果」增加重试（最多 5 次、间隔 5 秒）：npm registry 存在秒级传播延迟，
   刚发布完立刻回查可能偶发 404；连续 5 次都查不到才判为失败并报 `::error::`。
4. `v1.5.1` 尚未真正发布到 npm（当时为演练），本次版本号升到 `1.5.2`。

### v1.5.1  2026-11-06

修复 GitHub Actions 发布到 npm 失败的问题。

1. 修复发布步骤 `npm publish dist/*.tgz` 的路径解析错误：npm 会把 `dist/<name>-<version>.tgz`
   识别为 GitHub 简写（`owner/repo`），转成 `ssh://git@github.com/dist/<name>-<version>.tgz.git`
   去克隆仓库；CI 环境没有 SSH key，于是报 `Permission denied (publickey)`、`npm error code 128`，
   流程在「发布」这一步失败。现在统一以 `./` 前缀的相对路径传入（`./dist/<name>-<version>.tgz`），
   npm 会正确识别为本地 tarball 文件。
2. 发布步骤新增 tarball 存在性校验：找不到 `dist/*.tgz` 时输出 `::error::` 并立即退出，
   避免把空路径传给 npm 产生误导性的错误。
3. `dry_run`（演练）、`provenance`（签名）两个分支与普通发布共用同一份 tarball 路径解析逻辑。

### v1.5.0  2026-11-06

新增 GitHub Actions 打包发布流程，包名改为 npm 公共包名 `dsh-linux-desktop-use`（原 `@local/dsh-linux-desktop-use`）。

1. 新增 `.github/workflows/publish.yml`：仅 `workflow_dispatch` 手动触发，**不自动打包、不自动发布**；
   在 GitHub Actions 页面点击「Run workflow」才执行，输入项 `publish`（是否真正发布）、`dry_run`（发布演练）、
   `provenance`（npm provenance 签名）。
2. 打包阶段内置校验：`node --check` 语法检查、`package.json` 校验（无 `private`、有 `version`）、
   `npm pack` 生成 tarball 并作为 artifact 上传。
3. 发布阶段内置校验：`NPM_TOKEN` secret 存在性检查、目标版本是否已发布（重复发布提前拦截）、
   `npm publish --access public` 后回查 npm 上的版本与 tarball 地址。
4. `package.json` 去掉 `private: true`，新增 `repository` / `homepage` / `bugs` /
   `publishConfig.access` / `engines` 等发布元数据；`files` 纳入 `CHANGELOG.md`。
5. 包名从 `@local/dsh-linux-desktop-use` 改为 `dsh-linux-desktop-use`（npm 上不存在 `@local` 组织，
   无法在该 scope 发布）；`client.js` 的模块 id 与 `cordis.patch.yml` 的插件名同步更新。
6. README 新增「从 npm 安装」与「发布到 npm（GitHub Actions 手动触发）」两节，说明 secret 配置、
   输入项含义与工作流步骤。
