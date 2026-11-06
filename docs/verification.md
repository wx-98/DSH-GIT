# 验收记录（dsh-git）

> 目标 DSH：**0.2.1-rc.5**（由运行中实例的 `__DSH_BOOT__.release` 证实：`{"version":"0.2.1-rc.5","commit":"d4db512"}`）。
> 记录时间：2026-11-04，插件版本 0.1.1。

## 0. 结论

三层验证全部通过：**单元/集成测试 52 项** → **真实 DSH 实例 HTTP 端到端 18 项** → **真实浏览器（Chrome headless + CDP）UI 端到端**。
浏览器验证期间发现并修复了 2 个真实缺陷（见第 4 节）。

## 1. 单元 / 集成测试

```
$ node --test test/host.test.js test/client.test.js
ℹ tests 52
ℹ pass 52
ℹ fail 0
```

- `test/host.test.js`（24 项）：真实临时 git 仓库 + 假 Cordis ctx + 真 `node:http` 挂载 `/git/*` 做端到端；
  覆盖 status 四分组 / 中文与空格路径 / 重命名 / 二进制 / 四种 diff 模式 / log 分页 / commit 详情 / branches / checkout /
  stage·unstage·discard·commit / 空仓库 / 非仓库 / 越界路径 / 空提交信息 / nothing-to-commit / 连接栅栏 / 路由唯一性 / 解析器回归。
- `test/client.test.js`（28 项）：假 `window.__ModuleLoader__` 载入 `client.js`，断言 classic bundle 约束、factory 导出、
  `apply` 的注册行为（1 个 tab 类型 + body/title 两个槽位，key 均为 `dsh-git`）、zh/en 键集一致、API 路由与请求体形状，
  并用无依赖渲染 harness 渲染标题芯片与各面板状态。

## 2. 真实 DSH 实例 HTTP 端到端

把插件安装进 `web` profile（`dsh plugin --profile web add <repo>` + bundle 行），启动独立实例并执行
`node tools/verify-installed.mjs "http://127.0.0.1:PORT/?token=..."`：

```
PASS  index 可用 + 认证 cookie
PASS  客户端入口图包含 dsh-git
PASS  插件浏览器半边被 /plugins 正确服务
PASS  GET /git/health
PASS  连接栅栏拒绝无 cookie 请求
PASS  GET /git/status 的完整形状            PASS  GET /git/status 对非仓库目录返回 isRepo:false
PASS  GET /git/diff（worktree / staged / untracked）
PASS  GET /git/log 分页与形状               PASS  GET /git/commit 详情含文件统计
PASS  GET /git/diff mode=commit             PASS  GET /git/branches
PASS  POST /git/stage + /git/unstage 往返   PASS  POST /git/discard 需要 confirm
PASS  POST /git/discard 拒绝越界路径        PASS  POST /git/commit 空信息被拒 + 正常提交
PASS  POST /git/checkout 切换分支           PASS  未知 /git 路由返回 404 JSON

全部通过（共 18 项）
```

真实组合出来的客户端入口行：

```json
{"id":"dsh-git","url":"plugins/??dsh-git/client.js&rev=35738caeb459",
 "inject":["@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-ui-session",
            "@deepseek-ai/dsh-api-session-controller","@deepseek-ai/dsh-client-locale",
            "@deepseek-ai/dsh-client-shortcuts"],"immediately":true}
```

## 3. 真实浏览器 UI 端到端（Chrome headless + CDP）

用 `chrome --headless=new --remote-debugging-port=9333` 打开该实例，通过 CDP 驱动真实点击与截图：

| 步骤 | 结果 |
|---|---|
| 页面启动、`__DSH_BOOT__` 含 `dsh-git` | ✅ 71 个入口 |
| 客户端插件 `apply()` 执行（`style[data-dg-style="dsh-git/styles"]`，14.9 KB CSS） | ✅ |
| 右侧栏标签向导出现本插件的 **源代码管理** 条目（`data-sidebar-right-guide-entry="git"`） | ✅ [截图](ui-tab-wizard.png) |
| 打开面板：分支 `main`、`无上游`、仓库名、`变更 N / 历史` 标签 | ✅ [截图](ui-git-changes.png) |
| 变更分组：`已暂存 1` / `变更 5` / `未跟踪 4`，行内 `暂存` `放弃` `取消暂存` | ✅ |
| 点击 `暂存` → 文件从「未跟踪」移动到「已暂存」，出现 `取消暂存` | ✅ 真写 git index 后重新拉取 |
| `历史` 标签：分支下拉 `HEAD（当前分支）` + 提交行（sha/主题/`HEAD -> main`/作者/`7 分钟前`） | ✅ [截图](ui-git-history.png) |
| 点击提交 → 详情：完整 sha、作者、时间、refs、正文、16 个文件与 `+N -N` | ✅ |
| 点击文件 → diff：`工作区` 徽标、`+5 -1`、`@@ -553,7 +553,11 @@`、双列行号、增删着色 | ✅ [截图](ui-git-diff.png) |

