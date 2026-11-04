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
