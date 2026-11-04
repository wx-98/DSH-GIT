/**
 * Git CLI wrapper and output parsers for the dsh-git host half.
 *
 * This module deliberately has no cordis/DSH imports: index.js owns the HTTP
 * transport (connection fence, request parsing, mutation queue, status codes)
 * while this module owns git command invocation, repository relative path
 * safety and every stdout parser. All parsers are pure functions and are
 * exported so they can be exercised directly by the test suite.
 *
 * Interface contract: docs/contract.md section 1 (Host HTTP contract).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Wall clock budget for a single git command (contract 1.2). */
export const GIT_TIMEOUT_MS = 15000;

/** Hard cap for a single git command's stdout/stderr. */
export const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Global git options applied to every invocation, in contract order.
 *
 * "--no-optional-locks" keeps read commands from refreshing the index, so a
 * background status poll never races a foreground write. It is a global option
 * and must therefore stay in front of the subcommand.
 */
export const GIT_COMMON_ARGS = Object.freeze([
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "--no-optional-locks",
]);

/** Unified diff lines kept in one response (contract 1.3: "truncated"). */
export const MAX_DIFF_LINES = 4000;

/** Bytes read from an untracked file when synthesising its diff. */
export const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/** Diff modes accepted by GET /git/diff. */
export const DIFF_MODES = Object.freeze(["worktree", "staged", "untracked", "commit"]);

/** Default "limit" for GET /git/log. */
export const LOG_LIMIT_DEFAULT = 50;

/** Upper bound for "limit" (contract 1.3). */
export const LOG_LIMIT_MAX = 200;

/** Longest error message forwarded to the browser (contract 1.2). */
const MAX_MESSAGE_LENGTH = 500;

/** Bytes inspected when deciding whether a buffer is binary. */
const BINARY_PROBE_BYTES = 8000;

/** Known binary extensions, used in addition to the NUL byte probe. */
const BINARY_EXTENSIONS = new Set([
  ".7z", ".avi", ".bmp", ".bz2", ".class", ".db", ".dll", ".doc", ".docx",
  ".dylib", ".eot", ".exe", ".flac", ".gif", ".gz", ".ico", ".jar", ".jpeg",
  ".jpg", ".m4a", ".mov", ".mp3", ".mp4", ".node", ".ogg", ".otf", ".pdf",
  ".png", ".ppt", ".pptx", ".psd", ".rar", ".so", ".sqlite", ".tar", ".tgz",
  ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".xz",
  ".zip",
]);

/**
 * Failure raised by this module.
 *
 * The "code" is the wire level error code from contract 1.2; index.js maps it
 * to the HTTP status. Anything unexpected becomes "internal".
 */
export class GitError extends Error {
  /**
   * @param {string} code wire error code
   * @param {string} message human readable message (already truncated)
   * @param {{ stderr?: string, exitCode?: number | null }} [options]
   */
  constructor(code, message, options = {}) {
    super(typeof message === "string" && message !== "" ? message : code);
    this.name = "GitError";
    this.code = typeof code === "string" && code !== "" ? code : "internal";
    this.stderr = typeof options.stderr === "string" ? options.stderr : "";
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  }

