# Proposal

## Why

用户拿 IDEA 的 Git Log（左分支树 + 彩色提交图 + 列式信息 + 过滤工具条）做参照，提出两个具体问题：

1. **历史视图和 IDEA 差得远**：当前「历史」只有一个分支下拉 + 一行过滤输入 + 提交列表，没有 IDEA 那样的**分支树（HEAD / Local / Remote）**、没有**列式的作者/日期/哈希**、没有**合并提交的弱化样式**、也没有日期范围过滤与键盘上下选择。提交图的配色已按分支生命线着色（上一变更完成），但整体信息密度与可读性仍远低于 IDEA。
2. **怀疑上游显示有 bug**：用户观察到「有上游时仍显示『无上游』」。核查结论见下——**Host 侧在 5 种场景下都正确返回了 upstream**（正常跟踪、tracking ref 被删、`remote=.` 本地跟踪、`feature/x` 斜杠分支、detached），客户端两处渲染条件也正确；因此这不是解析缺陷，而是**显示语义**的问题：detached HEAD 被显示成「无上游」，且缺少「上游真实存在」的兜底（宿主版本差异或状态尚未轮询时会误报）。这点必须先用测试钉死，再修显示。

两个问题都落在历史视图与分支状态的可读性上，合并在一次变更里收口，避免反复动同一块 UI。

## What Changes

**A. IDEA 风格历史视图**
- 历史页改为**左侧分支树 + 右侧提交列表**：分支树分 HEAD / Local / Remote 三组，点击某个分支即把该分支设为日志范围（不改变 HEAD），带「全部」复位项；窄面板下树可折叠。
- 提交行改为**列式布局**：提交图 | 主题（含 refs 胶囊，胶囊按本地/远端/HEAD 着色并带图标）| 作者 | 日期（yyyy-MM-dd HH:mm，悬停显示相对时间）| 短哈希。
- **合并提交弱化**（斜体 + 次要色），HEAD 行保持强调色高亮。
- **过滤增强**：在现有「提交信息 / 作者 / 路径」之外增加**日期范围**（since/until），并与分支树的范围共同生效；工具条提供刷新与「跳到 HEAD」。
- **键盘导航**：↑/↓ 在提交间移动选中项，Enter 打开详情。

**B. 上游状态显示准确（问题 2 的落地）**
- detached HEAD **不再显示「无上游」**，改为显示「游离 HEAD」。
- 当 `status.branch.upstream` 缺失但分支列表中该分支带有 upstream 时，**回退使用分支列表的值**，避免宿主版本差异或首帧未轮询到导致误报。
- 面板摘要与芯片弹层使用同一套 upstream 展示规则。
- 补回归测试：有上游必须显示上游、确实无上游才显示「无上游」、detached 不显示「无上游」。

**明确不在本次范围**：网络操作（fetch/pull/push）、冲突解决、rebase、blame、并排 diff（沿用上一变更的边界）。

## Capabilities

### New Capabilities
（无。本次只修改既有能力。）

### Modified Capabilities
- `commit-history`：历史视图的布局、列、合并提交样式、日期过滤与键盘导航；「历史列表可过滤」要求的范围扩展。
- `branch-management`：新增「上游状态显示准确」的行为要求（含 detached 与兜底规则）。
- `git-host-api`：`GET /git/log` 新增日期范围参数（`since`/`until`）的契约与校验。

## Impact

- **代码**：`client.js`（HistoryPane 布局与列、分支树、合并/HEAD 样式、日期过滤、键盘导航、upstream 展示）、`index.js` + `lib/git.js`（log 的 since/until 参数与校验）、`test/client.test.js` 与 `test/host.test.js`。
- **契约与文档**：`docs/contract.md` 增补 `GET /git/log` 的日期参数；`docs/verification.md` 增加本轮验收与截图；README 更新历史视图能力。
- **兼容性**：只新增查询参数与 UI 行为，既有路由/字段不变；插件版本升到 0.4.0。
- **风险**：日期过滤的时区语义（`--since`/`--until` 按本地时区解释）需明确并测试；窄宽度下分支树与列表的挤压需要用折叠而非硬挤。
