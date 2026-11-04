/**
 * End-to-end tests for the dsh-git host half.
 *
 * Every test creates a real temporary git repository, applies the plugin to a
 * fake cordis context, publishes the registered routes on a real node:http
 * server and drives them with fetch(). Nothing is mocked below the HTTP layer:
 * the assertions in this file are the contract (docs/contract.md section 1)
 * checked against the git binary that ships with the host.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { apply } from "../index.js";
import {
  buildUntrackedDiff,
  mergeCommitFiles,
  parseNameStatus,
  parseNumstat,
  parseStatusPorcelainV2,
  parseUnifiedDiff,
} from "../lib/git.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Files committed by createRepoWithCommit(). */
const INITIAL_FILES = {
  "src/a.txt": "line1\nline2\nline3\n",
  "src/b.txt": "beta\n",
  "README.md": "# demo\n",
};

/**
 * Run git in a fixture repository.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>} stdout
 */
function gitRun(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error("git " + args.join(" ") + " failed: " + stderr.toString("utf8")));
          return;
        }
        resolve(stdout.toString("utf8"));
      },
    );
  });
}

/**
 * Write a map of repository relative path -> contents.
 *
 * @param {string} directory
 * @param {Record<string, string | Buffer>} files
 */
async function writeFiles(directory, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(directory, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents);
  }
}

/**
 * Configure a fresh repository with deterministic, host independent settings.
 *
 * @param {string} directory
 */
async function initRepo(directory) {
  await gitRun(directory, ["init", "-b", "main"]);
  await gitRun(directory, ["config", "user.name", "DSH Test"]);
  await gitRun(directory, ["config", "user.email", "dsh@example.com"]);
  await gitRun(directory, ["config", "gc.auto", "0"]);
  // Keep the fixtures byte identical on every Windows host: no CRLF rewriting.
  await gitRun(directory, ["config", "core.autocrlf", "false"]);
}

/**
 * Create a temporary repository with one initial commit.
 *
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string | Buffer>} [files]
 * @returns {Promise<string>} absolute repository path
 */
async function createRepoWithCommit(t, files = INITIAL_FILES) {
  const directory = await createTempDir(t, "dsh-git-repo-");
  await initRepo(directory);
  await writeFiles(directory, files);
  await gitRun(directory, ["add", "-A"]);
  await gitRun(directory, ["commit", "-m", "chore: initial commit"]);
  return directory;
}

/**
 * Create a temporary directory cleaned up when the test finishes.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function createTempDir(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// ---------------------------------------------------------------------------
// Plugin harness: fake ctx -> real HTTP server
// ---------------------------------------------------------------------------

/**
 * Pick the route for a request path: exact routes first, then the longest
 * matching prefix route (mirrors the dsh web server dispatch order).
 *
 * @param {Array<{ kind: string, path: string, handler: Function }>} registrations
 * @param {string} pathname
 */
function findRoute(registrations, pathname) {
  const exact = registrations.find((route) => route.kind === "exact" && route.path === pathname);
  if (exact !== undefined) return exact;
  let match = null;
  for (const route of registrations) {
    if (route.kind !== "prefix") continue;
    if (pathname !== route.path && !pathname.startsWith(route.path + "/")) continue;
    if (match === null || route.path.length > match.path.length) match = route;
  }
  return match;
}

/**
 * Apply the plugin to a fake cordis context and expose its routes over HTTP.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ requestRejection?: (req: any) => number | undefined }} [options]
 * @returns {Promise<{ base: string, registrations: Array<any>, effects: string[] }>}
 */