  /** Serialise to the { ok: false, code, message } wire shape. */
  toWire() {
    return { ok: false, code: this.code, message: this.message };
  }
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * First meaningful stderr line, truncated for the wire (contract 1.2).
 *
 * @param {unknown} stderr
 * @returns {string}
 */
export function stderrSummary(stderr) {
  const text = String(stderr === null || stderr === undefined ? "" : stderr).replace(/\r\n/g, "\n");
  let line = "";
  for (const entry of text.split("\n")) {
    const trimmed = entry.trim();
    if (trimmed !== "") {
      line = trimmed;
      break;
    }
  }
  return line.slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Map a finished git process to a git-failed error.
 *
 * @param {readonly string[]} args
 * @param {{ status: number, stderr: string }} result
 * @returns {GitError}
 */
function gitFailure(args, result) {
  const summary = stderrSummary(result.stderr) || "git " + String(args[0] || "") + " exited with code " + result.status;
  return new GitError("git-failed", summary, { stderr: result.stderr, exitCode: result.status });
}

/**
 * Run git without ever building a shell command line.
 *
 * Resolves for every ordinary exit status; rejects only when the process could
 * not be started at all (missing git binary) or exceeded the timeout, because
 * those are host problems rather than git results.
 *
 * @param {readonly string[]} args arguments after the global options
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export function runGit(args, options = {}) {
  const cwd = options.cwd;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : GIT_TIMEOUT_MS;
  const argv = [...GIT_COMMON_ARGS, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      argv,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: "buffer",
      },
      (error, stdout, stderr) => {
        // Buffers only: Windows console code pages must never influence the
        // bytes we parse. Decoding happens exactly once, as UTF-8.
        const out = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout || "");
        const err = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr || "");
        if (error !== null && error !== undefined) {
          if (typeof error.code === "string") {
            reject(
              new GitError("internal", "Failed to run git: " + String(error.message).slice(0, MAX_MESSAGE_LENGTH), {
                stderr: err,
              }),
            );
            return;
          }
          if (error.killed === true || error.signal) {
            reject(
              new GitError("internal", "git " + String(args[0] || "") + " timed out after " + timeoutMs + " ms", {
                stderr: err,
              }),
            );
            return;
          }
        }
        const status = error === null || error === undefined ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ status, stdout: out, stderr: err });
      },
    );
  });
}

/**
 * Run git and resolve the result when the command succeeded.
 *
 * @param {readonly string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export async function runGitChecked(args, options = {}) {
  const result = await runGit(args, options);
  if (result.status !== 0) throw gitFailure(args, result);
  return result;
}

/**
 * Resolve the "git --version" version token ("2.54.0.windows.1"), or null
 * when the git binary is unavailable (contract 1.3 GET /git/health).
 *
 * @returns {Promise<string | null>}
 */
export async function gitVersion() {
  try {
    const result = await runGit(["--version"], { timeoutMs: 5000 });
    if (result.status !== 0) return null;
    const match = /git version ([^\s]+)/.exec(result.stdout);
    return match === null ? null : match[1];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path helpers (contract 1.4)
// ---------------------------------------------------------------------------

/**
 * Convert a native path to the forward slash form used on the wire.
 *
 * @param {string} value
 * @returns {string}
 */
export function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

/**
 * Assert that a value is an absolute filesystem path and normalise it.
 *
 * @param {unknown} value
 * @param {string} [field] field name used in the error message
 * @returns {string} path.resolve normalised absolute path
 */
export function assertAbsolutePath(value, field = "root") {
  if (typeof value !== "string") {
    throw new GitError("bad-request", '"' + field + '" must be an absolute path string');
  }
  if (value === "" || value.includes("\u0000") || !path.isAbsolute(value)) {
    throw new GitError("invalid-path", '"' + field + '" must be an absolute path');
  }
  return path.resolve(value);
}

/**
 * Validate one repository relative path (contract 1.4).
 *
 * Rejects absolute paths, NUL bytes, ".." segments and empty results. Both
 * separators are accepted because Windows clients may send either form; the
 * normalised result is always POSIX with forward slashes.
 *
 * @param {unknown} value
 * @param {string} [field] field name used in the error message
 * @returns {string} normalised repository relative path
 */
export function normalizeRepoPath(value, field = "path") {
  if (typeof value !== "string") {
    throw new GitError("bad-request", '"' + field + '" must be a repository relative path string');
  }
  if (value.includes("\u0000")) {
    throw new GitError("invalid-path", '"' + field + '" must not contain NUL bytes');
  }
  const posix = value.replace(/\\/g, "/");
  if (path.isAbsolute(value) || posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw new GitError("invalid-path", '"' + field + '" must be a repository relative path: ' + JSON.stringify(value));
  }
  const segments = [];
  for (const segment of posix.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new GitError("invalid-path", '"' + field + '" must not contain ".." segments: ' + JSON.stringify(value));
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new GitError("invalid-path", '"' + field + '" must not be empty');
  }
  return segments.join("/");
}

/**
 * Normalise a non-empty array of repository relative paths.
 *
 * @param {unknown} values
 * @param {string} [field]
 * @returns {string[]}
 */
export function normalizeRepoPaths(values, field = "paths") {
  if (!Array.isArray(values) || values.length === 0) {
    throw new GitError("bad-request", '"' + field + '" must be a non-empty array of repository relative paths');
  }
  return values.map((value, index) => normalizeRepoPath(value, field + "[" + index + "]"));
}

/**
 * Join a repository relative path onto the work tree root and verify that the
 * result is still inside the work tree (defence in depth, contract 1.4).
 *
 * @param {string} toplevel absolute work tree root
 * @param {string} relativePath an already normalised repository relative path
 * @returns {string} absolute path inside the work tree
 */
export function resolveRepoPath(toplevel, relativePath) {
  const base = path.resolve(toplevel);
  const absolute = path.resolve(base, ...relativePath.split("/"));
  const relative = path.relative(base, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GitError("invalid-path", "Path escapes the repository: " + relativePath);
  }
  return absolute;
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the request root to an existing directory.
 *
 * @param {unknown} rawRoot
 * @returns {Promise<string>} normalised absolute directory
 */
export async function resolveRootDirectory(rawRoot) {
  const root = assertAbsolutePath(rawRoot, "root");
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT") throw new GitError("not-found", "Directory not found: " + toPosix(root));
    throw new GitError("invalid-path", "Cannot access root: " + toPosix(root));
  }
  if (!stat.isDirectory()) {
    throw new GitError("invalid-path", "Root is not a directory: " + toPosix(root));
  }
  return root;
}

/**
 * Resolve the git work tree that contains "root".
 *
 * @param {unknown} rawRoot absolute directory supplied by the caller
 * @returns {Promise<{ root: string, toplevel: string | null, isRepo: boolean }>}
 *   "root" is the normalised request path (forward slashes), "toplevel" the
 *   work tree root reported by git, or null when the directory is not a repo.
 */
export async function resolveRepo(rawRoot) {
  const root = await resolveRootDirectory(rawRoot);
  const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: root });
  if (result.status === 0) {
    const toplevel = toPosix(result.stdout.trim());
    if (toplevel !== "") return { root: toPosix(root), toplevel, isRepo: true };
  }
  if (/not a git repository|must be run in a work tree|not a git dir/i.test(result.stderr)) {
    return { root: toPosix(root), toplevel: null, isRepo: false };
  }
  throw gitFailure(["rev-parse", "--show-toplevel"], result);
}

/**
 * True when the repository has at least one commit reachable from HEAD.
 *
 * @param {string} toplevel
 * @returns {Promise<boolean>}
 */
export async function hasCommit(toplevel) {
  const result = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: toplevel });
  return result.status === 0 && result.stdout.trim() !== "";
}