浏览器里跑的每一步都打到了 Host 的真实路由（`/git/status`、`/git/stage`、`/git/log`、`/git/commit`、`/git/diff`），
不是 mock 数据。

## 4. 浏览器验证发现并修复的缺陷

1. **历史提交行布局错位**（CSS 类名冲突）：提交框的操作行与提交列表行都用了 `.dg-commit-row`，
   两条基础规则（横向 vs 纵向）互相覆盖，导致提交列表内容被水平居中。已把提交框操作行改名为 `.dg-commit-actions`。
2. **文本文件被误判为二进制**（Host 解析缺陷）：`parseUnifiedDiff` 的二进制标记正则未锚定行首，
   diff 内容里只要出现 `Binary files ... differ` 这段文字（例如本仓库 `lib/git.js` 自身的正则源码），
   整个文件就被当成二进制、返回 0 个 hunk。已锚定为 `^Binary files .* differ$`（`m` 标志）并补了回归测试。

修复后 `GET /git/diff?mode=commit&path=lib/git.js` 返回 `binary:false, hunks:1, additions:1312`。

## 5. 桌面端安装与热加载

`tools/install-desktop.ps1 -LivePatch` 安装到 `~/.dsh/profiles/desktop`：

- `node_modules/dsh-git` → 本仓库 junction；
- `package.json`：`dependencies["dsh-git"]="link:D:/code/DSH/Plugin/git"` + `dsh.profile.bundles += "dsh-git"`；
- `cordis.patch.yml` 追加 live patch 块（`patchReload` 默认 `live`）。

运行中的桌面实例（`http://127.0.0.1:58964`）前后对比：

| 请求 | 安装前 | 安装后 |
|---|---|---|
| `GET /git/health` | 404（未注册） | **401（已注册，被连接栅栏拒绝）** |

补充：profile patch 与 bundle patch 插入同一 id 时，组合结果仍是**恰好 1 个**入口（71 = 70 + 1），
因此「live patch + 重启后走 bundle」两种路径共存不会重复插行。

## 6. 已知限制

- 浏览器验证用的是独立 `web` profile 实例（同一份代码、同一个 0.2.1-rc.5 运行时），不是用户桌面窗口本身；
  桌面端的最终视觉确认仍需用户刷新页面。
- 未覆盖：多仓库/子模块视图、pull/push/fetch、stash、hunk 级暂存、三方冲突解决。

## 7. 0.2.0 增补：配色 / 提交图 / 头部分支芯片（2026-11-04 第二轮）

### 7.1 变更内容

| 需求 | 实现 |
|---|---|
| 「git 没有颜色」 | 状态字母按语义着色（M 琥珀、A/未跟踪 绿、D 红、R/C 蓝、冲突 橙），文件名跟随状态着色，深浅主题各一套；`HEAD -> main` 绿、远端引用蓝、短 sha 蓝 |
| 「没有 VSCode 那种 GRAPH」 | 历史列表左侧彩色泳道（圆点 + 竖线 + 合并/分叉曲线）；算法在 `tools/graph-lanes.mjs`（纯函数、16 项测试），`client.js` 内联同一份实现并用 SVG 绘制 |
| 「页面顶端显示当前分支」 | 注册 `conversation.session.header.actions`，在会话标题栏常驻 `● main 3` 芯片：分支名 + ahead/behind + 变更数；点击弹出分组变更摘要 |

### 7.2 测试

```
$ node --test test/host.test.js test/client.test.js test/graph-lanes.test.js
ℹ tests 72
ℹ pass 72
ℹ fail 0
```

- `test/graph-lanes.test.js`（16 项）：线性 / 并行分支 fork+merge / 双父 merge / 三父八爪鱼 / 根提交 /
  parents 缺失与未知父 / 空列表 / `maxLanes` 截断 / 颜色稳定 / 列复用 / 畸形输入 / ASCII 快照，
  另有两条不变量守卫：字段完备性、**第 N 行 `exits[].col` 必须出现在第 N+1 行 `entries` 的同一列**（列号跨行不错位）。