async function createHarness(t, options = {}) {
  // The real dsh web server throws when two routes share the same (kind, path)
  // pair ("route patterns are a composition-level contract"), so the fake
  // registry enforces exactly the same rule.
  /** @type {Map<string, { kind: string, path: string, handler: Function }>} */
  const registry = new Map();
  /** @type {string[]} */
  const effects = [];
  const requestRejection = options.requestRejection === undefined ? () => undefined : options.requestRejection;
  const ctx = {
    effect(fn, label) {
      effects.push(String(label));
      return fn();
    },
    webServer: {
      register(route) {
        const key = route.kind + " " + route.path;
        if (registry.has(key)) throw new Error("duplicate route registration: " + key);
        registry.set(key, route);
        return () => registry.delete(key);
      },
    },
    connection: { requestRejection },
  };
  apply(ctx);
  const registrations = [...registry.values()];

  const server = createServer((req, res) => {
    const url = new URL(req.url === undefined ? "/" : req.url, "http://127.0.0.1");
    const route = findRoute(registrations, url.pathname);
    if (route === undefined) {
      res.statusCode = 404;
      res.end("no route");
      return;
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  const base = "http://127.0.0.1:" + address.port;
  return { base, registrations, registrationKeys: [...registry.keys()], effects };
}

/**
 * Build a query string, encoding every value.
 *
 * @param {Record<string, string | number | undefined | null>} params
 * @returns {string}
 */
function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return "?" + search.toString();
}

/**
 * Issue one HTTP request and decode a JSON body when possible.
 *
 * @param {string} base
 * @param {string} method
 * @param {string} pathname
 * @param {{ body?: unknown, rawBody?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, json: any, text: string }>}
 */
async function request(base, method, pathname, options = {}) {
  const init = { method, headers: {} };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers["content-type"] = "application/json";
  }
  if (options.rawBody !== undefined) init.body = options.rawBody;
  if (options.headers !== undefined) Object.assign(init.headers, options.headers);
  const response = await fetch(base + pathname, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

/** @param {string} base @param {string} pathname */
const getJson = (base, pathname) => request(base, "GET", pathname);

/**
 * @param {string} base
 * @param {string} pathname
 * @param {unknown} body
 */
const postJson = (base, pathname, body) => request(base, "POST", pathname, { body });

/** @param {string} value */
const posix = (value) => value.replace(/\\/g, "/");

/**
 * Stable ordering helper: git sorts by path, but the assertions should not
 * depend on that detail.
 *
 * @param {Array<{ path: string }>} entries
 */
const byPath = (entries) => [...entries].sort((left, right) => left.path.localeCompare(right.path));

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("apply registers ten unique exact routes and the /git fallback", async (t) => {
  const harness = await createHarness(t);
  const exact = harness.registrations.filter((route) => route.kind === "exact");
  assert.equal(exact.length, 10);
  assert.deepEqual(exact.map((route) => route.path).sort(), [
    "/git/branches",
    "/git/checkout",
    "/git/commit",
    "/git/diff",
    "/git/health",
    "/git/log",
    "/git/stage",
    "/git/status",
    "/git/unstage",
    "/git/discard",
  ].sort());
  // Composition rule: every (kind, path) pair is registered exactly once, so
  // GET and POST /git/commit share a single registration.
  assert.equal(new Set(harness.registrationKeys).size, harness.registrationKeys.length);
  assert.equal(harness.registrationKeys.filter((key) => key === "exact /git/commit").length, 1);
  for (const route of harness.registrations) {
    assert.equal(typeof route.handler, "function");
  }
  assert.deepEqual(
    harness.registrations.filter((route) => route.kind === "prefix").map((route) => route.path),
    ["/git"],
  );
  assert.equal(harness.effects.length, 11);
  assert.ok(harness.effects.includes("git: GET /git/status"));
  assert.ok(harness.effects.includes("git: GET+POST /git/commit"));
  assert.ok(harness.effects.includes("git: fallback"));
});

test("GET /git/health reports the plugin and the git version", async (t) => {
  const harness = await createHarness(t);
  const response = await getJson(harness.base, "/git/health");
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.plugin, "dsh-git");
  assert.match(response.json.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof response.json.git, "string");
  assert.match(response.json.git, /^\d+\.\d+/);
});

test("unknown /git routes answer with a 404 JSON error", async (t) => {
  const harness = await createHarness(t);
  const response = await getJson(harness.base, "/git/nope");
  assert.equal(response.status, 404);
  assert.deepEqual(response.json.ok, false);
  assert.equal(response.json.code, "not-found");
  assert.match(response.json.message, /Unknown git route/);

  // The fallback accepts any method: HEAD/OPTIONS must not leak an HTML error.
  const head = await request(harness.base, "HEAD", "/git/nope");
  assert.equal(head.status, 404);
  assert.equal(head.text, "");
  const options = await request(harness.base, "OPTIONS", "/git/nope");
  assert.equal(options.status, 404);
  assert.equal(options.json.code, "not-found");
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("GET /git/status reports a clean repository", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  const response = await getJson(harness.base, "/git/status" + qs({ root: repo }));
  assert.equal(response.status, 200);
  const body = response.json;
  assert.equal(body.ok, true);
  assert.equal(body.isRepo, true);
  assert.equal(body.root, posix(repo));
  assert.equal(typeof body.toplevel, "string");
  assert.equal(path.basename(body.toplevel), path.basename(repo));
  assert.equal(body.branch.name, "main");
  assert.equal(body.branch.detached, false);
  assert.match(body.branch.sha, /^[0-9a-f]{40}$/);
  assert.equal(body.branch.shortSha, body.branch.sha.slice(0, 7));
  assert.equal(body.branch.upstream, null);
  assert.equal(body.branch.ahead, 0);
  assert.equal(body.branch.behind, 0);
  assert.deepEqual(body.staged, []);
  assert.deepEqual(body.unstaged, []);
  assert.deepEqual(body.untracked, []);
  assert.deepEqual(body.conflicted, []);
  assert.deepEqual(body.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
});

test("GET /git/status groups modified, untracked, staged and renamed entries", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  const endpoint = "/git/status" + qs({ root: repo });

  await writeFiles(repo, { "src/a.txt": "line1\nchanged\nline3\n", "notes.md": "# notes\n" });
  let body = (await getJson(harness.base, endpoint)).json;
  assert.deepEqual(byPath(body.unstaged), [{ path: "src/a.txt", origPath: null, status: "M" }]);
  assert.deepEqual(byPath(body.untracked), [{ path: "notes.md", origPath: null, status: "?" }]);
  assert.deepEqual(body.staged, []);
  assert.deepEqual(body.counts, { staged: 0, unstaged: 1, untracked: 1, conflicted: 0 });

  const staged = await postJson(harness.base, "/git/stage", { root: repo, paths: ["src/a.txt", "notes.md"] });
  assert.equal(staged.status, 200);
  assert.deepEqual(staged.json, { ok: true, staged: ["src/a.txt", "notes.md"] });

  body = (await getJson(harness.base, endpoint)).json;
  assert.deepEqual(byPath(body.staged), [
    { path: "notes.md", origPath: null, status: "A" },
    { path: "src/a.txt", origPath: null, status: "M" },
  ]);
  assert.deepEqual(body.unstaged, []);
  assert.deepEqual(body.untracked, []);
  assert.deepEqual(body.counts, { staged: 2, unstaged: 0, untracked: 0, conflicted: 0 });

  const unstaged = await postJson(harness.base, "/git/unstage", { root: repo, paths: ["notes.md"] });
  assert.equal(unstaged.status, 200);
  assert.deepEqual(unstaged.json, { ok: true });

  body = (await getJson(harness.base, endpoint)).json;
  assert.deepEqual(byPath(body.staged), [{ path: "src/a.txt", origPath: null, status: "M" }]);
  assert.deepEqual(byPath(body.untracked), [{ path: "notes.md", origPath: null, status: "?" }]);

  // A staged rename is reported with its original path.
  await gitRun(repo, ["mv", "src/b.txt", "src/c.txt"]);
  body = (await getJson(harness.base, endpoint)).json;
  const rename = body.staged.find((entry) => entry.path === "src/c.txt");
  assert.ok(rename !== undefined);
  assert.equal(rename.status, "R");
  assert.equal(rename.origPath, "src/b.txt");
  assert.equal(body.counts.staged, 2);
});

test("Chinese and space file names round-trip through status, diff and stage", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  const relativePath = "目录/文件 名.ts";

  await writeFiles(repo, { [relativePath]: "export const a = 1;\n" });

  let body = (await getJson(harness.base, "/git/status" + qs({ root: repo }))).json;
  assert.deepEqual(byPath(body.untracked), [{ path: relativePath, origPath: null, status: "?" }]);
  assert.equal(body.counts.untracked, 1);

  const untrackedDiff = await getJson(
    harness.base,
    "/git/diff" + qs({ root: repo, path: relativePath, mode: "untracked" }),
  );
  assert.equal(untrackedDiff.status, 200);
  assert.equal(untrackedDiff.json.path, relativePath);
  assert.equal(untrackedDiff.json.additions, 1);
  assert.equal(untrackedDiff.json.hunks[0].lines[0].text, "export const a = 1;");

  const staged = await postJson(harness.base, "/git/stage", { root: repo, paths: [relativePath] });
  assert.equal(staged.status, 200);
  assert.deepEqual(staged.json.staged, [relativePath]);

  body = (await getJson(harness.base, "/git/status" + qs({ root: repo }))).json;
  assert.deepEqual(byPath(body.staged), [{ path: relativePath, origPath: null, status: "A" }]);

  const stagedDiff = await getJson(harness.base, "/git/diff" + qs({ root: repo, path: relativePath, mode: "staged" }));
  assert.equal(stagedDiff.status, 200);
  assert.equal(stagedDiff.json.additions, 1);
  assert.equal(stagedDiff.json.hunks[0].lines[0].newLine, 1);
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test("GET /git/diff parses worktree, staged, untracked and commit modes", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  const diffUrl = (params) => "/git/diff" + qs(Object.assign({ root: repo }, params));

  await writeFiles(repo, { "src/a.txt": "line1\nline2 changed\nline3\nline4\n" });

  const worktree = await getJson(harness.base, diffUrl({ path: "src/a.txt", mode: "worktree" }));
  assert.equal(worktree.status, 200);
  const worktreeBody = worktree.json;
  assert.equal(worktreeBody.ok, true);
  assert.equal(worktreeBody.path, "src/a.txt");
  assert.equal(worktreeBody.mode, "worktree");
  assert.equal(worktreeBody.binary, false);
  assert.equal(worktreeBody.truncated, false);
  assert.equal(worktreeBody.additions, 2);
  assert.equal(worktreeBody.deletions, 1);
  assert.equal(worktreeBody.hunks.length, 1);
  const hunk = worktreeBody.hunks[0];
  assert.equal(hunk.header, "@@ -1,3 +1,4 @@");
  assert.deepEqual(
    { oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines },
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
  );
  assert.deepEqual(hunk.lines, [
    { type: "context", text: "line1", oldLine: 1, newLine: 1 },
    { type: "del", text: "line2", oldLine: 2, newLine: null },
    { type: "add", text: "line2 changed", oldLine: null, newLine: 2 },
    { type: "context", text: "line3", oldLine: 3, newLine: 3 },
    { type: "add", text: "line4", oldLine: null, newLine: 4 },
  ]);

  // Nothing staged yet.
  const emptyStaged = await getJson(harness.base, diffUrl({ path: "src/a.txt", mode: "staged" }));
  assert.equal(emptyStaged.status, 200);
  assert.deepEqual(emptyStaged.json.hunks, []);
  assert.equal(emptyStaged.json.additions, 0);
  assert.equal(emptyStaged.json.deletions, 0);

  await postJson(harness.base, "/git/stage", { root: repo, paths: ["src/a.txt"] });
  const staged = await getJson(harness.base, diffUrl({ path: "src/a.txt", mode: "staged" }));
  assert.equal(staged.json.additions, 2);
  assert.equal(staged.json.deletions, 1);
  const cleared = await getJson(harness.base, diffUrl({ path: "src/a.txt", mode: "worktree" }));
  assert.deepEqual(cleared.json.hunks, []);

  // Untracked: the whole file is one synthetic hunk.
  await writeFiles(repo, { "new file.txt": "alpha\nbeta\n" });
  const untracked = await getJson(harness.base, diffUrl({ path: "new file.txt", mode: "untracked" }));
  assert.equal(untracked.status, 200);
  assert.equal(untracked.json.additions, 2);
  assert.equal(untracked.json.deletions, 0);
  assert.equal(untracked.json.hunks.length, 1);
  assert.equal(untracked.json.hunks[0].oldStart, 0);
  assert.equal(untracked.json.hunks[0].oldLines, 0);
  assert.equal(untracked.json.hunks[0].newStart, 1);
  assert.deepEqual(
    untracked.json.hunks[0].lines,
    [
      { type: "add", text: "alpha", oldLine: null, newLine: 1 },
      { type: "add", text: "beta", oldLine: null, newLine: 2 },
    ],
  );

  // Untracked binary file.
  await fs.writeFile(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
  const binary = await getJson(harness.base, diffUrl({ path: "logo.png", mode: "untracked" }));
  assert.equal(binary.status, 200);
  assert.equal(binary.json.binary, true);
  assert.deepEqual(binary.json.hunks, []);

  // Commit mode: the initial commit added src/a.txt with three lines.
  const statusBody = (await getJson(harness.base, "/git/status" + qs({ root: repo }))).json;
  const headSha = statusBody.branch.sha;
  const commit = await getJson(harness.base, diffUrl({ path: "src/a.txt", mode: "commit", rev: headSha }));
  assert.equal(commit.status, 200);
  assert.equal(commit.json.mode, "commit");
  assert.equal(commit.json.additions, 3);
  assert.equal(commit.json.deletions, 0);
  assert.equal(commit.json.hunks.length, 1);

  const unknownRevision = await getJson(
    harness.base,
    diffUrl({ path: "src/a.txt", mode: "commit", rev: "0123456789abcdef0123456789abcdef01234567" }),
  );
  assert.equal(unknownRevision.status, 404);
  assert.equal(unknownRevision.json.code, "not-found");

  const unknownMode = await getJson(harness.base, diffUrl({ path: "src/a.txt", mode: "sideways" }));
  assert.equal(unknownMode.status, 400);
  assert.equal(unknownMode.json.code, "bad-request");
});

test("a tracked binary file is reported as binary in diffs and commit details", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);

  await fs.writeFile(path.join(repo, "asset.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const committed = await postJson(harness.base, "/git/commit", {
    root: repo,
    message: "feat: add binary asset",
    all: true,
  });
  assert.equal(committed.status, 200);

  await fs.writeFile(path.join(repo, "asset.bin"), Buffer.from([0x00, 0x09, 0x09, 0x09]));
  const diff = await getJson(harness.base, "/git/diff" + qs({ root: repo, path: "asset.bin", mode: "worktree" }));
  assert.equal(diff.status, 200);
  assert.equal(diff.json.binary, true);
  assert.deepEqual(diff.json.hunks, []);
  assert.equal(diff.json.additions, 0);

  const detail = await getJson(harness.base, "/git/commit" + qs({ root: repo, sha: committed.json.sha }));
  assert.equal(detail.status, 200);
  const file = detail.json.files.find((entry) => entry.path === "asset.bin");
  assert.ok(file !== undefined);
  assert.equal(file.binary, true);
  assert.equal(file.additions, null);
  assert.equal(file.deletions, null);
  assert.equal(file.status, "A");
});

// ---------------------------------------------------------------------------
// log + commit detail
// ---------------------------------------------------------------------------

test("GET /git/log paginates with hasMore", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  for (let index = 1; index <= 3; index += 1) {
    await writeFiles(repo, { ["notes-" + index + ".txt"]: "note " + index + "\n" });
    const committed = await postJson(harness.base, "/git/commit", {
      root: repo,
      message: "feat: note " + index,
      all: true,
    });
    assert.equal(committed.status, 200);
  }

  const first = await getJson(harness.base, "/git/log" + qs({ root: repo, limit: 2, skip: 0 }));
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.ref, "HEAD");
  assert.equal(first.json.commits.length, 2);
  assert.equal(first.json.hasMore, true);
  const head = first.json.commits[0];
  assert.match(head.sha, /^[0-9a-f]{40}$/);
  assert.equal(head.shortSha, head.sha.slice(0, 7));
  assert.equal(head.subject, "feat: note 3");
  assert.equal(head.author, "DSH Test");
  assert.equal(head.email, "dsh@example.com");
  assert.equal(typeof head.time, "number");
  assert.ok(head.time > 0);
  assert.deepEqual(head.refs, ["HEAD -> main"]);
  assert.equal(head.parents.length, 1);
  assert.match(head.parents[0], /^[0-9a-f]{40}$/);

  const second = await getJson(harness.base, "/git/log" + qs({ root: repo, limit: 2, skip: 2 }));
  assert.equal(second.json.commits.length, 2);
  assert.equal(second.json.hasMore, false);
  assert.equal(second.json.commits[0].subject, "feat: note 1");
  assert.equal(second.json.commits[1].subject, "chore: initial commit");

  const clamped = await getJson(harness.base, "/git/log" + qs({ root: repo, limit: 9999 }));
  assert.equal(clamped.status, 200);
  assert.equal(clamped.json.commits.length, 4);
  assert.equal(clamped.json.hasMore, false);
});