/**
 * Current branch name plus detached state.
 *
 * @param {string} toplevel
 * @returns {Promise<{ name: string, detached: boolean }>}
 */
export async function readCurrentBranch(toplevel) {
  const symbolic = await runGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: toplevel });
  if (symbolic.status === 0) {
    const name = symbolic.stdout.trim();
    if (name !== "") return { name, detached: false };
  }
  return { name: "HEAD", detached: true };
}

// ---------------------------------------------------------------------------
// status --porcelain=v2 (contract 1.3)
// ---------------------------------------------------------------------------

/**
 * Parse "git status --porcelain=v2 --branch -z" output.
 *
 * Record grammar (git-status(1), porcelain v2 with NUL separators):
 *   "# branch.oid|head|upstream|ab ..."
 *   "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
 *   "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>" NUL "<origPath>"
 *   "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
 *   "? <path>"
 *   "! <path>"
 *
 * With "-z" a rename record keeps the new path in the record body and carries
 * the old path in the following NUL separated token.
 *
 * @param {string} text raw stdout
 * @returns {{
 *   branch: { name: string, detached: boolean, sha: string | null, shortSha: string | null, upstream: string | null, ahead: number, behind: number },
 *   staged: Array<{ path: string, origPath: string | null, status: string }>,
 *   unstaged: Array<{ path: string, origPath: string | null, status: string }>,
 *   untracked: Array<{ path: string, origPath: string | null, status: string }>,
 *   conflicted: Array<{ path: string, origPath: string | null, status: string }>,
 *   counts: { staged: number, unstaged: number, untracked: number, conflicted: number },
 * }}
 */
export function parseStatusPorcelainV2(text) {
  const records = String(text === null || text === undefined ? "" : text).split("\u0000");
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];
  let headName = null;
  let oid = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;

  /**
   * Split one XY code into its index (X) and work tree (Y) halves.
   *
   * @param {string} xy
   * @param {string} pathname
   * @param {string | null} origPath
   */
  const pushChanged = (xy, pathname, origPath) => {
    const x = xy[0] === undefined ? "." : xy[0];
    const y = xy[1] === undefined ? "." : xy[1];
    if (x !== ".") staged.push({ path: pathname, origPath, status: x });
    if (y !== ".") unstaged.push({ path: pathname, origPath, status: y });
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === "") continue;

    if (record.startsWith("# ")) {
      const header = record.slice(2);
      if (header.startsWith("branch.oid ")) {
        const value = header.slice("branch.oid ".length).trim();
        oid = value === "" || value === "(initial)" ? null : value;
      } else if (header.startsWith("branch.head ")) {
        headName = header.slice("branch.head ".length).trim();
      } else if (header.startsWith("branch.upstream ")) {
        const value = header.slice("branch.upstream ".length).trim();
        upstream = value === "" ? null : value;
      } else if (header.startsWith("branch.ab ")) {
        const match = /^branch\.ab \+(\d+) -(\d+)$/.exec(header);
        if (match !== null) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }

    const kind = record[0];
    if (kind === "1" && record[1] === " ") {
      const parts = record.split(" ");
      // "1" + XY + sub + mH + mI + mW + hH + hI precede the path.
      if (parts.length >= 9) pushChanged(parts[1], parts.slice(8).join(" "), null);
      continue;
    }
    if (kind === "2" && record[1] === " ") {
      const parts = record.split(" ");
      // "2" + XY + sub + mH + mI + mW + hH + hI + <X><score> precede the path.
      const pathname = parts.length >= 10 ? parts.slice(9).join(" ") : "";
      const origPath = records[index + 1] === undefined ? "" : records[index + 1];
      index += 1;
      if (pathname !== "") pushChanged(parts[1], pathname, origPath === "" ? null : origPath);
      continue;
    }
    if (kind === "u" && record[1] === " ") {
      const parts = record.split(" ");
      const pathname = parts.length >= 11 ? parts.slice(10).join(" ") : "";
      if (pathname !== "") conflicted.push({ path: pathname, origPath: null, status: "U" });
      continue;
    }
    if (kind === "?" && record[1] === " ") {
      untracked.push({ path: record.slice(2), origPath: null, status: "?" });
      continue;
    }
    // "!" (ignored) records are intentionally dropped: the contract has no
    // ignored group and the client never asks for them.
  }

  const detached = headName === "(detached)" || (headName === null && oid !== null);
  let name = "HEAD";
  if (!detached) name = headName === null ? (oid === null ? "main" : "HEAD") : headName;

  return {
    branch: {
      name,
      detached,
      sha: oid,
      shortSha: oid === null ? null : oid.slice(0, 7),
      upstream,
      ahead,
      behind,
    },
    staged,
    unstaged,
    untracked,
    conflicted,
    counts: {
      staged: staged.length,
      unstaged: unstaged.length,
      untracked: untracked.length,
      conflicted: conflicted.length,
    },
  };
}

/**
 * Read and parse the working tree status.
 *
 * "-uall" expands untracked directories into individual files so every entry
 * in the response can be staged, diffed and discarded by path. The wire shape
 * is unchanged (contract 1.3).
 *
 * @param {string} toplevel
 * @returns {ReturnType<typeof parseStatusPorcelainV2>}
 */
export async function readStatus(toplevel) {
  const result = await runGitChecked(["status", "--porcelain=v2", "--branch", "-uall", "-z"], { cwd: toplevel });
  return parseStatusPorcelainV2(result.stdout);
}