- `test/client.test.js`（32 项，新增 4 项）：提交图线性/分叉合并/容错、ref 色调映射，以及 `apply` 现在注册 3 个槽位
  （body、title、header chip）。

### 7.3 真实浏览器验证（headless Chrome + CDP）

| 检查 | 结果 |
|---|---|
| 会话标题栏出现芯片，内容为 `main 3`（分支 main + 3 项变更） | ✅ [截图](ui-header-chip.png) |
| 点击芯片弹出摘要：分支、`无上游`、`变更 2`（M client.js / M test/client.test.js）、`未跟踪 1` | ✅ [截图](ui-chip-popover.png) |
| 变更面板状态字母与文件名着色（M 琥珀、U 绿） | ✅ [截图](ui-git-changes.png) |
| 历史列表彩色泳道（线性仓库：单列圆点） | ✅ [截图](ui-git-history.png) |
| 历史列表在**真实分叉仓库**上的泳道：两条彩色泳道 + 合并/分叉曲线 + 彩色 ref 标签 | ✅ [截图](ui-git-graph.png) |

提交图验证用的仓库是临时构造的（`main` 主线 + `feature/scm`、`feature/graph` 两个分支各两次提交，两次 `--no-ff` 合并），
以临时 workspace 挂到独立 web 实例上截图，验证后已从 workspace 注册表还原并删除。

### 7.4 已知限制

- 提交图按页（每页 50 条）计算泳道，跨页的分支线在翻页处重新起线（列号仍稳定，不会错位）。
- 头部芯片 10s 轮询一次（面板可见时 4s），不推送事件。

## 8. 0.3.0：git-idea-parity（OpenSpec 变更）验收

变更：`openspec/changes/git-idea-parity/`（proposal / 4 份 delta spec / design / tasks 共 30 项，已全部勾选）。
目标 DSH：0.2.1-rc.5。

### 8.1 自动化测试

```
$ node --test test/host.test.js test/client.test.js test/graph-lanes.test.js
ℹ tests 112
ℹ pass 112
ℹ fail 0
```

- `test/host.test.js` 41 项（原 24 + 17）：stats / apply-hunk（单块暂存、取消暂存、上下文失配 409 且索引不变、1 MiB 413）
  / amend / 分支增删改（当前分支 409、未合并需 force）/ stash 五操作（含 pop 冲突保留条目）/ log 过滤 / 新路由栅栏。
- `test/client.test.js` 51 项（原 33 + 18）：芯片字体继承、分支面板（分组/勾选/切换/失败错误条）、分支增删改、
  日志范围与切换分离、HEAD 大圆点+环、历史过滤、目录树、文件统计、hunk 按钮与补丁重建、amend 与提交信息历史、i18n 键集。
- `test/graph-lanes.test.js` 20 项（原 16 + 4）：HEAD 生命线使用保留色、并存泳道不重色、分支生命线颜色稳定、超调色板回退。

### 8.2 真实实例端到端（安装后自检）

```
$ node tools/verify-installed.mjs "http://127.0.0.1:PORT/?token=..."
全部通过（共 24 项）
```

新增覆盖：`GET /git/stats`、`POST /git/apply-hunk`、`POST /git/amend`、`POST /git/branches`（含拒绝删除当前分支）、
`GET/POST /git/stash` 全链路、`GET /git/log` 的 grep/author/path 过滤与无匹配空页。

### 8.3 浏览器 UI 回归（headless Chrome + CDP，真实点击）

| 检查 | 结果 |
|---|---|
| 芯片字体与相邻头部元素完全一致（family/12px/400/18px） | ✅ 计算样式比对 |
| 芯片弹层为分支面板（不透明背景、当前分支段 + 切换分支 + 分支操作） | ✅ [截图](ui-branch-panel.png) |
| 通过 UI 创建分支 `demo/ui-check` → 芯片立即变为该分支 | ✅ |
| 点击 `main` 行切回 → 芯片与面板同步 | ✅ |
| 删除分支：二次确认弹层 → 删除成功、面板刷新 | ✅ |
| 变更列表为可折叠目录树 + 每文件 `+N/-N` + amend 开关 | ✅ [截图](ui-changes-tree.png) |
| diff 每个 hunk 带「暂存此块」，按钮在横向滚动时仍完整可见 | ✅ [截图](ui-hunk-actions.png) |
| 历史视图：过滤栏 + 「切换到此分支」+ HEAD 大圆点与环 | ✅ |
| 真实分叉仓库上的多色泳道（HEAD 生命线强调色 + 分支调色板色） | ✅ [截图](ui-git-graph.png) |

