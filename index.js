/**
 * Host half of the dsh-git bundle.
 *
 * Registers the "/git/*" HTTP routes consumed by the browser half (client.js).
 * Every route is guarded by the dsh connection fence
 * (ctx.connection.requestRejection), mutating routes are serialised through a
 * single promise queue and every failure is reported with the wire error codes
 * from docs/contract.md section 1.2.
 *
 * The git work itself lives in lib/git.js, which has no runtime dependency on
 * cordis so its parsers can be unit tested in isolation.
 */
import * as fs from "node:fs/promises";

import {
  GitError,
  LOG_LIMIT_DEFAULT,
  amendCommit,
  applyHunk,
  branchAction,
  checkoutBranch,
  commitStaged,
  discardPaths,
  gitVersion,
  readBranches,
  readCommit,
  readDiff,
  readLog,
  readStash,
  readStats,
  readStatus,
  resolveRepo,
  stagePaths,
  stashAction,
  unstagePaths,
} from "./lib/git.js";

export const name = "git";
export const inject = ["webServer", "connection"];

/** Shared route prefix (contract 1.1). */
const PREFIX = "/git";

/** Package name reported by GET /git/health. */
const PLUGIN_NAME = "dsh-git";

/** Hard cap for JSON request bodies: 64 KiB (contract 1.2). */
const MAX_BODY_BYTES = 64 * 1024;

/** POST /git/apply-hunk carries a patch, so its cap is 1 MiB (contract 1.5). */
const MAX_HUNK_BODY_BYTES = 1024 * 1024;

/** Wire error code -> HTTP status (contract 1.2). */
const STATUS_BY_CODE = Object.freeze({
  "bad-request": 400,
  "invalid-path": 400,
  "not-found": 404,
  "not-a-repo": 409,
  "git-failed": 422,
  conflict: 409,
  internal: 500,
});