// ---------------------------------------------------------------------------
// Unified diff (contract 1.3)
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into structured hunks.
 *
 * Preamble lines ("diff --git", "index", "---", "+++", mode lines) are skipped
 * before the first hunk; "\ No newline at end of file" markers are dropped
 * because the contract has no line type for them.
 *
 * @param {string} text raw "git diff" output
 * @param {{ maxLines?: number }} [options]
 * @returns {{ binary: boolean, truncated: boolean, additions: number, deletions: number, hunks: Array<object> }}
 */
export function parseUnifiedDiff(text, options = {}) {
  const maxLines =
    Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : MAX_DIFF_LINES;
  const source = String(text === null || text === undefined ? "" : text);
  // Both markers must be anchored to the start of a line: a *content* line
  // that merely spells "Binary files ... differ" (a test fixture, a comment in
  // a diff viewer, this very file) is prefixed by "+", "-" or " " and must not
  // turn the whole file into a binary diff.
  if (/^Binary files .* differ\s*$/m.test(source) || /^GIT binary patch$/m.test(source)) {
    return { binary: true, truncated: false, additions: 0, deletions: 0, hunks: [] };
  }

  const lines = source.split("\n");
  const hunks = [];
  let additions = 0;
  let deletions = 0;
  let truncated = false;
  let current = null;
  let oldLineNo = 0;
  let newLineNo = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (index >= maxLines) {
      truncated = true;
      break;
    }
    const line = lines[index];
    if (line === "") continue;

    if (line.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (header === null) {
        current = null;
        continue;
      }
      const oldLines = header[2] === undefined ? 1 : Number(header[2]);
      const newLines = header[4] === undefined ? 1 : Number(header[4]);
      current = {
        header:
          "@@ -" +
          header[1] +
          (header[2] === undefined ? "" : "," + header[2]) +
          " +" +
          header[3] +
          (header[4] === undefined ? "" : "," + header[4]) +
          " @@",
        oldStart: Number(header[1]),
        oldLines: oldLines,
        newStart: Number(header[3]),
        newLines: newLines,
        lines: [],
      };
      hunks.push(current);
      oldLineNo = Number(header[1]);
      newLineNo = Number(header[3]);
      oldRemaining = oldLines;
      newRemaining = newLines;
      continue;
    }

    if (current === null) continue;

    const marker = line[0];
    if (marker === "+") {
      current.lines.push({ type: "add", text: line.slice(1), oldLine: null, newLine: newLineNo });
      newLineNo += 1;
      newRemaining -= 1;
      additions += 1;
    } else if (marker === "-") {
      current.lines.push({ type: "del", text: line.slice(1), oldLine: oldLineNo, newLine: null });
      oldLineNo += 1;
      oldRemaining -= 1;
      deletions += 1;
    } else if (marker === " ") {
      current.lines.push({ type: "context", text: line.slice(1), oldLine: oldLineNo, newLine: newLineNo });
      oldLineNo += 1;
      newLineNo += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      // "\ No newline at end of file" and any other marker: not a content
      // line, so it neither counts nor breaks the surrounding hunk.
      continue;
    }
    if (oldRemaining <= 0 && newRemaining <= 0) current = null;
  }

  return { binary: false, truncated, additions, deletions, hunks };
}

/**
 * Binary detection: NUL byte in the first 8 KiB or a known binary extension.
 *
 * @param {Buffer} buffer
 * @param {string} [fileName]
 * @returns {boolean}
 */
export function isBinaryBuffer(buffer, fileName = "") {
  if (fileName !== "" && BINARY_EXTENSIONS.has(path.extname(fileName).toLowerCase())) return true;
  const sample = buffer.subarray(0, BINARY_PROBE_BYTES);
  return sample.includes(0);
}

/**
 * Synthesise the diff of a wholly new (untracked) file.
 *
 * The contract models this as /dev/null -> file: one hunk that adds every
 * line, with oldStart 0 / oldLines 0.
 *
 * @param {Buffer} buffer file contents (already capped by the caller)
 * @param {string} fileName used for the extension heuristic
 * @param {{ truncated?: boolean }} [options]
 * @returns {{ binary: boolean, truncated: boolean, additions: number, deletions: number, hunks: Array<object> }}
 */
export function buildUntrackedDiff(buffer, fileName, options = {}) {
  const alreadyTruncated = options.truncated === true;
  if (isBinaryBuffer(buffer, fileName)) {
    return { binary: true, truncated: alreadyTruncated, additions: 0, deletions: 0, hunks: [] };
  }

  const lines = buffer.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].endsWith("\r")) lines[index] = lines[index].slice(0, -1);
  }
  if (lines.length === 0) {
    return { binary: false, truncated: alreadyTruncated, additions: 0, deletions: 0, hunks: [] };
  }

  const truncated = alreadyTruncated || lines.length > MAX_DIFF_LINES;
  const visible = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;
  const hunk = {
    header: "@@ -0,0 +1," + visible.length + " @@",
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: visible.length,
    lines: visible.map((text, index) => ({ type: "add", text: text, oldLine: null, newLine: index + 1 })),
  };
  return { binary: false, truncated, additions: visible.length, deletions: 0, hunks: [hunk] };
}

/**
 * Read an untracked file (capped at 2 MiB) and synthesise its diff.
 *
 * @param {string} absolutePath
 * @param {string} relativePath repository relative path (for binary detection)
 * @returns {Promise<{ binary: boolean, truncated: boolean, additions: number, deletions: number, hunks: Array<object> }>}
 */