分叉仓库验证用临时 workspace 挂到独立 web 实例，验证后已还原 workspace 注册表并删除临时仓库。

### 8.4 已知限制（本变更内）

- 远端分支在切换列表中为**只读**（直接 checkout 会进入 detached HEAD），需要先创建本地跟踪分支（未实现创建跟踪动作）。
- 泳道截断提示为启发式（`maxLanes >= GRAPH_MAX_LANES`），算法本身不返回截断标志。
- hunk 补丁不包含 `\ No newline at end of file` 标记；无结尾换行的文件在 hunk 暂存时可能需要手动处理。
- 网络操作（fetch/pull/push）、冲突解决界面、rebase、blame、并排 diff 不在本变更范围内。

## 9. 0.4.0：git-history-idea-parity（OpenSpec 变更）验收

变更：`openspec/changes/git-history-idea-parity/`（proposal / 3 份 delta spec / design / tasks 共 19 项，已全部勾选）。

### 9.1 自动化测试

```
$ node --test test/host.test.js test/client.test.js test/graph-lanes.test.js
ℹ tests 140
ℹ pass 140
ℹ fail 0
```

- `test/host.test.js` 47 项（原 41 + 6）：`GET /git/log` 的 `since`/`until`（区间、单边、边界当天、非法值 400 不跑 git、与 author 组合、无匹配空页、分页保持）。
- `test/client.test.js` 73 项（原 56 + 17）：分支树三组与范围切换（只改 ref 不改 HEAD）、窄宽度折叠、树的三态、grid 列布局与日期格式、合并提交弱化、HEAD 强调、refs 胶囊色调、键盘导航、跳到 HEAD、日期过滤参数（`until` 归一化 23:59:59）、三种空状态、上游解析与三态渲染（有上游/无上游/游离 HEAD/roster 兜底）。
- `test/graph-lanes.test.js` 20 项不变（内联算法与模块一致性用例仍绿）。

### 9.2 真实实例端到端（安装后自检）

```
$ node tools/verify-installed.mjs "http://127.0.0.1:PORT/?token=..."
全部通过（共 26 项）
```

新增覆盖：**真实 upstream 断言**（本地裸远端 + `push -u` 后 `status.branch.upstream === "origin/main"`，分支列表当前项的 upstream 同样正确）与 **`GET /git/log` 日期范围**（六月区间只回 1 条、七月边界当天包含、未来起点空页、非法值 400）。

### 9.3 浏览器 UI 回归（headless Chrome + CDP，真实点击）

| 检查 | 结果 |
|---|---|
| 历史页双栏：左分支树（全部 / HEAD / 本地 / 远端）+ 右列表 | ✅ [截图](ui-history-idea.png) |
| 列式布局：图 / 主题+refs / 作者 / `yyyy-MM-dd HH:mm` 日期 / 短哈希 | ✅ 同上 |
| 合并提交斜体弱化、HEAD 行强调、refs 胶囊带色调点 | ✅ 同上（两处 `合并 feature/...` 为斜体灰） |
| 日期过滤两个输入 + 清除；分支树选中显示「范围：…」 | ✅ 同上 |
| **有上游时显示上游**：面板摘要显示 `领先 7 origin/main repo`，无「无上游」 | ✅ 同上 |
| **游离 HEAD 不显示无上游**：`git checkout --detach` 后摘要显示「游离 HEAD」，`无上游` 不再出现 | ✅ [截图](ui-detached-head.png) |

分叉 + 上游 + 固定日期的演示仓库通过临时 workspace 挂到独立 web 实例验证，验证后已还原注册表并删除临时仓库。

### 9.4 已知限制（本变更内）

- 分支树在窄面板下折叠为按钮（< 560px），不做分支搜索；分支数很多时靠滚动。
- 日期过滤按**本地时区**解释；`until` 由客户端归一化为当天 23:59:59（git 的 date-only 语义取当前时钟，不能直接依赖）。
- 列表不做虚拟滚动（每页 50 条）。
- 网络操作、冲突解决、rebase、blame、并排 diff 仍不在范围内。

