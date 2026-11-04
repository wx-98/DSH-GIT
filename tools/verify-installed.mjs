#!/usr/bin/env node
/**
 * dsh-git 安装后自检脚本（真实 DSH Host 端到端验证）。
 *
 * 用法：
 *   node tools/verify-installed.mjs "http://127.0.0.1:PORT/?token=XXXX"
 *
 * 它做四件事：
 *   1. 用启动 token 换取浏览器认证 cookie（与真实 GUI 同一条路径）；
 *   2. 从 index 的 globalThis["__DSH_BOOT__"] 断言 dsh-git 已进入客户端入口图，
 *      并拉取它被服务的 /plugins 组合脚本，断言内容确实是本插件的浏览器半边；
 *   3. 生成一个临时 git 仓库（含修改/未跟踪/重命名/中文路径），逐条驱动 /git/* 路由，
 *      校验 docs/contract.md 第 1 节的 JSON 形状；
 *   4. 断言连接栅栏生效：不带 cookie 的 /git/* 必须被拒（401/403）。
 *
 * 退出码 0 = 全部通过；1 = 有断言失败。失败项会逐条打印。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 断言累加器。 */
const results = [];
function check(name, fn) {
  results.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertShape(value, keys, label) {
  for (const key of keys) {
    assert(Object.prototype.hasOwnProperty.call(value, key), label + " 缺少字段 " + key);
  }
}

// ---------------------------------------------------------------------------
// HTTP 会话
// ---------------------------------------------------------------------------

/** 认证后的最小 HTTP 客户端：base URL + cookie。 */
class Session {
  /** @param {string} baseUrl @param {string[]} cookies */
  constructor(baseUrl, cookies) {
    this.baseUrl = baseUrl;
    this.cookies = cookies;
  }

  /**
   * @param {string} pathname
   * @param {RequestInit} [init]
   */
  async fetch(pathname, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (this.cookies.length > 0) headers.cookie = this.cookies.join("; ");
    const target = pathname.startsWith("/") ? this.baseUrl + pathname : this.baseUrl + "/" + pathname;
    const response = await fetch(target, { ...init, headers, redirect: "manual" });
    return response;
  }

  /** @param {string} pathname */
  async json(pathname) {
    const response = await this.fetch(pathname);
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text), text };
    } catch {
      return { status: response.status, body: null, text };
    }
  }

  /**
   * @param {string} pathname
   * @param {unknown} payload
   */
  async post(pathname, payload) {
    const response = await this.fetch(pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body, text };
  }
}

/**
 * 用启动 token 换取 cookie。index 请求返回 303 + Set-Cookie。
 * @param {import("node:url").URL} url
 * @returns {Promise<Session>}
 */
async function authenticate(url) {
  const first = await fetch(url, { redirect: "manual" });
  const rawCookies =
    typeof first.headers.getSetCookie === "function"
      ? first.headers.getSetCookie()
      : [first.headers.get("set-cookie")].filter(Boolean);
  const cookies = rawCookies.map((entry) => String(entry).split(";")[0]).filter((entry) => entry.length > 0);
  if (cookies.length === 0) {
    throw new Error("index 请求没有下发认证 cookie（status " + first.status + "），token 可能已失效");
  }
  return new Session(url.origin, cookies);
}

// ---------------------------------------------------------------------------
// 客户端入口图
// ---------------------------------------------------------------------------

/**
 * 从 index HTML 中解析 __DSH_BOOT__ 并返回 dsh-git 行。
 * @param {string} html
 */
function findBootEntry(html) {
  const marker = 'globalThis["__DSH_BOOT__"] = ';
  const index = html.indexOf(marker);
  if (index < 0) throw new Error("index HTML 里找不到 __DSH_BOOT__ 注入");
  let cursor = index + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = cursor; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error("__DSH_BOOT__ JSON 不完整");
  const boot = JSON.parse(html.slice(cursor, end));
  const entries = Array.isArray(boot.entries) ? boot.entries : [];
  const entry = entries.find((item) => item && item.id === "dsh-git");
  return { boot, entry, entries };
}

