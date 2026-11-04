# Design

## Context

现状（见 proposal.md 的 Why）：插件是双面 bundle——`index.js` + `lib/git.js` 跑在 Host 进程内提供 `/git/*` HTTP 路由，`client.js` 是单文件 classic 浏览器 bundle，注册右侧栏标签（`sidebarRightTabs`）与会话头部条目（`conversation.session.header.actions`）。约束：

- **无构建步骤**：浏览器半边必须自包含，只能 `require("react" / "react-dom")`；任何共享算法只能以「独立模块 + 内联同一份实现」的方式存在（`tools/graph-lanes.mjs` 已是此模式）。
- **无第三方依赖**：Host 只用 `node:*` 与 git CLI；客户端不引入图形/图标库。
- **契约先行**：`docs/contract.md` 是 Host⇄Client 唯一事实来源，新路由与新字段必须先登记。
- **写操作串行 + 连接栅栏**：所有 POST 先过 `ctx.connection.requestRejection`，再进单一 promise 队列。
- **主题**：只用 `--dsw-*` 变量并从 `body[data-ds-dark-theme]` 分支深浅取值。

## Goals / Non-Goals

**Goals:**
- 让提交图在**任意仓库拓扑**下都能读出「哪条线是什么、当前在哪」，包括线性历史。
- 头部芯片与宿主头部排版融为一体（字体/尺寸/间距），并成为**唯一的顶部入口**：看分支、切分支、管分支。
- 把面板从「只读展示」推进到「日常可用」：目录树 + 文件统计、hunk 级索引操作、amend、stash、历史过滤。
- 全部新能力都有自动化测试（Host 端到端 + 客户端渲染 + 算法单测）与契约文档。

**Non-Goals:**
- 网络远端操作（fetch/pull/push）与凭据管理——需要单独的凭据/远端 UX 设计。
- 冲突解决界面、rebase/cherry-pick/submodule、blame、并排 diff。
- 不改变既有路由的语义与形状（只新增，保持向后兼容）。

## Decisions

### D1 提交图：颜色绑定「分支生命线」，而不是「列槽位」

**问题**：现在 `allocColor` 按列槽位分配，列复用即换颜色；线性仓库只有一列，于是整条图恒为调色板第 0 色（蓝），用户无法区分。

**方案**：把颜色从「列」上移到「分支线」：
- 每条泳道在**出现时**申请一个颜色，整条生命线保持不变；
- 同一时刻并存的泳道保证颜色互不相同（容量限制时按最少使用回退）；
- HEAD 所在列使用**强调色**（不占普通调色板），并给 HEAD 提交更大圆点 + 环形描边；
- 列号仍全局稳定（不改左移策略），只是颜色索引与列索引解耦。

**替代方案**：按 ref 名做哈希上色（`feature/x` 固定某色）——否决：同一分支的中间段与合并段可能落在不同列，哈希会让同一条线出现两色；且 hash 冲突不可控。

**实现位置**：`tools/graph-lanes.mjs` 的 `laneColors` 生成逻辑；`client.js` 的 `CommitGraph` 只消费结果，新增 `headLane`/`isHeadRow` 标记由 client 侧计算（`commit.sha === headSha`），避免把 ref 语义塞进纯算法。

### D2 芯片排版：字体/尺寸全部从宿主继承

**问题**：`.dg-chip-branch` 与 `.dg-pop-branch` 硬编码 `font-family: var(--dsh-font-mono)`。

**方案**：删除这两处等宽声明，改为 `font: inherit`（芯片基类已继承），只保留 `font-variant-numeric: tabular-nums`；字号/行高/间距对齐宿主头部胶囊（12px / 18px / 6px gap，圆点 7px）。分支名等长文本用 `text-overflow: ellipsis` 处理，不靠等宽字体对齐。

**替代方案**：保留等宽但调小字号——否决：等宽字体在中文语境下宽度突兀，且视觉回归无法通过。

### D3 分支切换：芯片弹层即分支面板，切换与过滤彻底分离

**现状缺陷**：面板历史页的分支下拉只改日志 ref，用户误以为是切换。