test("GET /git/commit returns metadata and per-file counters", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  await writeFiles(repo, { "src/a.txt": "line1\nline2\nline3\nline4\n", "docs/new.md": "hello\n" });
  await gitRun(repo, ["add", "-A"]);
  await gitRun(repo, ["commit", "-m", "feat: expand file", "-m", "body line one\nbody line two"]);
  const headSha = (await gitRun(repo, ["rev-parse", "HEAD"])).trim();

  const response = await getJson(harness.base, "/git/commit" + qs({ root: repo, sha: headSha }));
  assert.equal(response.status, 200);
  const detail = response.json;
  assert.equal(detail.ok, true);
  assert.equal(detail.commit.sha, headSha);
  assert.equal(detail.commit.shortSha, headSha.slice(0, 7));
  assert.equal(detail.commit.subject, "feat: expand file");
  assert.equal(detail.commit.body, "body line one\nbody line two");
  assert.equal(detail.commit.author, "DSH Test");
  assert.equal(detail.commit.email, "dsh@example.com");
  assert.deepEqual(detail.commit.refs, ["HEAD -> main"]);
  assert.equal(detail.commit.parents.length, 1);
  assert.equal(typeof detail.commit.time, "number");

  const files = new Map(detail.files.map((entry) => [entry.path, entry]));
  assert.deepEqual(files.get("src/a.txt"), {
    path: "src/a.txt",
    origPath: null,
    status: "M",
    additions: 1,
    deletions: 0,
    binary: false,
  });
  assert.deepEqual(files.get("docs/new.md"), {
    path: "docs/new.md",
    origPath: null,
    status: "A",
    additions: 1,
    deletions: 0,
    binary: false,
  });

  // An abbreviated sha resolves to the same commit.
  const abbreviated = await getJson(harness.base, "/git/commit" + qs({ root: repo, sha: headSha.slice(0, 8) }));
  assert.equal(abbreviated.status, 200);
  assert.equal(abbreviated.json.commit.sha, headSha);

  const unknown = await getJson(
    harness.base,
    "/git/commit" + qs({ root: repo, sha: "0123456789abcdef0123456789abcdef01234567" }),
  );
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, "not-found");
});

