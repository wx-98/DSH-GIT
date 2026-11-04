# Tasks

## 1. 契约与提交图算法基线

- [x] 1.1 在 `docs/contract.md` 登记本轮新增路由与字段（`GET /git/stats`、`POST /git/apply-hunk`、`POST /git/amend`、`POST /git/branches`、`GET/POST /git/stash`、`/git/log` 的 `grep/author/path` 参数，以及 apply-hunk 的 1 MiB 体上限）；验证：逐条路由与本清单一致，且 `grep -n "apply-hunk" docs/contract.md` 有可读的请求/响应示例。
- [x] 1.2 改造 `tools/graph-lanes.mjs`：颜色绑定分支生命线（出现即分配、消失才释放）、同时并存的泳道不重色、HEAD 行输出可被高亮的标记；列号稳定性保持不变。验证：`node --test test/graph-lanes.test.js` 全绿且新增用例覆盖 D1。
- [x] 1.3 为算法补用例：线性历史单泳道颜色等于 HEAD 强调色槽位、两条并存分支颜色不同、同一分支跨行颜色不变、并存数超调色板时按最少使用回退。验证：上述 4 条在 `test/graph-lanes.test.js` 中各自有独立的 `test(...)` 并通过。
- [x] 1.4 把同一份算法内联进 `client.js`，并新增「内联实现与模块输出一致」的测试（同一组 fixture 分别跑模块与 `__test.computeLanes`，逐行深比较 `lane/width/passThrough/exits/laneColors`）。验证：`node --test test/client.test.js` 通过且该一致性用例存在。

## 2. Host：新增 git 操作与路由

- [x] 2.1 在 `lib/git.js` 增加批量行数统计 `readStats(toplevel)`（`git diff --numstat` 与 `git diff --cached --numstat` 合并，保留二进制 `-` 语义）。验证：`test/host.test.js` 新增用例断言修改/新增/删除文件各自的 `+N/-N` 与二进制为 `null`。
- [x] 2.2 在 `lib/git.js` 增加 `applyHunk(toplevel, { path, direction, patch })`：校验补丁只含单个 hunk 且文件头与 `path` 一致，写临时文件后执行 `git apply --cached [--reverse]`，失败返回 409/422 且索引不变。验证：`test/host.test.js` 覆盖「只暂存一块」「取消暂存一块」「上下文失配返回错误且索引不变」。
- [x] 2.3 在 `lib/git.js` 增加 `amendCommit(toplevel, { message })`（`git commit --amend`，空信息 400）。验证：`test/host.test.js` 断言提交数量不变、HEAD sha 改变、trim 后为空返回 400。
- [x] 2.4 在 `lib/git.js` 增加分支三操作：创建（`git switch -c`）、删除（`git branch -d`，`force` 时 `-D`）、重命名（`git branch -m`），并拒绝删除当前分支（409）。验证：`test/host.test.js` 覆盖创建后 HEAD 指向新分支、删除当前分支 409、未合并分支无 force 时失败、`force: true` 成功、重命名后旧名消失。
- [x] 2.5 在 `lib/git.js` 增加 stash 五操作（list/create/apply/pop/drop），`pop` 失败时不得清空 stash。验证：`test/host.test.js` 覆盖创建→列表→应用→pop→drop 全链路与「工作区脏时 pop 冲突仍保留 stash」。
- [x] 2.6 在 `index.js` 注册新路由并按既有体系校验：连接栅栏、写操作串行队列、`apply-hunk` 请求体上限 1 MiB、错误码映射（bad-request/invalid-path/not-a-repo/git-failed/conflict）。验证：`test/host.test.js` 断言无 cookie 返回 401/403、越界路径 400、超限体 413、路由 (kind,path) 唯一。
- [x] 2.7 `lib/git.js` 的 `readLog` 支持过滤参数：`grep`（`--grep`）、`author`（`--author`）、`path`（`-- <path>`），并保留既有分页语义。验证：`test/host.test.js` 断言三个过滤各自生效、组合过滤生效、无匹配时返回空列表且 `hasMore:false`。

## 3. 客户端：芯片排版与分支管理

