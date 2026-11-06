# 发布记录（publish-dsh-git）

> 对应 OpenSpec 变更：`openspec/changes/publish-dsh-git/`。本文件记录每一步**可复核**的外部动作。

## 1. GitHub（已完成）

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/wx-98/DSH-GIT |
| 分支 | `main`（首次推送后持续更新） |
| 首个发布 tag | `v0.4.0` |
| Topics | `dsh`, `dsh-plugin`, `git`, `source-control` |
| License | MIT（GitHub 已识别） |
| 描述 | VSCode/IDEA-style Git source control for the DeepSeek Harness right sidebar: commit graph, branch switching, staging, hunk actions. |

复核命令：

```bash
git ls-remote --heads --tags https://github.com/wx-98/DSH-GIT.git
curl -s https://api.github.com/repos/wx-98/DSH-GIT/topics
curl -s https://api.github.com/repos/wx-98/DSH-GIT | grep -E '"license"|"default_branch"'
```

## 2. GitHub 安装冒烟（已完成）

```
$ pnpm add github:wx-98/DSH-GIT      # 临时目录
+ dsh-git-control 0.4.0
```

安装后的包内容核对：`dsh.bundle.patch = ./cordis.patch.yml`、`dsh.client.platform = web`、
`cordis.patch.yml` 行名 = `dsh-git-control`、`client.js` 的 bundle id 一致。

## 3. npm（已完成）

| 项 | 值 |
|---|---|
| 包名 | `dsh-git-control`（无 scope；`dsh-git` 等近似名已被占） |
| 版本 | `0.4.2`（当前）；`0.4.0` 为首发版本 |
| 发布源 | `https://registry.npmjs.org/`（本机默认源是内网 `registry.npm.wps.cn`，发布时显式指定公共源） |
| tarball | https://registry.npmjs.org/dsh-git-control/-/dsh-git-control-0.4.0.tgz |
| 账号 | `moonfiremoon` |

### npm 版本历史

| 版本 | 变更 |
|---|---|
| `0.4.0` | 首发 |
| `0.4.1` | 修正等宽字体回退：`Cascadia Mono` / `Cascadia Code` / `Consolas` 优先于 `ui-monospace`；修复中文 Windows 上等宽文本回落成 NSimSun（新宋体）的问题 |
| `0.4.2` | 修复桌面端顶部 Git 分支芯片点击无反应：芯片与弹层加 `-webkit-app-region:no-drag`，退出窗口顶部拖拽区（Electron 拖拽区会吞掉点击） |

`npm view dsh-git-control version` → `0.4.1`；tarball `https://registry.npmjs.org/dsh-git-control/-/dsh-git-control-0.4.1.tgz`。

复核：

```bash
npm view dsh-git-control version dist.tarball repository.url license
# 0.4.0 / https://registry.npmjs.org/dsh-git-control/-/dsh-git-control-0.4.0.tgz
# git+https://github.com/wx-98/DSH-GIT.git / MIT
```

安装冒烟（两条都通过）：

1. 普通包安装：临时目录 `pnpm add dsh-git-control --registry https://registry.npmjs.org/` → 包内 `dsh.bundle`、loader 行名、bundle id 均正确；
2. **DSH 真实安装**：web profile 改为从 npm 安装 `dsh-git-control@0.4.0`，启动独立实例后 `tools/verify-installed.mjs` **26/26 通过**。

> 运维注意：`dsh plugin --profile <p> add <pkg>` 只登记依赖；profile 的 `dsh.profile.bundles` 必须包含该 bundle 名才会被组合（GUI 的插件页会做这一步，手工 pnpm 安装后要自己补）。

## 4. GitHub Release

https://github.com/wx-98/DSH-GIT/releases/tag/v0.4.0

## 5. awesome-dsh-plugin 收录（已合并）

- 规则：PR 只新增 `data/plugins/<owner>__<repo>.yml`，不手改生成的 README；仓库需声明 `dsh.bundle`、带 `dsh-plugin` topic、**满 1 天**。
- 已 fork：`wx-98/awesome-dsh-plugin`；分支 `add-dsh-git`；文件 `data/plugins/wx-98__DSH-GIT.yml`（`category: git`）。
- 门禁：目标仓库创建于 `2026-11-04T13:01:11Z`；PR 开于 `2026-11-05T13:12Z`（满 24h 后）。
- **PR**：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12342 —— **已合并**（1 个文件、+7 行；Submission gate 与 check 均 success）
- 条目含店铺图标：`assets/icon-180.png`（180×180 PNG，由 `icon.svg` 渲染），通过 `icon:` 字段引用 raw.githubusercontent。

## 6. dshplugin.world 提交（已完成）

| 动作 | 链接 |
|---|---|
| 自己仓库的 listing issue（标题 `[dshplugin.world] list this`） | https://github.com/wx-98/DSH-GIT/issues/1 |
| 官方 Harness discussions（Show Your Plugins! 分类） | https://github.com/deepseek-ai/deepseek-harness/discussions/12165 |

README checklist（公开仓库 / `dsh-plugin` topic / 一句话职责 + `dsh plugin --profile …` 安装命令 + 插件类型声明）已逐条满足。



- 包名：`dsh-git-control`（npmjs 上未占用，已验证 404）。
- 当前 npm 账号：`moonfiremoon`；对 `@wx-98` 组织的成员查询返回 403（非成员），因此该 scope 的发布权限未确认。
- 发布尝试被 **EOTP** 拦住：所用 granular token 没有 2FA bypass，npm 要求一次性口令。
- 待办：换用 Automation token（或勾选 Bypass 2FA 的 granular token），并确认包名归属。