test("a rename inside a commit keeps path and origPath", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  await gitRun(repo, ["mv", "src/b.txt", "src/renamed.txt"]);
  await gitRun(repo, ["commit", "-m", "refactor: rename b"]);
  const headSha = (await gitRun(repo, ["rev-parse", "HEAD"])).trim();

  const detail = await getJson(harness.base, "/git/commit" + qs({ root: repo, sha: headSha }));
  assert.equal(detail.status, 200);
  const file = detail.json.files.find((entry) => entry.path === "src/renamed.txt");
  assert.ok(file !== undefined);
  assert.equal(file.status, "R");
  assert.equal(file.origPath, "src/b.txt");
  assert.equal(file.binary, false);
});

// ---------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------

test("GET /git/branches lists branches and POST /git/checkout switches", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  await gitRun(repo, ["branch", "dev"]);

  const response = await getJson(harness.base, "/git/branches" + qs({ root: repo }));
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.current, "main");
  assert.equal(response.json.detached, false);
  assert.equal(response.json.local.length, 2);
  const main = response.json.local.find((entry) => entry.name === "main");
  assert.deepEqual(
    { isCurrent: main.isCurrent, upstream: main.upstream, ahead: main.ahead, behind: main.behind },
    { isCurrent: true, upstream: null, ahead: 0, behind: 0 },
  );
  assert.match(main.sha, /^[0-9a-f]{40}$/);
  const dev = response.json.local.find((entry) => entry.name === "dev");
  assert.equal(dev.isCurrent, false);
  assert.deepEqual(response.json.remote, []);

  const checkout = await postJson(harness.base, "/git/checkout", { root: repo, branch: "dev" });
  assert.equal(checkout.status, 200);
  assert.deepEqual(checkout.json, { ok: true });
  const after = await getJson(harness.base, "/git/branches" + qs({ root: repo }));
  assert.equal(after.json.current, "dev");
  assert.equal(after.json.local.find((entry) => entry.name === "dev").isCurrent, true);

  const missing = await postJson(harness.base, "/git/checkout", { root: repo, branch: "no-such-branch" });
  assert.equal(missing.status, 422);
  assert.equal(missing.json.code, "git-failed");
  assert.match(missing.json.message, /no-such-branch/);
});

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