/** Transport level failures that carry an explicit HTTP status. */
class HttpError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code wire error code
   * @param {string} message human readable message
   */
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Mutation queue: every POST route shares one promise chain so two writes never
// interleave (contract 1.2). A rejected task never poisons the chain.
// ---------------------------------------------------------------------------
let mutationChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueueMutation(task) {
  const result = mutationChain.then(() => task());
  mutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON response, tolerating an already ended response.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  if (res.writableEnded || res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * Map any thrown value to the contract wire error.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {unknown} error
 */
function sendError(res, error) {
  if (res.writableEnded) return;
  if (error instanceof HttpError) {
    sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
    return;
  }
  if (error instanceof GitError) {
    sendJson(res, STATUS_BY_CODE[error.code] || 500, error.toWire());
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { ok: false, code: "internal", message: message.slice(0, 500) });
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {URL}
 */
function parseRequestUrl(req) {
  try {
    return new URL(req.url === undefined ? "/" : req.url, "http://localhost");
  } catch {
    throw new HttpError(400, "bad-request", "Malformed request URL");
  }
}

/**
 * Consume (and discard) the remaining request body.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<void>}
 */
function drainRequest(req) {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", resolve);
    req.on("close", resolve);
    req.on("error", () => resolve());
  });
}

/**
 * Read and parse a JSON object body (contract 1.2).
 *
 * Enforces the body cap (64 KiB, or the caller supplied cap for the hunk patch
 * route, contract 1.5) and the application/json content type. The request
 * stream is always drained so even a rejected body gets its response.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {number} [maxBytes] body cap, defaults to MAX_BODY_BYTES
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const contentType = String(req.headers["content-type"] === undefined ? "" : req.headers["content-type"]).trim();
  const hasJsonContentType = /^application\/json(?:\s*;|$)/i.test(contentType);
  const declaredLength = Number(req.headers["content-length"]);
  const chunks = [];
  let total = 0;
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > maxBytes;
  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      total += chunk.length;
      if (tooLarge) return;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (hasJsonContentType) chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
  if (tooLarge) throw new HttpError(413, "bad-request", "Request body exceeds " + maxBytes + " bytes");
  if (!hasJsonContentType) {
    throw new HttpError(415, "bad-request", 'Content-Type must be "application/json"');
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw new GitError("bad-request", "Request body must be a JSON object");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GitError("bad-request", "Request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GitError("bad-request", "Request body must be a JSON object");
  }
  return parsed;
}

/**
 * @param {URL} url
 * @param {string} field
 * @returns {string}
 */
function requireQuery(url, field) {
  const value = url.searchParams.get(field);
  if (value === null || value === "") {
    throw new GitError("bad-request", 'Missing query parameter "' + field + '"');
  }
  return value;
}

/**
 * Resolve "root" and require a git work tree (mutating and non-status routes).
 *
 * GET /git/status deliberately does not use this: it reports isRepo false
 * instead of failing (contract 1.3).
 *
 * @param {unknown} rawRoot
 * @returns {Promise<{ root: string, toplevel: string, isRepo: boolean }>}
 */
async function requireRepo(rawRoot) {
  const target = await resolveRepo(rawRoot);
  if (!target.isRepo) throw new GitError("not-a-repo", "Not a git repository: " + target.root);
  return target;
}

/** Cached package version for GET /git/health. */
let cachedVersion = null;

/**
 * Plugin version reported by GET /git/health.
 *
 * @returns {Promise<string>}
 */
async function pluginVersion() {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const text = await fs.readFile(new URL("./package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(text);
    cachedVersion = typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

// ---------------------------------------------------------------------------
// Read-only routes (never queued)
// ---------------------------------------------------------------------------

/**
 * GET /git/status - working tree summary (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleStatus(req, res) {
  const url = parseRequestUrl(req);
  const target = await resolveRepo(requireQuery(url, "root"));
  if (!target.isRepo) {
    sendJson(res, 200, { ok: true, isRepo: false, root: target.root, toplevel: null });
    return;
  }
  const status = await readStatus(target.toplevel);
  sendJson(res, 200, {
    ok: true,
    isRepo: true,
    root: target.root,
    toplevel: target.toplevel,
    branch: status.branch,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
    conflicted: status.conflicted,
    counts: status.counts,
  });
}

/**
 * GET /git/diff - one file's unified diff (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleDiff(req, res) {
  const url = parseRequestUrl(req);
  const target = await requireRepo(requireQuery(url, "root"));
  const mode = url.searchParams.get("mode");
  const rev = url.searchParams.get("rev");
  const diff = await readDiff(target.toplevel, {
    path: requireQuery(url, "path"),
    mode: mode === null ? "worktree" : mode,
    rev: rev === null ? undefined : rev,
  });
  sendJson(res, 200, {
    ok: true,
    path: diff.path,
    mode: diff.mode,
    binary: diff.binary,
    truncated: diff.truncated,
    additions: diff.additions,
    deletions: diff.deletions,
    hunks: diff.hunks,
  });
}

/**
 * GET /git/stats - batch line counters for the whole work tree (contract 1.5).
 *
 * A read-only route, so it is never queued.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleStats(req, res) {
  const url = parseRequestUrl(req);
  const target = await requireRepo(requireQuery(url, "root"));
  const stats = await readStats(target.toplevel);
  sendJson(res, 200, { ok: true, staged: stats.staged, unstaged: stats.unstaged });
}

/**
 * GET /git/stash - list stash entries (contract 1.5).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleStashList(req, res) {
  const url = parseRequestUrl(req);
  const target = await requireRepo(requireQuery(url, "root"));
  const stash = await readStash(target.toplevel);
  sendJson(res, 200, { ok: true, entries: stash.entries });
}

/**
 * GET /git/log - one page of history (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleLog(req, res) {
  const url = parseRequestUrl(req);
  const target = await requireRepo(requireQuery(url, "root"));
  const ref = url.searchParams.get("ref");
  const limit = url.searchParams.get("limit");
  const skip = url.searchParams.get("skip");
  // Optional filters added by contract 1.5; absent parameters stay undefined so
  // lib/git.js can tell "no filter" from a malformed empty value.
  const grep = url.searchParams.get("grep");
  const author = url.searchParams.get("author");
  const filterPath = url.searchParams.get("path");
  // Optional date range added by "日志查询支持日期范围"; absent parameters stay
  // undefined so lib/git.js can tell "no bound" from a malformed empty value.
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const page = await readLog(target.toplevel, {
    ref: ref === null ? "HEAD" : ref,
    limit: limit === null ? LOG_LIMIT_DEFAULT : limit,
    skip: skip === null ? 0 : skip,
    grep: grep === null ? undefined : grep,
    author: author === null ? undefined : author,
    path: filterPath === null ? undefined : filterPath,
    since: since === null ? undefined : since,
    until: until === null ? undefined : until,
  });
  sendJson(res, 200, { ok: true, ref: page.ref, hasMore: page.hasMore, commits: page.commits });
}

/**
 * GET /git/commit - one commit plus its changed files (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleCommit(req, res) {
  const url = parseRequestUrl(req);
  const target = await requireRepo(requireQuery(url, "root"));
  const detail = await readCommit(target.toplevel, requireQuery(url, "sha"));
  sendJson(res, 200, { ok: true, commit: detail.commit, files: detail.files });
}

/**
 * GET /git/branches - local and remote branches (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleBranches(req, res) {
  const url = parseRequestUrl(req);
  const target = await requireRepo(requireQuery(url, "root"));
  const branches = await readBranches(target.toplevel);
  sendJson(res, 200, {
    ok: true,
    current: branches.current,
    detached: branches.detached,
    local: branches.local,
    remote: branches.remote,
  });
}

/**
 * GET /git/health - installation self check (contract 1.3).
 *
 * Always answers 200 with ok:true; a missing git binary only nulls the "git"
 * field so the client can render a clear diagnostic instead of a hard error.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleHealth(req, res) {
  await drainRequest(req);
  const [version, git] = await Promise.all([pluginVersion(), gitVersion()]);
  sendJson(res, 200, { ok: true, plugin: PLUGIN_NAME, version, git });
}

// ---------------------------------------------------------------------------
// Mutating routes (serialised through the queue)
// ---------------------------------------------------------------------------

/**
 * POST /git/stage (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleStage(req, res) {
  const body = await readJsonBody(req);
  const target = await requireRepo(body.root);
  const staged = await enqueueMutation(() => stagePaths(target.toplevel, body.paths));
  sendJson(res, 200, { ok: true, staged });
}

/**
 * POST /git/unstage (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleUnstage(req, res) {
  const body = await readJsonBody(req);
  const target = await requireRepo(body.root);
  await enqueueMutation(() => unstagePaths(target.toplevel, body.paths));
  sendJson(res, 200, { ok: true });
}

/**
 * POST /git/discard (contract 1.3). Requires "confirm: true".
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleDiscard(req, res) {
  const body = await readJsonBody(req);
  if (body.confirm !== true) throw new GitError("bad-request", '"confirm" must be true');
  const target = await requireRepo(body.root);
  await enqueueMutation(() => discardPaths(target.toplevel, body.paths));
  sendJson(res, 200, { ok: true });
}

/**
 * POST /git/commit (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleCreateCommit(req, res) {
  const body = await readJsonBody(req);
  const target = await requireRepo(body.root);
  const result = await enqueueMutation(() =>
    commitStaged(target.toplevel, { message: body.message, all: body.all === true }),
  );
  sendJson(res, 200, { ok: true, sha: result.sha, shortSha: result.shortSha });
}

/**
 * POST /git/checkout (contract 1.3).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleCheckout(req, res) {
  const body = await readJsonBody(req);
  const target = await requireRepo(body.root);
  await enqueueMutation(() => checkoutBranch(target.toplevel, body.branch));
  sendJson(res, 200, { ok: true });
}

/**
 * POST /git/apply-hunk - stage or unstage one hunk (contract 1.5).
 *
 * The body carries a patch, so this is the one route with the 1 MiB cap.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleApplyHunk(req, res) {
  const body = await readJsonBody(req, MAX_HUNK_BODY_BYTES);
  const target = await requireRepo(body.root);
  await enqueueMutation(() => applyHunk(target.toplevel, body));
  sendJson(res, 200, { ok: true });
}

/**
 * POST /git/amend - rewrite the last commit (contract 1.5).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleAmend(req, res) {
  const body = await readJsonBody(req);
  const target = await requireRepo(body.root);
  const result = await enqueueMutation(() => amendCommit(target.toplevel, body));
  sendJson(res, 200, { ok: true, sha: result.sha, shortSha: result.shortSha });
}

/**
 * POST /git/branches - create, delete or rename a branch (contract 1.5).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleBranchAction(req, res) {
  const body = await readJsonBody(req);
  const target = await requireRepo(body.root);
  const branch = await enqueueMutation(() => branchAction(target.toplevel, body));
  sendJson(res, 200, { ok: true, name: branch.name });
}

/**
 * POST /git/stash - create, apply, pop or drop a stash entry (contract 1.5).
 *
 * "drop" throws away work, so it needs the same explicit "confirm: true" as
 * discardPaths (contract 1.5).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleStashMutation(req, res) {
  const body = await readJsonBody(req);
  if (body.action === "drop" && body.confirm !== true) {
    throw new GitError("bad-request", '"confirm" must be true to drop a stash entry');
  }
  const target = await requireRepo(body.root);
  const stash = await enqueueMutation(() => stashAction(target.toplevel, body));
  sendJson(res, 200, { ok: true, entries: stash.entries });
}

/**
 * Shared handler for "/git/branches".
 *
 * The DSH web server rejects two routes that share the same (kind, path) pair,
 * so the list (GET) and the create/delete/rename (POST) forms are served by one
 * exact registration that dispatches on the request method (contract 1.5).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleBranchesRoute(req, res) {
  if (req.method === "GET") {
    await handleBranches(req, res);
    return;
  }
  if (req.method === "POST") {
    await handleBranchAction(req, res);
    return;
  }
  await drainRequest(req);
  res.setHeader("allow", "GET, POST");
  sendJson(res, 405, {
    ok: false,
    code: "bad-request",
    message: "Method " + String(req.method) + " is not allowed",
  });
}

/**
 * Shared handler for "/git/stash".
 *
 * One registration serves GET (list) and POST (create/apply/pop/drop), for the
 * same composition reason as "/git/commit" and "/git/branches" (contract 1.5).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleStashRoute(req, res) {
  if (req.method === "GET") {
    await handleStashList(req, res);
    return;
  }
  if (req.method === "POST") {
    await handleStashMutation(req, res);
    return;
  }
  await drainRequest(req);
  res.setHeader("allow", "GET, POST");
  sendJson(res, 405, {
    ok: false,
    code: "bad-request",
    message: "Method " + String(req.method) + " is not allowed",
  });
}

/**
 * Shared handler for "/git/commit".
 *
 * The DSH web server rejects two routes that share the same (kind, path) pair,
 * so the read (GET ?sha=) and write (POST) forms of this endpoint are served by
 * one exact registration that dispatches on the request method. Both keep the
 * JSON shapes from contract 1.3.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleCommitRoute(req, res) {
  if (req.method === "GET") {
    await handleCommit(req, res);
    return;
  }
  if (req.method === "POST") {
    await handleCreateCommit(req, res);
    return;
  }
  await drainRequest(req);
  res.setHeader("allow", "GET, POST");
  sendJson(res, 405, {
    ok: false,
    code: "bad-request",
    message: "Method " + String(req.method) + " is not allowed",
  });
}

/**
 * Fallback for unknown "/git/*" routes.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handleUnknown(req, res) {
  await drainRequest(req);
  const url = parseRequestUrl(req);
  sendJson(res, 404, {
    ok: false,
    code: "not-found",
    message: "Unknown git route: " + String(req.method === undefined ? "?" : req.method) + " " + url.pathname,
  });
}

// ---------------------------------------------------------------------------
// Route table + registration
// ---------------------------------------------------------------------------
const ROUTES = Object.freeze([
  { method: "GET", path: PREFIX + "/status", handler: handleStatus },
  { method: "GET", path: PREFIX + "/stats", handler: handleStats },
  { method: "GET", path: PREFIX + "/diff", handler: handleDiff },
  { method: "GET", path: PREFIX + "/log", handler: handleLog },
  // GET and POST share one registration: duplicate (kind, path) pairs are a
  // composition error in the DSH web server, so these handlers dispatch
  // themselves on req.method.
  { method: null, path: PREFIX + "/commit", handler: handleCommitRoute },
  { method: null, path: PREFIX + "/branches", handler: handleBranchesRoute },
  { method: null, path: PREFIX + "/stash", handler: handleStashRoute },
  { method: "GET", path: PREFIX + "/health", handler: handleHealth },
  { method: "POST", path: PREFIX + "/stage", handler: handleStage },
  { method: "POST", path: PREFIX + "/unstage", handler: handleUnstage },
  { method: "POST", path: PREFIX + "/discard", handler: handleDiscard },
  { method: "POST", path: PREFIX + "/checkout", handler: handleCheckout },
  { method: "POST", path: PREFIX + "/apply-hunk", handler: handleApplyHunk },
  { method: "POST", path: PREFIX + "/amend", handler: handleAmend },
]);

/**
 * Wrap a handler with the connection fence, the method guard and a top level
 * try/catch (contract 1.1).
 *
 * @param {any} ctx plugin context
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>} handler
 * @param {string | null} method allowed HTTP method, or null to accept any
 */
function wrapHandler(ctx, handler, method) {
  return async (req, res) => {
    // Connection fence: always the very first thing a handler does.
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (method !== null && req.method !== method) {
      await drainRequest(req);
      res.setHeader("allow", method);
      sendJson(res, 405, { ok: false, code: "bad-request", message: "Method " + String(req.method) + " is not allowed" });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

/**
 * Register the dsh-git host routes.
 *
 * @param {any} ctx cordis plugin context ("webServer" + "connection" injected)
 * @param {unknown} [_config]
 */
export function apply(ctx, _config) {
  for (const route of ROUTES) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "exact",
          path: route.path,
          handler: wrapHandler(ctx, route.handler, route.method),
        }),
      "git: " + (route.method === null ? "GET+POST" : route.method) + " " + route.path,
    );
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: "prefix", path: PREFIX, handler: wrapHandler(ctx, handleUnknown, null) }),
    "git: fallback",
  );
}