async function readUntrackedDiff(absolutePath, relativePath) {
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT") throw new GitError("not-found", "File not found: " + relativePath);
    throw new GitError("invalid-path", "Cannot read " + relativePath);
  }
  if (stat.isDirectory()) {
    return { binary: false, truncated: false, additions: 0, deletions: 0, hunks: [] };
  }
  const truncated = stat.size > MAX_UNTRACKED_BYTES;
  const length = Math.min(stat.size, MAX_UNTRACKED_BYTES);
  const handle = await fs.open(absolutePath, "r");
  let buffer;
  try {
    buffer = Buffer.allocUnsafe(length);
    const result = await handle.read(buffer, 0, length, 0);
    buffer = buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
  return buildUntrackedDiff(buffer, relativePath, { truncated });
}

/**
 * Validate a revision argument (no leading dash, no whitespace, no NUL).
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function validateRevision(value, field = "rev") {
  if (typeof value !== "string") throw new GitError("bad-request", '"' + field + '" must be a revision string');
  const revision = value.trim();
  if (revision === "" || revision.includes("\u0000") || revision.startsWith("-") || /\s/.test(revision)) {
    throw new GitError("bad-request", "Invalid revision: " + JSON.stringify(String(value)));
  }
  return revision;
}

/**
 * True when a git failure means "that object/revision does not exist".
 *
 * @param {string} stderr
 * @returns {boolean}
 */
function isMissingRevision(stderr) {
  return /unknown revision|bad object|bad revision|not a valid object name|ambiguous argument|does not exist/i.test(
    String(stderr === null || stderr === undefined ? "" : stderr),
  );
}

/**
 * Read one file's diff in the requested mode (contract 1.3).
 *
 * @param {string} toplevel
 * @param {{ path: unknown, mode?: string, rev?: unknown }} request
 * @returns {Promise<{ path: string, mode: string, binary: boolean, truncated: boolean, additions: number, deletions: number, hunks: Array<object> }>}
 */
export async function readDiff(toplevel, request) {
  const mode = typeof request.mode === "string" && request.mode !== "" ? request.mode : "worktree";
  if (!DIFF_MODES.includes(mode)) {
    throw new GitError("bad-request", '"mode" must be one of ' + DIFF_MODES.join(", "));
  }
  const relativePath = normalizeRepoPath(request.path, "path");
  const absolutePath = resolveRepoPath(toplevel, relativePath);

  if (mode === "untracked") {
    const diff = await readUntrackedDiff(absolutePath, relativePath);
    return { path: relativePath, mode, binary: diff.binary, truncated: diff.truncated, additions: diff.additions, deletions: diff.deletions, hunks: diff.hunks };
  }

  /** @type {string[]} */
  let args;
  if (mode === "worktree") {
    args = ["diff", "--no-color", "--find-renames", "-U3", "--", relativePath];
  } else if (mode === "staged") {
    args = ["diff", "--cached", "--no-color", "--find-renames", "-U3", "--", relativePath];
  } else {
    const revision = validateRevision(request.rev === undefined || request.rev === null ? "HEAD" : request.rev);
    args = ["show", "--no-color", "--format=", revision, "--", relativePath];
  }

  const result = await runGit(args, { cwd: toplevel });
  if (result.status !== 0) {
    if (mode === "commit" && isMissingRevision(result.stderr)) {
      throw new GitError("not-found", "No such revision: " + String(request.rev === undefined ? "HEAD" : request.rev));
    }
    throw gitFailure(args, result);
  }
  const diff = parseUnifiedDiff(result.stdout);
  return { path: relativePath, mode, binary: diff.binary, truncated: diff.truncated, additions: diff.additions, deletions: diff.deletions, hunks: diff.hunks };
}

// ---------------------------------------------------------------------------
// log (contract 1.3)
// ---------------------------------------------------------------------------

/**
 * Split a "%D" decoration list into refs (the "tag: " prefix is stripped).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseRefs(text) {
  const trimmed = String(text === null || text === undefined ? "" : text).trim();
  if (trimmed === "") return [];
  const refs = [];
  for (const entry of trimmed.split(", ")) {
    const value = entry.trim();
    if (value === "") continue;
    refs.push(value.replace(/^tag:\s*/, ""));
  }
  return refs;
}

/**
 * Parse "git log -z --format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s".
 *
 * @param {string} text
 * @returns {Array<{ sha: string, shortSha: string, author: string, email: string, time: number, subject: string, parents: string[], refs: string[] }>}
 */
export function parseLogOutput(text) {
  const commits = [];
  for (const record of String(text === null || text === undefined ? "" : text).split("\u0000")) {
    if (record === "") continue;
    const fields = record.split("\u001f");
    if (fields.length < 8) continue;
    commits.push({
      sha: fields[0],
      shortSha: fields[1],
      author: fields[2],
      email: fields[3],
      time: Number.parseInt(fields[4], 10) || 0,
      subject: fields[7],
      parents: fields[5].split(" ").filter((entry) => entry !== ""),
      refs: parseRefs(fields[6]),
    });
  }
  return commits;
}

/**
 * Clamp an integer option.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value === undefined ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Read one page of the commit log.
 *
 * @param {string} toplevel
 * @param {{ ref?: string, limit?: number | string, skip?: number | string }} [options]
 * @returns {Promise<{ ref: string, hasMore: boolean, commits: Array<object> }>}
 */
