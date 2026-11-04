# Tasks

## 1. 契约与 Host：日志日期范围

- [x] 1.1 在 `docs/contract.md` 的 `GET /git/log` 小节登记 `since`/`until`（格式、本地时区语义、非法值 400、与既有过滤组合）；验证：`grep -n "since" docs/contract.md` 能看到参数表与示例，且与实现参数名一致。
- [x] 1.2 `lib/git.js` 的 `readLog` 支持 `since`/`until`：校验格式（`^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$` 且可解析），非法值抛 400；合法值映射为 `--since=`/`--until=`，与 `grep/author/path/limit/skip/ref` 组合生效。验证：`test/host.test.js` 新增用例覆盖「范围内的提交被返回」「范围外被排除」「跨月边界」「非法值 400 且不启动 git」「与 author 组合」。
- [x] 1.3 `index.js` 把 `since`/`until` 查询参数透传给 `readLog`，并保证无匹配时返回 `{ok:true, commits:[], hasMore:false}`。验证：`test/host.test.js` 的无匹配用例与 400 用例通过，既有 41 项仍全绿。

## 2. 客户端：上游状态显示修复

- [x] 2.1 新增纯函数 `resolveUpstream(branch, branches, currentName)` → `{ kind: "detached"|"upstream"|"none", name }`，按 design D6 的三级判定（detached → status.upstream → 分支列表兜底 → none）。验证：`test/client.test.js` 用四条用例分别断言 detached/有上游/兜底/无上游的返回值。
- [x] 2.2 面板摘要与芯片弹层改用该函数：detached 显示「游离 HEAD」而不是「无上游」；有上游显示上游名；确实无上游才显示「无上游」。验证：渲染测试分别断言三种状态下的可见文本，且「有上游」场景**不出现**「无上游」文案。
- [x] 2.3 补 i18n 键（zh/en 一致）：`summary.detachedUpstream` 之类的新文案；验证：键集一致性用例通过。

## 3. 客户端：历史视图双栏与分支树

- [x] 3.1 `HistoryPane` 改为双栏：左侧分支树（HEAD / 本地 / 远端三组，当前分支打勾），右侧列表；树选择只改 `ref` 不改 HEAD，另有「全部」复位项。验证：渲染测试断言三组节点与勾选；交互测试断言点击分支后只发出 `ref=<name>` 的 log 请求、未调用 checkout。
- [x] 3.2 用 `ResizeObserver` 观察内容区宽度：< 560px 时分支树折叠为「分支/范围」按钮（弹层展开），列表保持可读。验证：渲染测试模拟窄宽度（传入宽度或触发回调）断言折叠态与展开后可选择分支。
- [x] 3.3 分支树数据来自 `GET /git/branches`，切换分支（芯片动作）后刷新树；分支为空/加载中/失败各有可见状态。验证：渲染测试覆盖加载中、空树、失败三种状态文案。

## 4. 客户端：列布局、合并样式与键盘导航

- [x] 4.1 提交行改为 grid 列布局（图 | 主题+refs | 作者 | 日期 | 短哈希），日期用 `yyyy-MM-dd HH:mm` 绝对格式、title 显示相对时间；窄宽度按 D3 依次隐藏作者→哈希。验证：渲染测试断言各列文本与窄宽度下的隐藏。
- [x] 4.2 合并提交（`parents.length > 1`）主题斜体 + 次要色，HEAD 行保持强调；refs 胶囊按本地/远端/HEAD 区分颜色或图标。验证：渲染测试分别断言合并行 class、HEAD 行 class、三类胶囊 class。
- [x] 4.3 键盘导航：列表容器可聚焦，↑/↓ 移动选中、Enter 打开详情、Home/End 跳首尾，并让选中行滚动可见。验证：交互测试模拟按键断言选中索引变化与详情打开；越界按键不移动。

## 5. 客户端：日期过滤与工具条

- [x] 5.1 过滤栏增加起始/结束日期两个 `<input type="date">`，`until` 归一化为当天 23:59:59 后作为 `until` 参数发送；「清除」同时清空日期。验证：交互测试断言请求参数形状（`since=YYYY-MM-DD`、`until=YYYY-MM-DDT23:59:59`）与清除后的参数消失。
- [x] 5.2 工具条提供刷新与「跳到 HEAD」；日期范围无结果时显示专门的空状态（与全空历史、纯文本过滤无结果区分）。验证：渲染测试断言三种空状态文案互不相同。
- [x] 5.3 补本组 i18n 键（zh/en 一致）并更新过滤提示文案。验证：`test/client.test.js` 全绿且键集一致性用例覆盖新键。

## 6. 集成验证与交付

- [x] 6.1 运行完整测试套件（host + client + graph-lanes）并确认全绿。验证：`node --test test/host.test.js test/client.test.js test/graph-lanes.test.js` 输出 pass 数较本轮开始时增加。
- [x] 6.2 扩展并运行 `tools/verify-installed.mjs`：新增 `GET /git/log` 的 `since`/`until`（含非法值 400）与真实仓库上的 upstream 字段断言。验证：对独立 web 实例运行脚本输出「全部通过」且用例数增加。
- [x] 6.3 headless Chrome + CDP 视觉回归：分支树+列布局（宽/窄两档）、合并提交弱化、日期过滤、键盘导航、上游显示（有上游/detached 两种仓库状态）。验证：产出截图到 `docs/` 并在验收记录中逐条对照。
- [x] 6.4 更新 `docs/verification.md`、`README.md`（历史视图能力与截图）、`package.json` 版本 0.4.0。验证：README 中的命令与截图路径可解析，`openspec validate git-history-idea-parity` 通过。

## Workflow follow-up

- 实现完成并通过评审后运行 `openspec archive git-history-idea-parity`，把三份 delta 合并进主 spec。
