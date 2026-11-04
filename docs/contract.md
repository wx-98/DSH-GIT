# dsh-git — 内部契约（Host ⇄ Client 单一事实来源）

> 本文件是 Host 半边（\`index.js\` / \`lib/git.js\`）与浏览器半边（\`client.js\`）之间
> 唯一的接口契约。两侧独立实现，任何一侧改动都必须先改本文件。

## 0. 运行环境事实（已验证，不要臆测）

- DSH 版本：**0.1.2-rc.1**（\`@deepseek-ai/dsh-base\` 等包版本）。
- 插件包名：\`dsh-git\`，ESM（\`"type": "module"\`），**无构建步骤、无运行时依赖**。
- Host 半边入口：\`index.js\`（\`export const name\`, \`export const inject\`, \`export function apply(ctx, config)\`）。
- 浏览器半边入口：\`client.js\`，必须是自包含的单文件 classic 脚本，形如：

\`\`\`js
window.__ModuleLoader__.load({
  id: "dsh-git",
  factory(require) {
    const React = require("react");
    const ReactDOM = require("react-dom");
    // ... 全部代码 ...
    const inject = ["slots", "locale"];
    function apply(ctx) { /* ... */ }
    return { apply, inject };
  },
});
\`\`\`

\`react\` 与 \`react-dom\` 来自 shell 静态模块基线（\`PLATFORM_MODULES\`），可直接 \`require\`。
**不要** \`require\` 其它 \`@deepseek-ai/*\` 包（例如 ui-primitives），以减少版本风险。

## 1. Host HTTP 契约

### 1.1 注册方式

\`\`\`js
export const name = "git";
export const inject = ["webServer", "connection"];

export function apply(ctx) {
  for (const route of ROUTES) {
    ctx.effect(
      () => ctx.webServer.register({ kind: "exact", path: route.path, handler: wrap(ctx, route) }),
      "git: " + route.method + " " + route.path,
    );
  }
  // 兜底 404（prefix 路由）
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: "/git", handler: fallback }), "git: fallback");
}
\`\`\`

- 每个 handler 第一行必须是连接栅栏：
  \`\`\`js
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== undefined) { res.statusCode = rejection; res.end(); return; }
  \`\`\`
- 所有路由前缀 \`/git\`。请求由浏览器同源 \`fetch\` 发起，前端使用**相对路径**（\`"git/status"\`），
  不要写死 \`/git/...\` 的绝对形式以外的东西；统一用 \`"/git/..."\` 绝对路径即可（DSH 无 base path 部署）。

### 1.2 通用约定

- \`root\`：查询参数或 JSON 字段，**绝对路径**，来自会话 cwd。Host 用
  \`git -C <root> rev-parse --show-toplevel\` 解析真实仓库根；解析失败返回 \`isRepo:false\`。
- 所有 git 调用使用 \`execFile("git", args)\`（**禁止 shell 字符串拼接**），参数含
  \`-c core.quotepath=false\`、\`--no-optional-locks\`、\`-c color.ui=false\`，超时 15s，\`maxBuffer\` 32MB。
- 读取类（GET）不排队；写操作（POST）通过一个 promise 串行队列，避免并发互相踩。
- 成功响应 HTTP 200 且 \`{ ok: true, ... }\`；失败为 \`{ ok: false, code, message }\` + 语义化状态码：

| code | HTTP | 含义 |
|---|---|---|
| \`bad-request\` | 400 | 参数缺失/非法 |
| \`invalid-path\` | 400 | 路径非法（非绝对、越界） |
| \`not-found\` | 404 | 路径或对象不存在 |
| \`not-a-repo\` | 409 | 目标目录不是 git 仓库（仅 POST 用，GET 用 isRepo:false） |
| \`git-failed\` | 422 | git 命令非零退出（message 用 stderr 首行） |
| \`conflict\` | 409 | 操作与当前状态冲突 |
| \`internal\` | 500 | 未知错误 |

- 路径一律用 **仓库相对 POSIX 风格**（\`src/a.ts\`）在 git 子命令与 JSON 中传递；
  仅在需要展示绝对路径时由客户端拼接。

### 1.3 路由表

#### GET /git/status?root=&lt;abs&gt;

\`\`\`jsonc
{
  "ok": true,
  "isRepo": true,
  "root": "D:\\code\\x",              // 传入路径的规范化结果（正斜杠）
  "toplevel": "D:/code/x",            // git rev-parse --show-toplevel
  "branch": {
    "name": "main",                   // 可读分支名；detached 时为 "HEAD"
    "detached": false,
    "sha": "5f2c...",                 // 完整 sha
    "shortSha": "5f2c1a9",
    "upstream": "origin/main",        // 无则为 null
    "ahead": 1,
    "behind": 0
  },
  "staged":     [ { "path": "src/a.ts", "origPath": null, "status": "M" } ],
  "unstaged":   [ { "path": "src/b.ts", "origPath": null, "status": "M" } ],
  "untracked":  [ { "path": "notes.md", "origPath": null, "status": "?" } ],
  "conflicted": [ { "path": "src/c.ts", "origPath": null, "status": "U" } ],
  "counts": { "staged": 1, "unstaged": 1, "untracked": 1, "conflicted": 0 }
}
\`\`\`

- 非仓库时：\`{ "ok": true, "isRepo": false, "root": "...", "toplevel": null }\`（不带其它字段）。
- \`status\` 单字母：\`M\` 修改、\`A\` 新增、\`D\` 删除、\`R\` 重命名、\`C\` 复制、\`T\` 类型变更、
  \`U\` 冲突、\`?\` 未跟踪。重命名/复制带 \`origPath\`。
- 用 \`git status --porcelain=v2 --branch -z\`（\`-z\` 以 NUL 分隔，兼容空格/中文路径）。
- 若 HEAD 不存在（空仓库），\`branch.sha\` 为 \`null\`，\`branch.name\` 取分支名或 \`"main"\`。

#### GET /git/diff?root=&lt;abs&gt;&path=&lt;相对路径&gt;&mode=worktree|staged|untracked|commit&rev=&lt;sha&gt;

\`\`\`jsonc
{
  "ok": true,
  "path": "src/a.ts",
  "mode": "worktree",
  "binary": false,
  "truncated": false,          // 超过 4000 行时截断
  "additions": 3,
  "deletions": 1,
  "hunks": [
    {
      "header": "@@ -1,3 +1,4 @@",
      "oldStart": 1, "oldLines": 3, "newStart": 1, "newLines": 4,
      "lines": [
        { "type": "context", "text": "const a = 1;", "oldLine": 1, "newLine": 1 },
        { "type": "del",     "text": "const b = 2;", "oldLine": 2, "newLine": null },
        { "type": "add",     "text": "const b = 3;", "oldLine": null, "newLine": 2 }
      ]
    }
  ]
}
\`\`\`

- \`mode=worktree\`：\`git diff --no-color --find-renames -U3 -- <path>\`
- \`mode=staged\`：\`git diff --cached --no-color ... -- <path>\`
- \`mode=untracked\`：合成 diff，整个文件当作新增（\`/dev/null\` → 文件），二进制按扩展名/内容含 NUL 判定。
- \`mode=commit\`：\`git show --no-color --format= <rev> -- <path>\`；无 \`rev\` 视为 HEAD。
- 二进制：\`git diff\` 输出含 \`Binary files ... differ\` 时 \`binary:true\`、\`hunks:[]\`。
- 空 diff：\`hunks: []\`、\`additions:0\`、\`deletions:0\`。

#### GET /git/log?root=&lt;abs&gt;&limit=50&skip=0&ref=HEAD

\`\`\`jsonc
{
  "ok": true,
  "ref": "HEAD",
  "hasMore": true,
  "commits": [
    {
      "sha": "5f2c...", "shortSha": "5f2c1a9",
      "author": "Wang Xiao", "email": "w@x.io",
      "time": 1699999999,                // 作者时间，Unix 秒
      "subject": "feat: add git plugin",
      "parents": ["a1b2..."],
      "refs": ["HEAD -> main", "origin/main"]   // %D 去前缀后的数组，可为 []
    }
  ]
}
\`\`\`

- \`git log --no-color -z --format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%P%x1f%D%x1f%s -n <limit+1> --skip=<skip> <ref>\`
  （实现可自由选择分隔符，只要 JSON 形状一致；\`limit\` 上限 200）。
- \`hasMore\` = 实际返回超过 limit 一条时为 true（多取一条再丢弃）。

#### GET /git/commit?root=&lt;abs&gt;&sha=&lt;完整或短 sha&gt;

\`\`\`jsonc
{
  "ok": true,
  "commit": {
    "sha": "5f2c...", "shortSha": "5f2c1a9",
    "author": "Wang Xiao", "email": "w@x.io", "time": 1699999999,
    "subject": "feat: add git plugin",
    "body": "长描述第一行\n第二行",       // 空字符串表示无
    "parents": ["a1b2..."], "refs": ["HEAD -> main"]
  },
  "files": [
    { "path": "src/a.ts", "origPath": null, "status": "M",
      "additions": 3, "deletions": 1, "binary": false }
  ]
}
\`\`\`

- 文件清单用 \`git show --numstat --format= -M <sha>\`（或 \`git diff-tree\`），
  状态字母由 \`--name-status -M\` 合并得到；二进制文件 \`additions/deletions\` 为 \`null\`。

#### GET /git/branches?root=&lt;abs&gt;

\`\`\`jsonc
{
  "ok": true,
  "current": "main",
  "detached": false,
  "local": [
    { "name": "main", "sha": "5f2c...", "upstream": "origin/main",
      "ahead": 1, "behind": 0, "isCurrent": true }
  ],
  "remote": [ { "name": "origin/main", "sha": "5f2c...", "isCurrent": false } ]
}
\`\`\`

- \`git for-each-ref --format='%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)' refs/heads refs/remotes\`
  解析 \`[ahead 1, behind 2]\` 轨道信息。

#### POST /git/stage

\`\`\`json
{ "root": "D:/code/x", "paths": ["src/a.ts", "notes.md"] }
\`\`\`
→ \`{ "ok": true, "staged": ["src/a.ts","notes.md"] }\`；删除的文件用 \`git add -A -- <paths>\`。

#### POST /git/unstage

\`\`\`json
{ "root": "D:/code/x", "paths": ["src/a.ts"] }
\`\`\`
→ \`{ "ok": true }\`；实现：\`git restore --staged -- <paths>\`；空仓库（无 HEAD）用 \`git rm --cached -- <paths>\` 兜底。

#### POST /git/discard

\`\`\`json
{ "root": "D:/code/x", "paths": ["src/a.ts"], "confirm": true }
\`\`\`
→ \`{ "ok": true }\`
- \`confirm !== true\` → 400 bad-request。
- 已跟踪文件：\`git restore --worktree -- <paths>\`（先 \`git checkout --\` 兼容旧版）。
- 未跟踪文件/目录：\`git clean -fd -- <paths>\`（**只允许仓库内相对路径**；拒绝 \`..\`、绝对路径、空路径）。

#### POST /git/commit

\`\`\`json
{ "root": "D:/code/x", "message": "feat: x", "all": false }
\`\`\`
→ \`{ "ok": true, "sha": "5f2c...", "shortSha": "5f2c1a9" }\`
- \`message\` 去空白后为空 → 400。
- \`all: true\` 时先 \`git add -A\` 再提交（\`git commit -m\`），否则直接 \`git commit -m\`。
- 无变更可提交（git 退出码 1 且 stderr 含 "nothing to commit"）→ 409 \`conflict\`。

#### POST /git/checkout

\`\`\`json
{ "root": "D:/code/x", "branch": "dev" }
\`\`\`
→ \`{ "ok": true }\`；\`git checkout -- <branch>\`（失败 → 422 git-failed，message 保留 stderr）。

#### GET /git/health

→ \`{ "ok": true, "plugin": "dsh-git", "version": "0.1.0", "git": "2.54.0.windows.1" }\`
（用于安装自检：\`git --version\` 拿不到时 \`git: null\`，仍返回 ok:true。）

### 1.4 安全边界

- 所有 \`paths\` 必须是仓库相对路径：拒绝绝对路径、\`..\` 上跳、含 NUL；\`resolve\` 后
  必须仍在 toplevel 之内（\`prefix\` 检查）。
- \`root\` 必须是绝对路径且存在目录；不做「只允许工作区内」的限制（用户明确在会话 cwd 上操作）。
- 不读取 \`.git\` 内部文件；只通过 git CLI。
- 不产生任何模型可见事件（纯 UI 插件）。

---

## 2. 浏览器半边契约（0.2.1-rc.5：右侧栏标签）

> 参照物：已安装且可用的第三方插件 \`dsh-folder-explorer\`
> （\`C:\Users\wangxiao13\.dsh\profiles\desktop\node_modules\dsh-folder-explorer\client.js\`）。
> 它就是用 0.2.1-rc.5 的右侧栏标签 API 实现的，**照抄其注册形状**。

### 2.1 插件结构与服务注入

\`\`\`js
window.__ModuleLoader__.load({
  id: "dsh-git",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const ReactDOM = require("react-dom");
    // ... 全部代码 ...
    const inject = ["slots", "locale", "sidebarRightTabs", "sidebarRight", "shortcuts"];
    function apply(ctx) {
      ctx.effect(() => { installStyles(); return () => removeStyles(); }, "dsh-git: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-git: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,                      // "dsh-git"
        kind: KIND,                  // "git"
        keepMounted: true,
        title: () => t("type.label"),
        guide: [{ id: "git", order: 10, title: () => t("guide.title"),
                  description: () => t("guide.description"), icon: GitGlyph }],
      }), "dsh-git: tab type");
      ctx.effect(() => ctx.slots.inject(BODY_SLOT, () => ctx.slots.register(
        { name: BODY_SLOT, key: ID, locale: NS }, GitBody)), "dsh-git: body");
      ctx.effect(() => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register(
        { name: TITLE_SLOT, key: ID, locale: NS }, GitTitle)), "dsh-git: title");
    }
    exports.apply = apply; exports.inject = inject;
    return module.exports;
  },
});
\`\`\`

常量：
\`\`\`js
const ID = "dsh-git";
const KIND = "git";
const NS = "git";
const BODY_SLOT = "sidebar.right.pane.tab";
const TITLE_SLOT = "sidebar.right.pane.tab.title";
\`\`\`

**注意**：slot 注册用 \`key: ID\`（不是 \`id\`）；\`sidebarRightTabs.register\` 用 \`id/kind\`。
\`react\` / \`react-dom\` 来自静态模块表，可直接 \`require\`；**不要 require 任何其它包**。

### 2.2 组件 props（真实注入）

- \`GitBody({ sessionId, useSessions, useTabInfo, t })\`
- \`GitTitle({ useTabInfo, t })\` —— 标题芯片：Git 图标 + \`tabInfo.tab.title\`（空则 \`t("type.label")\`）+ 分支名 + 变更数徽标。
- 会话 cwd（**照抄**）：
\`\`\`js
function NO_SESSIONS() { return undefined; }
function useSessionCwd(useSessions, sessionId) {
  const useStore = typeof useSessions === "function" ? useSessions : NO_SESSIONS;
  return useStore((state) => {
    const byId = state ? state.byId : null;
    const session = byId && sessionId != null ? byId[sessionId] : null;
    return session ? session.cwd : undefined;
  });
}
\`\`\`
- cwd 未知 / 非 git 仓库时，整块面板显示空状态（不得抛错、不得空白）。
- **没有 portal、没有遮罩、没有抽屉**：面板就是右侧栏内容区，需要 \`height: 100%\`、
  内部 flex 纵向布局、列表区 \`overflow: auto\`、\`min-height: 0\`，避免撑破侧栏。

### 2.3 UI 布局（VSCode SCM 风格，面板内）

\`\`\`
┌───────────────────────────────┐
│ ⎇ main   ↑1 ↓0      [⟳]       │  ← 顶部摘要行（分支 / ahead / behind / 刷新）
├───────────────────────────────┤
│ [ 变更 ] [ 历史 ]             │  ← 两个 tab（面板内自绘）
├───────────────────────────────┤
│ 变更 tab:                     │
│ ┌ 提交信息 textarea ────────┐ │
│ │ …                         │ │
│ └───────────── [ 提交 ] ────┘ │
│ ▸ 已暂存 (2)                  │
│   M  src/a.ts      [−暂存]    │
│ ▸ 变更 (3)                    │
│   M  src/b.ts   [＋暂存][↺]   │
│ ▸ 未跟踪 (1)                  │
│   U  notes.md   [＋暂存][↺]   │
│ ▸ 冲突 (0)   (空组不显示)      │
│ ⟶ 点击行 → 覆盖式打开 diff 视图 │
├───────────────────────────────┤
│ 历史 tab: 分支下拉 + 提交列表   │
└───────────────────────────────┘
\`\`\`

Diff 视图在同一面板内**覆盖**列表区域（顶部「← 返回」按钮），不跳转、不弹窗。
所有交互不得使用 \`window.confirm\` / \`alert\`；放弃变更用面板内二次确认行内截面。

### 2.4 交互与可靠性要求

- 面板可见时（\`tabInfo.tab.visible !== false\`）：变更 tab 每 4s 轮询 status；切到历史 tab 时停止 status 轮询、首次进入拉 log。面板不可见时全部停止（\`keepMounted\` 会让组件常驻，必须用可见性短路）。
- 写操作成功后：重新拉 status；若在历史 tab 且已提交，回列表并刷新。
- 网络/接口失败：面板顶部红色错误条 + 「重试」；不得白屏。Host 返回 \`ok:false\` 时展示 message。
- 提交按钮状态：无已暂存且无未暂存变更 → 禁用；提交中 → busy 态禁用；提交成功 → 清空 textarea + 成功提示（3s 自动消失）。
- 滚动到底自动加载下一页 log（20/页够用，用 50 也行，要与契约 \`limit\` 一致）。
- 键盘：Esc 关闭 diff/确认；Ctrl/Cmd+Enter 提交。

### 2.5 样式与主题

- 只用宿主主题变量（必须带回退值）：
  \`--dsw-alias-label-primary\`、\`--dsw-alias-label-secondary\`、\`--dsw-alias-label-tertiary\`、
  \`--dsw-alias-fill-l1\`、\`--dsw-alias-fill-l2\`、\`--dsw-alias-border-l1\`、\`--dsw-alias-border-l2\`、
  \`--dsw-elevation-prominent\`、\`--dsw-specific-menu\`。
- 增删行背景：\`rgba(46,160,67,.16)\` / \`rgba(248,81,73,.16)\`。
- 样式通过 \`<style data-plugin="dsh-git">\` 注入一次（\`installStyles\`/\`removeStyles\` 在 \`apply\` 的 effect 里），
  类名全部 \`dg-\` 前缀；mono 字体 \`var(--dsh-font-mono, ui-monospace, monospace)\` 仅用于 sha/路径/diff。
- 不修改 \`document.body\` 的样式、不监听 \`window\` 全局事件（除必要的快捷键监听并在卸载时移除）。

### 2.6 文案

- zh 为键集真源，en 键集完全一致；所有可见文案走 \`t()\`，键名形如
  \`type.label\`、\`guide.title\`、\`guide.description\`、\`tabs.changes\`、\`tabs.history\`、\`changes.empty\`。
- 至少包含：\`type.label\`（"Git"）、\`guide.title\`、\`guide.description\`（标签向导里的说明）。

---

## 3. 测试与验收

- \`test/host.test.js\`（Host 同事）：\`node:test\` + 真实临时 git 仓库 + 假 ctx + node:http 端到端，
  覆盖第 1 节全部路由与边界。
- \`test/client.test.js\`（Client 同事）：
  1. 假 \`window\`（\`{ __ModuleLoader__: { load: (r) => captured = r } }\`）执行 \`client.js\` 源码，
     断言 \`captured.id === "dsh-git"\`；
  2. stub \`require\` 返回真实 react/react-dom（从 \`C:\Users\wangxiao13\.dsh\profiles\node_modules\` 用
     \`createRequire\` 绝对路径加载，失败则 \`t.skip()\`），调用 factory，断言导出含 \`apply\` 与 \`inject\`；
  3. 假 ctx 调 \`apply\`，断言：locale.register 收到 zh/en 且键集相同；
     \`sidebarRightTabs.register\` 收到 \`{id:"dsh-git", kind:"git"}\`；
     \`slots.register\` 被调用两次（body + title），名字分别为 \`sidebar.right.pane.tab\` /
     \`sidebar.right.pane.tab.title\`，且 \`key === "dsh-git"\`；
  4. \`react-dom/server.renderToStaticMarkup\` 渲染 \`GitTitle\`（props 带假 \`useTabInfo\`/\`t\`），
     断言 HTML 含 \`dg-\` 与 "Git"；
  5. 纯函数单测（diff 行分类、状态字母映射、相对时间、basename）。
- 全部测试：\`node --test test/\` 全绿。
