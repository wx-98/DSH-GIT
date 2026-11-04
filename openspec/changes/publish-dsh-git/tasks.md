# Tasks

## 1. 发布前元数据与包身份

- [x] 1.1 新增 `LICENSE`（MIT，版权方写 `wx-98`），并确认 GitHub 仓库识别到 license；验证：文件存在且首行是 `MIT License`，仓库 API 的 `license.spdx_id` 在推送后变为 `MIT`。
- [x] 1.2 在 `package.json` 补 `repository`、`homepage`、`bugs`、`author`、`publishConfig`（`access: public` + `registry: https://registry.npmjs.org/`）、`engines`（node >= 22，DSH 0.2.1+），并复核 `files` 白名单；验证：`npm pack --dry-run --json` 的文件列表只含 `package.json`、`index.js`、`lib/git.js`、`client.js`、`cordis.patch.yml`、`locale/*`、`icon.svg`、`tools/graph-lanes.mjs`、`README.md`、`LICENSE`。
- [x] 1.3 定名并完成三处同步：把 `package.json#name`、`cordis.patch.yml` 的 loader 行 `name`、`client.js` 的 `__ModuleLoader__.load({ id })` 与槽位 key 统一为选定名（首选 `@wx-98/dsh-git`，退回 `dsh-gitvcs`）；同步更新测试里的 id 断言与 README 安装命令。验证：`node --test test/host.test.js test/client.test.js test/graph-lanes.test.js` 全绿。
- [x] 1.4 新增守卫测试：读取 `package.json#name`，断言 `cordis.patch.yml` 的 insert 行 name 与 `client.js` 的 bundle id 都等于它；验证：故意改错一处时该测试失败（本地临时验证后还原），正常时通过。
- [x] 1.5 README 顶部加「安装块」：一句话职责 + `dsh plugin --profile <profile> add <新包名>` + 插件类型声明（Cordis 插件 bundle）+ GitHub 安装方式；验证：registry 的 checklist 三条能在 README 中逐条指认。

## 2. GitHub 上线

- [x] 2.1 校验 GitHub token 身份与权限（`GET /user`、确认能写 `wx-98/DSH-GIT`）；若权限不足立即停止并报告需要的 scope。验证：`/user` 返回预期 login，且 `PUT /repos/wx-98/DSH-GIT/topics` 预检不返回 403。
- [x] 2.2 推送 `main`（当前 3 个提交历史）并打 tag `v0.4.0`；验证：`git ls-remote --heads --tags` 能看到 `refs/heads/main` 与 `refs/tags/v0.4.0`，GitHub API 的 `size` 不再为 0。
- [x] 2.3 设置仓库描述与 topics `dsh-plugin`、`dsh`、`git`（整体 PUT，幂等）；验证：`GET /repos/wx-98/DSH-GIT/topics` 的 `names` 含 `dsh-plugin`，且 `GET /repos/wx-98/DSH-GIT` 的 `description` 非空。

## 3. npm 发布

- [ ] 3.1 确认 npm 凭据可用且指向公共源（`npm whoami --registry https://registry.npmjs.org/`）；若未登录，说明需要用户提供 `NPM_TOKEN` 或执行 `npm login` 后停止。验证：命令输出用户名而不是 ENEEDAUTH。
- [ ] 3.2 发布前检查版本与名称未被占用（`npm view <pkg>@<version>` 应 404），执行 `npm publish --registry https://registry.npmjs.org/`；验证：发布成功且输出 tarball URL。
- [ ] 3.3 发布后校验并做安装冒烟：`npm view <pkg> version dist.tarball repository.url`；在临时 profile 里执行 `dsh plugin --profile <tmp> add <pkg>` 并 `openspec` 外的等价自检（至少确认包被 pnpm 安装且 `package.json#dsh.bundle` 可解析）。验证：两条命令均成功，记录输出。

## 4. awesome-dsh-plugin 收录 PR

- [x] 4.1 检查时间门禁与前置条件：仓库 `created_at` 距今 ≥ 1 天、已带 `dsh-plugin` topic、`package.json` 有 `dsh.bundle`；未满足则记录并等待（不提前开 PR）。验证：三项逐一用 API/文件核对并记录。
- [x] 4.2 fork upstream、在 fork 上建分支并新增 `data/plugins/wx-98__DSH-GIT.yml`（`category: git`，`description.en` 必填、`zh` 可选、不手改生成的 README）；验证：YAML 能解析、`url`/文件名与仓库完全一致。
- [ ] 4.3 向 upstream `main` 开 PR，标题与正文说明「新增一个插件数据文件」，并附仓库 URL、类别（ui/git）、安装命令；验证：PR 创建成功并返回 URL，CI（若有）通过或指出需修复项。

## 5. dshplugin.world 提交

- [x] 5.1 逐条核对 registry 的 checklist（公开仓库、topic、README 一句话 + `dsh plugin --profile …` 安装命令 + 类型声明）；缺项先补 README。验证：三条在 README 中可指认，且 `GET /repos/.../topics` 含 `dsh-plugin`。
- [x] 5.2 在自己仓库开 issue，标题 `[dshplugin.world] list this`，正文含仓库 URL、类别（Cordis plugin / UI）、安装命令与一句话说明；验证：issue 创建成功并返回 URL。
- [x] 5.3 在官方 Harness discussions 发一条 ping，链接到该 issue；若该渠道需要额外权限则记录并跳过一次（不阻塞其它提交）。验证：ping 存在或记录阻塞原因。

## 6. 发布验收与文档

- [ ] 6.1 汇总一次可复现的发布验收：`git ls-remote` 的 main/tag、GitHub topics、`npm view` 三个字段、awesome PR URL、registry issue URL 全部记录到 `docs/verification.md` 新的「发布记录」小节。验证：小节中的每条命令都能被重跑复核。
- [ ] 6.2 在 README 顶部加 awesome 徽章（`[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)`），并在安装块下方注明「npm 包名 / GitHub 仓库 / 注册表收录状态」；验证：徽章链接可达，README 渲染无坏链。
- [ ] 6.3 跑完全量测试与 `openspec validate publish-dsh-git`，确认改名/元数据改动没有破坏插件行为；验证：`node --test test/host.test.js test/client.test.js test/graph-lanes.test.js` 全绿且校验通过。

## Workflow follow-up

- 本变更含外部账号操作：执行前需要用户提供 `GITHUB_TOKEN` 与 npm 凭据（或确认已在环境中）。
- 完成后运行 `openspec archive publish-dsh-git`（skip_specs 变更无需同步主 spec）。