export async function readLog(toplevel, options = {}) {
  const ref = typeof options.ref === "string" && options.ref.trim() !== "" ? options.ref.trim() : "HEAD";
  if (ref.startsWith("-") || /\s/.test(ref)) throw new GitError("bad-request", "Invalid ref: " + JSON.stringify(ref));
  const limit = clampInt(options.limit, LOG_LIMIT_DEFAULT, 1, LOG_LIMIT_MAX);
  const skip = clampInt(options.skip, 0, 0, Number.MAX_SAFE_INTEGER);

  // An empty repository has no HEAD yet: that is an empty page, not an error.
  if (ref === "HEAD" && !(await hasCommit(toplevel))) {
    return { ref, hasMore: false, commits: [] };
  }

  const result = await runGit(
    [
      "log",
      "-z",
      "--no-color",
      "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s",
      "-n",
      String(limit + 1),
      "--skip=" + skip,
      ref,
    ],
    { cwd: toplevel },
  );
  if (result.status !== 0) throw gitFailure(["log"], result);

  const commits = parseLogOutput(result.stdout);
  const hasMore = commits.length > limit;
  if (hasMore) commits.length = limit;
  return { ref, hasMore, commits };
}

// ---------------------------------------------------------------------------
// commit detail (contract 1.3)
// ---------------------------------------------------------------------------

/**
 * Parse "git show -z --numstat --format= -M" output.
 *
 * A normal record is "<add>\t<del>\t<path>"; a rename/copy record is
 * "<add>\t<del>\t" followed by the old path and the new path as separate NUL
 * separated tokens. Binary files report "-" for both counters.
 *
 * @param {string} text
 * @returns {Array<{ path: string, origPath: string | null, additions: number | null, deletions: number | null, binary: boolean }>}
 */
export function parseNumstat(text) {
  const tokens = String(text === null || text === undefined ? "" : text).split("\u0000");
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "") continue;
    const match = /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/.exec(token);
    if (match === null) continue;
    const added = match[1];
    const deleted = match[2];
    let pathname = match[3];
    let origPath = null;
    if (pathname === "") {
      const oldPath = tokens[index + 1] === undefined ? "" : tokens[index + 1];
      pathname = tokens[index + 2] === undefined ? "" : tokens[index + 2];
      index += 2;
      origPath = oldPath === "" ? null : oldPath;
    }
    if (pathname === "") continue;
    const binary = added === "-" && deleted === "-";
    entries.push({
      path: pathname,
      origPath,
      additions: binary || added === "-" ? null : Number(added),
      deletions: binary || deleted === "-" ? null : Number(deleted),
      binary,
    });
  }
  return entries;
}

/**
 * Parse "git show -z --name-status --format= -M" output.
 *
 * Records are "<status>\0<path>" or, for renames/copies,
 * "<status>\0<old>\0<new>".
 *
 * @param {string} text
 * @returns {Array<{ path: string, origPath: string | null, status: string }>}
 */
export function parseNameStatus(text) {
  const tokens = String(text === null || text === undefined ? "" : text).split("\u0000");
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "") continue;
    const status = token.slice(0, 1);
    if (status === "R" || status === "C") {
      const origPath = tokens[index + 1] === undefined ? "" : tokens[index + 1];
      const pathname = tokens[index + 2] === undefined ? "" : tokens[index + 2];
      index += 2;
      if (pathname !== "") {
        entries.push({ path: pathname, origPath: origPath === "" ? null : origPath, status });
      }
      continue;
    }
    const pathname = tokens[index + 1] === undefined ? "" : tokens[index + 1];
    index += 1;
    if (pathname !== "") entries.push({ path: pathname, origPath: null, status });
  }
  return entries;
}

/**
 * Join the "--name-status" order (authoritative for status and renames) with
 * the "--numstat" counters.
 *
 * @param {ReturnType<typeof parseNumstat>} numstat
 * @param {ReturnType<typeof parseNameStatus>} nameStatus
 * @returns {Array<{ path: string, origPath: string | null, status: string, additions: number | null, deletions: number | null, binary: boolean }>}
 */
export function mergeCommitFiles(numstat, nameStatus) {
  const byPath = new Map();
  for (const entry of numstat) {
    byPath.set(entry.path, entry);
    if (entry.origPath !== null) byPath.set(entry.origPath, entry);
  }
  const files = [];
  const used = new Set();
  for (const entry of nameStatus) {
    let stats = byPath.get(entry.path);
    if (stats === undefined && entry.origPath !== null) stats = byPath.get(entry.origPath);
    if (stats !== undefined) used.add(stats.path);
    files.push({
      path: entry.path,
      origPath: entry.origPath,
      status: entry.status,
      additions: stats === undefined ? null : stats.additions,
      deletions: stats === undefined ? null : stats.deletions,
      binary: stats === undefined ? false : stats.binary,
    });
  }
  // Defensive: counters without a status record (should not happen) are still
  // reported so the client never silently loses a changed file.
  for (const entry of numstat) {
    if (used.has(entry.path)) continue;
    used.add(entry.path);
    files.push({
      path: entry.path,
      origPath: entry.origPath,
      status: "M",
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.binary,
    });
  }
  return files;
}

/**
 * Read one commit plus the files it changed.
 *
 * @param {string} toplevel
 * @param {unknown} sha
 * @returns {Promise<{ commit: object, files: Array<object> }>}
 */
