# Design

## Context

现状（见 proposal.md 的 Why）：`client.js` 的 `HistoryPane` 是单列列表——顶部「日志范围」下拉 + 「切换到此分支」+ 刷新，一行三个过滤输入（grep/author/path），下面每行是「提交图 + (sha, 主题) + (refs, 作者, 相对时间)」。提交图算法（分支生命线配色、HEAD 强调、列稳定）已由上一变更完成并在 `tools/graph-lanes.mjs` 有 20 项测试。面板宽度约 700px，窄时更小。

约束：
- 浏览器半边仍是**单文件 classic bundle**，只能 `require("react")`，不得引第三方依赖；`client.js` 里内联的 `computeLanes` 与 `tools/graph-lanes.mjs` 由一致性测试逐行比对，**本次不改算法区**。
- 主题只用 `--dsw-*` 变量 + `body[data-ds-dark-theme]` 覆盖。
- 契约先行：`docs/contract.md` 是 Host⇄Client 唯一事实来源。
- Host 端写操作串行 + 连接栅栏；GET 不排队。

## Goals / Non-Goals

**Goals:**
- 历史视图达到 IDEA Git Log 的信息结构：分支树 + 列式提交列表 + 彩色图 + 过滤工具条 + 键盘操作。
- 把「有上游却显示无上游」变成**可测试的确定性行为**（纯函数 + 渲染断言），并修掉 detached 误显示。
- 所有新增行为有自动化测试，视觉结果有浏览器截图。

**Non-Goals:**
- 不做 IDEA 的完整功能集：cherry-pick、rebase、push 对话框、提交级代码评审。
- 不改提交图算法的配色/列逻辑（只改渲染层的列宽与行高）。
- 不做虚拟滚动（页大小 50 条，DOM 行数可控）。

## Decisions

### D1 双栏：固定宽度分支树 + 自适应列表，窄时折叠

分支树固定 176px（`flex: 0 0 176px`），列表 `flex: 1 1 auto; min-width: 0`。用一个 `ResizeObserver` 观察面板内容区：宽度 < 560px 时把分支树折叠成一个「分支/范围」按钮（弹层展开），避免把列表挤成不可读。**替代方案**：始终用下拉（现状）——被否决，IDEA 的核心价值就是树形分组可见；**替代方案**：CSS 容器查询——浏览器支持虽好，但宿主 Electron/Chrome 版本虽新仍需回退，ResizeObserver 更稳。

### D2 分支树的数据与语义

数据直接用既有 `GET /git/branches`：`current` + `local[]` + `remote[]`；HEAD 组展示当前分支（带 ✓），本地组给 `isCurrent` 标记，远端组只读。点击某项 → `logRef = branch.name` → `GET /git/log?ref=<name>`（既有参数，不新增 Host 能力）。「全部」= `ref=HEAD`（现状默认）。**明确约束**：分支树只改日志范围，绝不 checkout（切换分支仍走芯片面板的显式动作），这与既有 `branch-management` 的「过滤与切换分离」要求一致。

### D3 列布局用 CSS grid，列按宽度渐进显示

每行 `display: grid; grid-template-columns: <graph>px minmax(0, 1fr) auto auto auto`（图列宽度由 `row.width * 14` 算）。作者/日期/哈希为固定宽列，在窄宽度通过 class（由 D1 的同一 ResizeObserver 决定）依次隐藏作者 → 哈希，日期始终保留。**替代方案**：flex + 手写宽度——grid 对列对齐更省事，且空列不会塌陷。

### D4 合并提交与 HEAD 的视觉层级

`parents.length > 1` 判为合并提交 → 主题斜体 + 次要色（`--dsw-alias-label-secondary`），refs 胶囊不变；HEAD 行沿用上一变更的强调背景 + 大圆点。三档视觉层级：HEAD（强调）> 合并（弱化斜体）> 普通。

### D5 日期过滤的时区与边界

客户端传 `since=YYYY-MM-DD`、`until=YYYY-MM-DD`（原生 `<input type="date">`）；**客户端把 until 归一化成 `<date>T23:59:59`** 再发，Host 只做格式校验与转发 `--since/--until`（git 按本地时区解释）。Host 校验正则 `^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$` 且能 `Date.parse`，否则 400。**为什么不在 Host 端归一化**：Host 不该猜测 UI 的“含当天”语义；但 Host 必须拒绝非法值以免把任意字符串拼进 git 参数。

### D6 上游显示：一个纯函数决定，三处复用

新增纯函数 `resolveUpstream(branch, branches, currentName)` → `{ kind: "detached" | "upstream" | "none" | "unknown", name: string }`：
1. `branch.detached === true` → `detached`（显示「游离 HEAD」，**不再显示无上游**）；
2. `branch.upstream` 非空 → `upstream`；
3. 否则查 `branches.local` 中 `isCurrent`（或 name === currentName）那条的 `upstream`，非空 → `upstream`（兜底，覆盖宿主版本差异或首帧未轮询）；
4. 否则 → `none`（显示「无上游」）。
面板摘要、芯片弹层当前分支段、以及后续任何展示点都调它，避免三处各写一套条件。**替代方案**：修 Host 让它永远返回 upstream——被否决，Host 当前已正确（见 proposal 的核查），问题在客户端展示语义与兜底。

### D7 键盘导航

列表容器 `tabIndex=0` + `onKeyDown`：↑/↓ 移动 `activeIndex`（夹在范围内），Enter 打开详情，Home/End 跳首尾；移动后对选中行 `scrollIntoView({ block: "nearest" })`。鼠标 hover 不改变选中，点击才选中，避免抖动。

## Risks / Trade-offs

- **窄面板挤压** → D1 的折叠阈值 + D3 的渐进隐藏；浏览器验证覆盖 700/560/480 三档宽度。
- **日期过滤时区歧义** → 统一按本地时区，`until` 归一化到当天 23:59:59，并用「跨月/跨年」用例测试。
- **分支很多时树很长** → 树本身可滚动，组可折叠；不做搜索（分支数通常 < 200）。
- **ResizeObserver 抖动/循环** → 只在跨阈值时 setState，且以内容区宽度而非窗口宽度为信号。
- **上游兜底掩盖真实问题** → 兜底只在 `status.upstream` 缺失时生效，并在测试中固定三条分支（有上游/无上游/detached）。
- **不改算法区** → 一致性测试仍守护内联实现，渲染层改动不得触碰 `computeLanes`。

## Migration Plan

- 版本 0.3.0 → 0.4.0；只新增查询参数与 UI 行为，旧客户端仍可用。
- `docs/contract.md` 先登记 `since`/`until`，随后 Host → 客户端 → 文档/截图。
- 回滚：删除 UI 分支树与日期输入即可回到 0.3.0 的历史视图；Host 的日期参数为可选，不传即旧行为。
