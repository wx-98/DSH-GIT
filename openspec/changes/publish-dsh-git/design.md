# Design

## Context

见 proposal.md 的 Why。本设计只依赖已探测到的事实：目标 GitHub 仓库存在且为空（`wx-98/DSH-GIT`，public，`main`，2026-11-04T13:01Z 创建）、npm 上 `dsh-git` 被占、本机 npm 指向内网源且未登录、无 `gh` CLI、git 推送凭据可用、awesome 与 registry 的收录规则（已抓取原文）。

约束：
- 插件为**无构建**双面 bundle，发布产物就是仓库里的文件本身；`files` 白名单决定 npm tarball 内容。
- 包名同时是 DSH loader 行名与浏览器 bundle id（`__ModuleLoader__.load({ id })` 与槽位 `key`），三处必须一致。
- 凭据只能来自环境变量；仓库里不得出现 token。

## Goals / Non-Goals

**Goals:**
- 一次可复现的发布：同一个 commit 既能被 GitHub 用户 `clone`，也能被 `dsh plugin add <pkg>` 从 npm 安装。
- 三个社区渠道（topic、awesome 索引、registry）都按各自**真实规则**提交，而不是凭想象提交。
- 改名只有一处事实来源，并有测试守卫，杜绝「package.json 改了、bundle id 没改」这类隐性坏包。

**Non-Goals:**
- 不搭 CI 自动发布（GitHub Actions + OIDC provenance），本轮手工可复现即可。
- 不做 scope 之外的仓库重组（保留 `openspec/`、`docs/`、`.dsh/` 的历史）。
- 不追 PR 合并时间（awesome 列表由维护者审核）。

## Decisions

### D1 包名：`@wx-98/dsh-git`，不可用时退回 `dsh-gitvcs`

`dsh-git` 已被占（npm 上 0.0.1 占位包），且 npm 不允许同名覆盖。候选比较（已实测 npm registry）：

| 名称 | 状态 | 评价 |
|---|---|---|
| `@wx-98/dsh-git` | 未占用（404） | 与 GitHub 身份一致、语义最清晰；前提是 npm 账号拥有/能创建 `wx-98` scope |
| `dsh-gitvcs` | 未占用（404） | 无需 scope，但名字生硬 |
| `dsh-git-panel` / `dsh-git-plugin` / `dsh-idea-git` / `dsh-git-ui` / `dsh-git-toolkit` | 已占用 | 不可用 |
| `dsh-vcs-git` / `dsh-git-next` / `dsh-git-sc` | 未占用 | 备选，语义弱于上面两个 |

**决策**：以 `@wx-98/dsh-git` 为主方案；若用户 npm 账号无法使用该 scope，改用 `dsh-gitvcs`。两者都只影响「发布名」，实现上通过 D2 的单点改名落定。

**替代方案**：联系占位包作者转名——不可控、不在本轮；**替代方案**：不发布 npm，只走 GitHub——与需求冲突。

### D2 改名是单点操作 + 守卫测试

唯一事实来源是 `package.json#name`。需要同步的三处：

1. `cordis.patch.yml`：`- insert: [{ id: git, name: '<pkg>' }]`
2. `client.js`：`window.__ModuleLoader__.load({ id: '<pkg>' })`、`ID` 常量（槽位 `key`、样式标记）
3. 测试：`test/client.test.js` 的 id/key 断言

新增一条守卫测试：读 `package.json#name`，断言 `cordis.patch.yml` 的 insert 行 name 与 `client.js` 的 bundle id 都等于它。这样以后改名漏改一处会直接测试失败。

**注意**：loader 行的 `id: git`（DSH 内部条目 id）保持不变，它与包名解耦；只有 `name` 是模块说明符。

### D3 npm 发布必须显式钉公共源

本机 `npm config get registry` 指向内网 `https://registry.npm.wps.cn/`，直接 publish 会推到内网。做法：
- `package.json` 增加 `publishConfig: { "access": "public", "registry": "https://registry.npmjs.org/" }`（scoped 包必须 public 才能被匿名安装）；
- 发布命令再显式带 `--registry https://registry.npmjs.org/` 双保险；
- 发布前 `npm pack --dry-run --json` 审计 tarball 文件清单（不得含 `test/`、`docs/`、`openspec/`、`.dsh/`、截图），发布后 `npm view <pkg> version dist.tarball` 校验。
- 版本一旦发布不可覆盖：先 `npm view` 确认该版本不存在，再发布；失败需要 `0.4.1`。