export async function readCommit(toplevel, sha) {
  const revision = validateRevision(sha, "sha");
  const metaArgs = [
    "show",
    "-s",
    "--no-color",
    "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s%x1f%b",
    revision,
  ];
  const meta = await runGit(metaArgs, { cwd: toplevel });
  if (meta.status !== 0) {
    if (isMissingRevision(meta.stderr)) throw new GitError("not-found", "No such commit: " + revision);
    throw gitFailure(metaArgs, meta);
  }
  const fields = meta.stdout.split("\u001f");
  if (fields.length < 9) throw new GitError("internal", "Unexpected git show output");
  const commit = {
    sha: fields[0],
    shortSha: fields[1],
    author: fields[2],
    email: fields[3],
    time: Number.parseInt(fields[4], 10) || 0,
    subject: fields[7],
    body: fields.slice(8).join("\u001f").replace(/\s+$/, ""),
    parents: fields[5].split(" ").filter((entry) => entry !== ""),
    refs: parseRefs(fields[6]),
  };

  const fullSha = commit.sha;
  const numstatResult = await runGit(["show", "-z", "--numstat", "--format=", "-M", fullSha], { cwd: toplevel });
  if (numstatResult.status !== 0) throw gitFailure(["show", "--numstat"], numstatResult);
  const nameStatusResult = await runGit(["show", "-z", "--name-status", "--format=", "-M", fullSha], {
    cwd: toplevel,
  });
  if (nameStatusResult.status !== 0) throw gitFailure(["show", "--name-status"], nameStatusResult);

  return {
    commit,
    files: mergeCommitFiles(parseNumstat(numstatResult.stdout), parseNameStatus(nameStatusResult.stdout)),
  };
}

// ---------------------------------------------------------------------------
// branches (contract 1.3)
// ---------------------------------------------------------------------------

/**
 * Parse the upstream track string: "", "[ahead 1]", "[behind 2]",
 * "[ahead 1, behind 2]" or "[gone]".
 *
 * @param {string} text
 * @returns {{ ahead: number, behind: number, gone: boolean }}
 */
export function parseUpstreamTrack(text) {
  const source = String(text === null || text === undefined ? "" : text);
  const ahead = /ahead (\d+)/.exec(source);
  const behind = /behind (\d+)/.exec(source);
  return {
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
    gone: /\bgone\b/.test(source),
  };
}

/**
 * Parse the for-each-ref output produced by readBranches().
 *
 * @param {string} text
 * @returns {Array<{ ref: string, name: string, sha: string, upstream: string, track: string, head: string }>}
 */
export function parseForEachRef(text) {
  const refs = [];
  for (const line of String(text === null || text === undefined ? "" : text).split("\n")) {
    if (line === "") continue;
    const fields = line.split("\u001f");
    if (fields.length < 6) continue;
    refs.push({
      ref: fields[0],
      name: fields[1],
      sha: fields[2],
      upstream: fields[3],
      track: fields[4],
      head: fields[5].trim(),
    });
  }
  return refs;
}

/** for-each-ref format used by readBranches(). */
const FOR_EACH_REF_FORMAT =
  "%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)";

/**
 * Read local and remote branches.
 *
 * @param {string} toplevel
 * @returns {Promise<{ current: string, detached: boolean, local: Array<object>, remote: Array<object> }>}
 */
export async function readBranches(toplevel) {
  const result = await runGitChecked(
    ["for-each-ref", "--format=" + FOR_EACH_REF_FORMAT, "refs/heads", "refs/remotes"],
    { cwd: toplevel },
  );
  const current = await readCurrentBranch(toplevel);
  const local = [];
  const remote = [];
  for (const entry of parseForEachRef(result.stdout)) {
    if (entry.ref.startsWith("refs/heads/")) {
      const track = parseUpstreamTrack(entry.track);
      local.push({
        name: entry.name,
        sha: entry.sha,
        upstream: entry.upstream === "" ? null : entry.upstream,
        ahead: track.ahead,
        behind: track.behind,
        isCurrent: entry.head === "*" || entry.name === current.name,
      });
    } else if (entry.ref.startsWith("refs/remotes/")) {
      remote.push({
        name: entry.name,
        sha: entry.sha,
        isCurrent: entry.head === "*" || entry.name === current.name,
      });
    }
  }
  return { current: current.name, detached: current.detached, local, remote };
}

// ---------------------------------------------------------------------------
// Mutations (contract 1.3 POST routes)
// ---------------------------------------------------------------------------

/**
 * Stage paths with "git add -A" so deletions and untracked files are covered.
 *
 * @param {string} toplevel
 * @param {unknown} paths
 * @returns {Promise<string[]>} the normalised paths that were staged
 */
export async function stagePaths(toplevel, paths) {
  const normalized = normalizeRepoPaths(paths);
  for (const relativePath of normalized) resolveRepoPath(toplevel, relativePath);
  await runGitChecked(["add", "-A", "--", ...normalized], { cwd: toplevel });
  return normalized;
}

/**
 * Unstage paths, falling back to "git rm --cached" in a repository without a
 * first commit (git restore --staged needs a resolvable HEAD).
 *
 * @param {string} toplevel
 * @param {unknown} paths
 * @returns {Promise<string[]>} the normalised paths that were unstaged
 */