test("POST /git/commit validates the message, rejects empty commits and returns the sha", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);

  const blank = await postJson(harness.base, "/git/commit", { root: repo, message: "   \n\t" });
  assert.equal(blank.status, 400);
  assert.equal(blank.json.code, "bad-request");

  const missing = await postJson(harness.base, "/git/commit", { root: repo });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, "bad-request");

  const nothing = await postJson(harness.base, "/git/commit", { root: repo, message: "chore: noop" });
  assert.equal(nothing.status, 409);
  assert.equal(nothing.json.code, "conflict");

  await writeFiles(repo, { "src/a.txt": "line1\nline2\nline3 changed\n" });
  const committed = await postJson(harness.base, "/git/commit", {
    root: repo,
    message: "fix: change line 3",
    all: true,
  });
  assert.equal(committed.status, 200);
  assert.equal(committed.json.ok, true);
  assert.match(committed.json.sha, /^[0-9a-f]{40}$/);
  assert.equal(committed.json.shortSha, committed.json.sha.slice(0, 7));

  const status = (await getJson(harness.base, "/git/status" + qs({ root: repo }))).json;
  assert.deepEqual(status.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  assert.equal(status.branch.sha, committed.json.sha);

  const log = (await getJson(harness.base, "/git/log" + qs({ root: repo, limit: 1 }))).json;
  assert.equal(log.commits[0].sha, committed.json.sha);
  assert.equal(log.commits[0].subject, "fix: change line 3");
});

// ---------------------------------------------------------------------------
// stage / unstage / discard
// ---------------------------------------------------------------------------