// ---------------------------------------------------------------------------
// 临时 git 仓库
// ---------------------------------------------------------------------------

/** @param {string} cwd @param {string[]} args */
async function git(cwd, args) {
  const { stdout } = await run(
    "git",
    ["-c", "core.quotepath=false", "-c", "user.name=DSH Verify", "-c", "user.email=verify@dsh.local", "-c", "gc.auto=0", "-c", "commit.gpgsign=false", ...args],
    { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  return stdout;
}

/** 造一个包含各类变更的临时仓库。 */
async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-git-verify-"));
  await git(dir, ["init", "-b", "main"]);
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  await fs.writeFile(path.join(dir, "旧文件 名.md"), "# 旧\n", "utf8");
  await fs.writeFile(path.join(dir, "keep.txt"), "keep\n", "utf8");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "feat: 初始提交"]);
  // 第二次提交，用于 history
  await fs.writeFile(path.join(dir, "keep.txt"), "keep\nchanged\n", "utf8");
  await git(dir, ["add", "keep.txt"]);
  await git(dir, ["commit", "-m", "fix: 第二次提交"]);
  // 工作区改动
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 2;\nexport const b = 3;\n", "utf8");
  await fs.writeFile(path.join(dir, "新增 文件.txt"), "hello\nworld\n", "utf8");
  // 暂存一个改动
  await fs.writeFile(path.join(dir, "keep.txt"), "keep\nchanged\nstaged\n", "utf8");
  await git(dir, ["add", "keep.txt"]);
  // 重命名（未暂存）
  await git(dir, ["mv", "旧文件 名.md", "重命名 后.md"]);
  return dir;
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

const state = { session: null, repo: null, boot: null };

check("index 可用 + 认证 cookie", async () => {
  const response = await state.session.fetch("/");
  assert(response.status === 200, "index 状态码应为 200，实际 " + response.status);
  const html = await response.text();
  assert(html.includes("<html"), "index 不是 HTML");
  state.html = html;
});

check("客户端入口图包含 dsh-git", async () => {
  const { boot, entry, entries } = findBootEntry(state.html);
  state.boot = boot;
  assert(entries.length > 20, "入口图条目过少，疑似未正确组合：" + entries.length);
  assert(entry !== undefined, "入口图里没有 id 为 dsh-git 的条目");
  assert(typeof entry.url === "string" && entry.url.length > 0, "dsh-git 条目缺少 url");
  state.entry = entry;
});

check("插件浏览器半边被 /plugins 正确服务", async () => {
  const url = state.entry.url.startsWith("/") ? state.entry.url : "/" + state.entry.url;
  const response = await state.session.fetch(url);
  assert(response.status === 200, "bundle 状态码应为 200，实际 " + response.status + "（url " + url + "）");
  const source = await response.text();
  assert(source.includes("__ModuleLoader__.load"), "bundle 里没有 __ModuleLoader__.load");
  assert(source.includes('"dsh-git"'), "bundle 里没有 dsh-git 标识");
  state.bundleSource = source;
});

check("GET /git/health", async () => {
  const { status, body } = await state.session.json("/git/health");
  assert(status === 200, "状态码应为 200，实际 " + status);
  assert(body && body.ok === true, "ok 应为 true");
  assert(body.plugin === "dsh-git", "plugin 字段应为 dsh-git，实际 " + JSON.stringify(body.plugin));
  assert(typeof body.version === "string" && body.version.length > 0, "缺少 version");
  assert("git" in body, "缺少 git 字段");
});

check("连接栅栏拒绝无 cookie 请求", async () => {
  const anon = new Session(state.session.baseUrl, []);
  const response = await anon.fetch("/git/health");
  assert(response.status === 401 || response.status === 403, "无认证请求应被拒（401/403），实际 " + response.status);
});