- [x] 3.1 移除 `.dg-chip-branch` 与 `.dg-pop-branch` 的等宽字体声明，字号/行高/间距对齐宿主头部胶囊，并保留 `tabular-nums`。验证：`test/client.test.js` 断言注入的 CSS 文本不再包含 `dsh-font-mono` 的芯片选择器；浏览器截图里芯片与「PTC 模式」「N 个子智能体」字体一致。
- [x] 3.2 把芯片弹层改造成分支面板：当前分支段（名称/upstream/ahead-behind/变更摘要）+ 切换分支段（本地与远端分组、当前分支打勾），点击调用 `api.checkout`。验证：`test/client.test.js` 用假 api 断言点击分支触发一次 checkout 且参数为分支名；渲染测试断言分组与当前分支勾选。
- [x] 3.3 弹层增加分支操作区：创建（输入名 + 确认）、删除（二次确认，当前分支禁用）、重命名；全部调用新路由并在成功后刷新 status/branches。验证：`test/client.test.js` 覆盖三个动作的调用与「当前分支删除按钮禁用」；渲染测试断言确认框出现。
- [x] 3.4 切换失败（脏工作区/冲突）在弹层内显示错误条，内容取自 Host 的 `message`，并提供重试入口。验证：`test/client.test.js` 断言失败响应下弹层渲染错误条文本且不关闭。
- [x] 3.5 补充本组 i18n 键（zh/en 键集完全一致）与 aria 标签，文案覆盖切换成功/失败、创建/删除/重命名、日志范围提示。验证：`test/client.test.js` 的键集一致性用例通过（zh/en 键数相等）。
- [x] 3.6 历史页把分支下拉改名为「日志范围」，并在旁边提供显式的「切换到此分支」动作与成功提示。验证：渲染测试断言两个控件文案不同；交互测试断言「切换」调用 checkout，而改变下拉只重新请求 log 不改 HEAD。

## 4. 客户端：提交图渲染与历史过滤

- [x] 4.1 `CommitGraph` 使用新的分支生命线配色，并对 HEAD 行使用强调色 + 更大圆点与环形描边，保留列宽/行高常量。验证：`test/client.test.js` 断言行内 svg 含 `dg-graph-dot-head`（或等价 class）且 HEAD 行圆点半径大于普通行。
- [x] 4.2 历史视图增加过滤栏：文本（`grep`）、作者、路径三个输入 + 「清除」。验证：渲染测试断言三个输入存在，交互测试断言输入后请求携带对应查询参数、清除后不带。
- [x] 4.3 历史视图在过滤无结果、泳道数被截断、空历史三种情况下给出明确空状态/提示，不显示空白区域。验证：渲染测试分别断言三种文案出现。
- [x] 4.4 补充本组测试与文案：HEAD 高亮、过滤参数、截断提示的 i18n 键（zh/en 一致）。验证：`node --test test/client.test.js` 通过，且新增用例名可在输出中看到。

## 5. 客户端：变更目录树、文件统计与 hunk 级操作

- [x] 5.1 增加纯函数 `buildChangeTree(entries)`：按 `/` 分层、目录优先并按名排序、保留原状态信息；返回可渲染节点树。验证：`test/client.test.js` 用固定输入断言树形（含深层目录、同名目录与文件、中文路径），并断言不修改入参。
- [x] 5.2 变更列表改为目录树渲染：目录可折叠（记住展开状态）、文件行显示状态字母 + 文件名 + `+N/-N`（来自 `GET /git/stats`，未跟踪文件留空）。验证：渲染测试断言目录节点、折叠切换、统计文本出现。
- [x] 5.3 diff 视图在每个 hunk 头部增加「暂存此块 / 取消暂存此块」按钮（仅在 `mode=worktree` / `staged` 时出现），点击由客户端重建单 hunk 补丁并调用 `POST /git/apply-hunk`；成功后刷新 status 与 diff。验证：交互测试断言按钮只在对应模式出现、点击产生正确补丁体与 direction；失败时断言错误条出现。
- [x] 5.4 提交框增加 amend 开关与提交信息历史（最近 10 条存 localStorage，可点击复用）。验证：渲染测试断言开关与历史列表；交互测试断言 amend 提交走 `POST /git/amend`、普通提交走 `POST /git/commit`。
- [x] 5.5 补充本组 i18n 键（zh/en 一致）与空状态（工作区干净、目录全折叠）文案。验证：`node --test test/client.test.js` 通过且键集一致性用例覆盖新键。

## 6. 集成验证与交付

- [x] 6.1 运行完整测试套件（host + client + graph-lanes + 浏览器无关的其余套件）并确认全部通过。验证：`node --test test/host.test.js test/client.test.js test/graph-lanes.test.js` 输出全绿，测试数较本轮开始时增加。
- [x] 6.2 扩展并运行安装后自检 `tools/verify-installed.mjs`，覆盖新增路由（stats/apply-hunk/amend/branches/stash/log 过滤）在真实 Host 上的行为。验证：对独立 web 实例运行脚本，输出「全部通过」且用例数增加。
- [x] 6.3 用 headless Chrome + CDP 做视觉与交互回归：芯片字体与相邻元素一致、分支切换成功与失败两条路径、提交图多泳道不同色、目录树、hunk 级暂存、amend。验证：产出更新后的截图到 `docs/`，并在验收记录中逐条对照。
- [x] 6.4 更新 `docs/verification.md`（本轮验收记录与截图）、`README.md`（能力清单与截图）、`package.json` 版本号 0.3.0。验证：`README` 中的命令与截图路径全部可解析，`openspec validate git-idea-parity` 仍然通过。

## Workflow follow-up

- 变更实现完成并通过评审后，运行 `openspec archive git-idea-parity` 归档，并把四份 delta 合并进主 spec。
- 归档后检查 `openspec/specs/<capability>/spec.md` 的 Purpose 段已由归档写入而不是保留 TBD 占位。