test("POST /git/stage, /git/unstage and /git/discard mutate the work tree", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);
  const statusUrl = "/git/status" + qs({ root: repo });

  // Stage a modification (tracked) and an untracked file.
  await writeFiles(repo, { "src/a.txt": "line1\nchanged\nline3\n", "scratch.txt": "temp\n" });
  const staged = await postJson(harness.base, "/git/stage", { root: repo, paths: ["src/a.txt", "scratch.txt"] });
  assert.equal(staged.status, 200);
  assert.deepEqual(staged.json, { ok: true, staged: ["src/a.txt", "scratch.txt"] });
  let status = (await getJson(harness.base, statusUrl)).json;
  assert.deepEqual(byPath(status.staged), [
    { path: "scratch.txt", origPath: null, status: "A" },
    { path: "src/a.txt", origPath: null, status: "M" },
  ]);

  const unstaged = await postJson(harness.base, "/git/unstage", { root: repo, paths: ["scratch.txt"] });
  assert.equal(unstaged.status, 200);
  status = (await getJson(harness.base, statusUrl)).json;
  assert.deepEqual(byPath(status.untracked), [{ path: "scratch.txt", origPath: null, status: "?" }]);
  assert.deepEqual(byPath(status.staged), [{ path: "src/a.txt", origPath: null, status: "M" }]);

  // Unstage the tracked file so the discard below acts on a work tree change.
  const unstageTracked = await postJson(harness.base, "/git/unstage", { root: repo, paths: ["src/a.txt"] });
  assert.equal(unstageTracked.status, 200);
  status = (await getJson(harness.base, statusUrl)).json;
  assert.deepEqual(byPath(status.unstaged), [{ path: "src/a.txt", origPath: null, status: "M" }]);
  assert.deepEqual(status.staged, []);

  // Discard a tracked modification: the file returns to HEAD content.
  const discardTracked = await postJson(harness.base, "/git/discard", {
    root: repo,
    paths: ["src/a.txt"],
    confirm: true,
  });
  assert.equal(discardTracked.status, 200);
  assert.deepEqual(discardTracked.json, { ok: true });
  status = (await getJson(harness.base, statusUrl)).json;
  assert.deepEqual(status.counts, { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 });
  assert.equal(await fs.readFile(path.join(repo, "src", "a.txt"), "utf8"), "line1\nline2\nline3\n");

  // Discard an untracked file: it is removed from disk.
  const discardUntracked = await postJson(harness.base, "/git/discard", {
    root: repo,
    paths: ["scratch.txt"],
    confirm: true,
  });
  assert.equal(discardUntracked.status, 200);
  await assert.rejects(fs.stat(path.join(repo, "scratch.txt")), { code: "ENOENT" });
  status = (await getJson(harness.base, statusUrl)).json;
  assert.deepEqual(status.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });

  // Discarding a newly staged ("A") file clears the index entry and the file.
  await writeFiles(repo, { "fresh.txt": "brand new\n" });
  const stageNew = await postJson(harness.base, "/git/stage", { root: repo, paths: ["fresh.txt"] });
  assert.equal(stageNew.status, 200);
  status = (await getJson(harness.base, statusUrl)).json;
  assert.deepEqual(byPath(status.staged), [{ path: "fresh.txt", origPath: null, status: "A" }]);
  const discardNew = await postJson(harness.base, "/git/discard", {
    root: repo,
    paths: ["fresh.txt"],
    confirm: true,
  });
  assert.equal(discardNew.status, 200);
  await assert.rejects(fs.stat(path.join(repo, "fresh.txt")), { code: "ENOENT" });
  status = (await getJson(harness.base, statusUrl)).json;
  assert.deepEqual(status.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });

  // "confirm" is mandatory and empty path lists are rejected.
  const noConfirm = await postJson(harness.base, "/git/discard", { root: repo, paths: ["src/a.txt"] });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.json.code, "bad-request");
  const emptyPaths = await postJson(harness.base, "/git/stage", { root: repo, paths: [] });
  assert.equal(emptyPaths.status, 400);
  assert.equal(emptyPaths.json.code, "bad-request");
});

// ---------------------------------------------------------------------------
// Empty repository
// ---------------------------------------------------------------------------

test("an empty repository reports no HEAD but still answers status, log and branches", async (t) => {
  const repo = await createTempDir(t, "dsh-git-empty-");
  await initRepo(repo);
  const harness = await createHarness(t);

  const status = await getJson(harness.base, "/git/status" + qs({ root: repo }));
  assert.equal(status.status, 200);
  assert.equal(status.json.isRepo, true);
  assert.equal(status.json.branch.name, "main");
  assert.equal(status.json.branch.sha, null);
  assert.equal(status.json.branch.shortSha, null);
  assert.deepEqual(status.json.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });

  const log = await getJson(harness.base, "/git/log" + qs({ root: repo }));
  assert.equal(log.status, 200);
  assert.deepEqual(log.json, { ok: true, ref: "HEAD", hasMore: false, commits: [] });

  const branches = await getJson(harness.base, "/git/branches" + qs({ root: repo }));
  assert.equal(branches.status, 200);
  assert.equal(branches.json.current, "main");
  assert.equal(branches.json.detached, false);
  assert.deepEqual(branches.json.local, []);
  assert.deepEqual(branches.json.remote, []);

  // staging then unstaging falls back to "git rm --cached" without a HEAD.
  await writeFiles(repo, { "first.txt": "hello\n" });
  const staged = await postJson(harness.base, "/git/stage", { root: repo, paths: ["first.txt"] });
  assert.equal(staged.status, 200);
  const unstaged = await postJson(harness.base, "/git/unstage", { root: repo, paths: ["first.txt"] });
  assert.equal(unstaged.status, 200);
  const afterUnstage = (await getJson(harness.base, "/git/status" + qs({ root: repo }))).json;
  assert.deepEqual(byPath(afterUnstage.untracked), [{ path: "first.txt", origPath: null, status: "?" }]);

  // the very first commit can still be created
  const committed = await postJson(harness.base, "/git/commit", {
    root: repo,
    message: "feat: first commit",
    all: true,
  });
  assert.equal(committed.status, 200);
  assert.match(committed.json.sha, /^[0-9a-f]{40}$/);
  const afterCommit = (await getJson(harness.base, "/git/status" + qs({ root: repo }))).json;
  assert.equal(afterCommit.branch.sha, committed.json.sha);
  assert.equal(afterCommit.branch.name, "main");
});