check("GET /git/status 的完整形状", async () => {
  const { status, body } = await state.session.json("/git/status?root=" + encodeURIComponent(state.repo));
  assert(status === 200, "状态码应为 200，实际 " + status);
  assert(body.ok === true && body.isRepo === true, "应是 git 仓库");
  assertShape(body, ["root", "toplevel", "branch", "staged", "unstaged", "untracked", "conflicted", "counts"], "status");
  assertShape(body.branch, ["name", "detached", "sha", "shortSha", "upstream", "ahead", "behind"], "branch");
  // 先保存，后续用例依赖它；断言失败不应让依赖项连锁失败。
  state.status = body;
  assert(body.branch.name === "main", "分支名应为 main，实际 " + body.branch.name);
  // git mv 会把重命名放进暂存区，所以暂存区 = keep.txt 修改 + 重命名，共 2 项。
  assert(body.staged.length === 2, "已暂存应为 2 个，实际 " + body.staged.length);
  assert(
    body.staged.some((item) => item.path === "keep.txt" && item.status === "M"),
    "keep.txt 的修改未被识别为已暂存",
  );
  assert(
    body.unstaged.some((item) => item.path === "a.ts" && item.status === "M"),
    "a.ts 的修改未被识别为未暂存",
  );
  assert(body.untracked.length === 1, "未跟踪应为 1 个，实际 " + body.untracked.length);
  assert(body.untracked[0].path.includes("新增 文件.txt"), "未跟踪路径解析错误：" + body.untracked[0].path);
  assert(body.counts.staged === 2 && body.counts.untracked === 1, "counts 汇总不一致：" + JSON.stringify(body.counts));
  const renamed = [...body.staged, ...body.unstaged].find((item) => item.status === "R");
  assert(renamed !== undefined, "重命名未出现在变更里");
  assert(renamed.origPath === "旧文件 名.md", "重命名 origPath 错误：" + renamed.origPath);
  assert(renamed.path === "重命名 后.md", "重命名 path 错误：" + renamed.path);
});

check("GET /git/status 对非仓库目录返回 isRepo:false", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-git-plain-"));
  const { status, body } = await state.session.json("/git/status?root=" + encodeURIComponent(plain));
  assert(status === 200, "状态码应为 200，实际 " + status);
  assert(body.ok === true && body.isRepo === false, "非仓库应返回 isRepo:false");
});

check("GET /git/diff（worktree / staged / untracked）", async () => {
  const target = state.status.unstaged.find((item) => item.path === "a.ts");
  assert(target !== undefined, "a.ts 应在未暂存列表里");
  const worktree = await state.session.json(
    "/git/diff?root=" + encodeURIComponent(state.repo) + "&path=" + encodeURIComponent("a.ts") + "&mode=worktree",
  );
  assert(worktree.status === 200 && worktree.body.ok === true, "worktree diff 失败：" + worktree.text.slice(0, 200));
  assert(Array.isArray(worktree.body.hunks) && worktree.body.hunks.length > 0, "worktree diff 应有 hunk");
  assert(worktree.body.binary === false, "文本文件不应是 binary");
  const hunk = worktree.body.hunks[0];
  assertShape(hunk, ["header", "oldStart", "oldLines", "newStart", "newLines", "lines"], "hunk");
  const kinds = new Set(hunk.lines.map((line) => line.type));
  assert(kinds.has("add") && kinds.has("del"), "diff 行类型缺失：" + JSON.stringify([...kinds]));

  const staged = await state.session.json(
    "/git/diff?root=" + encodeURIComponent(state.repo) + "&path=" + encodeURIComponent("keep.txt") + "&mode=staged",
  );
  assert(staged.status === 200 && staged.body.ok === true, "staged diff 失败");
  assert(staged.body.additions >= 1 || staged.body.hunks.length >= 1, "staged diff 为空");

  const untracked = await state.session.json(
    "/git/diff?root=" + encodeURIComponent(state.repo) + "&path=" + encodeURIComponent("新增 文件.txt") + "&mode=untracked",
  );
  assert(untracked.status === 200 && untracked.body.ok === true, "untracked diff 失败：" + untracked.text.slice(0, 200));
  assert(untracked.body.hunks.length === 1, "未跟踪文件应合成 1 个 hunk");
});