## 10. 发布验收（publish-dsh-git）

完整记录见 [publish-record.md](publish-record.md)。可复现的核心命令：

```bash
git ls-remote --heads --tags https://github.com/wx-98/DSH-GIT.git
curl -s https://api.github.com/repos/wx-98/DSH-GIT/topics
npm view dsh-git-control version dist.tarball repository.url license
node tools/verify-installed.mjs "http://127.0.0.1:PORT/?token=..."   # 对从 npm 安装后的实例
```

| 项 | 结果 |
|---|---|
| GitHub 仓库 / tag / topics / MIT | https://github.com/wx-98/DSH-GIT · `v0.4.0` · `dsh-plugin` 等 4 个 · MIT |
| GitHub Release | https://github.com/wx-98/DSH-GIT/releases/tag/v0.4.0 |
| npm 包 | `dsh-git-control@0.4.0`（公共源） |
| npm 安装后的真实实例自检 | 26/26 通过 |
| dshplugin.world 收录 issue | https://github.com/wx-98/DSH-GIT/issues/1 |
| 官方 discussions（Show Your Plugins!） | https://github.com/deepseek-ai/deepseek-harness/discussions/12165 |
| awesome-dsh-plugin 收录 | PR https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12342 **已合并**，条目已进入索引 |

## 11. 等宽字体回退（0.4.1）

问题：插件声明 `font-family: var(--dsh-font-mono, ui-monospace, monospace)`，但当前 DSH 宿主**没有定义** `--dsh-font-mono`，于是退到泛型关键字；在中文 Windows 上 Chrome 把 `ui-monospace`/`monospace` 解析成 **NSimSun（新宋体）**，等宽内容（分支名、短 SHA、diff/hunk）观感与代码字体不符。

修正：把命名等宽字体排在泛型关键字之前，并仍以宿主变量优先：

```css
font-family: var(--dsh-font-mono,'Cascadia Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,ui-monospace,monospace)
```

验证（headless Chrome + CDP `CSS.getPlatformFontsForNode`，对**从 npm 安装的 0.4.1** 实例）：

| 内容 | 修正前实际字体 | 修正后实际字体 |
|---|---|---|
| 等宽（分支名 / 短 SHA / diff） | `NSimSun` | **`Cascadia Mono`** |
| 界面文字（提交主题等） | `Segoe UI` | `Segoe UI`（继承宿主 `--dsw-font-family`，未变） |

同时新增回归测试 `monospace text asks for real code fonts before the generic keyword`：断言每条 mono 规则都以 `var(--dsh-font-mono,` 开头、含 `Consolas` 与 `'Cascadia Mono'`、命名字体位于 `ui-monospace` 之前、且以泛型 `monospace)` 收尾。

## 12. 顶部芯片点击无响应（0.4.2）

现象：桌面端会话顶部栏里的 Git 分支芯片，点击没有任何反应（网页版正常）。

根因：DSH 桌面外壳在 Windows 上给窗口顶部画了一条拖拽区（见 `app.asar` 中的样式）：

```css
[data-windows-titlebar] .frame:before{
  height: var(--dsh-windows-titlebar-height);
  -webkit-app-region: drag;   /* 拖拽区会吞掉点击事件 */
  position: absolute; inset: 0 0 auto;
}
```

Electron 的拖拽区不派发鼠标事件；芯片所在位置正好落在这条带子里，所以 `onClick` 从未执行。网页版不存在 `[data-windows-titlebar]`，因此浏览器里复现不出来（已实测 0.4.1 网页版点击正常）。

修正：让芯片与其弹层显式退出拖拽区（外壳自己也对顶栏控件这么处理）：

```css
.dg-chip-root{...-webkit-app-region:no-drag;app-region:no-drag}
.dg-pop{...-webkit-app-region:no-drag;app-region:no-drag}
```

验证：

- 回归测试 `the header chip and its popover opt out of the window drag region`（断言两条规则都带 `no-drag`）；
- 0.4.2 在真实实例中点击芯片 → `aria-expanded=true`、弹层出现且内容为「当前分支 / main / origin/main / 切换分支 …」。

## 13. 芯片弹层在桌面端不显示（0.4.3）

现象：0.4.2 之后点击顶部 `main` 胶囊，事件能进来了，但弹层内容看不见。