// ---------------------------------------------------------------------------
// Error mapping, path safety and transport guards
// ---------------------------------------------------------------------------

test("a directory that is not a repository reports isRepo false and rejects writes", async (t) => {
  const directory = await createTempDir(t, "dsh-git-norepo-");
  const harness = await createHarness(t);

  const status = await getJson(harness.base, "/git/status" + qs({ root: directory }));
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { ok: true, isRepo: false, root: posix(directory), toplevel: null });

  const stage = await postJson(harness.base, "/git/stage", { root: directory, paths: ["a.txt"] });
  assert.equal(stage.status, 409);
  assert.equal(stage.json.code, "not-a-repo");

  const branches = await getJson(harness.base, "/git/branches" + qs({ root: directory }));
  assert.equal(branches.status, 409);
  assert.equal(branches.json.code, "not-a-repo");
});

test("path escapes and malformed bodies are rejected with contract codes", async (t) => {
  const repo = await createRepoWithCommit(t);
  const harness = await createHarness(t);

  const parentEscape = await postJson(harness.base, "/git/stage", { root: repo, paths: ["../outside.txt"] });
  assert.equal(parentEscape.status, 400);
  assert.equal(parentEscape.json.code, "invalid-path");

  const nestedEscape = await postJson(harness.base, "/git/stage", {
    root: repo,
    paths: ["src/../../outside.txt"],
  });
  assert.equal(nestedEscape.status, 400);
  assert.equal(nestedEscape.json.code, "invalid-path");

  const absolute = await postJson(harness.base, "/git/stage", {
    root: repo,
    paths: [path.join(repo, "src", "a.txt")],
  });
  assert.equal(absolute.status, 400);
  assert.equal(absolute.json.code, "invalid-path");

  const nul = await postJson(harness.base, "/git/stage", { root: repo, paths: ["src/\u0000a.txt"] });
  assert.equal(nul.status, 400);
  assert.equal(nul.json.code, "invalid-path");

  const diffEscape = await getJson(harness.base, "/git/diff" + qs({ root: repo, path: "../../etc/passwd" }));
  assert.equal(diffEscape.status, 400);
  assert.equal(diffEscape.json.code, "invalid-path");

  const relativeRoot = await getJson(harness.base, "/git/status" + qs({ root: "relative/dir" }));
  assert.equal(relativeRoot.status, 400);
  assert.equal(relativeRoot.json.code, "invalid-path");

  const missingRoot = await getJson(harness.base, "/git/status");
  assert.equal(missingRoot.status, 400);
  assert.equal(missingRoot.json.code, "bad-request");

  const absentRoot = await getJson(harness.base, "/git/status" + qs({ root: path.join(repo, "missing") }));
  assert.equal(absentRoot.status, 404);
  assert.equal(absentRoot.json.code, "not-found");

  const malformed = await request(harness.base, "POST", "/git/stage", {
    rawBody: "{not json",
    headers: { "content-type": "application/json" },
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, "bad-request");

  const wrongType = await request(harness.base, "POST", "/git/stage", {
    rawBody: JSON.stringify({ root: repo, paths: ["src/a.txt"] }),
    headers: { "content-type": "text/plain" },
  });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.json.ok, false);

  const notAnObject = await request(harness.base, "POST", "/git/stage", {
    rawBody: "[1,2,3]",
    headers: { "content-type": "application/json" },
  });
  assert.equal(notAnObject.status, 400);

  const wrongMethod = await request(harness.base, "POST", "/git/status" + qs({ root: repo }), {
    body: { root: repo },
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.ok, false);

  // The shared /git/commit route accepts GET and POST only.
  const putCommit = await request(harness.base, "PUT", "/git/commit", { body: { root: repo } });
  assert.equal(putCommit.status, 405);
  assert.equal(putCommit.json.ok, false);
  assert.equal(putCommit.headers.get("allow"), "GET, POST");
});

test("the connection fence rejects every /git route before any work happens", async (t) => {
  const forbidden = await createHarness(t, { requestRejection: () => 403 });
  const health = await getJson(forbidden.base, "/git/health");
  assert.equal(health.status, 403);
  assert.equal(health.text, "");
  const unknown = await getJson(forbidden.base, "/git/nope");
  assert.equal(unknown.status, 403);
  const stage = await postJson(forbidden.base, "/git/stage", { root: "D:/does-not-matter", paths: ["a.txt"] });
  assert.equal(stage.status, 403);

  const unauthenticated = await createHarness(t, { requestRejection: () => 401 });
  const status = await getJson(unauthenticated.base, "/git/status" + qs({ root: "D:/anything" }));
  assert.equal(status.status, 401);
});

// ---------------------------------------------------------------------------
// Parser units (pure functions from lib/git.js)
// ---------------------------------------------------------------------------

test("parseStatusPorcelainV2 handles renames, conflicts and ignored entries", () => {
  const raw = [
    "# branch.oid 5f2c1a9deadbeefdeadbeefdeadbeefdeadbeef00",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +1 -2",
    "1 M. N... 100644 100644 100644 aaaa bbbb src/a.ts",
    "1 .M N... 100644 100644 100644 aaaa bbbb 目录/文件 名.ts",
    "2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.ts",
    "old name.ts",
    "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.ts",
    "? untracked file.md",
    "! ignored.log",
    "",
  ].join("\u0000");
  const parsed = parseStatusPorcelainV2(raw);
  assert.deepEqual(parsed.branch, {
    name: "main",
    detached: false,
    sha: "5f2c1a9deadbeefdeadbeefdeadbeefdeadbeef00",
    shortSha: "5f2c1a9",
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
  });
  assert.deepEqual(parsed.staged, [
    { path: "src/a.ts", origPath: null, status: "M" },
    { path: "new name.ts", origPath: "old name.ts", status: "R" },
  ]);
  assert.deepEqual(parsed.unstaged, [{ path: "目录/文件 名.ts", origPath: null, status: "M" }]);
  assert.deepEqual(parsed.untracked, [{ path: "untracked file.md", origPath: null, status: "?" }]);
  assert.deepEqual(parsed.conflicted, [{ path: "conflict.ts", origPath: null, status: "U" }]);
  assert.deepEqual(parsed.counts, { staged: 2, unstaged: 1, untracked: 1, conflicted: 1 });
});

test("parseStatusPorcelainV2 degrades gracefully on an unborn branch", () => {
  const parsed = parseStatusPorcelainV2("# branch.oid (initial)\u0000# branch.head main\u0000");
  assert.equal(parsed.branch.sha, null);
  assert.equal(parsed.branch.shortSha, null);
  assert.equal(parsed.branch.name, "main");
  assert.equal(parsed.branch.detached, false);
  assert.deepEqual(parsed.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
});

test("parseUnifiedDiff ignores no-newline markers and detects binary diffs", () => {
  const diff = [
    "diff --git a/x.txt b/x.txt",
    "index 1111111..2222222 100644",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.binary, false);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.hunks.length, 1);
  assert.deepEqual(parsed.hunks[0].lines, [
    { type: "context", text: "keep", oldLine: 1, newLine: 1 },
    { type: "del", text: "old", oldLine: 2, newLine: null },
    { type: "add", text: "new", oldLine: null, newLine: 2 },
  ]);

  const binary = parseUnifiedDiff("diff --git a/b.bin b/b.bin\nBinary files a/b.bin and b/b.bin differ\n");
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.hunks, []);
  assert.equal(binary.additions, 0);

  const truncated = parseUnifiedDiff("@@ -1,1 +1,200 @@\n" + "+x\n".repeat(50), { maxLines: 10 });
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.additions <= 9);
});

