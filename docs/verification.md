# 验收记录（dsh-git）

> 目标 DSH：**0.2.1-rc.5**（由运行中实例的 `__DSH_BOOT__.release` 证实：`{"version":"0.2.1-rc.5","commit":"d4db512"}`）。
> 记录时间：2026-11-04。

## 1. 单元 / 集成测试

```
$ node --test test/host.test.js test/client.test.js
ℹ tests 51
ℹ pass 51
ℹ fail 0
```

- `test/host.test.js`（23 项）：用真实临时 git 仓库 + 假 Cordis ctx + 真实 `node:http` 把 `/git/*` 路由挂起来做端到端；
  覆盖 status 四分组 / 中文与空格路径 / 重命名 / 二进制 / 四种 diff 模式 / log 分页 / commit 详情 / branches / checkout /
  stage·unstage·discard·commit / 空仓库 / 非仓库 / 越界路径 / 空提交信息 / nothing-to-commit / 连接栅栏 / 路由唯一性。
- `test/client.test.js`（28 项）：用假 `window.__ModuleLoader__` 载入 `client.js`，断言 classic bundle 约束、
  factory 导出、`apply` 的注册行为（1 个 tab 类型 + body/title 两个槽位，key 均为 `dsh-git`）、zh/en 键集一致、
  API 路由与请求体形状，并用无依赖渲染 harness 渲染标题芯片与各面板状态。

## 2. 真实 DSH 实例端到端（Host + 客户端入口图）

把插件安装进 `web` profile（`dsh plugin --profile web add <repo>` + bundle 行），启动一个独立实例并执行：

```
$ node tools/verify-installed.mjs "http://127.0.0.1:PORT/?token=..."
→ 认证 http://127.0.0.1:PORT ...
→ 临时仓库 C:\Users\...\Temp\dsh-git-verify-xxxx
  PASS  index 可用 + 认证 cookie
  PASS  客户端入口图包含 dsh-git
  PASS  插件浏览器半边被 /plugins 正确服务
  PASS  GET /git/health
  PASS  连接栅栏拒绝无 cookie 请求
  PASS  GET /git/status 的完整形状
  PASS  GET /git/status 对非仓库目录返回 isRepo:false
  PASS  GET /git/diff（worktree / staged / untracked）
  PASS  GET /git/log 分页与形状
  PASS  GET /git/commit 详情含文件统计
  PASS  GET /git/diff mode=commit
  PASS  GET /git/branches
  PASS  POST /git/stage + /git/unstage 往返
  PASS  POST /git/discard 需要 confirm
  PASS  POST /git/discard 拒绝越界路径
  PASS  POST /git/commit 空信息被拒 + 正常提交
  PASS  POST /git/checkout 切换分支
  PASS  未知 /git 路由返回 404 JSON

全部通过（共 18 项）
```

其中「客户端入口图包含 dsh-git」拿到的是真实组合结果：

```json
{"id":"dsh-git","url":"plugins/??dsh-git/client.js&rev=35738caeb459",
 "inject":["@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-ui-session",
            "@deepseek-ai/dsh-api-session-controller","@deepseek-ai/dsh-client-locale",
            "@deepseek-ai/dsh-client-shortcuts"],"immediately":true}
```

即：`dsh.bundle.patch` 成功插入 Loader 行 → `dsh.client` 被模块系统扫描成入口图 → `/plugins` 正常服务浏览器半边。

## 3. 桌面端（运行中的应用）热加载

用 `tools/install-desktop.ps1 -LivePatch` 安装到 `~/.dsh/profiles/desktop`：

- `node_modules/dsh-git` → 本仓库的 junction；
- `package.json`：`dependencies["dsh-git"]="link:D:/code/DSH/Plugin/git"` + `dsh.profile.bundles += "dsh-git"`；
- `cordis.patch.yml` 追加 live patch 块（`patchReload` 默认 `live`）。

运行中的桌面实例（`http://127.0.0.1:58964`）在 patch 生效前后的对比：

| 请求 | 安装前 | 安装后 |
|---|---|---|
| `GET /git/health` | 404（未注册） | **401（已注册，被连接栅栏拒绝）** |

→ Host 半边已在**运行中的应用**里激活；浏览器刷新页面后即会取到含 `dsh-git` 的新入口图。

补充验证：向 profile patch 追加与 bundle patch 相同 id 的 `insert` 行时，组合结果仍然是**恰好 1 个** `dsh-git` 入口
（71 = 70 + 1），说明两种安装方式共存不会产生重复行，重启前后都安全。

## 4. 尚未覆盖的部分

- 真实浏览器里的像素级渲染：本次会话没有可用的浏览器自动化，UI 的正确性由
  （a）无依赖渲染 harness 的组件渲染测试、（b）真实实例上全部数据链路的 18 项端到端断言、
  （c）与已验证可用的第三方右侧栏插件 `dsh-folder-explorer` 完全一致的注册形状 三者共同支撑。
  最终视觉验收需要用户在 GUI 中刷新页面后确认。
