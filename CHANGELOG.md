# 更新日志

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