check("GET /git/log 分页与形状", async () => {
  const { status, body } = await state.session.json(
    "/git/log?root=" + encodeURIComponent(state.repo) + "&limit=1&skip=0",
  );
  assert(status === 200 && body.ok === true, "log 失败：" + state.session.baseUrl);
  assert(Array.isArray(body.commits) && body.commits.length === 1, "limit=1 应只返回 1 条");
  assert(body.hasMore === true, "有更多提交时 hasMore 应为 true");
  assertShape(body.commits[0], ["sha", "shortSha", "author", "email", "time", "subject", "parents", "refs"], "commit row");
  assert(body.commits[0].subject.includes("第二次提交"), "最新提交主题错误：" + body.commits[0].subject);
  state.headSha = body.commits[0].sha;
});

check("GET /git/commit 详情含文件统计", async () => {
  const { status, body } = await state.session.json(
    "/git/commit?root=" + encodeURIComponent(state.repo) + "&sha=" + state.headSha,
  );
  assert(status === 200 && body.ok === true, "commit 详情失败");
  assertShape(body.commit, ["sha", "shortSha", "author", "email", "time", "subject", "body", "parents", "refs"], "commit");
  assert(Array.isArray(body.files) && body.files.length >= 1, "commit 文件列表为空");
  assertShape(body.files[0], ["path", "status", "additions", "deletions", "binary"], "commit file");
  assert(body.files[0].path === "keep.txt", "文件路径错误：" + body.files[0].path);
  assert(body.files[0].additions === 1, "additions 应为 1，实际 " + body.files[0].additions);
});

check("GET /git/diff mode=commit", async () => {
  const { status, body } = await state.session.json(
    "/git/diff?root=" + encodeURIComponent(state.repo) + "&path=keep.txt&mode=commit&rev=" + state.headSha,
  );
  assert(status === 200 && body.ok === true, "commit diff 失败：" + state.headSha);
  assert(body.hunks.length >= 1, "commit diff 为空");
});

check("GET /git/branches", async () => {
  const { status, body } = await state.session.json("/git/branches?root=" + encodeURIComponent(state.repo));
  assert(status === 200 && body.ok === true, "branches 失败");
  assert(body.current === "main", "current 应为 main，实际 " + body.current);
  assert(Array.isArray(body.local) && body.local.length === 1, "本地分支数量错误");
  assert(body.local[0].isCurrent === true, "isCurrent 应为 true");
});

check("POST /git/stage + /git/unstage 往返", async () => {
  const staged = await state.session.post("/git/stage", { root: state.repo, paths: ["a.ts"] });
  assert(staged.status === 200 && staged.body.ok === true, "stage 失败：" + staged.text.slice(0, 200));
  let after = await state.session.json("/git/status?root=" + encodeURIComponent(state.repo));
  assert(after.body.staged.some((item) => item.path === "a.ts"), "a.ts 未被暂存");

  const unstaged = await state.session.post("/git/unstage", { root: state.repo, paths: ["a.ts"] });
  assert(unstaged.status === 200 && unstaged.body.ok === true, "unstage 失败：" + unstaged.text.slice(0, 200));
  after = await state.session.json("/git/status?root=" + encodeURIComponent(state.repo));
  assert(!after.body.staged.some((item) => item.path === "a.ts"), "a.ts 仍在暂存区");
});

