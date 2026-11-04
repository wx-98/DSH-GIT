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

## 3. awesome-dsh-plugin 投稿（已备好，待仓库满 1 天）

- 规则：PR 只新增 `data/plugins/<owner>__<repo>.yml`，不手改生成的 README；仓库需声明 `dsh.bundle`、带 `dsh-plugin` topic、**满 1 天**。
- 已 fork：`wx-98/awesome-dsh-plugin`；分支 `add-dsh-git`；文件 `data/plugins/wx-98__DSH-GIT.yml`（`category: git`）。
- 门禁：目标仓库创建于 `2026-11-04T13:01:11Z`，**最早 2026-11-05T13:01Z（北京时间 21:01）** 才能开 PR。

## 4. dshplugin.world 提交（已完成）

| 动作 | 链接 |
|---|---|
| 自己仓库的 listing issue（标题 `[dshplugin.world] list this`） | https://github.com/wx-98/DSH-GIT/issues/1 |
| 官方 Harness discussions（Show Your Plugins! 分类） | https://github.com/deepseek-ai/deepseek-harness/discussions/12165 |

README checklist（公开仓库 / `dsh-plugin` topic / 一句话职责 + `dsh plugin --profile …` 安装命令 + 插件类型声明）已逐条满足。

## 5. npm（阻塞中）

- 包名：`dsh-git-control`（npmjs 上未占用，已验证 404）。
- 当前 npm 账号：`moonfiremoon`；对 `@wx-98` 组织的成员查询返回 403（非成员），因此该 scope 的发布权限未确认。
- 发布尝试被 **EOTP** 拦住：所用 granular token 没有 2FA bypass，npm 要求一次性口令。
- 待办：换用 Automation token（或勾选 Bypass 2FA 的 granular token），并确认包名归属。