### D4 GitHub 侧：先内容后主题，topic 幂等

顺序：push `main` → 打 tag `v0.4.0` → 设置描述 → 设置 topics（`dsh-plugin`、`dsh`、`git`）。topics 用 `PUT /repos/{owner}/{repo}/topics`（幂等，整体替换）。

**凭据**：无 `gh` CLI，用 REST API + `GITHUB_TOKEN`（`Authorization: Bearer`）；git push 走既有凭据管理器。token 不落盘。

### D5 awesome-dsh-plugin：一个数据文件 + 满 1 天后再开 PR

按贡献指南（已抓取原文）：PR 只新增 `data/plugins/wx-98__DSH-GIT.yml`：

```yaml
url: https://github.com/wx-98/DSH-GIT
name: wx-98/DSH-GIT
category: git
description:
  en: VSCode/IDEA-style Git source control in the DSH right sidebar with a commit graph, branch switching and staging.
  zh: 在 DSH 右侧栏提供类 VSCode/IDEA 的 Git 源码管理，含提交图、分支切换与暂存操作。
```

- `category` 用列表里真实存在的 `git`；
- **不**手工改 README（由脚本生成）；
- 仓库必须满 1 天（`created_at` = 2026-11-04T13:01:11Z → 最早 `2026-11-05T13:01:11Z`），所以 PR 步骤带时间门禁；
- fork 到 `wx-98/awesome-dsh-plugin` → 分支 `add-dsh-git` → PR 到 upstream `main`，PR 描述按模板说明「新增一个数据文件」。

### D6 dshplugin.world：README checklist + 自己仓库的 issue

该站没有表单，要求：
1. README 有**一句话职责**、**以 `dsh plugin --profile …` 开头的安装命令**、**插件类型声明**（Cordis plugin bundle）；
2. 在自己仓库开 issue，标题 `[dshplugin.world] list this`，正文含仓库 URL、类别（Cordis plugin / ui）、安装命令；
3. 在官方 Harness discussions 发一条 ping 链接到该 issue。
题目字面是「Submit Plugin」，落地就是这两步 + 确保 topic 已设置（他们会按快照抓）。

### D7 凭据与不可逆操作

- `GITHUB_TOKEN`、`NPM_TOKEN` 只从环境变量读；任何命令输出不得回显 token；`.gitignore` 确认已有 `.env`。
- 不可逆：npm 版本发布（不可撤回/覆盖，只能 deprecate）、GitHub topic（可改）、PR（可关）。
- 失败恢复：npm 发布失败可换补丁版本；PR 被驳回按评论修改；issue 可编辑。

## Risks / Trade-offs

- **改名影响已安装用户** → 发布说明里写清「旧名 `dsh-git` 是本地 link 安装，新名从 npm 安装」；README 安装块只给新名。
- **内网 registry 误发** → D3 的双保险 + 发布后 `npm view` 校验公共源。
- **awesome 1 天门禁** → 任务里显式检查 `created_at`，未满则等到满 1 天再开 PR（不提前开 PR 制造噪音）。
- **token 权限不足**（topics 需要 repo scope；跨仓库 PR 需要 fork 写权限）→ 任务第一步先用 `GET /user` 验证 token 身份与 scopes，权限不足立刻停。
- **npm scope 归属未知** → 若 `@wx-98` 不可用，按 D1 退回 `dsh-gitvcs`，守卫测试保证三处一致。
- **发布产物含多余文件** → `npm pack --dry-run` 白名单核对（`files` 已限定 index.js/lib/client.js/cordis.patch.yml/locale/icon/tools/graph-lanes.mjs）。

## Migration Plan

1. 元数据与改名（含守卫测试）→ 全量测试 → 提交。
2. push + tag + topics；`npm pack` 审计 → 发布 → `npm view` 校验 → 临时 profile 安装冒烟。
3. 仓库满 1 天后开 awesome PR；随后发 registry issue + discussion ping。
4. 回滚：npm 侧用 `npm deprecate`；GitHub 侧删 tag/改 topic；PR 可关。改名回滚只需还原三处 + 守卫测试。

## Open Questions

- npm 账号是否能使用 `@wx-98` scope（决定 D1 主/备方案），以及两枚 token 能否提供——这两点不影响任务拆分，只影响执行时的取值。