根因：芯片位于桌面窗口的标题栏带内，该带的祖先容器会裁剪溢出内容（`overflow` 裁剪 + 顶部拖拽条覆盖层），弹层用的是 `position: absolute`，于是被裁到不可见区域；网页版没有这类祖先，所以照常显示。

修正：弹层改为**锚定到芯片矩形**的 `position: fixed`（`popoverFixedStyle(anchor, viewportWidth)` 纯函数），从而脱离所有祖先裁剪；同时 `z-index` 提到 1200，高于顶栏覆盖层；视口 `resize`/`scroll` 时自动收起，避免浮层与芯片脱离。

```css
.dg-pop-fixed{position:fixed;top:auto;right:auto;left:auto;z-index:1200}
```

验证：

- 单元测试 `popoverFixedStyle anchors the popover below the chip as a fixed element`（正常矩形、缺省矩形、右侧越界钳制）；
- 真实实例（0.4.3）：点击芯片 → `aria-expanded=true`、弹层 `position: fixed`、矩形 `(x=200, y=43, 340×330)`、完全在视口内、内容为「当前分支 / main / origin/main / 切换分支 …」。

## 14. 弹层被标题栏裁剪（0.4.4）

现象：0.4.3（`position: fixed` 锚定芯片）在桌面端依旧只露出一条很窄的浅色条——弹层渲染了，但被裁掉。

根因：芯片位于桌面外壳的标题栏结构内。浏览器实测其祖先链为

```
.dg-chip-root -> div -> .headerActions -> .titleCluster -> .titleRow -> div
```

标题栏这一组祖先会裁剪溢出，并且创建了 fixed 定位的包含块（transform 类），所以 `position: fixed` 也无法逃出，弹层被裁成一条。

修正：把弹层放进**顶层（top layer）**——`<div popover="manual">` + `showPopover()` / `hidePopover()`。顶层元素不受任何祖先 `overflow` / stacking context / transform 影响，同时元素仍在 React 树内（不需要 portal、不需要 react-dom）。UA 会把 `[popover]` 居中（`inset:0;margin:auto`），因此样式里清掉这些偏移并保留锚定坐标。

```css
.dg-pop[popover]{inset:auto;margin:0;padding:8px}
```

验证（真实实例 0.4.4）：

| 检查 | 结果 |
|---|---|
| 点击芯片 | `aria-expanded=true`，弹层存在且 `matches(':popover-open') === true` |
| 是否在顶层 | `popover` 属性为 `manual`，`position: fixed`，矩形 `(200,43) 340×330`，完全可见 |
| 再点一次 | 关闭（节点移除，`aria-expanded=false`） |
| 再次打开 | 正常重开 |
| Escape | 关闭 |
| 点击外部 | 关闭 |

## 15. 弹层的三处体验问题（0.4.5）

0.4.4 之后用户反馈三点：① 点开有一帧延迟才显示完整内容；② 在弹层里滚动滚轮会直接把面板关掉；③ 为什么以前没有、现在才有。

| 问题 | 原因 | 修法 |
|---|---|---|
| ① 点开后迟钝一下 | `[popover]` 在 `showPopover()` 前是 `display:none`，而 `showPopover()` 写在 `useEffect`（绘制后）里；同时分支列表要等页面打开后才发请求 | 改为 `useLayoutEffect`（绘制前执行）；芯片空闲时**预取**分支列表，打开时作为 `initialBranches` 首帧就有内容 |
| ② 滚轮一滑就退出 | 0.4.3 为「避免浮层脱离芯片」在 `window` 上加了 **capture 阶段的 scroll 监听**，它会连弹层自身的滚动一起收到（弹层有 `max-height`，内部可滚动），于是第一下滑轮就触发关闭 | 删除 scroll 监听，只保留 `resize`（顶层弹层不随页面滚动移动，无需跟随） |
| ③ 为什么以前没有 | 0.4.0/0.4.1 的弹层是普通绝对定位元素，没有 `showPopover`、没有 scroll 监听——但它当时在桌面端**根本显示不出来**（就是前面两个 bug）；这三个问题都是为修「显示不出来」时引入的 | 见左两行 |

验证（真实实例 0.4.5）：

| 检查 | 结果 |
|---|---|
| 点击后下一帧 | 弹层已存在、`:popover-open` 为真、高度 240px、**首帧即含「切换分支」等内容** |
| 在弹层内滚轮 + 触发 `scroll` | 弹层保持打开（`survivesScroll: true`） |
| Escape | 关闭 |