test("parseUnifiedDiff never treats a quoted Binary files marker inside a hunk as binary", () => {
  // Regression: the marker regex used to be unanchored, so a text file whose
  // content spelled "Binary files ... differ" (diff viewers, fixtures, this
  // module's own regex) was reported as a binary diff with zero hunks.
  const diff = [
    "diff --git a/lib/view.js b/lib/view.js",
    "--- a/lib/view.js",
    "+++ b/lib/view.js",
    "@@ -1,1 +1,3 @@",
    " const marker = 1;",
    '+const hint = "Binary files a/x and b/y differ";',
    "+const other = 2;",
  ].join("\n");
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.binary, false, "quoted marker must not mark the diff binary");
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 0);
  // A real git marker still wins.
  assert.equal(parseUnifiedDiff("Binary files a/b.bin and b/b.bin differ\n").binary, true);
});

test("parseNumstat and parseNameStatus join per-file counters", () => {
  const numstat = "-\t-\tbin.dat\u00001\t1\tkeep.txt\u00001\t0\t\u0000a.txt\u0000renamed.txt\u0000";
  const nameStatus = "M\u0000bin.dat\u0000M\u0000keep.txt\u0000R073\u0000a.txt\u0000renamed.txt\u0000";
  const files = mergeCommitFiles(parseNumstat(numstat), parseNameStatus(nameStatus));
  assert.deepEqual(files, [
    { path: "bin.dat", origPath: null, status: "M", additions: null, deletions: null, binary: true },
    { path: "keep.txt", origPath: null, status: "M", additions: 1, deletions: 1, binary: false },
    { path: "renamed.txt", origPath: "a.txt", status: "R", additions: 1, deletions: 0, binary: false },
  ]);
});

test("buildUntrackedDiff synthesises one /dev/null hunk or a binary marker", () => {
  const text = buildUntrackedDiff(Buffer.from("alpha\nbeta\n"), "note.txt");
  assert.equal(text.binary, false);
  assert.equal(text.additions, 2);
  assert.equal(text.hunks[0].header, "@@ -0,0 +1,2 @@");
  assert.deepEqual(text.hunks[0].lines.map((line) => line.text), ["alpha", "beta"]);

  const empty = buildUntrackedDiff(Buffer.alloc(0), "empty.txt");
  assert.equal(empty.binary, false);
  assert.deepEqual(empty.hunks, []);

  const binary = buildUntrackedDiff(Buffer.from([0x00, 0x01, 0x02]), "blob.bin");
  assert.equal(binary.binary, true);
  assert.deepEqual(binary.hunks, []);
});