check("POST /git/discard 需要 confirm", async () => {
  const rejected = await state.session.post("/git/discard", { root: state.repo, paths: ["a.ts"] });
  assert(rejected.status === 400, "缺少 confirm 应返回 400，实际 " + rejected.status);
  assert(rejected.body && rejected.body.ok === false, "应返回 ok:false");

  const ok = await state.session.post("/git/discard", { root: state.repo, paths: ["a.ts"], confirm: true });
  assert(ok.status === 200 && ok.body.ok === true, "discard 失败：" + ok.text.slice(0, 200));
  const after = await state.session.json("/git/status?root=" + encodeURIComponent(state.repo));
  assert(!after.body.unstaged.some((item) => item.path === "a.ts"), "a.ts 仍被修改");
});

check("POST /git/discard 拒绝越界路径", async () => {
  const bad = await state.session.post("/git/discard", { root: state.repo, paths: ["../outside.txt"], confirm: true });
  assert(bad.status === 400 || bad.status === 403, "越界路径应被拒，实际 " + bad.status);
});

check("POST /git/commit 空信息被拒 + 正常提交", async () => {
  const empty = await state.session.post("/git/commit", { root: state.repo, message: "   " });
  assert(empty.status === 400, "空提交信息应 400，实际 " + empty.status);

  const staged = await state.session.post("/git/stage", { root: state.repo, paths: ["keep.txt", "新增 文件.txt"] });
  assert(staged.status === 200, "stage 失败");
  const committed = await state.session.post("/git/commit", { root: state.repo, message: "chore: 自检提交" });
  assert(committed.status === 200 && committed.body.ok === true, "commit 失败：" + committed.text.slice(0, 300));
  assert(typeof committed.body.sha === "string" && committed.body.sha.length === 40, "commit 未返回完整 sha");

  const log = await state.session.json("/git/log?root=" + encodeURIComponent(state.repo) + "&limit=1");
  assert(log.body.commits[0].subject === "chore: 自检提交", "最新提交主题错误：" + log.body.commits[0].subject);

  const nothing = await state.session.post("/git/commit", { root: state.repo, message: "chore: 空提交" });
  assert(nothing.status === 409, "无变更提交应 409，实际 " + nothing.status);
});

check("POST /git/checkout 切换分支", async () => {
  await git(state.repo, ["branch", "dev"]);
  const switched = await state.session.post("/git/checkout", { root: state.repo, branch: "dev" });
  assert(switched.status === 200 && switched.body.ok === true, "checkout 失败：" + switched.text.slice(0, 200));
  const after = await state.session.json("/git/status?root=" + encodeURIComponent(state.repo));
  assert(after.body.branch.name === "dev", "切换后分支应为 dev，实际 " + after.body.branch.name);
  await state.session.post("/git/checkout", { root: state.repo, branch: "main" });
});

check("未知 /git 路由返回 404 JSON", async () => {
  const { status, body } = await state.session.json("/git/does-not-exist");
  assert(status === 404, "应为 404，实际 " + status);
  assert(body && body.ok === false, "应返回 ok:false JSON");
});

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const rawUrl = process.argv[2];
  if (!rawUrl) {
    console.error('用法: node tools/verify-installed.mjs "http://127.0.0.1:PORT/?token=XXXX"');
    process.exit(2);
  }
  const url = new URL(rawUrl);
  console.log("→ 认证 " + url.origin + " ...");
  state.session = await authenticate(url);
  state.repo = await makeRepo();
  console.log("→ 临时仓库 " + state.repo);

  let failed = 0;
  for (const item of results) {
    try {
      await item.fn();
      console.log("  PASS  " + item.name);
    } catch (error) {
      failed += 1;
      console.log("  FAIL  " + item.name + " :: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  await fs.rm(state.repo, { recursive: true, force: true });
  console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项失败") + "（共 " + results.length + " 项）");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("自检脚本崩溃:", error);
  process.exit(1);
});