export async function unstagePaths(toplevel, paths) {
  const normalized = normalizeRepoPaths(paths);
  for (const relativePath of normalized) resolveRepoPath(toplevel, relativePath);
  if (await hasCommit(toplevel)) {
    const result = await runGit(["restore", "--staged", "--", ...normalized], { cwd: toplevel });
    if (result.status === 0) return normalized;
    if (!/could not resolve|unknown revision|ambiguous argument/i.test(result.stderr)) {
      throw gitFailure(["restore", "--staged"], result);
    }
  }
  await runGitChecked(["rm", "--cached", "-r", "--", ...normalized], { cwd: toplevel });
  return normalized;
}

/**
 * Discard changes for a mixed set of paths.
 *
 * Three kinds of "discard" are distinguished from one status snapshot:
 *
 * - untracked path -> "git clean -fd" (contract 1.3);
 * - tracked path (modified, deleted, renamed, conflicted) ->
 *   "git restore --worktree" from the index, with "git checkout --" as the
 *   fallback for old git releases;
 * - a path that is newly staged (index status "A") is a file the user added and
 *   now wants gone entirely: it is removed from the index with
 *   "git rm --cached -f" and then deleted from the work tree with "git clean",
 *   because "git restore --worktree" would happily recreate it from the index
 *   and leave the staged addition behind.
 *
 * The client only offers discard on work tree and untracked rows, but a staged
 * addition reaches this route whenever it also has work tree changes ("AM"),
 * so the third case is handled explicitly instead of silently doing nothing.
 *
 * @param {string} toplevel
 * @param {unknown} paths
 * @returns {Promise<void>}
 */
export async function discardPaths(toplevel, paths) {
  const normalized = normalizeRepoPaths(paths);
  for (const relativePath of normalized) resolveRepoPath(toplevel, relativePath);
  const status = await readStatus(toplevel);
  const untrackedSet = new Set(status.untracked.map((entry) => entry.path));
  const addedSet = new Set();
  const trackedSet = new Set();
  for (const entry of status.staged) {
    trackedSet.add(entry.path);
    if (entry.status === "A") addedSet.add(entry.path);
  }
  for (const entry of status.unstaged) trackedSet.add(entry.path);
  for (const entry of status.conflicted) trackedSet.add(entry.path);

  const restore = [];
  const unstagedAdds = [];
  const clean = [];
  for (const relativePath of normalized) {
    if (untrackedSet.has(relativePath)) clean.push(relativePath);
    else if (addedSet.has(relativePath)) unstagedAdds.push(relativePath);
    else if (trackedSet.has(relativePath)) restore.push(relativePath);
    // Unknown to git: treat as untracked. "git clean" is a no-op when nothing
    // matches while "git restore" would fail with "pathspec did not match".
    else clean.push(relativePath);
  }

  if (unstagedAdds.length > 0) {
    await runGitChecked(["rm", "--cached", "-f", "-r", "--", ...unstagedAdds], { cwd: toplevel });
    for (const relativePath of unstagedAdds) clean.push(relativePath);
  }

  if (restore.length > 0) {
    const args = ["restore", "--worktree", "--", ...restore];
    const result = await runGit(args, { cwd: toplevel });
    if (result.status !== 0) {
      if (/unknown option|not a git command|unrecognized|incompatible/i.test(result.stderr)) {
        await runGitChecked(["checkout", "--", ...restore], { cwd: toplevel });
      } else {
        throw gitFailure(args, result);
      }
    }
  }
  if (clean.length > 0) {
    await runGitChecked(["clean", "-fd", "--", ...clean], { cwd: toplevel });
  }
}

/**
 * Create a commit; "all: true" stages every change first.
 *
 * @param {string} toplevel
 * @param {{ message?: unknown, all?: unknown }} request
 * @returns {Promise<{ sha: string, shortSha: string }>}
 */
export async function commitStaged(toplevel, request) {
  const message = typeof request.message === "string" ? request.message : "";
  if (message.trim() === "") throw new GitError("bad-request", '"message" must not be empty');
  if (request.all === true) await runGitChecked(["add", "-A"], { cwd: toplevel });

  const args = ["commit", "-m", message];
  const result = await runGit(args, { cwd: toplevel });
  if (result.status !== 0) {
    // git 2.54 writes the "nothing to commit" summary on stdout, not stderr,
    // so both streams are inspected (contract 1.3, commit route).
    const output = result.stdout + "\n" + result.stderr;
    if (
      result.status === 1 &&
      /nothing (?:added )?to commit|no changes added to commit|nothing to commit/i.test(output)
    ) {
      throw new GitError("conflict", "Nothing to commit");
    }
    throw gitFailure(args, result);
  }
  const head = await runGitChecked(["rev-parse", "HEAD"], { cwd: toplevel });
  const sha = head.stdout.trim();
  if (sha === "") throw new GitError("internal", "Unable to resolve HEAD after commit");
  return { sha, shortSha: sha.slice(0, 7) };
}

/**
 * Check out an existing local branch.
 *
 * @param {string} toplevel
 * @param {unknown} branch
 * @returns {Promise<void>}
 */
export async function checkoutBranch(toplevel, branch) {
  if (typeof branch !== "string") throw new GitError("bad-request", '"branch" must be a string');
  const name = branch.trim();
  if (name === "" || name.includes("\u0000") || /\s/.test(name) || name.startsWith("-")) {
    throw new GitError("bad-request", "Invalid branch name: " + JSON.stringify(branch));
  }
  // A trailing "--" keeps git from ever reading the branch name as a pathspec.
  await runGitChecked(["checkout", name, "--"], { cwd: toplevel });
}
