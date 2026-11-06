# 更新日志

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
