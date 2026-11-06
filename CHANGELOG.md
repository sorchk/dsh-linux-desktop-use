# 更新日志

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
