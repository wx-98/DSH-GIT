# Proposal

## Why

插件本身已经能用了（0.4.0，140 项测试全绿、26 项真实实例自检），但它只存在于本机：没有推到公开发布、GitHub 仓库还没有任何内容、没有 `dsh-plugin` topic、不在社区索引里、也没有 npm 包。DSH 生态的三个发现渠道——官方 `dsh-plugin` topic、awesome-dsh-plugin 索引、dshplugin.world 注册表——都要求「公开可检视的仓库 + 可 `dsh plugin add` 的包」，所以再不发布就等于没有。

本轮摸底还把几个硬事实钉死了：

- **目标仓库已存在且为空**：`wx-98/DSH-GIT`（public、default branch `main`、size=0、无 topic、无 license），创建于 `2026-11-04T13:01:11Z`。
- **npm 名称 `dsh-git` 已被占用**：npmjs 上是 `dushaobindoudou` 的占位包（0.0.1，"name reserved; first release in development"）。所以「支持 npm 路线」必须先解决包名，而包名同时是 DSH loader 行名与浏览器 bundle id，改名会牵动三处 + 测试 + 文档。
- **本机 npm 指向内网源**（`https://registry.npm.wps.cn/`）且未登录；直接 `npm publish` 会把包推到内网而不是 npmjs，必须在 `publishConfig` 里钉死公共源。
- **没有 `gh` CLI**，npm 未登录；git 推送走 Windows 凭据管理器（`git ls-remote` 对目标仓库已成功）。topic / PR / issue 需要 GitHub token。
- **awesome-dsh-plugin 的收录门槛**：仓库需声明 `dsh.bundle`（已满足）、带 `dsh-plugin` topic、且**仓库至少满 1 天**——目标仓库到 `2026-11-05T13:01Z` 才满 1 天，因此「开 PR」这一步必须排在该时刻之后。
- **dshplugin.world 没有网页表单**：它的 Submit 页要求 README 里有「一句话职责 + 以 `dsh plugin --profile …` 开头的安装命令 + 插件类型（Cordis plugin）」，提交方式是**在自己仓库开 issue**，标题 `[dshplugin.world] list this`，外加官方 Harness discussions 里的一条 ping；他们还会按快照周期抓 `dsh-plugin` topic。

## What Changes

**A. 发布前元数据与包身份**
- 新增 `LICENSE`（MIT 正文）；`package.json` 补 `repository`、`homepage`、`bugs`、`author`、`publishConfig`（public + 公共 registry）、`engines` 说明，并审计 `files`（不带 tests/docs/openspec/.dsh）。
- **包名决策**：`dsh-git` 已被占用，本轮按推荐方案改为 `@wx-98/dsh-git`（若 npm 账号拥有 `wx-98` scope），否则退回未占用的 `dsh-gitvcs`。改名必须让三处身份一致：`package.json#name`、`cordis.patch.yml` 的 loader 行 `name`、`client.js` 的 `__ModuleLoader__.load({ id })` 与槽位 key；并加一条「三处必须等于 package.json name」的守卫测试。
- README 顶部补**安装块**：一句话职责 + `dsh plugin --profile <profile> add <pkg>` + 插件类型声明（Cordis 插件 bundle），满足 registry 的 checklist。

**B. GitHub 上线**
- 把现有历史推到 `wx-98/DSH-GIT`（`main`）、打 tag `v0.4.0`。
- 仓库描述、`dsh-plugin` + `dsh` topics、默认分支、license 识别（补 LICENSE 后 GitHub 自动识别）。

**C. npm 发布**
- 用公共源显式发布（`publishConfig.registry` + `--registry` 双保险），验证 `npm view <name> version`、`npm pack --dry-run` 的产物清单、以及一条从 npm 安装到临时 profile 的冒烟命令。

**D. awesome-dsh-plugin 收录 PR**
- 按官方规则新增**单个文件** `data/plugins/wx-98__DSH-GIT.yml`（`category: git`，`description.en`/护 `zh`，不手改生成的 README），fork → 分支 → PR；PR 只能在仓库满 1 天后开。

**E. dshplugin.world 提交**
- 在自己仓库开 issue（标题 `[dshplugin.world] list this`，正文含仓库 URL、类别、安装命令），并在官方 Harness discussions 发一条 ping；同时确认 README checklist 三条全部满足。

**不在本次范围**：CI 自动化发布（GitHub Actions + OIDC provenance）、多版本长期维护流程、docs 站点、国际化 README。

## Capabilities

### New Capabilities
（无。）

### Modified Capabilities
（无。本变更只改发布/打包元数据与对外流程，不改变插件运行时行为，`.openspec.yaml` 已声明 `skip_specs: true`。）

## Impact

- **仓库文件**：`LICENSE`（新增）、`package.json`（name/metadata/publishConfig/engines/files）、`cordis.patch.yml`（若改名）、`client.js`（bundle id 与槽位 key）、`test/client.test.js`、`test/host.test.js`（id 断言）、`README.md`（安装块 + badge）、`docs/verification.md`（发布记录）。
- **外部系统**：GitHub 仓库 `wx-98/DSH-GIT`（commit/tag/topics/issue）、npmjs `<新包名>`、awesome-dsh-plugin（fork + PR）、dshplugin.world（issue + discussion ping）。
- **凭据**：需要 `GITHUB_TOKEN`（repo 权限，用于 topics/issue/PR）与 npm 发布凭据；只通过环境变量注入，不落盘、不提交。
- **兼容性**：改名是**破坏性**的安装名变更（已安装的用户需重新 `dsh plugin add` 新名）；不改名的替代路径是不发布 npm（与需求冲突）。