**方案**：
- 芯片弹层分两段：`当前分支`（名称、upstream、ahead/behind、变更摘要）+ `切换分支`（本地 / 远端分组，当前分支打勾）。
- 点击分支 → `POST /git/checkout` → 成功则刷新 status/branches 并提示「已切换到 x」；失败则把 Host 返回的 `message`（git stderr 首行）显示在弹层内。
- 历史页下拉改名为「日志范围」，并在旁边加显式的「切换到此分支」动作；两者文案与位置分开。
- 分支创建/删除/重命名放在弹层底部「分支操作」区（删除需二次确认，当前分支禁止删除）。

**替代方案**：把切换做进历史页下拉——否决：日志过滤是只读浏览，切换是写操作，混在一起正是当前误解的根源。

### D4 Hunk 级暂存：客户端发补丁，Host 用 `git apply --cached`

**方案**：
- Client 从已有结构化 diff 重建**单 hunk 补丁**（`diff --git` 头 + `---/+++` + 该 hunk 文本），调用新增 `POST /git/apply-hunk`，body `{ root, path, direction: "stage"|"unstage", patch }`。
- Host 校验 patch 的路径与 hunk 数量（只允许 1 个 hunk，且 `path` 必须与补丁头一致），写临时文件后执行 `git apply --cached --unidiff-zero --whitespace=nowarn <tmp>`（取消暂存用 `--reverse --cached`），失败返回 409/422 + stderr 摘要，索引保持不变（`git apply` 本身原子）。
- 为 CRLF 仓库：应用前把补丁行尾统一为 `\n`（git apply 对 CRLF 工作区有 `--ignore-whitespace` 兜底，仅在失败后重试一次）。

**替代方案**：客户端整块重建索引（`git add -p` 交互式模拟）——否决：需要读工作区原文并与索引比对，逻辑更重且易与用户手动改动竞争。

### D5 变更目录树由客户端构建

**方案**：Host 已返回仓库相对路径列表，客户端按 `/` 分层构建树（目录优先、按名排序），折叠状态存组件内 state；已暂存/变更/未跟踪/冲突仍作为四个根分组。文件行数用新增的 `GET /git/stats?root=`（`git diff --numstat` + `--cached --numstat`）批量取，避免逐文件请求。

**替代方案**：Host 直接返回树结构——否决：树是纯展示派生，放 Host 会让宿主承担 UI 决策（且每次都要重算）。

### D6 契约与错误码沿用既有体系

新增路由：`GET /git/stats`、`POST /git/apply-hunk`、`POST /git/amend`、`POST /git/branches`（create/delete/rename 用 `action` 区分）、`GET/POST /git/stash`。全部沿用现有错误码表与 64 KiB body 上限；`apply-hunk` 的补丁体单独放宽到 1 MiB 并仍受连接栅栏保护。

## Risks / Trade-offs

- **补丁上下文失配**（用户编辑与 diff 之间有竞态）→ `git apply` 原子失败即返回 409，客户端提示「文件已变化，请刷新后重试」，不重试猜测。
- **CRLF / 空白差异**导致 hunk 应用失败 → 应用前统一行尾；失败且 stderr 提示空白问题时，带 `--ignore-whitespace` 重试一次并记录。
- **颜色容量不足**（>8 条并存分支）→ 调色板 8 色循环，靠「并存不重色」尽量延后冲突，并在超出时接受复用（与 VSCode 行为一致）。
- **芯片弹层遮挡/裁剪**（头部容器可能 `overflow: hidden`）→ 弹层沿用现有绝对定位方案（已验证可用）；若出现裁剪，改为 `position: fixed` + 测量锚点。
- **stash 破坏性**（drop/pop 会丢数据）→ 全部需要显式确认；`pop` 失败时不清空 stash。
- **测试成本**：hunk 级操作需要真实索引状态，Host 测试继续用临时仓库 + node:http 端到端；分支/stash 亦然。

## Migration Plan

- 版本从 0.2.0 → 0.3.0；`/git/*` 只新增不改签名，旧客户端仍可工作。
- `docs/contract.md` 先登记新路由与新字段（实现前），随后实现 Host → 客户端 → 文档/README/截图。
- 桌面端为 link 安装：宿主改动需重启应用生效，客户端改动刷新页面即可（HMR）。
- 回滚：删除新增路由与 UI 入口即可回到 0.2.0 行为，无数据迁移。

## Open Questions

- 分支删除的默认强度：`-d`（拒绝未合并）为主、`-D` 需二次确认——需要在实现时确认 UI 文案的措辞，但不影响契约与任务拆分。
