// Browser half of the dsh-git-control plugin.
//
// A single self-contained client bundle (classic script, no build step, no
// dependencies beyond the shell's static "react" baseline). It registers one
// right-sidebar tab type (kind: "git"), its panel body and its title chip:
//
//   * sidebarRightTabs.register  -> the tab type ("dsh-git-control" / "git")
//   * slots register "sidebar.right.pane.tab"        -> GitBody  (panel content)
//   * slots register "sidebar.right.pane.tab.title"  -> GitTitle (title chip)
//
// Everything the panel shows comes from the Host half's /git/* HTTP contract in
// docs/contract.md; when a route fails the panel keeps rendering and shows an
// inline error banner with a retry action.
window.__ModuleLoader__.load({
  id: "dsh-git-control",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const Fragment = React.Fragment;

    // -------------------------------------------------------------------------
    // Identity and wire constants
    // -------------------------------------------------------------------------

    /** This implementation's identity in the tab system and the body/title slot key. */
    const ID = "dsh-git-control";
    /** The right-sidebar tab kind this package owns. */
    const KIND = "git";
    /** Locale namespace used for every visible string. */
    const NS = "git";
    /** Slot seats contributed by a right-sidebar tab. */
    const BODY_SLOT = "sidebar.right.pane.tab";
    const TITLE_SLOT = "sidebar.right.pane.tab.title";
    /** Style tag discriminator so repeated loads replace one stylesheet. */
    const STYLE_TAG = ID + "/styles";
    /** Host route prefix (the Host registers every route under /git). */
    const ROUTE_PREFIX = "/git";
    /** Working-tree polling cadence while the changes tab is visible. */
    const POLL_MS = 4000;
    /** Header chip polling cadence; slower than the panel because it is always mounted. */
    const CHIP_POLL_MS = 10000;
    /** Commits fetched per log page (the Host caps limit at 200). */
    const LOG_LIMIT = 50;
    /** Distance from the bottom that triggers the next log page. */
    const SCROLL_SLACK = 64;
    /** Auto-dismiss delay for the transient success notice. */
    const NOTICE_MS = 3000;

    // -------------------------------------------------------------------------
    // Small pure helpers
    // -------------------------------------------------------------------------

    /** Replace {name} placeholders; a missing value renders as an empty string. */
    function format(template, params) {
      if (typeof template !== "string") return "";
      if (params === null || params === undefined || typeof params !== "object") return template;
      return template.replace(/\{([A-Za-z0-9_.]+)\}/g, function (match, name) {
        const value = params[name];
        return value === undefined || value === null ? "" : String(value);
      });
    }

    function isNonEmptyString(value) {
      return typeof value === "string" && value.length > 0;
    }

    function toCount(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
      return Math.floor(value);
    }

    /** Last path segment; tolerates both separators and trailing separators. */
    function basename(value) {
      if (typeof value !== "string" || value.length === 0) return "";
      let end = value.length;
      while (end > 0) {
        const char = value.charAt(end - 1);
        if (char !== "/" && char !== "\\") break;
        end -= 1;
      }
      if (end === 0) return "";
      const slice = value.slice(0, end);
      const index = Math.max(slice.lastIndexOf("/"), slice.lastIndexOf("\\"));
      return index === -1 ? slice : slice.slice(index + 1);
    }

    /** Parent path, normalised to forward slashes; empty when there is no parent. */
    function dirname(value) {
      if (typeof value !== "string" || value.length === 0) return "";
      const normalised = value.replace(/\\/g, "/").replace(/\/+$/, "");
      const index = normalised.lastIndexOf("/");
      if (index === -1) return "";
      if (index === 0) return "/";
      const head = normalised.slice(0, index);
      return /^[A-Za-z]:$/.test(head) ? head + "/" : head;
    }

    /** Join a directory and a repository-relative POSIX path for display. */
    function joinPath(root, relative) {
      const base = typeof root === "string" ? root.replace(/\\/g, "/").replace(/\/+$/, "") : "";
      if (typeof relative !== "string" || relative.length === 0) return base;
      const suffix = relative.replace(/\\/g, "/").replace(/^\/+/, "");
      return base + "/" + suffix;
    }

    function formatLineNumber(value) {
      return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    }

    /** Absolute local timestamp; the panel only ever shows this next to a relative one. */
    function formatAbsoluteTime(seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
      const date = new Date(seconds * 1000);
      try {
        return date.toLocaleString();
      } catch (error) {
        return date.toISOString();
      }
    }

    /** "3 minutes ago" in at most one unit; empty for an unusable timestamp. */
    function formatRelativeTime(seconds, nowMs, translate) {
      const t = typeof translate === "function" ? translate : defaultTranslate;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
      const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
      const delta = Math.max(0, Math.floor(now / 1000 - seconds));
      if (delta < 60) return t("time.justNow");
      const minutes = Math.floor(delta / 60);
      if (minutes < 60) return t("time.minutes", { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t("time.hours", { count: hours });
      const days = Math.floor(hours / 24);
      if (days < 7) return t("time.days", { count: days });
      if (days < 30) return t("time.weeks", { count: Math.floor(days / 7) });
      if (days < 365) return t("time.months", { count: Math.floor(days / 30) });
      return t("time.years", { count: Math.floor(days / 365) });
    }

    /** Wire status letter -> localized status word. */
    const STATUS_LABEL_KEYS = {
      M: "status.M",
      A: "status.A",
      D: "status.D",
      R: "status.R",
      C: "status.C",
      T: "status.T",
      U: "status.U",
      "?": "status.untracked",
    };

    /** Wire status letter -> badge tint class suffix. */
    const STATUS_TONES = {
      M: "mod",
      A: "add",
      D: "del",
      R: "add",
      C: "add",
      T: "mod",
      U: "conflict",
      "?": "untracked",
    };

    /**
     * Letter, tone and label key for one file row. The panel renders the letter the
     * contract asks for per group ("U" for untracked, "!" for conflicted), while the
     * label always names the real state.
     */
    function statusMeta(status, section) {
      if (section === "conflicted") {
        return { letter: "!", tone: "conflict", labelKey: "status.conflict", status: "U" };
      }
      if (section === "untracked") {
        return { letter: "U", tone: "untracked", labelKey: "status.untracked", status: "?" };
      }
      const letter = typeof status === "string" && STATUS_LABEL_KEYS[status] !== undefined ? status : "M";
      return {
        letter: letter,
        tone: STATUS_TONES[letter] !== undefined ? STATUS_TONES[letter] : "mod",
        labelKey: STATUS_LABEL_KEYS[letter],
        status: letter,
      };
    }

    /** Row class, sign and kind for one unified-diff line. */
    function classifyDiffLine(line) {
      const type = line !== null && typeof line === "object" ? line.type : undefined;
      if (type === "add") {
        return { kind: "add", sign: "+", rowClass: "dg-diff-row dg-diff-row-add" };
      }
      if (type === "del") {
        return { kind: "del", sign: "-", rowClass: "dg-diff-row dg-diff-row-del" };
      }
      if (type === "meta") {
        return { kind: "meta", sign: "", rowClass: "dg-diff-row dg-diff-row-meta" };
      }
      return { kind: "context", sign: " ", rowClass: "dg-diff-row dg-diff-row-context" };
    }

    /**
     * Tone of one ref decoration: the checked-out line, a remote-tracking ref,
     * or a plain local branch. Drives the coloured ref pills in the history list.
     */
    function refTone(tag) {
      const value = typeof tag === "string" ? tag.trim() : "";
      if (value.startsWith("HEAD")) return "head";
      if (value.indexOf("/") !== -1) return "remote";
      return "local";
    }

    /** One ref decoration: a coloured pill whose dot encodes the ref kind. */
    function refTagNode(tag, key) {
      const tone = refTone(tag);
      return h("span", {
        className: "dg-ref-tag dg-ref-" + tone,
        key: key,
        title: String(tag),
      },
        h("span", { className: "dg-ref-dot dg-ref-dot-" + tone, "aria-hidden": "true" }),
        h("span", { className: "dg-ref-label" }, String(tag)));
    }

    // -------------------------------------------------------------------------
    // History layout, dates and filters (design D1, D3, D5)
    // -------------------------------------------------------------------------

    /** Panel width assumed until the ResizeObserver reports the real one. */
    const HISTORY_DEFAULT_WIDTH = 720;
    /** Below this the branch tree folds into a toggle (design D1). */
    const HISTORY_TREE_BREAKPOINT = 560;
    /** Below this the author column is dropped (design D3). */
    const HISTORY_AUTHOR_BREAKPOINT = 640;
    /** Below this the short-hash column is dropped too (design D3). */
    const HISTORY_HASH_BREAKPOINT = 520;

    /** Absolute commit timestamp as `yyyy-MM-dd HH:mm` in the local time zone. */
    function formatCommitDate(seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
      const date = new Date(seconds * 1000);
      const pad = function (value) {
        return value < 10 ? "0" + String(value) : String(value);
      };
      try {
        return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
          + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
      } catch (error) {
        return "";
      }
    }

    /** One `<input type="date">` value, or "" when it is not `YYYY-MM-DD`. */
    function normalizeDateValue(value) {
      const raw = typeof value === "string" ? value.trim() : "";
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
    }

    /** Until bound: the whole selected day, so "to 2026-10-31" includes it (D5). */
    function normalizeUntilValue(value) {
      const date = normalizeDateValue(value);
      return date === "" ? "" : date + "T23:59:59";
    }

    /** Which history pieces a panel width can afford. */
    function resolveHistoryLayout(value) {
      const width = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : HISTORY_DEFAULT_WIDTH;
      return {
        width: width,
        treeCollapsed: width < HISTORY_TREE_BREAKPOINT,
        showAuthor: width >= HISTORY_AUTHOR_BREAKPOINT,
        showHash: width >= HISTORY_HASH_BREAKPOINT,
      };
    }

    /** Trimmed log query parameters; the until date is normalised to end of day. */
    function logQueryParams(filters) {
      const source = filters !== null && filters !== undefined && typeof filters === "object" ? filters : {};
      const pick = function (name) {
        return isNonEmptyString(source[name]) ? source[name].trim() : "";
      };
      return {
        grep: pick("grep"),
        author: pick("author"),
        path: pick("path"),
        since: normalizeDateValue(pick("since")),
        until: normalizeUntilValue(pick("until")),
      };
    }

    /** Text / date / combined filter activity for empty states and the clear link. */
    function summarizeHistoryFilters(filters) {
      const params = logQueryParams(filters);
      const text = params.grep !== "" || params.author !== "" || params.path !== "";
      const date = params.since !== "" || params.until !== "";
      return { params: params, text: text, date: date, active: text === true || date === true };
    }

    /** Index of the HEAD commit inside one page of commits; -1 when absent. */
    function indexOfHeadCommit(commits, headSha) {
      if (!isNonEmptyString(headSha) || !Array.isArray(commits)) return -1;
      for (let index = 0; index < commits.length; index += 1) {
        const commit = commits[index];
        if (commit !== null && typeof commit === "object" && commit.sha === headSha) return index;
      }
      return -1;
    }

    /**
     * What the current branch's upstream slot must say.
     *
     * A detached HEAD has no upstream by definition, so it must not be reported
     * as "no upstream"; and when the status payload has not learned the upstream
     * yet (first poll, or a host that omits the field) the branch roster is the
     * fallback authority instead of a hard default.
     *
     * @param {unknown} branch status.branch
     * @param {unknown} branches GET /git/branches payload (may be null)
     * @param {string} currentName current branch name
     * @returns {{ kind: "detached"|"upstream"|"none", name: string }}
     */
    /**
     * Fixed-position style for the header-chip popover.
     *
     * The chip sits inside the desktop window's title-bar band, and the ancestors
     * there clip their overflow; an absolutely positioned popover is then cut off,
     * which reads as "clicking does nothing". Anchoring to the chip's rect with
     * `position: fixed` escapes every clipping ancestor.
     *
     * @param {{ top: number, bottom: number, right: number } | null} anchor
     * @param {number} viewportWidth
     * @returns {{ position: string, top: string, right: string } | null}
     */
    function popoverFixedStyle(anchor, viewportWidth) {
      if (anchor === null || typeof anchor !== "object") return null;
      if (!Number.isFinite(anchor.bottom) || !Number.isFinite(anchor.right)) return null;
      const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
      const right = width > 0 ? Math.max(8, Math.round(width - anchor.right)) : 8;
      return {
        position: "fixed",
        top: Math.round(anchor.bottom) + 6 + "px",
        right: right + "px",
        // The UA stylesheet centres [popover] with inset:0 + margin:auto; the
        // chip anchors it instead, so those offsets must be cleared.
        left: "auto",
        bottom: "auto",
        margin: "0",
      };
    }

    function resolveUpstream(branch, branches, currentName) {
      if (branch !== null && typeof branch === "object" && branch.detached === true) {
        return { kind: "detached", name: "" };
      }
      if (branch !== null && typeof branch === "object" && isNonEmptyString(branch.upstream)) {
        return { kind: "upstream", name: branch.upstream };
      }
      const locals = branches !== null && typeof branches === "object" && Array.isArray(branches.local) ? branches.local : [];
      for (const entry of locals) {
        if (entry === null || typeof entry !== "object") continue;
        const isCurrent = entry.isCurrent === true || (isNonEmptyString(currentName) && entry.name === currentName);
        if (!isCurrent) continue;
        if (isNonEmptyString(entry.upstream)) return { kind: "upstream", name: entry.upstream };
      }
      return { kind: "none", name: "" };
    }

    /** Locale key for one diff mode. */
    function modeKey(mode) {
      if (mode === "staged") return "diff.mode.staged";
      if (mode === "untracked") return "diff.mode.untracked";
      if (mode === "commit") return "diff.mode.commit";
      return "diff.mode.worktree";
    }

    function isVisibleTab(tabInfo) {
      if (tabInfo === null || tabInfo === undefined) return true;
      const tab = tabInfo.tab;
      if (tab === null || tab === undefined) return true;
      return tab.visible !== false;
    }

    // -------------------------------------------------------------------------
    // Presentation helpers: change tree, hunk patch and commit-message history
    // -------------------------------------------------------------------------

    /** Tree ordering: directories first, then files, each group by name. */
    function compareTreeNodes(left, right) {
      const leftDir = left.type === "dir";
      const rightDir = right.type === "dir";
      if (leftDir !== rightDir) return leftDir ? -1 : 1;
      if (left.name === right.name) return 0;
      return left.name < right.name ? -1 : 1;
    }

    /** Sort a node list in place (directories first) and recurse into directories. */
    function sortTreeNodes(nodes) {
      nodes.sort(compareTreeNodes);
      for (let index = 0; index < nodes.length; index += 1) {
        if (nodes[index].type === "dir") sortTreeNodes(nodes[index].children);
      }
      return nodes;
    }

    /**
     * Group repository-relative status entries into a renderable directory tree.
     * Directories come first, then files, each sorted by name; the input array and
     * its entries are never modified.
     */
    function buildChangeTree(entries) {
      const list = Array.isArray(entries) ? entries : [];
      const roots = [];
      const dirs = new Map();
      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        if (entry === null || typeof entry !== "object") continue;
        const raw = isNonEmptyString(entry.path) ? entry.path : "";
        const normalised = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
        if (normalised === "") continue;
        const segments = normalised.split("/").filter(function (segment) { return segment.length > 0; });
        if (segments.length === 0) continue;
        let siblings = roots;
        let prefix = "";
        for (let depth = 0; depth < segments.length - 1; depth += 1) {
          prefix = prefix === "" ? segments[depth] : prefix + "/" + segments[depth];
          let dir = dirs.get(prefix);
          if (dir === undefined) {
            dir = { type: "dir", name: segments[depth], path: prefix, children: [] };
            dirs.set(prefix, dir);
            siblings.push(dir);
          }
          siblings = dir.children;
        }
        siblings.push({ type: "file", name: segments[segments.length - 1], path: normalised, entry: entry });
      }
      return sortTreeNodes(roots);
    }

    /** Depth-first list of every directory node in a tree. */
    function collectTreeDirs(nodes, out) {
      const list = Array.isArray(nodes) ? nodes : [];
      const bucket = Array.isArray(out) ? out : [];
      for (let index = 0; index < list.length; index += 1) {
        const node = list[index];
        if (node !== null && typeof node === "object" && node.type === "dir") {
          bucket.push(node);
          collectTreeDirs(node.children, bucket);
        }
      }
      return bucket;
    }

    /** Total number of file rows below one directory node. */
    function countTreeFiles(node) {
      if (node === null || typeof node !== "object" || !Array.isArray(node.children)) return 0;
      let total = 0;
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (child === null || typeof child !== "object") continue;
        total += child.type === "dir" ? countTreeFiles(child) : 1;
      }
      return total;
    }

    /** One hunk's unified-diff body, newline terminated. */
    function hunkBodyText(hunk) {
      const lines = hunk !== null && typeof hunk === "object" && Array.isArray(hunk.lines) ? hunk.lines : [];
      let out = "";
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const type = line !== null && typeof line === "object" ? line.type : "context";
        const text = line !== null && typeof line === "object" && typeof line.text === "string" ? line.text : "";
        out += (type === "add" ? "+" : type === "del" ? "-" : " ") + text + "\n";
      }
      return out;
    }

    /** Rebuild the single-hunk patch POST /git/apply-hunk accepts. */
    function buildHunkPatch(path, hunk) {
      const file = typeof path === "string" ? path.replace(/\\/g, "/").replace(/^\/+/, "") : "";
      const header = hunk !== null && typeof hunk === "object" && isNonEmptyString(hunk.header) ? hunk.header : "@@";
      return "diff --git a/" + file + " b/" + file + "\n"
        + "--- a/" + file + "\n"
        + "+++ b/" + file + "\n"
        + header + "\n"
        + hunkBodyText(hunk);
    }

    /** Sha of the commit carrying HEAD (fallback: the newest commit of the page). */
    function headShaOf(commits) {
      const list = Array.isArray(commits) ? commits : [];
      for (let index = 0; index < list.length; index += 1) {
        const commit = list[index];
        if (commit === null || typeof commit !== "object") continue;
        const refs = Array.isArray(commit.refs) ? commit.refs : [];
        for (let refIndex = 0; refIndex < refs.length; refIndex += 1) {
          const ref = refs[refIndex];
          if (typeof ref === "string" && ref.indexOf("HEAD") === 0) {
            return isNonEmptyString(commit.sha) ? commit.sha : "";
          }
        }
      }
      for (let index = 0; index < list.length; index += 1) {
        const commit = list[index];
        if (commit !== null && typeof commit === "object" && isNonEmptyString(commit.sha)) return commit.sha;
      }
      return "";
    }

    /** localStorage key and capacity of the recent commit-message list. */
    const COMMIT_HISTORY_KEY = "dsh.git.commitMessages.v1";
    const COMMIT_HISTORY_MAX = 10;

    /** The browser's localStorage, or null when it is unavailable or throws. */
    function commitStorage() {
      try {
        if (typeof localStorage === "undefined" || localStorage === null) return null;
        return localStorage;
      } catch (error) {
        return null;
      }
    }

    /** Recent commit messages, newest first, at most COMMIT_HISTORY_MAX entries. */
    function readCommitHistory(storage) {
      const store = storage === undefined ? commitStorage() : storage;
      if (store === null || store === undefined || typeof store.getItem !== "function") return [];
      let raw = null;
      try {
        raw = store.getItem(COMMIT_HISTORY_KEY);
      } catch (error) {
        raw = null;
      }
      if (typeof raw !== "string" || raw === "") return [];
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      const out = [];
      for (let index = 0; index < parsed.length; index += 1) {
        const item = parsed[index];
        if (!isNonEmptyString(item)) continue;
        const trimmed = item.trim();
        if (trimmed === "" || out.indexOf(trimmed) !== -1) continue;
        out.push(trimmed);
        if (out.length >= COMMIT_HISTORY_MAX) break;
      }
      return out;
    }

    /** Record one used commit message and return the refreshed list. */
    function rememberCommitMessage(storage, message) {
      const store = storage === undefined ? commitStorage() : storage;
      const trimmed = isNonEmptyString(message) ? message.trim() : "";
      if (trimmed === "") return readCommitHistory(store);
      const previous = readCommitHistory(store);
      const next = [trimmed];
      for (let index = 0; index < previous.length; index += 1) {
        if (previous[index] !== trimmed && next.length < COMMIT_HISTORY_MAX) next.push(previous[index]);
      }
      if (store !== null && store !== undefined && typeof store.setItem === "function") {
        try {
          store.setItem(COMMIT_HISTORY_KEY, JSON.stringify(next));
        } catch (error) {
          // Quota / private-mode failures must never break committing.
        }
      }
      return next;
    }

    // -------------------------------------------------------------------------
    // Host API (docs/contract.md section 1)
    // -------------------------------------------------------------------------

    /** One failed Host call: {ok:false, code, message} or a transport failure. */
    class ApiError extends Error {
      constructor(code, detail) {
        super(typeof detail === "string" && detail.length > 0 ? detail : String(code));
        this.name = "ApiError";
        this.code = typeof code === "string" && code.length > 0 ? code : "internal";
        this.detail = typeof detail === "string" ? detail : "";
      }
    }

    /** "/git/status?root=..." with every provided parameter encoded. */
    function apiUrl(name, params) {
      let query = "";
      if (params !== null && typeof params === "object") {
        const parts = [];
        const keys = Object.keys(params);
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          const value = params[key];
          if (value === undefined || value === null || value === "") continue;
          parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
        }
        if (parts.length > 0) query = "?" + parts.join("&");
      }
      return ROUTE_PREFIX + "/" + name + query;
    }

    /** Read one Host response: success is {ok:true,...}, failure carries code+message. */
    async function parseResponse(response) {
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (body !== null && typeof body === "object" && body.ok === false) {
        const code = isNonEmptyString(body.code) ? body.code : "internal";
        const message = isNonEmptyString(body.message) ? body.message : "";
        throw new ApiError(code, message);
      }
      if (response.ok === true && body !== null && typeof body === "object" && body.ok === true) {
        return body;
      }
      const status = typeof response.status === "number" ? response.status : 0;
      let code = "internal";
      if (status === 400 || status === 422) code = "bad-request";
      else if (status === 404) code = "not-found";
      else if (status === 409) code = "conflict";
      else if (status === 401 || status === 403) code = "permission-denied";
      const detail = body !== null && typeof body === "object" && isNonEmptyString(body.message) ? body.message : "";
      throw new ApiError(code, detail === "" ? "HTTP " + String(status) : detail);
    }

    /** One Host request; POST bodies are JSON so the Host can read them verbatim. */
    function requestJson(name, params, payload) {
      if (typeof fetch !== "function") {
        return Promise.reject(new ApiError("no-fetch", "fetch is unavailable"));
      }
      const options = {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      };
      let url = apiUrl(name, params);
      if (payload !== undefined) {
        options.method = "POST";
        options.headers["content-type"] = "application/json";
        options.body = JSON.stringify(payload);
        url = ROUTE_PREFIX + "/" + name;
      }
      return fetch(url, options).then(parseResponse, function (cause) {
        const detail = cause !== null && cause !== undefined && isNonEmptyString(cause.message) ? cause.message : "";
        throw new ApiError("network", detail);
      });
    }

    function toApiError(error) {
      if (error instanceof ApiError) return error;
      if (error !== null && typeof error === "object" && isNonEmptyString(error.code)) {
        return new ApiError(error.code, isNonEmptyString(error.message) ? error.message : "");
      }
      if (error !== null && typeof error === "object" && isNonEmptyString(error.message)) {
        return new ApiError("internal", error.message);
      }
      return new ApiError("internal", "");
    }

    /** Localize one failure through a "{message}" template. */
    function describeFailure(translate, key, error) {
      const t = typeof translate === "function" ? translate : defaultTranslate;
      const failure = toApiError(error);
      const detail = failure.detail !== "" ? failure.detail : failure.code;
      return t(key, { message: detail });
    }

    /** Every Host route this bundle consumes. */
    const api = {
      status: function (root) {
        return requestJson("status", { root: root });
      },
      diff: function (root, path, mode, rev) {
        return requestJson("diff", { root: root, path: path, mode: mode, rev: rev });
      },
      log: function (root, options) {
        const opts = options || {};
        return requestJson("log", {
          root: root,
          limit: opts.limit !== undefined ? opts.limit : LOG_LIMIT,
          skip: opts.skip !== undefined ? opts.skip : 0,
          ref: opts.ref !== undefined ? opts.ref : "HEAD",
          grep: opts.grep,
          author: opts.author,
          path: opts.path,
          since: opts.since,
          until: opts.until,
        });
      },
      commitDetail: function (root, sha) {
        return requestJson("commit", { root: root, sha: sha });
      },
      branches: function (root) {
        return requestJson("branches", { root: root });
      },
      stage: function (root, paths) {
        return requestJson("stage", null, { root: root, paths: paths });
      },
      unstage: function (root, paths) {
        return requestJson("unstage", null, { root: root, paths: paths });
      },
      discard: function (root, paths) {
        return requestJson("discard", null, { root: root, paths: paths, confirm: true });
      },
      commitChanges: function (root, message, all) {
        return requestJson("commit", null, { root: root, message: message, all: all === true });
      },
      checkout: function (root, branch) {
        return requestJson("checkout", null, { root: root, branch: branch });
      },
      /** Per-file +N/-N for the whole working tree (one request, see contract 1.5). */
      stats: function (root) {
        return requestJson("stats", { root: root });
      },
      /** Apply exactly one reconstructed hunk to the index. */
      applyHunk: function (root, path, direction, patch) {
        return requestJson("apply-hunk", null, { root: root, path: path, direction: direction, patch: patch });
      },
      /** Amend the previous commit (message may be replaced wholesale). */
      amend: function (root, message) {
        return requestJson("amend", null, { root: root, message: message });
      },
      /** create / delete / rename through the single POST /git/branches route. */
      branchAction: function (root, action, params) {
        const body = { root: root, action: action };
        if (params !== null && params !== undefined && typeof params === "object") {
          const keys = Object.keys(params);
          for (let index = 0; index < keys.length; index += 1) {
            const key = keys[index];
            if (params[key] !== undefined) body[key] = params[key];
          }
        }
        return requestJson("branches", null, body);
      },
      health: function () {
        return requestJson("health", null);
      },
    };

    // -------------------------------------------------------------------------
    // Title-chip store
    //
    // The title slot receives no sessionId, so the body publishes a tiny read-only
    // snapshot (cwd / branch / change count) and the title subscribes to it. One
    // git tab per session is the common case; when several are open the most
    // recently updated body wins, which keeps the chip honest without guessing.
    // -------------------------------------------------------------------------

    const EMPTY_TITLE_STATE = { cwd: "", branch: "", count: 0, isRepo: false };
    const titleStore = { snapshot: EMPTY_TITLE_STATE, listeners: [] };

    function sameTitleState(left, right) {
      return left.cwd === right.cwd
        && left.branch === right.branch
        && left.count === right.count
        && left.isRepo === right.isRepo;
    }

    function publishTitleState(next) {
      const state = {
        cwd: typeof next.cwd === "string" ? next.cwd : "",
        branch: typeof next.branch === "string" ? next.branch : "",
        count: toCount(next.count),
        isRepo: next.isRepo === true,
      };
      if (sameTitleState(titleStore.snapshot, state)) return;
      titleStore.snapshot = state;
      const listeners = titleStore.listeners.slice();
      for (let index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index]();
        } catch (error) {
          // A broken subscriber must never break the publisher.
        }
      }
    }

    function subscribeTitleState(listener) {
      titleStore.listeners.push(listener);
      return function () {
        const index = titleStore.listeners.indexOf(listener);
        if (index !== -1) titleStore.listeners.splice(index, 1);
      };
    }

    function useTitleState() {
      const stateRef = React.useState(titleStore.snapshot);
      const state = stateRef[0];
      const setState = stateRef[1];
      React.useEffect(function () {
        function sync() {
          setState(titleStore.snapshot);
        }
        const unsubscribe = subscribeTitleState(sync);
        sync();
        return unsubscribe;
      }, []);
      return state;
    }

    // -------------------------------------------------------------------------
    // Inline SVG icons (no icon package: keep the bundle dependency-free)
    // -------------------------------------------------------------------------

    function GitGlyph(props) {
      const options = props || {};
      const size = typeof options.size === "number" ? options.size : 18;
      return h("svg", {
        className: options.className,
        width: size,
        height: size,
        viewBox: "0 0 20 20",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("circle", { cx: "5.75", cy: "4.75", r: "2", stroke: "currentColor", strokeWidth: "1.3" }),
        h("circle", { cx: "5.75", cy: "15.25", r: "2", stroke: "currentColor", strokeWidth: "1.3" }),
        h("circle", { cx: "14.25", cy: "7.5", r: "2", stroke: "currentColor", strokeWidth: "1.3" }),
        h("path", { d: "M5.75 6.75v6.5", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }),
        h("path", { d: "M14.25 9.5c0 2.62-2.13 4.75-4.75 4.75H5.75", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }));
    }

    function RefreshIcon(props) {
      const options = props || {};
      const spinning = options.spinning === true;
      return h("svg", {
        className: spinning ? "dg-spin" : undefined,
        width: 14,
        height: 14,
        viewBox: "0 0 16 16",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", { d: "M13.2 8a5.2 5.2 0 1 1-1.56-3.7", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }),
        h("path", { d: "M13.3 2.7v3.4H9.9", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round" }));
    }

    function JumpHeadIcon() {
      return h("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 16 16",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", { d: "M8 2.2v7.2", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }),
        h("path", { d: "M4.6 6.2 8 9.6l3.4-3.4", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round" }),
        h("path", { d: "M3.4 13.2h9.2", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }));
    }

    function BackIcon() {
      return h("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 16 16",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", { d: "M9.9 3.4 5.3 8l4.6 4.6", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }));
    }

    function CheckIcon(props) {
      const options = props || {};
      return h("svg", {
        className: options.className,
        width: 22,
        height: 22,
        viewBox: "0 0 24 24",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("circle", { cx: "12", cy: "12", r: "9", stroke: "currentColor", strokeWidth: "1.3" }),
        h("path", { d: "m8 12.3 2.6 2.6L16.2 9.3", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }));
    }

    function AlertIcon(props) {
      const options = props || {};
      return h("svg", {
        className: options.className,
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("circle", { cx: "8", cy: "8", r: "6.3", stroke: "currentColor", strokeWidth: "1.3" }),
        h("path", { d: "M8 4.9v3.6", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
        h("circle", { cx: "8", cy: "11", r: "0.85", fill: "currentColor" }));
    }

    function FileGlyph(props) {
      const options = props || {};
      return h("svg", {
        className: options.className,
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        fill: "none",
        focusable: "false",
        "aria-hidden": "true",
      },
        h("path", { d: "M4 2.2h5.2L12.6 5.6v8.2H4z", stroke: "currentColor", strokeWidth: "1.2", strokeLinejoin: "round" }),
        h("path", { d: "M9.1 2.4v3.4h3.3", stroke: "currentColor", strokeWidth: "1.2", strokeLinejoin: "round" }));
    }

    // -------------------------------------------------------------------------
    // Shared hooks and defensive fallbacks
    // -------------------------------------------------------------------------

    function NO_SESSIONS() {
      return undefined;
    }

    function NO_TAB_INFO() {
      return undefined;
    }

    /** Session cwd through the injected sessions selector hook. */
    function useSessionCwd(useSessions, sessionId) {
      const useStore = typeof useSessions === "function" ? useSessions : NO_SESSIONS;
      return useStore(function (state) {
        const byId = state ? state.byId : null;
        const session = byId && sessionId !== null && sessionId !== undefined ? byId[sessionId] : null;
        return session ? session.cwd : undefined;
      });
    }

    /** Esc closes the innermost overlay that owns this hook instance. */
    function useEscape(active, onEscape) {
      const handlerRef = React.useRef(onEscape);
      handlerRef.current = onEscape;
      React.useEffect(function () {
        if (active !== true) return undefined;
        if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined;
        function onKeyDown(event) {
          if (event.key !== "Escape" && event.key !== "Esc") return;
          const handler = handlerRef.current;
          if (typeof handler !== "function") return;
          if (typeof event.preventDefault === "function") event.preventDefault();
          if (typeof event.stopPropagation === "function") event.stopPropagation();
          handler();
        }
        document.addEventListener("keydown", onKeyDown);
        return function () {
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [active]);
    }

    // -------------------------------------------------------------------------
    // Render safety net: a component error must never blank the whole panel.
    // -------------------------------------------------------------------------

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
        this.handleRetry = this.handleRetry.bind(this);
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch() {
        // The host slot boundary would otherwise unmount the entire tab.
      }

      handleRetry() {
        this.setState({ failed: false });
      }

      render() {
        if (this.state.failed === true) {
          const t = typeof this.props.t === "function" ? this.props.t : defaultTranslate;
          return h("div", { className: "dg-empty", role: "alert" },
            h(AlertIcon, { className: "dg-empty-icon" }),
            h("div", { className: "dg-empty-title" }, t("error.render")),
            h("button", { type: "button", className: "dg-btn", onClick: this.handleRetry }, t("state.retry")));
        }
        return this.props.children === undefined ? null : this.props.children;
      }
    }

    // -------------------------------------------------------------------------
    // Diff viewer: hunk headers, line numbers, add/del tinting, per-hunk staging
    // -------------------------------------------------------------------------

    function DiffView(props) {
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const stateRef = React.useState({ loading: true, error: null, data: null });
      const state = stateRef[0];
      const setState = stateRef[1];
      const attemptRef = React.useState(0);
      const attempt = attemptRef[0];
      const setAttempt = attemptRef[1];
      const busyRef = React.useState(null);
      const busyHunk = busyRef[0];
      const setBusyHunk = busyRef[1];
      const hunkErrorRef = React.useState(null);
      const hunkError = hunkErrorRef[0];
      const setHunkError = hunkErrorRef[1];
      const noticeRef = React.useState(null);
      const notice = noticeRef[0];
      const setNotice = noticeRef[1];

      React.useEffect(function () {
        let cancelled = false;
        setState({ loading: true, error: null, data: null });
        api.diff(props.cwd, props.path, props.mode, props.rev).then(function (payload) {
          if (cancelled) return;
          setState({ loading: false, error: null, data: payload });
        }, function (error) {
          if (cancelled) return;
          setState({ loading: false, error: toApiError(error), data: null });
        });
        return function () {
          cancelled = true;
        };
      }, [props.cwd, props.path, props.mode, props.rev, attempt]);

      React.useEffect(function () {
        if (notice === null) return undefined;
        const timer = setTimeout(function () {
          setNotice(null);
        }, NOTICE_MS);
        return function () {
          clearTimeout(timer);
        };
      }, [notice]);

      /** Only the working-tree and the staged diff can be applied hunk by hunk. */
      const stageable = props.mode === "worktree";
      const unstageable = props.mode === "staged";

      function applyHunk(hunk, index, direction) {
        if (busyHunk !== null) return;
        setBusyHunk(index);
        setHunkError(null);
        setNotice(null);
        const patch = buildHunkPatch(props.path, hunk);
        api.applyHunk(props.cwd, props.path, direction, patch).then(function () {
          setBusyHunk(null);
          setNotice(direction === "stage" ? t("changes.hunk.staged") : t("changes.hunk.unstaged"));
          if (typeof props.onChanged === "function") props.onChanged();
          setAttempt(attempt + 1);
        }, function (error) {
          setBusyHunk(null);
          setHunkError(describeFailure(t, "changes.hunk.failed", error));
        });
      }

      function renderLine(line, key) {
        const info = classifyDiffLine(line);
        const text = line !== null && typeof line === "object" && typeof line.text === "string" ? line.text : "";
        return h("div", { className: info.rowClass, key: key },
          h("span", { className: "dg-ln dg-ln-old" }, formatLineNumber(line ? line.oldLine : null)),
          h("span", { className: "dg-ln dg-ln-new" }, formatLineNumber(line ? line.newLine : null)),
          h("span", { className: "dg-diff-sign" }, info.sign),
          h("span", { className: "dg-diff-text" }, text.length > 0 ? text : " "));
      }

      function renderHunk(hunk, index) {
        const lines = hunk !== null && typeof hunk === "object" && Array.isArray(hunk.lines) ? hunk.lines : [];
        const header = hunk !== null && typeof hunk === "object" && isNonEmptyString(hunk.header) ? hunk.header : "@@";
        const direction = stageable ? "stage" : unstageable ? "unstage" : null;
        const labelKey = direction === "stage" ? "changes.hunk.stage" : "changes.hunk.unstage";
        const action = direction === null
          ? null
          : h("button", {
            type: "button",
            className: "dg-hunk-btn",
            disabled: busyHunk !== null,
            title: t(labelKey),
            "aria-label": t(labelKey) + " " + header,
            onClick: function (event) {
              if (event !== null && event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
              applyHunk(hunk, index, direction);
            },
          }, busyHunk === index ? t("changes.action.busy") : t(labelKey));
        return h("div", { className: "dg-hunk-block", key: "hunk-" + String(index) },
          h("div", { className: "dg-hunk" },
            action === null ? null : h("span", { className: "dg-hunk-actions" }, action),
            h("span", { className: "dg-hunk-text" }, header)),
          lines.map(function (line, lineIndex) {
            return renderLine(line, "line-" + String(index) + "-" + String(lineIndex));
          }));
      }

      const data = state.data;
      const hunks = data !== null && typeof data === "object" && Array.isArray(data.hunks) ? data.hunks : [];
      const additions = data !== null && typeof data === "object" && typeof data.additions === "number" ? data.additions : 0;
      const deletions = data !== null && typeof data === "object" && typeof data.deletions === "number" ? data.deletions : 0;
      const truncated = data !== null && typeof data === "object" && data.truncated === true;
      const binary = data !== null && typeof data === "object" && data.binary === true;

      let body = null;
      if (state.loading === true) {
        body = h("div", { className: "dg-loading" }, t("diff.loading"));
      } else if (state.error !== null) {
        body = h("div", { className: "dg-empty" },
          h("div", { className: "dg-empty-title" }, t("diff.error")),
          h("div", { className: "dg-empty-body" }, describeFailure(t, "error.banner", state.error)),
          h("button", {
            type: "button",
            className: "dg-btn",
            onClick: function () {
              setAttempt(attempt + 1);
            },
          }, t("state.retry")));
      } else if (binary === true) {
        body = h("div", { className: "dg-empty" },
          h(FileGlyph, { className: "dg-empty-icon" }),
          h("div", { className: "dg-empty-body" }, t("diff.binary")));
      } else if (hunks.length === 0) {
        body = h("div", { className: "dg-empty" },
          h("div", { className: "dg-empty-body" }, t("diff.empty")));
      } else {
        body = h("div", { className: "dg-diff-body" },
          hunks.map(function (hunk, index) {
            return renderHunk(hunk, index);
          }));
      }

      const notices = [];
      if (hunkError !== null) {
        notices.push(h("div", { className: "dg-notice dg-notice-error", key: "hunk-error", role: "alert" }, hunkError));
      }
      if (notice !== null) {
        notices.push(h("div", { className: "dg-notice dg-notice-success", key: "hunk-notice", role: "status" }, notice));
      }

      return h("div", { className: "dg-diff" },
        h("div", { className: "dg-diff-head" },
          typeof props.onBack === "function"
            ? h("button", {
              type: "button",
              className: "dg-icon-btn",
              title: typeof props.backLabel === "string" ? props.backLabel : t("diff.back"),
              "aria-label": typeof props.backLabel === "string" ? props.backLabel : t("diff.back"),
              onClick: props.onBack,
            }, h(BackIcon))
            : null,
          h("span", { className: "dg-diff-path dg-mono", title: props.path }, props.path),
          h("span", { className: "dg-diff-mode" }, t(modeKey(props.mode))),
          data !== null && state.loading !== true && state.error === null
            ? h("span", { className: "dg-diff-stats" },
              h("span", { className: "dg-add" }, "+" + String(additions)),
              h("span", { className: "dg-del" }, "-" + String(deletions)))
            : null),
        truncated ? h("div", { className: "dg-diff-notice" }, t("diff.truncated")) : null,
        notices,
        body);
    }

    // -------------------------------------------------------------------------
    // Changes tab: commit box (amend + history), directory tree, row actions, diff
    // -------------------------------------------------------------------------

    function ChangesPane(props) {
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const status = props.status !== null && typeof props.status === "object" ? props.status : {};
      const staged = Array.isArray(status.staged) ? status.staged : [];
      const unstaged = Array.isArray(status.unstaged) ? status.unstaged : [];
      const untracked = Array.isArray(status.untracked) ? status.untracked : [];
      const conflicted = Array.isArray(status.conflicted) ? status.conflicted : [];

      const messageRef = React.useState("");
      const message = messageRef[0];
      const setMessage = messageRef[1];
      const busyRef = React.useState(null);
      const busy = busyRef[0];
      const setBusy = busyRef[1];
      const actionErrorRef = React.useState(null);
      const actionError = actionErrorRef[0];
      const setActionError = actionErrorRef[1];
      const noticeRef = React.useState(null);
      const notice = noticeRef[0];
      const setNotice = noticeRef[1];
      const diffRef = React.useState(null);
      const diff = diffRef[0];
      const setDiff = diffRef[1];
      const pendingDiscardRef = React.useState(null);
      const pendingDiscard = pendingDiscardRef[0];
      const setPendingDiscard = pendingDiscardRef[1];
      const statsRef = React.useState(null);
      const stats = statsRef[0];
      const setStats = statsRef[1];
      const expandedRef = React.useState(function () { return {}; });
      const expanded = expandedRef[0];
      const setExpanded = expandedRef[1];
      const amendRef = React.useState(false);
      const amend = amendRef[0];
      const setAmend = amendRef[1];
      const historyRef = React.useState(function () { return readCommitHistory(); });
      const commitHistory = historyRef[0];
      const setCommitHistory = historyRef[1];

      const hasChanges = staged.length > 0 || unstaged.length > 0;
      const canCommit = message.trim().length > 0 && (hasChanges || amend === true);
      const autoStageAll = staged.length === 0 && unstaged.length > 0 && amend !== true;

      /** Per-file +N/-N comes from one batched GET /git/stats. */
      const refreshStats = React.useCallback(function () {
        if (!isNonEmptyString(props.cwd)) return;
        api.stats(props.cwd).then(function (payload) {
          setStats(payload !== null && typeof payload === "object" ? payload : null);
        }, function () {
          setStats(null);
        });
      }, [props.cwd]);

      React.useEffect(function () {
        refreshStats();
      }, [refreshStats, props.status]);

      React.useEffect(function () {
        if (notice === null) return undefined;
        const timer = setTimeout(function () {
          setNotice(null);
        }, NOTICE_MS);
        return function () {
          clearTimeout(timer);
        };
      }, [notice]);

      useEscape(diff !== null || pendingDiscard !== null, function () {
        if (pendingDiscard !== null) setPendingDiscard(null);
        else setDiff(null);
      });

      function notifyChanged() {
        if (typeof props.onChanged === "function") props.onChanged();
      }

      function runWrite(key, action) {
        setBusy(key);
        setActionError(null);
        setNotice(null);
        action().then(function () {
          setBusy(null);
          notifyChanged();
        }, function (error) {
          setBusy(null);
          setActionError(describeFailure(t, "changes.action.failed", error));
        });
      }

      function submitCommit() {
        if (busy !== null) return;
        const trimmed = message.trim();
        if (trimmed.length === 0) {
          setActionError(t("changes.commit.empty"));
          return;
        }
        if (!hasChanges && amend !== true) {
          setActionError(t("changes.commit.nothing"));
          return;
        }
        const amending = amend === true;
        runWrite("commit", function () {
          const request = amending ? api.amend(props.cwd, trimmed) : api.commitChanges(props.cwd, trimmed, autoStageAll);
          return request.then(function (payload) {
            setMessage("");
            setAmend(false);
            setCommitHistory(rememberCommitMessage(undefined, trimmed));
            const shortSha = payload !== null && typeof payload === "object" && isNonEmptyString(payload.shortSha)
              ? payload.shortSha
              : payload !== null && typeof payload === "object" && isNonEmptyString(payload.sha) ? payload.sha.slice(0, 7) : "";
            setNotice(amending
              ? t("changes.amend.success", { sha: shortSha })
              : t("changes.commit.success", { sha: shortSha }));
            setDiff(null);
            return payload;
          });
        });
      }

      function activate(row, event) {
        if (event !== null && event !== undefined && typeof event.stopPropagation === "function") {
          event.stopPropagation();
        }
        if (busy !== null) return;
        if (row.kind === "stage") runWrite("stage:" + row.path, function () { return api.stage(props.cwd, [row.path]); });
        else if (row.kind === "unstage") runWrite("unstage:" + row.path, function () { return api.unstage(props.cwd, [row.path]); });
        else if (row.kind === "discard") setPendingDiscard({ path: row.path, untracked: row.untracked === true });
      }

      function confirmDiscard() {
        const target = pendingDiscard;
        setPendingDiscard(null);
        if (target === null) return;
        runWrite("discard:" + target.path, function () {
          return api.discard(props.cwd, [target.path]).then(function (payload) {
            if (diff !== null && diff.path === target.path) setDiff(null);
            return payload;
          });
        });
      }

      function openDiff(path, mode) {
        if (isNonEmptyString(path)) setDiff({ path: path, mode: mode });
      }

      /** Collapse/expand one directory of one group; directories default to open. */
      function toggleDir(section, path) {
        const key = section + ":" + path;
        setExpanded(function (previous) {
          const next = Object.assign({}, previous);
          // Directories default to open, so a missing/true entry collapses and
          // an explicit false expands.
          next[key] = previous[key] === false;
          return next;
        });
      }

      /** +N/-N for one row, or null when the Host has no numbers for it. */
      function statFor(section, path) {
        if (stats === null || typeof stats !== "object") return null;
        const map = section === "staged"
          ? stats.staged
          : section === "unstaged" || section === "conflicted" ? stats.unstaged : null;
        if (map === null || map === undefined || typeof map !== "object") return null;
        const entry = map[path];
        if (entry === null || entry === undefined || typeof entry !== "object") return null;
        if (entry.binary === true) return { binary: true, additions: 0, deletions: 0 };
        const additions = typeof entry.additions === "number" ? entry.additions : null;
        const deletions = typeof entry.deletions === "number" ? entry.deletions : null;
        if (additions === null && deletions === null) return null;
        return { binary: false, additions: additions === null ? 0 : additions, deletions: deletions === null ? 0 : deletions };
      }

      function renderRow(item, group, depth) {
        const path = item !== null && typeof item === "object" && isNonEmptyString(item.path) ? item.path : "";
        if (path === "") return null;
        const origPath = item !== null && typeof item === "object" && isNonEmptyString(item.origPath) ? item.origPath : "";
        const meta = statusMeta(item ? item.status : "M", group.section);
        const selected = diff !== null && diff.path === path;
        const stat = statFor(group.section, path);
        const actions = [];
        for (let index = 0; index < group.actions.length; index += 1) {
          const kind = group.actions[index];
          const labelKey = kind === "stage"
            ? "changes.action.stage"
            : kind === "unstage"
              ? "changes.action.unstage"
              : "changes.action.discard";
          const key = kind === "unstage" ? "unstage:" + path : kind + ":" + path;
          actions.push(h("button", {
            key: kind,
            type: "button",
            className: "dg-mini-btn" + (kind === "discard" ? " dg-mini-btn-danger" : ""),
            disabled: busy !== null,
            title: t(labelKey),
            "aria-label": t(labelKey) + " " + path,
            onClick: function (event) {
              activate({ kind: kind, path: path, untracked: group.section === "untracked" }, event);
            },
          }, busy === key ? t("changes.action.busy") : t(labelKey)));
        }
        return h("div", {
          key: group.section + ":" + path,
          className: "dg-file-row dg-file-row-tone-" + meta.tone + (selected ? " dg-file-row-selected" : ""),
          role: "button",
          tabIndex: 0,
          "aria-pressed": selected ? "true" : "false",
          title: t("changes.row.open", { path: path }),
          style: { paddingLeft: String(5 + depth * 12) + "px" },
          onClick: function () {
            openDiff(path, group.diffMode);
          },
          onKeyDown: function (event) {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (typeof event.preventDefault === "function") event.preventDefault();
            openDiff(path, group.diffMode);
          },
        },
          h("span", { className: "dg-badge dg-badge-" + meta.tone, title: t(meta.labelKey) }, meta.letter),
          h("span", { className: "dg-file-name" },
            basename(path),
            origPath === "" ? null : h("span", { className: "dg-file-orig" }, " <- " + origPath)),
          stat === null
            ? null
            : stat.binary === true
              ? h("span", { className: "dg-numstat dg-muted" }, t("history.binary"))
              : h("span", { className: "dg-numstat" },
                h("span", { className: "dg-add" }, "+" + String(stat.additions)),
                h("span", { className: "dg-del" }, "-" + String(stat.deletions))),
          actions.length > 0 ? h("span", { className: "dg-row-actions" }, actions) : null);
      }

      function renderTreeNode(node, group, depth) {
        if (node === null || typeof node !== "object") return null;
        if (node.type !== "dir") return renderRow(node.entry, group, depth);
        const key = group.section + ":" + node.path;
        const open = expanded[key] !== false;
        return h("div", { className: "dg-tree-dir", key: "dir:" + key },
          h("div", {
            className: "dg-dir-row",
            role: "button",
            tabIndex: 0,
            "aria-expanded": open ? "true" : "false",
            "aria-label": t("changes.tree.toggle", { path: node.path }),
            title: t("changes.tree.toggle", { path: node.path }),
            style: { paddingLeft: String(5 + depth * 12) + "px" },
            onClick: function () {
              toggleDir(group.section, node.path);
            },
            onKeyDown: function (event) {
              if (event.key !== "Enter" && event.key !== " ") return;
              if (typeof event.preventDefault === "function") event.preventDefault();
              toggleDir(group.section, node.path);
            },
          },
            h("span", { className: "dg-dir-caret", "aria-hidden": "true" }, open ? "\u25be" : "\u25b8"),
            h("span", { className: "dg-dir-name" }, node.name),
            h("span", { className: "dg-dir-count" }, String(countTreeFiles(node)))),
          open
            ? h("div", { className: "dg-tree-children" }, node.children.map(function (child) {
              return renderTreeNode(child, group, depth + 1);
            }))
            : null);
      }

      const groups = [
        { section: "staged", titleKey: "changes.group.staged", items: staged, diffMode: "staged", actions: ["unstage"] },
        { section: "unstaged", titleKey: "changes.group.unstaged", items: unstaged, diffMode: "worktree", actions: ["stage", "discard"] },
        { section: "untracked", titleKey: "changes.group.untracked", items: untracked, diffMode: "untracked", actions: ["stage", "discard"] },
        { section: "conflicted", titleKey: "changes.group.conflicted", items: conflicted, diffMode: "worktree", actions: [] },
      ].filter(function (group) {
        return group.items.length > 0;
      }).map(function (group) {
        return {
          section: group.section,
          titleKey: group.titleKey,
          items: group.items,
          diffMode: group.diffMode,
          actions: group.actions,
          tree: buildChangeTree(group.items),
        };
      });

      let dirTotal = 0;
      let dirCollapsed = 0;
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const dirs = collectTreeDirs(groups[groupIndex].tree, []);
        for (let dirIndex = 0; dirIndex < dirs.length; dirIndex += 1) {
          dirTotal += 1;
          if (expanded[groups[groupIndex].section + ":" + dirs[dirIndex].path] === false) dirCollapsed += 1;
        }
      }
      const allCollapsed = dirTotal > 0 && dirCollapsed === dirTotal;

      const commitBox = h("div", { className: "dg-commit-box" },
        h("textarea", {
          className: "dg-textarea",
          value: message,
          placeholder: t("changes.commit.placeholder"),
          "aria-label": t("changes.commit.placeholder"),
          spellCheck: false,
          onChange: function (event) {
            setMessage(event.target.value);
          },
          onKeyDown: function (event) {
            if ((event.ctrlKey === true || event.metaKey === true) && event.key === "Enter") {
              if (typeof event.preventDefault === "function") event.preventDefault();
              submitCommit();
            }
          },
        }),
        h("div", { className: "dg-commit-options" },
          h("label", { className: "dg-amend", title: t("changes.amend.hint") },
            h("input", {
              type: "checkbox",
              className: "dg-amend-check",
              checked: amend === true,
              "aria-label": t("changes.amend"),
              onChange: function (event) {
                setAmend(event.target.checked === true);
              },
            }),
            h("span", { className: "dg-amend-label" }, t("changes.amend"))),
          amend === true ? h("span", { className: "dg-hint" }, t("changes.amend.hint")) : null),
        commitHistory.length === 0 ? null : h("div", { className: "dg-commit-history" },
          h("span", { className: "dg-commit-history-title" }, t("changes.commitHistory")),
          commitHistory.map(function (item, index) {
            return h("button", {
              key: "recent-" + String(index),
              type: "button",
              className: "dg-history-chip",
              title: item,
              onClick: function () {
                setMessage(item);
              },
            }, item);
          })),
        h("div", { className: "dg-commit-actions" },
          h("button", {
            type: "button",
            className: "dg-btn dg-btn-primary",
            disabled: !canCommit || busy !== null,
            onClick: submitCommit,
          }, busy === "commit"
            ? t("changes.commit.committing")
            : amend === true ? t("changes.amend.button") : t("changes.commit.button")),
          h("span", { className: "dg-hint" },
            conflicted.length > 0
              ? t("changes.conflict.hint")
              : autoStageAll ? t("changes.commit.all") : t("changes.commit.hint"))));

      const notices = [];
      if (actionError !== null) {
        notices.push(h("div", { className: "dg-notice dg-notice-error", key: "action-error", role: "alert" }, actionError));
      }
      if (notice !== null) {
        notices.push(h("div", { className: "dg-notice dg-notice-success", key: "notice", role: "status" }, notice));
      }
      if (allCollapsed) {
        notices.push(h("div", { className: "dg-notice dg-notice-info", key: "collapsed-hint", role: "status" }, t("changes.tree.collapsed")));
      }

      let listContent;
      if (groups.length === 0) {
        listContent = h("div", { className: "dg-empty" },
          h(CheckIcon, { className: "dg-empty-icon" }),
          h("div", { className: "dg-empty-title" }, t("changes.empty.title")),
          h("div", { className: "dg-empty-body" }, t("changes.empty.body")));
      } else {
        listContent = groups.map(function (group) {
          return h("div", { className: "dg-group", key: group.section },
            h("div", { className: "dg-group-head" },
              h("span", { className: "dg-group-title" }, t(group.titleKey)),
              h("span", { className: "dg-group-count" }, String(group.items.length))),
            h("div", { className: "dg-file-list" }, group.tree.map(function (node) {
              return renderTreeNode(node, group, 0);
            })));
        });
      }

      const confirmElement = pendingDiscard === null ? null : h("div", { className: "dg-confirm", role: "alertdialog", "aria-label": t("confirm.discard.title") },
        h(AlertIcon, { className: "dg-confirm-icon" }),
        h("div", { className: "dg-confirm-main" },
          h("div", { className: "dg-confirm-title" }, t("confirm.discard.title")),
          h("div", { className: "dg-confirm-body" },
            pendingDiscard.untracked === true
              ? t("confirm.discard.untracked", { path: pendingDiscard.path })
              : t("confirm.discard.tracked", { path: pendingDiscard.path }))),
        h("div", { className: "dg-confirm-actions" },
          h("button", { type: "button", className: "dg-btn", onClick: function () { setPendingDiscard(null); } }, t("confirm.cancel")),
          h("button", { type: "button", className: "dg-btn dg-btn-danger", onClick: confirmDiscard }, t("confirm.confirm"))));

      const bodyArea = diff === null
        ? h("div", { className: "dg-scroll dg-groups" }, listContent)
        : h("div", { className: "dg-diff-slot" }, h(DiffView, {
          cwd: props.cwd,
          path: diff.path,
          mode: diff.mode,
          t: t,
          onChanged: notifyChanged,
          onBack: function () {
            setDiff(null);
          },
        }));

      return h("div", { className: "dg-pane" }, confirmElement, commitBox, notices, bodyArea);
    }

    // -------------------------------------------------------------------------
    // History tab: branch filter, paged commit list, commit detail, file diff
    // -------------------------------------------------------------------------

    function CommitDetail(props) {
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const stateRef = React.useState({ loading: true, error: null, data: null });
      const state = stateRef[0];
      const setState = stateRef[1];
      const attemptRef = React.useState(0);
      const attempt = attemptRef[0];
      const setAttempt = attemptRef[1];
      const fileRef = React.useState(null);
      const file = fileRef[0];
      const setFile = fileRef[1];

      React.useEffect(function () {
        let cancelled = false;
        setState({ loading: true, error: null, data: null });
        api.commitDetail(props.cwd, props.sha).then(function (payload) {
          if (cancelled) return;
          setState({ loading: false, error: null, data: payload });
        }, function (error) {
          if (cancelled) return;
          setState({ loading: false, error: toApiError(error), data: null });
        });
        return function () {
          cancelled = true;
        };
      }, [props.cwd, props.sha, attempt]);

      useEscape(file !== null, function () {
        setFile(null);
      });

      if (file !== null) {
        return h(DiffView, {
          cwd: props.cwd,
          path: file.path,
          mode: "commit",
          rev: props.sha,
          t: t,
          onBack: function () {
            setFile(null);
          },
          backLabel: t("history.file.back"),
        });
      }

      const data = state.data;
      const commit = data !== null && typeof data === "object" && data.commit !== null && typeof data.commit === "object" ? data.commit : null;
      const files = data !== null && typeof data === "object" && Array.isArray(data.files) ? data.files : [];

      const head = h("div", { className: "dg-diff-head" },
        h("button", {
          type: "button",
          className: "dg-icon-btn",
          title: t("history.detail.back"),
          "aria-label": t("history.detail.back"),
          onClick: props.onBack,
        }, h(BackIcon)),
        h("span", { className: "dg-diff-path" }, t("history.detail.title")));

      if (state.loading === true) {
        return h("div", { className: "dg-detail" }, head, h("div", { className: "dg-loading" }, t("state.loading")));
      }
      if (state.error !== null || commit === null) {
        return h("div", { className: "dg-detail" },
          head,
          h("div", { className: "dg-empty" },
            h("div", { className: "dg-empty-title" }, t("diff.error")),
            h("div", { className: "dg-empty-body" }, state.error === null ? "" : describeFailure(t, "error.banner", state.error)),
            h("button", {
              type: "button",
              className: "dg-btn",
              onClick: function () {
                setAttempt(attempt + 1);
              },
            }, t("state.retry"))));
      }

      const refs = Array.isArray(commit.refs) ? commit.refs : [];
      const parents = Array.isArray(commit.parents) ? commit.parents : [];
      const rows = [];
      rows.push(detailRow(t("history.detail.sha"), h("span", { className: "dg-mono" }, isNonEmptyString(commit.sha) ? commit.sha : props.sha), "sha"));
      rows.push(detailRow(t("history.detail.author"),
        isNonEmptyString(commit.author) ? commit.author + (isNonEmptyString(commit.email) ? " <" + commit.email + ">" : "") : "",
        "author"));
      const relativeTime = formatRelativeTime(commit.time, Date.now(), t);
      const absoluteTime = formatAbsoluteTime(commit.time);
      const timeText = absoluteTime === ""
        ? relativeTime
        : relativeTime === "" ? absoluteTime : absoluteTime + "  (" + relativeTime + ")";
      rows.push(detailRow(t("history.detail.time"), timeText, "time"));
      if (refs.length > 0) {
        rows.push(detailRow(t("history.detail.refs"), h("span", { className: "dg-ref-list" }, refs.map(function (tag, index) {
          return refTagNode(tag, "ref-" + String(index));
        })), "refs"));
      }
      if (parents.length > 0) {
        rows.push(detailRow(t("history.detail.parents"), h("span", { className: "dg-mono" }, parents.map(function (parent, index) {
          return h("span", { key: "parent-" + String(index) }, (index > 0 ? " " : "") + String(parent).slice(0, 7));
        })), "parents"));
      }

      const fileRows = files.map(function (entry, index) {
        const path = entry !== null && typeof entry === "object" && isNonEmptyString(entry.path) ? entry.path : "";
        const meta = statusMeta(entry ? entry.status : "M", null);
        const binary = entry !== null && typeof entry === "object" && entry.binary === true;
        const additions = entry !== null && typeof entry === "object" && typeof entry.additions === "number" ? entry.additions : 0;
        const deletions = entry !== null && typeof entry === "object" && typeof entry.deletions === "number" ? entry.deletions : 0;
        return h("div", {
          className: "dg-file-table-row",
          key: "file-" + String(index),
          role: "button",
          tabIndex: 0,
          title: t("changes.row.open", { path: path }),
          onClick: function () {
            setFile({ path: path });
          },
          onKeyDown: function (event) {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (typeof event.preventDefault === "function") event.preventDefault();
            setFile({ path: path });
          },
        },
          h("span", { className: "dg-badge dg-badge-" + meta.tone, title: t(meta.labelKey) }, meta.letter),
          h("span", { className: "dg-file-name" }, path),
          h("span", { className: "dg-numstat" },
            binary
              ? h("span", { className: "dg-muted" }, t("history.binary"))
              : h(Fragment, null,
                h("span", { className: "dg-add" }, "+" + String(additions)),
                h("span", { className: "dg-del" }, "-" + String(deletions)))));
      });

      return h("div", { className: "dg-detail" },
        head,
        h("div", { className: "dg-detail-scroll" },
          h("div", { className: "dg-detail-title" }, isNonEmptyString(commit.subject) ? commit.subject : t("history.subject.empty")),
          h("div", { className: "dg-detail-grid" }, rows),
          h("div", { className: "dg-section-title" }, t("history.detail.message")),
          h("pre", { className: "dg-body-text" }, isNonEmptyString(commit.body) ? commit.body : t("history.detail.noMessage")),
          h("div", { className: "dg-section-title" }, t("history.files", { count: files.length })),
          files.length === 0
            ? h("div", { className: "dg-empty-body" }, t("history.files.empty"))
            : h("div", { className: "dg-file-table" }, fileRows)));
    }

    /** One label/value line in the commit detail grid. */
    function detailRow(label, value, key) {
      return h("div", { className: "dg-detail-row", key: key },
        h("span", { className: "dg-detail-label" }, label),
        h("span", { className: "dg-detail-value" }, value));
    }

    /**
     * History tab: branch tree + column commit list (design D1-D4, D7).
     *
     * The tree only changes the log range (GET /git/log?ref=); checking a branch
     * out stays an explicit toolbar action. A ResizeObserver on the panel root
     * folds the tree and drops columns on narrow widths; tests pass an explicit
     * `width` prop instead of driving a live observer.
     */
    function HistoryPane(rawProps) {
      const props = rawProps || {};
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const branchesRef = React.useState(null);
      const branches = branchesRef[0];
      const setBranches = branchesRef[1];
      const branchErrorRef = React.useState(null);
      const branchError = branchErrorRef[0];
      const setBranchError = branchErrorRef[1];
      const refNameRef = React.useState("HEAD");
      const refName = refNameRef[0];
      const setRefName = refNameRef[1];
      const filterRef = React.useState(function () {
        return { grep: "", author: "", path: "", since: "", until: "" };
      });
      const filters = filterRef[0];
      const setFilters = filterRef[1];
      const commitsRef = React.useState([]);
      const commits = commitsRef[0];
      const setCommits = commitsRef[1];
      const headSha = React.useMemo(function () {
        return headShaOf(commits);
      }, [commits]);
      // Lane layout for the current page; the HEAD life gets the accent colour.
      const graph = React.useMemo(function () {
        return computeLanes(commits, { maxLanes: GRAPH_MAX_LANES, headSha: headSha });
      }, [commits, headSha]);
      const hasMoreRef = React.useState(false);
      const hasMore = hasMoreRef[0];
      const setHasMore = hasMoreRef[1];
      const loadingRef = React.useState(true);
      const loading = loadingRef[0];
      const setLoading = loadingRef[1];
      const loadingMoreRef = React.useState(false);
      const loadingMore = loadingMoreRef[0];
      const setLoadingMore = loadingMoreRef[1];
      const logErrorRef = React.useState(null);
      const logError = logErrorRef[0];
      const setLogError = logErrorRef[1];
      const detailRef = React.useState(null);
      const detail = detailRef[0];
      const setDetail = detailRef[1];
      const switchBusyRef = React.useState(false);
      const switchBusy = switchBusyRef[0];
      const setSwitchBusy = switchBusyRef[1];
      const switchErrorRef = React.useState(null);
      const switchError = switchErrorRef[0];
      const setSwitchError = switchErrorRef[1];
      const noticeRef = React.useState(null);
      const notice = noticeRef[0];
      const setNotice = noticeRef[1];
      const tokenRef = React.useState(0);
      const token = tokenRef[0];
      const setToken = tokenRef[1];
      const treeOpenRef = React.useState(false);
      const treeOpen = treeOpenRef[0];
      const setTreeOpen = treeOpenRef[1];
      const measuredWidthRef = React.useState(HISTORY_DEFAULT_WIDTH);
      const measuredWidth = measuredWidthRef[0];
      const setMeasuredWidth = measuredWidthRef[1];
      const activeRef = React.useState(0);
      const activeIndex = activeRef[0];
      const setActiveIndex = activeRef[1];

      const seqRef = React.useRef(0);
      const appendingRef = React.useRef(false);
      const refreshTokenRef = React.useRef(props.refreshToken);
      const commitsLenRef = React.useRef(0);
      const rootNodeRef = React.useRef(null);
      const rowNodesRef = React.useRef({});
      commitsLenRef.current = commits.length;

      const width = typeof props.width === "number" && Number.isFinite(props.width) && props.width > 0
        ? props.width
        : measuredWidth;
      const layout = resolveHistoryLayout(width);
      const treeCollapsed = layout.treeCollapsed === true;
      const treeVisible = treeCollapsed !== true || treeOpen === true;
      const logFilters = summarizeHistoryFilters(filters);
      const filterActive = logFilters.active === true;
      const rangeLabel = refName === "HEAD" ? t("history.head") : refName;

      React.useEffect(function () {
        let cancelled = false;
        api.branches(props.cwd).then(function (payload) {
          if (cancelled) return;
          setBranches(payload);
          setBranchError(null);
        }, function (error) {
          if (cancelled) return;
          setBranches(null);
          setBranchError(toApiError(error));
        });
        return function () {
          cancelled = true;
        };
      }, [props.cwd, token]);

      // Layout signal for the two-column split (design D1/D3). The browser drives
      // it with a ResizeObserver; the hook harness has neither DOM nodes nor a
      // ResizeObserver, so the default width stands and the `width` prop overrides.
      React.useEffect(function () {
        if (typeof props.width === "number" && Number.isFinite(props.width)) return undefined;
        const node = rootNodeRef.current;
        if (node === null || node === undefined) return undefined;
        if (typeof ResizeObserver === "function") {
          const observer = new ResizeObserver(function (entries) {
            const entry = Array.isArray(entries) && entries.length > 0 ? entries[0] : null;
            const rect = entry !== null && entry !== undefined && entry.contentRect !== null && typeof entry.contentRect === "object"
              ? entry.contentRect
              : null;
            if (rect === null || typeof rect.width !== "number" || rect.width <= 0) return;
            setMeasuredWidth(rect.width);
          });
          observer.observe(node);
          return function () {
            observer.disconnect();
          };
        }
        if (typeof node.getBoundingClientRect === "function") {
          const rect = node.getBoundingClientRect();
          if (rect !== null && typeof rect === "object" && typeof rect.width === "number" && rect.width > 0) {
            setMeasuredWidth(rect.width);
          }
        }
        return undefined;
      }, []);

      React.useEffect(function () {
        if (refreshTokenRef.current === props.refreshToken) return undefined;
        refreshTokenRef.current = props.refreshToken;
        setToken(function (value) {
          return value + 1;
        });
        return undefined;
      }, [props.refreshToken]);

      React.useEffect(function () {
        if (notice === null) return undefined;
        const timer = setTimeout(function () {
          setNotice(null);
        }, NOTICE_MS);
        return function () {
          clearTimeout(timer);
        };
      }, [notice]);

      const loadPage = React.useCallback(function (append) {
        if (append === true && appendingRef.current === true) return;
        const seq = seqRef.current + 1;
        seqRef.current = seq;
        if (append === true) {
          appendingRef.current = true;
          setLoadingMore(true);
        } else {
          setLoading(true);
        }
        const skip = append === true ? commitsLenRef.current : 0;
        const query = logQueryParams(filters);
        api.log(props.cwd, {
          limit: LOG_LIMIT,
          skip: skip,
          ref: refName,
          grep: query.grep,
          author: query.author,
          path: query.path,
          since: query.since,
          until: query.until,
        }).then(function (payload) {
          if (seqRef.current !== seq) return;
          const list = payload !== null && typeof payload === "object" && Array.isArray(payload.commits) ? payload.commits : [];
          setLogError(null);
          setHasMore(payload !== null && typeof payload === "object" && payload.hasMore === true);
          setCommits(function (previous) {
            return append === true ? previous.concat(list) : list;
          });
          setLoading(false);
          setLoadingMore(false);
          appendingRef.current = false;
        }, function (error) {
          if (seqRef.current !== seq) return;
          setLogError(toApiError(error));
          if (append !== true) setCommits([]);
          setLoading(false);
          setLoadingMore(false);
          appendingRef.current = false;
        });
      }, [props.cwd, refName, filters.grep, filters.author, filters.path, filters.since, filters.until]);

      React.useEffect(function () {
        loadPage(false);
      }, [loadPage, token]);

      // Keep the keyboard selection inside the list as filters and pages change.
      React.useEffect(function () {
        if (commits.length === 0) {
          if (activeIndex !== 0) setActiveIndex(0);
          return;
        }
        if (activeIndex > commits.length - 1) setActiveIndex(commits.length - 1);
      }, [commits.length, activeIndex]);

      useEscape(detail !== null, function () {
        setDetail(null);
      });

      function updateFilter(name, value) {
        const next = typeof value === "string" ? value : "";
        setFilters(function (previous) {
          if (previous[name] === next) return previous;
          const updated = {
            grep: previous.grep,
            author: previous.author,
            path: previous.path,
            since: previous.since,
            until: previous.until,
          };
          updated[name] = next;
          return updated;
        });
      }

      function clearFilters() {
        setFilters({ grep: "", author: "", path: "", since: "", until: "" });
      }

      function checkoutRange() {
        if (refName === "HEAD" || switchBusy === true) return;
        const target = refName;
        setSwitchBusy(true);
        setSwitchError(null);
        setNotice(null);
        api.checkout(props.cwd, target).then(function () {
          setSwitchBusy(false);
          setNotice(t("branch.switch.success", { branch: target }));
          setToken(function (value) {
            return value + 1;
          });
          if (typeof props.onChanged === "function") props.onChanged();
        }, function (error) {
          setSwitchBusy(false);
          setSwitchError(describeFailure(t, "branch.switch.failed", error));
        });
      }

      function onScroll(event) {
        const node = event.currentTarget;
        if (node === null || node === undefined) return;
        if (hasMore !== true || loading === true || loadingMore === true) return;
        const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
        if (remaining <= SCROLL_SLACK) loadPage(true);
      }

      // The row DOM node is only reachable through the ref callback; the hook
      // harness never mounts DOM, so every scroll is guarded (design D7).
      function scrollRowIntoView(index) {
        const nodes = rowNodesRef.current;
        const node = nodes !== null && typeof nodes === "object" ? nodes[index] : null;
        if (node === null || node === undefined) return;
        if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
      }

      function moveActive(next) {
        const count = commits.length;
        if (count === 0) return;
        const clamped = next < 0 ? 0 : next > count - 1 ? count - 1 : next;
        setActiveIndex(clamped);
        scrollRowIntoView(clamped);
      }

      function jumpToHead() {
        const index = indexOfHeadCommit(commits, headSha);
        if (index < 0) return;
        setActiveIndex(index);
        scrollRowIntoView(index);
      }

      function onListKeyDown(event) {
        if (event === null || event === undefined || typeof event.key !== "string") return;
        const count = commits.length;
        if (count === 0) return;
        if (event.key === "Enter") {
          if (typeof event.preventDefault === "function") event.preventDefault();
          const commit = commits[activeIndex];
          const sha = commit !== null && typeof commit === "object" && isNonEmptyString(commit.sha) ? commit.sha : "";
          if (sha !== "") setDetail({ sha: sha });
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (event.key === "ArrowDown") moveActive(activeIndex + 1);
        else if (event.key === "ArrowUp") moveActive(activeIndex - 1);
        else if (event.key === "Home") moveActive(0);
        else moveActive(count - 1);
      }

      if (detail !== null) {
        return h("div", { className: "dg-history" },
          h(CommitDetail, {
            cwd: props.cwd,
            sha: detail.sha,
            t: t,
            onBack: function () {
              setDetail(null);
            },
          }));
      }

      const options = [h("option", { key: "HEAD", value: "HEAD" }, t("history.head"))];
      const local = branches !== null && typeof branches === "object" && Array.isArray(branches.local) ? branches.local : [];
      const remote = branches !== null && typeof branches === "object" && Array.isArray(branches.remote) ? branches.remote : [];
      for (let index = 0; index < local.length; index += 1) {
        const branch = local[index];
        if (branch === null || typeof branch !== "object" || !isNonEmptyString(branch.name)) continue;
        options.push(h("option", { key: "local-" + branch.name, value: branch.name },
          branch.name + (branch.isCurrent === true ? " *" : "")));
      }
      for (let index = 0; index < remote.length; index += 1) {
        const branch = remote[index];
        if (branch === null || typeof branch !== "object" || !isNonEmptyString(branch.name)) continue;
        options.push(h("option", { key: "remote-" + branch.name, value: branch.name }, branch.name));
      }

      const currentName = branches !== null && typeof branches === "object" && isNonEmptyString(branches.current) ? branches.current : "";
      const detached = branches !== null && typeof branches === "object" && branches.detached === true;

      function treeItem(value, label, options_) {
        const opts = options_ === null || options_ === undefined ? {} : options_;
        const selected = refName === value;
        const classes = ["dg-history-tree-item"];
        if (selected === true) classes.push("dg-history-tree-item-current");
        const aria = isNonEmptyString(opts.aria) ? opts.aria : t("history.tree.entry", { branch: label });
        return h("button", {
          type: "button",
          key: opts.key,
          className: classes.join(" "),
          title: aria,
          "aria-label": aria,
          "aria-current": selected === true ? "true" : undefined,
          onClick: function () {
            setRefName(value);
            if (treeCollapsed === true) setTreeOpen(false);
          },
        },
          h("span", { className: "dg-history-tree-dot dg-history-tree-dot-" + (opts.tone === undefined ? "local" : opts.tone), "aria-hidden": "true" }),
          h("span", { className: "dg-history-tree-name" }, label),
          opts.current === true ? h("span", { className: "dg-history-tree-check", "aria-hidden": "true" }, "\u2713") : null);
      }

      function treeStatus(text, key) {
        return h("div", { className: "dg-history-tree-status", key: key }, text);
      }

      const treeNodes = [treeItem("HEAD", t("history.tree.all"), { key: "range-all", tone: "head", aria: t("history.tree.all") })];
      if (branches === null || typeof branches !== "object") {
        treeNodes.push(treeStatus(branchError !== null ? t("history.tree.error") : t("history.tree.loading"), "tree-status"));
      } else {
        const headItems = [];
        if (detached === true) {
          headItems.push(treeItem("HEAD", t("summary.detachedHead"), { key: "head-detached", tone: "head", current: true }));
        } else if (currentName !== "") {
          headItems.push(treeItem(currentName, currentName, { key: "head-branch", tone: "head", current: true }));
        }
        treeNodes.push(h("div", { className: "dg-history-tree-group", key: "group-head" },
          h("div", { className: "dg-history-tree-title" }, t("history.tree.head")),
          headItems.length === 0 ? treeStatus(t("history.tree.empty"), "head-empty") : headItems));
        const localItems = [];
        for (let index = 0; index < local.length; index += 1) {
          const branch = local[index];
          if (branch === null || typeof branch !== "object" || !isNonEmptyString(branch.name)) continue;
          const isCurrent = branch.isCurrent === true || branch.name === currentName;
          localItems.push(treeItem(branch.name, branch.name, {
            key: "local-" + branch.name,
            tone: "local",
            current: isCurrent,
          }));
        }
        treeNodes.push(h("div", { className: "dg-history-tree-group", key: "group-local" },
          h("div", { className: "dg-history-tree-title" }, t("history.tree.local")),
          localItems.length === 0 ? treeStatus(t("history.tree.empty"), "local-empty") : localItems));
        const remoteItems = [];
        for (let index = 0; index < remote.length; index += 1) {
          const branch = remote[index];
          if (branch === null || typeof branch !== "object" || !isNonEmptyString(branch.name)) continue;
          remoteItems.push(treeItem(branch.name, branch.name, { key: "remote-" + branch.name, tone: "remote" }));
        }
        treeNodes.push(h("div", { className: "dg-history-tree-group", key: "group-remote" },
          h("div", { className: "dg-history-tree-title" }, t("history.tree.remote")),
          remoteItems.length === 0 ? treeStatus(t("history.tree.empty"), "remote-empty") : remoteItems));
      }

      const tree = h("aside", {
        className: "dg-history-tree" + (treeCollapsed === true ? " dg-history-tree-pop" : ""),
        "aria-label": t("history.tree.title"),
      }, treeNodes);

      const header = h("div", { className: "dg-history-head" },
        h("select", {
          className: "dg-select",
          value: refName,
          title: t("history.refRange"),
          "aria-label": t("history.refRange"),
          onChange: function (event) {
            setRefName(event.target.value);
          },
        }, options),
        h("button", {
          type: "button",
          className: "dg-btn dg-checkout-btn",
          disabled: refName === "HEAD" || switchBusy === true,
          title: refName === "HEAD"
            ? t("history.checkout.hint")
            : t("history.checkout.title", { branch: refName }),
          "aria-label": refName === "HEAD"
            ? t("history.checkout.hint")
            : t("history.checkout.title", { branch: refName }),
          onClick: checkoutRange,
        }, switchBusy === true ? t("changes.action.busy") : t("history.checkout.button")),
        h("button", {
          type: "button",
          className: "dg-icon-btn",
          title: t("summary.refresh"),
          "aria-label": t("summary.refresh"),
          onClick: function () {
            setToken(token + 1);
          },
        }, h(RefreshIcon)),
        h("button", {
          type: "button",
          className: "dg-icon-btn dg-history-jump",
          title: t("history.jumpToHead"),
          "aria-label": t("history.jumpToHead"),
          disabled: commits.length === 0,
          onClick: jumpToHead,
        }, h(JumpHeadIcon)),
        treeCollapsed === true
          ? h("button", {
            type: "button",
            className: "dg-btn dg-history-tree-toggle",
            "aria-label": t("history.tree.toggle"),
            "aria-expanded": treeOpen === true ? "true" : "false",
            title: t("history.tree.toggle"),
            onClick: function () {
              setTreeOpen(treeOpen !== true);
            },
          }, t("history.tree.title"))
          : null);

      const filterBar = h("div", { className: "dg-history-filters" },
        h("input", {
          className: "dg-filter-input",
          value: filters.grep,
          placeholder: t("history.filter.grep"),
          title: t("history.filter.grep"),
          "aria-label": t("history.filter.grep"),
          spellCheck: false,
          onChange: function (event) {
            updateFilter("grep", event.target.value);
          },
        }),
        h("input", {
          className: "dg-filter-input",
          value: filters.author,
          placeholder: t("history.filter.author"),
          title: t("history.filter.author"),
          "aria-label": t("history.filter.author"),
          spellCheck: false,
          onChange: function (event) {
            updateFilter("author", event.target.value);
          },
        }),
        h("input", {
          className: "dg-filter-input",
          value: filters.path,
          placeholder: t("history.filter.path"),
          title: t("history.filter.path"),
          "aria-label": t("history.filter.path"),
          spellCheck: false,
          onChange: function (event) {
            updateFilter("path", event.target.value);
          },
        }),
        h("input", {
          type: "date",
          className: "dg-filter-input dg-filter-date",
          value: filters.since,
          title: t("history.filter.since"),
          "aria-label": t("history.filter.since"),
          onChange: function (event) {
            updateFilter("since", event.target.value);
          },
        }),
        h("input", {
          type: "date",
          className: "dg-filter-input dg-filter-date",
          value: filters.until,
          title: t("history.filter.until"),
          "aria-label": t("history.filter.until"),
          onChange: function (event) {
            updateFilter("until", event.target.value);
          },
        }),
        h("button", {
          type: "button",
          className: "dg-link-btn dg-filter-clear",
          disabled: filterActive !== true,
          title: t("history.filter.clear"),
          onClick: clearFilters,
        }, t("history.filter.clear")),
        filterActive ? h("span", { className: "dg-filter-active" }, t("history.filter.active")) : null);

      const banners = [];
      if (logError !== null || branchError !== null) {
        banners.push(h("div", { className: "dg-error-banner", key: "log-error", role: "alert" },
          h(AlertIcon, { className: "dg-error-icon" }),
          h("span", { className: "dg-error-text" }, describeFailure(t, "error.banner", logError !== null ? logError : branchError)),
          h("button", {
            type: "button",
            className: "dg-link-btn",
            onClick: function () {
              setToken(token + 1);
            },
          }, t("state.retry"))));
      }
      if (switchError !== null) {
        banners.push(h("div", { className: "dg-notice dg-notice-error", key: "switch-error", role: "alert" }, switchError));
      }
      if (notice !== null) {
        banners.push(h("div", { className: "dg-notice dg-notice-success", key: "switch-notice", role: "status" }, notice));
      }
      if (graph.maxLanes >= GRAPH_MAX_LANES) {
        banners.push(h("div", { className: "dg-diff-notice", key: "lanes-truncated" }, t("history.lanes.truncated", { max: GRAPH_MAX_LANES })));
      }

      const commitRows = commits.map(function (commit, index) {
        const safe = commit !== null && typeof commit === "object" ? commit : {};
        const sha = isNonEmptyString(safe.sha) ? safe.sha : "";
        const shortSha = isNonEmptyString(safe.shortSha) ? safe.shortSha : sha.slice(0, 7);
        const subject = isNonEmptyString(safe.subject) ? safe.subject : t("history.subject.empty");
        const refs = Array.isArray(safe.refs) ? safe.refs : [];
        const author = isNonEmptyString(safe.author) ? safe.author : "";
        const time = safe.time;
        const parents = Array.isArray(safe.parents) ? safe.parents : [];
        const isMerge = parents.length > 1;
        const isHead = headSha !== "" && sha === headSha;
        const row = graph.rows[index];
        const rowWidth = row !== null && row !== undefined && typeof row.width === "number" && Number.isFinite(row.width) ? row.width : 1;
        const graphWidth = Math.max(1, rowWidth) * GRAPH_LANE_WIDTH;
        const rowClasses = ["dg-commit-row"];
        if (isHead === true) {
          rowClasses.push("dg-commit-row-head");
          rowClasses.push("dg-commit-head");
        }
        if (isMerge === true) rowClasses.push("dg-commit-merge");
        if (index === activeIndex) rowClasses.push("dg-commit-active");
        const relative = time === null || time === undefined ? "" : formatRelativeTime(time, Date.now(), t);
        const absolute = time === null || time === undefined ? "" : formatCommitDate(time);
        return h("div", {
          className: rowClasses.join(" "),
          key: sha === "" ? "commit-" + String(index) : sha,
          role: "button",
          tabIndex: -1,
          style: { gridTemplateColumns: graphWidth + "px minmax(0,1fr) auto auto auto" },
          title: subject,
          "aria-current": isHead === true ? "true" : undefined,
          ref: function (node) {
            rowNodesRef.current[index] = node;
          },
          onClick: function () {
            setActiveIndex(index);
            setDetail({ sha: sha });
          },
          onKeyDown: function (event) {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (typeof event.preventDefault === "function") event.preventDefault();
            setActiveIndex(index);
            setDetail({ sha: sha });
          },
        },
          h(CommitGraph, {
            row: row,
            rowKey: sha === "" ? index : sha,
            headLabel: isHead === true ? t("graph.headLabel") : undefined,
          }),
          h("div", { className: "dg-commit-main" },
            h("span", { className: "dg-commit-subject" }, subject),
            refs.length === 0 ? null : h("span", { className: "dg-commit-refs" }, refs.map(function (tag, refIndex) {
              return refTagNode(tag, "ref-" + String(refIndex));
            }))),
          h("span", { className: "dg-commit-author" }, author),
          h("span", { className: "dg-commit-date", title: relative }, absolute),
          h("span", { className: "dg-sha dg-commit-sha" }, shortSha));
      });

      let listContent;
      if (loading === true) {
        listContent = h("div", { className: "dg-loading" }, t("history.loading"));
      } else if (commits.length === 0) {
        if (logFilters.date === true) {
          listContent = h("div", { className: "dg-empty" },
            h("div", { className: "dg-empty-title" }, t("history.empty.dateRange")),
            h("button", {
              type: "button",
              className: "dg-link-btn",
              onClick: clearFilters,
            }, t("history.filter.clear")));
        } else if (logFilters.text === true) {
          listContent = h("div", { className: "dg-empty" },
            h("div", { className: "dg-empty-title" }, t("history.empty.filtered")),
            h("button", {
              type: "button",
              className: "dg-link-btn",
              onClick: clearFilters,
            }, t("history.filter.clear")));
        } else {
          listContent = h("div", { className: "dg-empty" },
            h("div", { className: "dg-empty-title" }, t("history.empty")));
        }
      } else {
        listContent = commitRows;
      }

      const listClasses = ["dg-commit-list"];
      if (layout.showAuthor !== true) listClasses.push("dg-hide-author");
      if (layout.showHash !== true) listClasses.push("dg-hide-hash");

      return h("div", { className: "dg-history", ref: rootNodeRef },
        header,
        filterBar,
        banners,
        h("div", { className: "dg-history-body" },
          treeVisible === true ? tree : null,
          h("div", { className: "dg-history-main" },
            h("div", { className: "dg-history-range", title: rangeLabel }, t("history.range", { ref: rangeLabel })),
            h("div", {
              className: listClasses.join(" "),
              tabIndex: 0,
              "aria-label": t("history.list.aria"),
              onScroll: onScroll,
              onKeyDown: onListKeyDown,
            },
              listContent,
              loadingMore === true ? h("div", { className: "dg-load-more" }, t("history.loadMore")) : null,
              loading !== true && loadingMore !== true && commits.length > 0 && hasMore !== true
                ? h("div", { className: "dg-load-more" }, t("history.noMore"))
                : null))));
    }

    // -------------------------------------------------------------------------
    // Commit graph (VSCode / gitk style lanes)
    // -------------------------------------------------------------------------

    /** Lane palette: eight hues that stay distinguishable on light and dark panels. */
    const LANE_COLORS = ["#4f9cf9", "#e3b341", "#3fb950", "#a371f7", "#f85149", "#39c5cf", "#db61a2", "#8b949e"];

    /** Colour of the branch life that contains HEAD (index `HEAD_COLOR`, one past the palette). */
    const GRAPH_HEAD_COLOR = "#f78166";

    /** Graph geometry, in CSS pixels; the commit row is exactly this tall. */
    const GRAPH_LANE_WIDTH = 14;
    const GRAPH_ROW_HEIGHT = 44;
    const GRAPH_MAX_LANES = 10;

    /** Default lane cap for one page of commits. */
    const DEFAULT_MAX_LANES = 12;
    /** Palette size; matches LANE_COLORS.length. */
    const PALETTE_SIZE = 8;
    /** Colour slot reserved for the HEAD branch life. */
    const HEAD_COLOR = PALETTE_SIZE;
    /** Sanitised empty parents list. */
    const NO_PARENTS = [];

/* ------------------------------------------------------------------------ */
/* helpers                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * @param {unknown} value
 * @returns {number} a positive integer, `DEFAULT_MAX_LANES` when unusable
 */
function normalizeMaxLanes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_LANES;
  const limit = Math.trunc(value);
  return limit < 1 ? 1 : limit;
}

/**
 * Sanitise a `parents` field: strings only, trimmed, non-empty, de-duplicated.
 *
 * @param {unknown} parents
 * @returns {string[]}
 */
function normalizeParents(parents) {
  if (!Array.isArray(parents)) return NO_PARENTS;
  const out = [];
  for (const value of parents) {
    if (typeof value !== "string") continue;
    const sha = value.trim();
    if (sha.length === 0 || out.indexOf(sha) >= 0) continue;
    out.push(sha);
  }
  return out;
}

/**
 * Pick the palette index used by the fewest live columns, lowest index on a
 * tie. Unused colours therefore come out in order 0, 1, 2, … and once every
 * colour is taken they keep cycling — two neighbouring lanes only share a
 * colour when the page really has more lanes than palette entries.
 *
 * @param {(string|null)[]} lanes
 * @param {(number|null)[]} colors
 * @returns {number}
 */
function allocColor(lanes, colors) {
  const counts = new Array(PALETTE_SIZE).fill(0);
  for (let i = 0; i < lanes.length; i += 1) {
    if (lanes[i] == null) continue;
    const color = colors[i];
    if (typeof color === "number" && color >= 0 && color < PALETTE_SIZE) counts[color] += 1;
  }
  let best = 0;
  for (let c = 1; c < PALETTE_SIZE; c += 1) {
    if (counts[c] < counts[best]) best = c;
  }
  return best;
}

/* ------------------------------------------------------------------------ */
/* computeLanes                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Lay out the commit graph lanes for a page of commits (newest → oldest).
 *
 * @param {Array<{ sha?: string, parents?: string[] }>} commits
 * @param {{ maxLanes?: number, headSha?: string }} [options] `headSha` marks the
 *   branch life that contains HEAD so it can use `HEAD_COLOR` end to end.
 * @returns {{
 *   maxLanes: number,
 *   rows: Array<{
 *     lane: number,
 *     width: number,
 *     passThrough: number[],
 *     entries: Array<{ col: number, fromLane: number }>,
 *     exits: Array<{ col: number, toCommit: string }>,
 *     merges: Array<{ from: number, to: number }>,
 *     color: number,
 *     laneColors: number[]
 *   }>
 * }}
 */
function computeLanes(commits, options = {}) {
  const limit = normalizeMaxLanes(options && typeof options === "object" ? options.maxLanes : undefined);
  const headSha = options && typeof options === "object" && typeof options.headSha === "string" ? options.headSha : "";
  const list = Array.isArray(commits) ? commits : [];

  /** `lanes[i]` = sha the column `i` expects next, or `null` when the slot is free. */
  const lanes = [];
  /** Colour index of the line currently living in column `i` (`null` when free). */
  const colors = [];

  const rows = [];
  let maxWidth = 0;

  for (const item of list) {
    const commit = item && typeof item === "object" ? item : {};
    const sha = typeof commit.sha === "string" ? commit.sha : "";
    const parents = normalizeParents(commit.parents);

    /* ---- 1. locate the column that this commit's dot lives in ----------- */
    let lane = lanes.indexOf(sha);
    let isNewColumn = false;
    if (lane < 0) {
      // Unknown commit (a branch tip, or the first commit of the page): take
      // the first column nobody waits for, else open a brand new column.
      lane = lanes.indexOf(null);
      if (lane < 0) {
        lane = lanes.length;
        lanes.push(null);
        colors.push(null);
      }
      lanes[lane] = sha;
      colors[lane] = headSha !== "" && sha === headSha ? HEAD_COLOR : allocColor(lanes, colors);
      isNewColumn = true;
    }
    const dotColor = typeof colors[lane] === "number" ? colors[lane] : 0;

    /* ---- 2. lines that come into the row from above --------------------- */
    const entries = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] == null) continue;
      if (i === lane && isNewColumn) continue; // a fresh column has no line above
      entries.push({ col: i, fromLane: i });
    }

    /* ---- 3. defensive: extra columns that also expect this commit ------- */
    // With the "reuse the existing column" rule below this never happens, but
    // if a caller hands us a list where a commit is expected twice, the extra
    // lines bend into the dot instead of being painted twice.
    const merges = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (i === lane || lanes[i] == null) continue;
      if (lanes[i] !== sha) continue;
      merges.push({ from: i, to: lane });
      lanes[i] = null;
      colors[i] = null;
    }

    /* ---- 4. hand the dot's column and the parents their continuations --- */
    lanes[lane] = null;
    const freedColor = colors[lane];
    colors[lane] = null;

    const targets = new Array(parents.length);
    for (let i = 0; i < parents.length; i += 1) {
      const parentSha = parents[i];
      let target = lanes.indexOf(parentSha);
      if (target < 0) {
        if (i === 0) {
          // The first parent keeps the dot's own column: the branch line runs
          // straight down and keeps its colour.
          target = lane;
        } else {
          // Further parents (merge / octopus) reuse a free column, which
          // includes the column the dot just vacated, else open a new one.
          target = lanes.indexOf(null);
          if (target < 0) {
            target = lanes.length;
            lanes.push(null);
            colors.push(null);
          }
        }
      }
      lanes[target] = parentSha;
      if (target === lane) {
        colors[target] = freedColor;
      } else if (colors[target] == null) {
        colors[target] = allocColor(lanes, colors);
      }
      targets[i] = target;
    }

    /* ---- 5. build the row ------------------------------------------------ */
    const passThrough = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (i === lane) continue;
      if (lanes[i] == null) continue;
      passThrough.push(i);
    }

    const exits = [];
    for (let i = 0; i < parents.length; i += 1) {
      exits.push({ col: targets[i], toCommit: parents[i] });
    }

    let width = lane + 1;
    for (const col of passThrough) if (col + 1 > width) width = col + 1;
    for (const entry of exits) if (entry.col + 1 > width) width = entry.col + 1;
    for (const merge of merges) {
      if (merge.from + 1 > width) width = merge.from + 1;
      if (merge.to + 1 > width) width = merge.to + 1;
    }
    if (width < 1) width = 1;
    if (width > limit) width = limit;

    const dotLane = lane < width ? lane : width - 1;

    const row = {
      lane: dotLane,
      width,
      passThrough: passThrough.filter((col) => col < width),
      entries: entries
        .filter((entry) => entry.col < width)
        .map((entry) => ({ col: entry.col, fromLane: entry.fromLane })),
      exits: exits.filter((exit) => exit.col < width),
      merges: merges.filter((merge) => merge.from < width && merge.to < width),
      color: dotColor,
      isHead: headSha !== "" && sha === headSha,
      laneColors: [],
    };
    for (let i = 0; i < width; i += 1) {
      // Free columns carry no line; `0` is just a type-correct placeholder.
      row.laneColors.push(typeof colors[i] === "number" ? colors[i] : 0);
    }
    // Keep the dot and the line of its own column in sync even when the column
    // was released this row (root commit / parent tracked elsewhere).
    if (typeof colors[dotLane] !== "number") row.laneColors[dotLane] = dotColor;

    rows.push(row);
    if (width > maxWidth) maxWidth = width;

    /* ---- 6. drop trailing free columns (indices stay stable) ------------- */
    while (lanes.length > 0 && lanes[lanes.length - 1] == null) {
      lanes.pop();
      colors.pop();
    }
  }

  return { rows, maxLanes: maxWidth };
}


    /**
     * One commit row's lane column.
     *
     * Drawing recipe (rows are one row tall, the dot sits at the vertical middle):
     *   - every column in `passThrough` draws a straight line top→bottom, except a
     *     column that is also an exit (that line only exists below the dot);
     *   - the dot column draws its upper half only when `entries` carries it, and
     *     its lower half only when `exits` carries it (a root commit has none);
     *   - every exit leaves the dot as a curve and lands on its column at the bottom,
     *     where the next row's `entries` picks the line up again.
     */
    function CommitGraph(props) {
      const row = props.row;
      const height = GRAPH_ROW_HEIGHT;
      const laneWidth = GRAPH_LANE_WIDTH;
      const middle = height / 2;
      if (row === null || row === undefined) {
        return h("span", { className: "dg-graph", style: { width: laneWidth + "px", height: height + "px" } });
      }
      const width = Math.max(1, row.width) * laneWidth;
      const palette = Array.isArray(row.laneColors) ? row.laneColors : [];
      const colourOf = function (column) {
        const index = typeof palette[column] === "number" ? palette[column] : 0;
        if (index === HEAD_COLOR) return GRAPH_HEAD_COLOR;
        return LANE_COLORS[((index % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
      };
      const centre = function (column) { return column * laneWidth + laneWidth / 2; };
      const lane = Math.max(0, row.lane | 0);
      const isHeadRow = row.isHead === true;
      const exits = Array.isArray(row.exits) ? row.exits : [];
      const entries = Array.isArray(row.entries) ? row.entries : [];
      const passThrough = Array.isArray(row.passThrough) ? row.passThrough : [];
      const keyPrefix = props.rowKey === undefined ? "" : String(props.rowKey) + ":";
      const exitColumns = new Set(exits.map(function (exit) { return exit.col; }));
      const shapes = [];

      // Straight lines: a pass-through column that also exits only exists below the dot.
      for (const column of passThrough) {
        const continues = exitColumns.has(column);
        shapes.push(h("line", {
          key: keyPrefix + "pass-" + String(column),
          x1: centre(column), x2: centre(column),
          y1: continues ? middle : 0, y2: height,
          stroke: colourOf(column), strokeWidth: 1.6, strokeLinecap: "round",
        }));
      }
      // The dot column: upper half from the incoming line, lower half into its first parent.
      const entersDot = entries.some(function (entry) { return entry.col === lane; });
      if (entersDot) {
        shapes.push(h("line", {
          key: keyPrefix + "in",
          x1: centre(lane), x2: centre(lane), y1: 0, y2: middle,
          stroke: colourOf(lane), strokeWidth: 1.6, strokeLinecap: "round",
        }));
      }
      if (exitColumns.has(lane)) {
        shapes.push(h("line", {
          key: keyPrefix + "out",
          x1: centre(lane), x2: centre(lane), y1: middle, y2: height,
          stroke: colourOf(lane), strokeWidth: 1.6, strokeLinecap: "round",
        }));
      }
      // Merge / fork curves: leave the dot and reach the other column at the row bottom.
      for (const exit of exits) {
        if (exit.col === lane) continue;
        const to = centre(exit.col);
        shapes.push(h("path", {
          key: keyPrefix + "exit-" + String(exit.col),
          d: "M " + centre(lane) + " " + middle + " C " + centre(lane) + " " + (middle + height / 4) + " " + to + " " + (middle + height / 4) + " " + to + " " + height,
          fill: "none", stroke: colourOf(exit.col), strokeWidth: 1.6, strokeLinecap: "round",
        }));
      }
      // Defensive folds (the stable-column model never produces them, but paint them
      // rather than drop a line if a caller ever hands one in).
      for (const merge of Array.isArray(row.merges) ? row.merges : []) {
        const from = centre(merge.from);
        shapes.push(h("path", {
          key: keyPrefix + "merge-" + String(merge.from),
          d: "M " + from + " 0 L " + from + " " + middle + " L " + centre(lane) + " " + middle,
          fill: "none", stroke: colourOf(merge.from), strokeWidth: 1.6, strokeLinecap: "round",
        }));
      }
      // HEAD gets a clearly larger dot plus a ring so it reads at a glance.
      if (isHeadRow) {
        shapes.push(h("circle", {
          key: keyPrefix + "dot-ring",
          className: "dg-graph-dot-ring",
          cx: centre(lane), cy: middle, r: 6.1,
          fill: "none", stroke: colourOf(lane), strokeWidth: 1.2, opacity: 0.6,
        }));
      }
      // The commit dot paints last so it covers the joins underneath it.
      shapes.push(h("circle", {
        key: keyPrefix + "dot",
        className: isHeadRow ? "dg-graph-dot dg-graph-dot-head" : "dg-graph-dot",
        cx: centre(lane), cy: middle, r: isHeadRow ? 4.8 : 3.6,
        fill: colourOf(lane),
        stroke: "var(--dsw-alias-bg-layer-1,#fff)",
        strokeWidth: isHeadRow ? 2.1 : 1.5,
      }));

      return h("span", {
        className: "dg-graph" + (isHeadRow ? " dg-graph-head" : ""),
        style: { width: width + "px", height: height + "px" },
        title: isHeadRow && typeof props.headLabel === "string" ? props.headLabel : undefined,
        "aria-hidden": "true",
      }, h("svg", {
        width: width, height: height, viewBox: "0 0 " + width + " " + height,
        className: "dg-graph-svg",
      }, shapes));
    }

    // -------------------------------------------------------------------------
    // Branch panel (the header chip's popover)
    // -------------------------------------------------------------------------

    /** Failure text for one Host error: the Host's own message comes first. */
    function failureMessage(error) {
      const failure = toApiError(error);
      return failure.detail !== "" ? failure.detail : failure.code;
    }

    /**
     * The header chip's popover: the current branch with its upstream/ahead/behind
     * and change summary, the switchable branch list (local and remote groups,
     * current branch ticked) and the create/rename/delete actions.
     *
     * Switching is a write: it goes through POST /git/checkout and refreshes both
     * status and branches. Failures keep the panel open and show the Host message.
     */
    function BranchPanel(rawProps) {
      const props = rawProps || {};
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const root = isNonEmptyString(props.root) ? props.root : "";
      const status = props.status !== null && typeof props.status === "object" ? props.status : {};

      const branchesRef = React.useState(null);
      const branches = branchesRef[0];
      const setBranches = branchesRef[1];
      const formRef = React.useState(function () { return { create: "", rename: null }; });
      const form = formRef[0];
      const setForm = formRef[1];
      const pendingDeleteRef = React.useState(null);
      const pendingDelete = pendingDeleteRef[0];
      const setPendingDelete = pendingDeleteRef[1];
      const busyRef = React.useState(null);
      const busy = busyRef[0];
      const setBusy = busyRef[1];
      const actionErrorRef = React.useState(null);
      const actionError = actionErrorRef[0];
      const setActionError = actionErrorRef[1];
      const noticeRef = React.useState(null);
      const notice = noticeRef[0];
      const setNotice = noticeRef[1];
      const mountedRef = React.useRef(false);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      const loadBranches = React.useCallback(function () {
        if (root === "") return;
        api.branches(root).then(function (payload) {
          if (!mountedRef.current) return;
          setBranches(payload !== null && typeof payload === "object" ? payload : null);
        }, function () {
          if (!mountedRef.current) return;
          setBranches(null);
        });
      }, [root]);

      React.useEffect(function () {
        loadBranches();
      }, [loadBranches]);

      React.useEffect(function () {
        if (notice === null) return undefined;
        const timer = setTimeout(function () {
          setNotice(null);
        }, NOTICE_MS);
        return function () {
          clearTimeout(timer);
        };
      }, [notice]);

      function refreshAll() {
        loadBranches();
        if (typeof props.onChanged === "function") props.onChanged();
      }

      function begin(key) {
        setBusy(key);
        setActionError(null);
        setNotice(null);
      }

      function switchTo(name) {
        if (busy !== null || !isNonEmptyString(name)) return;
        begin("switch:" + name);
        api.checkout(root, name).then(function () {
          if (!mountedRef.current) return;
          setBusy(null);
          setActionError(null);
          setNotice(t("branch.switch.success", { branch: name }));
          refreshAll();
        }, function (error) {
          if (!mountedRef.current) return;
          setBusy(null);
          setNotice(null);
          setActionError({
            key: "branch.switch.failed",
            message: failureMessage(error),
            retry: function () { switchTo(name); },
          });
        });
      }

      function createBranch() {
        if (busy !== null) return;
        const name = form.create.trim();
        if (name === "") {
          setActionError({ key: "branch.create.failed", message: t("branch.name.empty"), retry: null });
          return;
        }
        begin("create");
        api.branchAction(root, "create", { name: name }).then(function () {
          if (!mountedRef.current) return;
          setBusy(null);
          setForm(function (previous) { return { create: "", rename: previous.rename }; });
          setNotice(t("branch.create.success", { branch: name }));
          refreshAll();
        }, function (error) {
          if (!mountedRef.current) return;
          setBusy(null);
          setActionError({
            key: "branch.create.failed",
            message: failureMessage(error),
            retry: function () { createBranch(); },
          });
        });
      }

      function confirmRename() {
        const rename = form.rename;
        if (rename === null || busy !== null) return;
        const next = rename.value.trim();
        if (next === "" || next === rename.name) {
          setForm(function (previous) { return { create: previous.create, rename: null }; });
          return;
        }
        begin("rename:" + rename.name);
        api.branchAction(root, "rename", { name: rename.name, newName: next }).then(function () {
          if (!mountedRef.current) return;
          setBusy(null);
          setForm(function (previous) { return { create: previous.create, rename: null }; });
          setNotice(t("branch.rename.success", { from: rename.name, to: next }));
          refreshAll();
        }, function (error) {
          if (!mountedRef.current) return;
          setBusy(null);
          setActionError({
            key: "branch.rename.failed",
            message: failureMessage(error),
            retry: function () { confirmRename(); },
          });
        });
      }

      function deleteBranch(name, force) {
        if (busy !== null || !isNonEmptyString(name)) return;
        begin("delete:" + name);
        api.branchAction(root, "delete", { name: name, force: force === true }).then(function () {
          if (!mountedRef.current) return;
          setBusy(null);
          setPendingDelete(null);
          setNotice(t("branch.delete.success", { branch: name }));
          refreshAll();
        }, function (error) {
          if (!mountedRef.current) return;
          setBusy(null);
          const failure = toApiError(error);
          const message = failure.detail !== "" ? failure.detail : failure.code;
          // An unmerged branch only needs the explicit force confirmation; a
          // conflict (e.g. the current branch) is a plain failure.
          if (force !== true && failure.code !== "conflict") {
            setPendingDelete({ name: name, force: true, unmerged: true, message: message });
            return;
          }
          setPendingDelete(null);
          setActionError({
            key: "branch.delete.failed",
            message: message,
            retry: function () { deleteBranch(name, force); },
          });
        });
      }

      const branch = status.branch !== null && typeof status.branch === "object" ? status.branch : null;
      const counts = status.counts !== null && typeof status.counts === "object" ? status.counts : null;
      const currentName = branch !== null && isNonEmptyString(branch.name) ? branch.name : "";
      const detached = branch !== null && branch.detached === true;
      const ahead = branch === null ? 0 : toCount(branch.ahead);
      const behind = branch === null ? 0 : toCount(branch.behind);
      const upstreamInfo = resolveUpstream(branch, branches, currentName);
      const stagedCount = counts === null ? 0 : toCount(counts.staged);
      const unstagedCount = counts === null ? 0 : toCount(counts.unstaged);
      const untrackedCount = counts === null ? 0 : toCount(counts.untracked);
      const conflictedCount = counts === null ? 0 : toCount(counts.conflicted);
      const label = detached || currentName === "" ? t("chip.detached") : currentName;

      const local = branches !== null && typeof branches === "object" && Array.isArray(branches.local) ? branches.local : [];
      const remote = branches !== null && typeof branches === "object" && Array.isArray(branches.remote) ? branches.remote : [];

      function renderBranchRow(entry, groupId) {
        if (entry === null || typeof entry !== "object" || !isNonEmptyString(entry.name)) return null;
        const name = entry.name;
        const isCurrent = entry.isCurrent === true || (groupId === "local" && name === currentName);
        if (form.rename !== null && form.rename.name === name) {
          return h("div", { className: "dg-branch-rename", key: groupId + ":" + name },
            h("input", {
              className: "dg-pop-input",
              value: form.rename.value,
              "aria-label": t("branch.rename.placeholder"),
              onChange: function (event) {
                const value = event.target.value;
                setForm(function (previous) {
                  return {
                    create: previous.create,
                    rename: previous.rename === null ? null : { name: previous.rename.name, value: value },
                  };
                });
              },
              onKeyDown: function (event) {
                if (event.key !== "Enter" && event.key !== "Escape") return;
                if (typeof event.preventDefault === "function") event.preventDefault();
                if (event.key === "Escape") setForm(function (previous) { return { create: previous.create, rename: null }; });
                else confirmRename();
              },
            }),
            h("button", { type: "button", className: "dg-btn", disabled: busy !== null, onClick: confirmRename }, t("branch.rename.confirm")),
            h("button", {
              type: "button",
              className: "dg-mini-btn",
              onClick: function () {
                setForm(function (previous) { return { create: previous.create, rename: null }; });
              },
            }, t("branch.rename.cancel")));
        }
        const aheadEntry = toCount(entry.ahead);
        const behindEntry = toCount(entry.behind);
        return h("div", { className: "dg-branch-row" + (isCurrent ? " dg-branch-current" : ""), key: groupId + ":" + name },
          h("button", {
            type: "button",
            className: "dg-branch-pick",
            // Remote-tracking refs are reference-only: checking one out directly
            // would leave a detached HEAD, which is never what the click means.
            disabled: isCurrent === true || busy !== null || groupId === "remote",
            title: isCurrent === true
              ? t("branch.current.tag")
              : groupId === "remote"
                ? t("branch.remote.readonly", { branch: name })
                : t("branch.switch.row", { branch: name }),
            "aria-label": isCurrent === true
              ? t("branch.current.aria", { branch: name })
              : groupId === "remote"
                ? t("branch.remote.readonly", { branch: name })
                : t("branch.switch.row", { branch: name }),
            onClick: function () {
              if (isCurrent !== true && groupId !== "remote") switchTo(name);
            },
          },
            h("span", { className: "dg-branch-dot" + (isCurrent === true ? " dg-branch-dot-current" : "") }),
            h("span", { className: "dg-branch-name" }, name),
            isCurrent === true ? h("span", { className: "dg-branch-check", "aria-hidden": "true" }, "\u2713") : null,
            busy === "switch:" + name ? h("span", { className: "dg-branch-busy" }, t("changes.action.busy")) : null,
            aheadEntry > 0 ? h("span", { className: "dg-chip-ahead" }, "\u2191" + String(aheadEntry)) : null,
            behindEntry > 0 ? h("span", { className: "dg-chip-behind" }, "\u2193" + String(behindEntry)) : null),
          groupId !== "local" ? null : h("span", { className: "dg-branch-actions" },
            isCurrent === true
              ? h("button", {
                type: "button",
                className: "dg-mini-btn",
                disabled: true,
                "aria-disabled": "true",
                title: t("branch.delete.current"),
                "aria-label": t("branch.delete.aria", { branch: name }),
              }, t("branch.delete.button"))
              : h(Fragment, null,
                h("button", {
                  type: "button",
                  className: "dg-mini-btn",
                  disabled: busy !== null,
                  title: t("branch.rename.button"),
                  "aria-label": t("branch.rename.aria", { branch: name }),
                  onClick: function () {
                    setForm({ create: form.create, rename: { name: name, value: name } });
                  },
                }, t("branch.rename.button")),
                h("button", {
                  type: "button",
                  className: "dg-mini-btn dg-mini-btn-danger",
                  disabled: busy !== null,
                  title: t("branch.delete.button"),
                  "aria-label": t("branch.delete.aria", { branch: name }),
                  onClick: function () {
                    setPendingDelete({ name: name, force: false, unmerged: false, message: "" });
                  },
                }, t("branch.delete.button")))));
      }

      const errorBar = actionError === null ? null : h("div", { className: "dg-notice dg-notice-error", role: "alert" },
        h(AlertIcon, { className: "dg-error-icon" }),
        h("span", { className: "dg-error-text" }, t(actionError.key, { message: actionError.message })),
        actionError.retry === null || actionError.retry === undefined
          ? null
          : h("button", { type: "button", className: "dg-link-btn", onClick: actionError.retry }, t("branch.retry")));

      const confirmDialog = pendingDelete === null ? null : h("div", {
        className: "dg-pop-confirm",
        role: "alertdialog",
        "aria-label": t("branch.delete.confirmTitle", { branch: pendingDelete.name }),
      },
        h("div", { className: "dg-pop-confirm-title" },
          pendingDelete.force === true
            ? t("branch.delete.forceTitle", { branch: pendingDelete.name })
            : t("branch.delete.confirmTitle", { branch: pendingDelete.name })),
        h("div", { className: "dg-pop-confirm-body" },
          pendingDelete.force === true ? t("branch.delete.forceBody") : t("branch.delete.confirmBody")),
        pendingDelete.force === true && isNonEmptyString(pendingDelete.message)
          ? h("div", { className: "dg-pop-confirm-body" }, t("branch.delete.failed", { message: pendingDelete.message }))
          : null,
        h("div", { className: "dg-pop-confirm-actions" },
          h("button", {
            type: "button",
            className: "dg-btn",
            onClick: function () {
              setPendingDelete(null);
            },
          }, t("confirm.cancel")),
          h("button", {
            type: "button",
            className: "dg-btn dg-btn-danger",
            disabled: busy !== null,
            onClick: function () {
              deleteBranch(pendingDelete.name, pendingDelete.force === true);
            },
          }, pendingDelete.force === true ? t("branch.delete.forceButton") : t("branch.delete.confirmButton"))));

      const currentSection = h("div", { className: "dg-pop-section dg-pop-current" },
        h("div", { className: "dg-pop-section-title" }, t("branch.current.title")),
        h("div", { className: "dg-pop-current-name" },
          h("span", { className: "dg-chip-dot" + (stagedCount + unstagedCount + untrackedCount + conflictedCount > 0 ? " dg-chip-dot-dirty" : "") }),
          h("span", { className: "dg-pop-branch", title: label }, label),
          ahead > 0 ? h("span", { className: "dg-chip-ahead", title: t("chip.aheadTitle", { count: ahead }) }, "\u2191" + String(ahead)) : null,
          behind > 0 ? h("span", { className: "dg-chip-behind", title: t("chip.behindTitle", { count: behind }) }, "\u2193" + String(behind)) : null,
          upstreamInfo.kind === "detached"
            ? h("span", { className: "dg-pop-upstream dg-muted" }, t("summary.detachedHead"))
            : upstreamInfo.kind === "upstream"
              ? h("span", { className: "dg-pop-upstream dg-muted", title: upstreamInfo.name }, upstreamInfo.name)
              : h("span", { className: "dg-pop-upstream dg-muted" }, t("chip.noUpstream"))),
        h("div", { className: "dg-pop-summary" }, t("branch.summary", {
          staged: stagedCount,
          unstaged: unstagedCount,
          untracked: untrackedCount,
          conflicted: conflictedCount,
        })));

      const switchSection = h("div", { className: "dg-pop-section" },
        h("div", { className: "dg-pop-section-title" }, t("branch.switch.title")),
        local.length === 0 && remote.length === 0
          ? h("div", { className: "dg-pop-empty" }, t("branch.noBranches"))
          : h(Fragment, null,
            local.length === 0 ? null : h("div", { className: "dg-pop-group-title" }, h("span", null, t("branch.local"))),
            local.map(function (entry) { return renderBranchRow(entry, "local"); }),
            remote.length === 0 ? null : h("div", { className: "dg-pop-group-title" }, h("span", null, t("branch.remote"))),
            remote.map(function (entry) { return renderBranchRow(entry, "remote"); })));

      const opsSection = h("div", { className: "dg-pop-section dg-pop-ops" },
        h("div", { className: "dg-pop-section-title" }, t("branch.ops.title")),
        h("div", { className: "dg-branch-create" },
          h("input", {
            className: "dg-pop-input",
            value: form.create,
            placeholder: t("branch.create.placeholder"),
            title: t("branch.create.placeholder"),
            "aria-label": t("branch.create.placeholder"),
            onChange: function (event) {
              const value = event.target.value;
              setForm(function (previous) { return { create: value, rename: previous.rename }; });
            },
            onKeyDown: function (event) {
              if (event.key !== "Enter") return;
              if (typeof event.preventDefault === "function") event.preventDefault();
              createBranch();
            },
          }),
          h("button", {
            type: "button",
            className: "dg-btn",
            disabled: busy !== null || form.create.trim() === "",
            onClick: createBranch,
          }, t("branch.create.button"))),
        confirmDialog);

      const popoverStyle = props.popoverStyle !== null && typeof props.popoverStyle === "object" ? props.popoverStyle : null;
      // A title-bar ancestor renders the popover's clipping box, so the element
      // joins the top layer: a [popover] escapes every ancestor's overflow and
      // stacking context while staying inside the React tree (no portal needed).
      // Without the Popover API the CSS positioning is the fallback.
      const popRef = React.useRef(null);
      React.useEffect(function () {
        const node = popRef.current;
        if (node === null || typeof node.showPopover !== "function") return undefined;
        const isOpen = function () {
          return typeof node.matches === "function" && node.matches(":popover-open");
        };
        try {
          if (!isOpen()) node.showPopover();
        } catch (error) {
          return undefined;
        }
        return function () {
          try {
            if (isOpen()) node.hidePopover();
          } catch (error) {
            /* the element is already leaving the document */
          }
        };
      }, []);
      return h("div", {
        className: "dg-pop dg-branch-panel" + (popoverStyle === null ? "" : " dg-pop-fixed"),
        popover: "manual",
        ref: popRef,
        role: "dialog",
        "aria-label": t("chip.popTitle"),
        style: popoverStyle,
      },
        errorBar,
        notice === null ? null : h("div", { className: "dg-notice dg-notice-success", role: "status" }, notice),
        currentSection,
        switchSection,
        opsSection,
        h("div", { className: "dg-pop-foot" }, t("chip.popHint")));
    }

    // -------------------------------------------------------------------------
    // Session-header branch chip (conversation.session.header.actions)
    // -------------------------------------------------------------------------

    /**
     * Compact branch indicator for the conversation header: the branch name, the
     * ahead/behind counters and the number of working-tree changes, all in the
     * VSCode status-bar idiom. Clicking it opens a small read-only summary of the
     * working tree; the full panel stays in the right sidebar.
     *
     * Renders nothing at all outside a repository, so a conversation in a plain
     * directory never grows a control it cannot explain.
     */
    function GitBranchChip(rawProps) {
      const props = rawProps || {};
      const sessionId = props.sessionId;
      const useSessions = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS;
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const cwd = useSessionCwd(useSessions, sessionId);
      const root = isNonEmptyString(cwd) ? cwd : null;

      const statusState = React.useState(null);
      const status = statusState[0];
      const setStatus = statusState[1];
      const openState = React.useState(false);
      const anchorState = React.useState(null);
      const open = openState[0];
      const setOpen = openState[1];
      const setAnchor = anchorState[1];
      const rootRef = React.useRef(null);
      const anchor = anchorState[0];
      const mountedRef = React.useRef(false);
      const seqRef = React.useRef(0);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      const load = React.useCallback(function () {
        if (root === null) {
          setStatus(null);
          return;
        }
        const seq = seqRef.current + 1;
        seqRef.current = seq;
        api.status(root).then(function (payload) {
          if (!mountedRef.current || seqRef.current !== seq) return;
          setStatus(payload);
        }, function () {
          if (!mountedRef.current || seqRef.current !== seq) return;
          setStatus(null);
        });
      }, [root]);

      React.useEffect(function () {
        load();
      }, [load]);

      React.useEffect(function () {
        if (root === null) return undefined;
        const timer = setInterval(function () {
          if (typeof document !== "undefined" && document.hidden === true) return;
          load();
        }, CHIP_POLL_MS);
        return function () {
          clearInterval(timer);
        };
      }, [root, load]);

      React.useEffect(function () {
        if (!open) return undefined;
        if (typeof document === "undefined") return undefined;
        const onPointer = function (event) {
          const node = rootRef.current;
          if (node !== null && typeof node.contains === "function" && node.contains(event.target)) return;
          setOpen(false);
        };
        const onViewport = function () {
          setOpen(false);
        };
        window.addEventListener("resize", onViewport);
        window.addEventListener("scroll", onViewport, true);
        const onKey = function (event) {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointer, true);
        document.addEventListener("keydown", onKey);
        return function () {
          document.removeEventListener("pointerdown", onPointer, true);
          document.removeEventListener("keydown", onKey);
          window.removeEventListener("resize", onViewport);
          window.removeEventListener("scroll", onViewport, true);
        };
      }, [open]);

      const repo = status !== null && typeof status === "object" && status.isRepo === true;
      if (root === null || !repo) return null;

      const branch = status.branch !== null && typeof status.branch === "object" ? status.branch : null;
      const counts = status.counts !== null && typeof status.counts === "object" ? status.counts : null;
      const branchName = branch !== null && isNonEmptyString(branch.name) ? branch.name : "";
      const detached = branch !== null && branch.detached === true;
      const ahead = branch === null ? 0 : toCount(branch.ahead);
      const behind = branch === null ? 0 : toCount(branch.behind);
      const upstream = branch !== null && isNonEmptyString(branch.upstream) ? branch.upstream : "";
      const changeCount = counts === null
        ? 0
        : toCount(counts.staged) + toCount(counts.unstaged) + toCount(counts.untracked) + toCount(counts.conflicted);
      const label = detached ? t("chip.detached") : branchName;

      const ariaLabel = t("chip.aria", {
        branch: label,
        count: changeCount,
      });

      const popover = open
        ? h(BranchPanel, {
          root: root,
          status: status,
          t: t,
          onChanged: load,
          popoverStyle: popoverFixedStyle(anchor, typeof window === "undefined" ? 0 : window.innerWidth),
        })
        : null;

      return h("div", { className: "dg-chip-root", ref: rootRef },
        h("button", {
          type: "button",
          className: "dg-chip" + (changeCount > 0 ? " dg-chip-dirty" : ""),
          "aria-label": ariaLabel,
          "aria-expanded": open ? "true" : "false",
          title: ariaLabel,
          onClick: function () {
            if (open) {
              setOpen(false);
              return;
            }
            const node = rootRef.current;
            if (node !== null && typeof node.getBoundingClientRect === "function") {
              setAnchor(node.getBoundingClientRect());
            }
            setOpen(true);
          },
        },
          h("span", { className: "dg-chip-dot" + (changeCount > 0 ? " dg-chip-dot-dirty" : "") }),
          h("span", { className: "dg-chip-branch" }, label),
          ahead > 0 ? h("span", { className: "dg-chip-ahead" }, "↑" + String(ahead)) : null,
          behind > 0 ? h("span", { className: "dg-chip-behind" }, "↓" + String(behind)) : null,
          changeCount > 0 ? h("span", { className: "dg-chip-count" }, String(changeCount)) : null),
        popover);
    }

    // -------------------------------------------------------------------------
    // Title chip (sidebar.right.pane.tab.title)
    // -------------------------------------------------------------------------

    function GitTitle(rawProps) {
      const props = rawProps || {};
      const useTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : NO_TAB_INFO;
      const tabInfo = useTabInfo();
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const state = useTitleState();
      const tab = tabInfo === null || tabInfo === undefined ? null : tabInfo.tab;
      let title = "";
      if (tab !== null && tab !== undefined && isNonEmptyString(tab.title)) title = tab.title;
      if (title === "") title = t("type.label");
      const showBranch = state.isRepo === true && state.branch !== "";
      const showCount = state.isRepo === true && state.count > 0;
      return h(Fragment, null,
        h(GitGlyph, { size: 16, className: "dg-title-icon" }),
        h("span", { className: "dg-title-text" }, title),
        showBranch ? h("span", { className: "dg-title-branch", title: state.branch }, state.branch) : null,
        showCount ? h("span", { className: "dg-title-count", "aria-hidden": "true" }, String(state.count)) : null);
    }

    // -------------------------------------------------------------------------
    // Panel body (sidebar.right.pane.tab)
    // -------------------------------------------------------------------------

    function GitBody(rawProps) {
      const props = rawProps || {};
      const sessionId = props.sessionId;
      const useSessions = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS;
      const useTabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo : NO_TAB_INFO;
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const tabInfo = useTabInfo();
      const tabVisible = isVisibleTab(tabInfo);
      const cwd = useSessionCwd(useSessions, sessionId);
      const root = isNonEmptyString(cwd) ? cwd : null;

      const tabState = React.useState("changes");
      const tab = tabState[0];
      const setTab = tabState[1];
      const statusState = React.useState(null);
      const status = statusState[0];
      const setStatus = statusState[1];
      const statusErrorState = React.useState(null);
      const statusError = statusErrorState[0];
      const setStatusError = statusErrorState[1];
      const loadingState = React.useState(false);
      const loading = loadingState[0];
      const setLoading = loadingState[1];
      const tokenState = React.useState(0);
      const token = tokenState[0];
      const setToken = tokenState[1];

      const seqRef = React.useRef(0);
      const mountedRef = React.useRef(false);
      const rootRef = React.useRef(root);

      rootRef.current = root;

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
        };
      }, []);

      const loadStatus = React.useCallback(function (mode) {
        const target = rootRef.current;
        if (target === null) return;
        const seq = seqRef.current + 1;
        seqRef.current = seq;
        if (mode === "blocking") setLoading(true);
        api.status(target).then(function (payload) {
          if (seqRef.current !== seq || !mountedRef.current) return;
          setStatus(payload);
          setStatusError(null);
          setLoading(false);
        }, function (error) {
          if (seqRef.current !== seq || !mountedRef.current) return;
          setStatusError(toApiError(error));
          setLoading(false);
        });
      }, []);

      React.useEffect(function () {
        if (root === null) {
          setStatus(null);
          setStatusError(null);
          setLoading(false);
          return;
        }
        loadStatus("blocking");
      }, [root, token, loadStatus]);

      React.useEffect(function () {
        if (tab !== "changes") return undefined;
        if (tabVisible !== true) return undefined;
        if (root === null) return undefined;
        const timer = setInterval(function () {
          loadStatus("silent");
        }, POLL_MS);
        return function () {
          clearInterval(timer);
        };
      }, [tab, tabVisible, root, loadStatus]);

      // The upstream slot falls back to the branch roster, but only when the
      // status payload cannot name the upstream itself; a detached HEAD never
      // needs it, and a status that already carries an upstream never needs it.
      const branchesState = React.useState(null);
      const branches = branchesState[0];
      const setBranches = branchesState[1];
      const repo = status !== null && typeof status === "object" && status.isRepo === true;
      const branch = repo && status.branch !== null && typeof status.branch === "object" ? status.branch : null;
      const upstreamValue = branch !== null && isNonEmptyString(branch.upstream) ? branch.upstream : "";
      const detachedValue = branch !== null && branch.detached === true;
      const branchName = branch !== null && isNonEmptyString(branch.name) ? branch.name : "";

      React.useEffect(function () {
        if (root === null || branch === null || detachedValue === true || upstreamValue !== "") {
          setBranches(null);
          return undefined;
        }
        let cancelled = false;
        api.branches(root).then(function (payload) {
          if (!cancelled) setBranches(payload);
        }, function () {
          if (!cancelled) setBranches(null);
        });
        return function () {
          cancelled = true;
        };
        // `branchName` changes when the first status arrives, which is exactly when
        // the fallback must be reconsidered.
      }, [root, token, branchName, detachedValue, upstreamValue]);
      const counts = repo && status.counts !== null && typeof status.counts === "object" ? status.counts : null;
      const changeCount = counts === null
        ? 0
        : toCount(counts.staged) + toCount(counts.unstaged) + toCount(counts.untracked);
      const upstreamInfo = resolveUpstream(branch, branches, branchName);
      const repoName = basename((status !== null && typeof status === "object" && isNonEmptyString(status.toplevel) ? status.toplevel : root) || "");

      React.useEffect(function () {
        publishTitleState({
          cwd: root === null ? "" : root,
          branch: repo ? branchName : "",
          count: repo ? changeCount : 0,
          isRepo: repo,
        });
      }, [root, repo, branchName, changeCount]);

      React.useEffect(function () {
        const publishedRoot = root === null ? "" : root;
        return function () {
          if (titleStore.snapshot.cwd === publishedRoot) publishTitleState(EMPTY_TITLE_STATE);
        };
      }, [root]);

      function refresh() {
        setToken(token + 1);
      }

      const summary = h("div", { className: "dg-summary" },
        h("div", { className: "dg-summary-main" },
          h(GitGlyph, { size: 16, className: "dg-summary-icon" }),
          repo
            ? h("span", { className: "dg-branch-name", title: branchName }, detachedValue === true ? t("summary.detachedHead") : branchName)
            : h("span", { className: "dg-branch-name dg-muted" }, t("type.label")),
          branch !== null && toCount(branch.ahead) > 0 ? h("span", { className: "dg-track" }, t("summary.ahead", { count: toCount(branch.ahead) })) : null,
          branch !== null && toCount(branch.behind) > 0 ? h("span", { className: "dg-track" }, t("summary.behind", { count: toCount(branch.behind) })) : null,
          repo && upstreamInfo.kind === "upstream" ? h("span", { className: "dg-track dg-muted", title: upstreamInfo.name }, upstreamInfo.name) : null,
          repo && upstreamInfo.kind === "none" ? h("span", { className: "dg-track dg-muted" }, t("summary.noUpstream")) : null,
          repoName === "" ? null : h("span", { className: "dg-summary-repo dg-muted", title: repoName }, repoName)),
        h("div", { className: "dg-summary-actions" },
          h("button", {
            type: "button",
            className: "dg-icon-btn",
            disabled: loading === true,
            title: t("summary.refresh"),
            "aria-label": t("summary.refresh"),
            onClick: refresh,
          }, h(RefreshIcon, { spinning: loading === true }))));

      const tabs = h("div", { className: "dg-tabs", role: "tablist", "aria-label": t("tabs.aria") },
        h("button", {
          type: "button",
          role: "tab",
          className: "dg-tab" + (tab === "changes" ? " dg-tab-active" : ""),
          "aria-selected": tab === "changes" ? "true" : "false",
          onClick: function () {
            setTab("changes");
          },
        }, t("tabs.changes"), changeCount > 0 ? h("span", { className: "dg-tab-count" }, String(changeCount)) : null),
        h("button", {
          type: "button",
          role: "tab",
          className: "dg-tab" + (tab === "history" ? " dg-tab-active" : ""),
          "aria-selected": tab === "history" ? "true" : "false",
          onClick: function () {
            setTab("history");
          },
        }, t("tabs.history")));

      const banner = statusError === null ? null : h("div", { className: "dg-error-banner", role: "alert" },
        h(AlertIcon, { className: "dg-error-icon" }),
        h("span", { className: "dg-error-text" }, describeFailure(t, "error.banner", statusError)),
        h("button", { type: "button", className: "dg-link-btn", onClick: refresh }, t("state.retry")));

      let content;
      if (root === null) {
        content = h("div", { className: "dg-empty" },
          h(GitGlyph, { size: 28, className: "dg-empty-icon" }),
          h("div", { className: "dg-empty-title" }, t("state.noCwdTitle")),
          h("div", { className: "dg-empty-body" }, t("state.noCwdBody")));
      } else if (status === null && loading === true && statusError === null) {
        content = h("div", { className: "dg-loading" }, t("state.loading"));
      } else if (status !== null && typeof status === "object" && status.isRepo === false) {
        content = h("div", { className: "dg-empty" },
          h(GitGlyph, { size: 28, className: "dg-empty-icon" }),
          h("div", { className: "dg-empty-title" }, t("state.noRepoTitle")),
          h("div", { className: "dg-empty-body" }, t("state.noRepoBody", { path: repoName === "" ? root : repoName })));
      } else if (repo) {
        content = tab === "changes"
          ? h(ChangesPane, {
            cwd: root,
            t: t,
            status: status,
            onChanged: refresh,
          })
          : h(HistoryPane, {
            cwd: root,
            t: t,
            refreshToken: token,
            onChanged: refresh,
          });
      } else {
        content = h("div", { className: "dg-empty" },
          h("div", { className: "dg-empty-body" }, t("state.loading")));
      }

      return h("div", { className: "dg-root", "data-dg-plugin": ID },
        summary,
        tabs,
        banner,
        h("div", { className: "dg-content" }, h(PanelBoundary, { t: t }, content)));
    }

    // -------------------------------------------------------------------------
    // Stylesheet (one <style data-dg-plugin> tag, removed on unload)
    // -------------------------------------------------------------------------

    const CSS_TEXT = [
      ".dg-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f2328);background:transparent;font-size:13px;line-height:18px}",
      ".dg-summary{display:flex;align-items:center;gap:6px;min-height:34px;padding:0 6px 0 10px;flex:none;min-width:0;box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-summary-main{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;overflow:hidden}",
      ".dg-summary-icon{flex:none;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-branch-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsh-font-mono,'Cascadia Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-summary-repo{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}",
      ".dg-track{flex:none;color:var(--dsw-alias-label-tertiary,#6e7781);font-size:11px;font-variant-numeric:tabular-nums}",
      ".dg-summary-actions{display:flex;align-items:center;gap:2px;flex:none}",
      ".dg-muted{color:var(--dsw-alias-label-tertiary,#6e7781)!important}",
      ".dg-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;flex:none}",
      ".dg-icon-btn:hover:not(:disabled){background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-icon-btn:disabled{color:var(--dsw-alias-label-tertiary,#6e7781);cursor:default}",
      ".dg-spin{animation:dg-spin 1s linear infinite}",
      "@keyframes dg-spin{to{transform:rotate(360deg)}}",
      ".dg-tabs{display:flex;gap:2px;padding:4px 8px 0;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-tab{position:relative;padding:5px 9px 7px;border:0;border-radius:6px 6px 0 0;background:none;color:var(--dsw-alias-label-tertiary,#6e7781);font:inherit;font-size:12px;cursor:pointer}",
      ".dg-tab:hover{color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-tab-active{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}",
      ".dg-tab-active::after{content:\"\";position:absolute;left:7px;right:7px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-tab-count{margin-left:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781);font-variant-numeric:tabular-nums}",
      ".dg-error-banner{display:flex;align-items:center;gap:6px;margin:6px 8px 0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:rgba(248,81,73,.12);color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;flex:none}",
      ".dg-error-icon{flex:none;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-error-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}",
      ".dg-link-btn{border:0;background:none;padding:0;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;text-decoration:underline;cursor:pointer;flex:none}",
      ".dg-content{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden}",
      ".dg-pane{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;position:relative}",
      ".dg-commit-box{display:flex;flex-direction:column;gap:5px;padding:8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-textarea{width:100%;box-sizing:border-box;min-height:54px;max-height:140px;resize:vertical;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;line-height:17px;outline:none}",
      ".dg-textarea::placeholder{color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-textarea:focus{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.22))}",
      ".dg-commit-actions{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dg-hint{flex:1 1 auto;min-width:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#6e7781);overflow-wrap:anywhere}",
      ".dg-btn{flex:none;padding:3px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:6px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;line-height:18px;cursor:pointer}",
      ".dg-btn:hover:not(:disabled){background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28))}",
      ".dg-btn:disabled{opacity:.5;cursor:default}",
      ".dg-btn-primary{background:var(--dsw-alias-label-primary,#1f2328);border-color:transparent;color:var(--dsw-specific-menu,#fff)}",
      ".dg-btn-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary,#1f2328);opacity:.88}",
      ".dg-btn-danger{background:rgba(248,81,73,.18);border-color:rgba(248,81,73,.4)}",
      ".dg-notice{margin:6px 8px 0;padding:6px 8px;border-radius:8px;font-size:12px;flex:none;overflow-wrap:anywhere}",
      ".dg-notice-success{background:rgba(46,160,67,.14);color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-notice-error{background:rgba(248,81,73,.14);color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-scroll{overflow:auto;overscroll-behavior:contain;min-height:0}",
      ".dg-groups{flex:1 1 auto;padding:6px 6px 10px}",
      ".dg-diff-slot{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;border-top:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-group{margin-bottom:4px}",
      ".dg-group-head{display:flex;align-items:center;gap:6px;padding:4px 4px 3px;position:sticky;top:0;z-index:1;background:var(--dsw-specific-menu,transparent)}",
      ".dg-group-title{font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-group-count{font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781);font-variant-numeric:tabular-nums}",
      ".dg-file-list{display:flex;flex-direction:column}",
      ".dg-file-row{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:6px;cursor:pointer;min-width:0}",
      ".dg-file-row:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14))}",
      ".dg-file-row-selected{background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28))}",
      ".dg-file-row:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.24));outline-offset:-1px}",
      ".dg-badge{flex:none;width:15px;height:15px;border-radius:4px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-primary,#1f2328);font-size:10px;font-weight:700;line-height:14px;text-align:center;border:1px solid transparent;box-sizing:border-box}",
      // VSCode-like SCM status colours: M amber, A/untracked green, D red, R/C blue, conflict orange.
      ".dg-badge-mod{background:rgba(210,153,34,.16);border-color:rgba(210,153,34,.42);color:#9a6700}",
      ".dg-badge-add{background:rgba(46,160,67,.14);border-color:rgba(46,160,67,.4);color:#116329}",
      ".dg-badge-del{background:rgba(248,81,73,.14);border-color:rgba(248,81,73,.42);color:#cf222e}",
      ".dg-badge-renamed{background:rgba(47,129,247,.14);border-color:rgba(47,129,247,.4);color:#0950b8}",
      ".dg-badge-conflict{background:rgba(240,136,62,.16);border-color:rgba(240,136,62,.45);color:#bc4c00}",
      ".dg-badge-untracked{background:rgba(63,185,80,.14);border-color:rgba(63,185,80,.36);color:#1a7f37}",
      // Dark theme keeps the hues but lifts the foreground so they read on the dark panel.
      "body[data-ds-dark-theme] .dg-badge-mod{color:#e3b341;border-color:rgba(227,179,65,.45);background:rgba(227,179,65,.16)}",
      "body[data-ds-dark-theme] .dg-badge-add{color:#56d364;border-color:rgba(86,211,100,.4);background:rgba(86,211,100,.14)}",
      "body[data-ds-dark-theme] .dg-badge-del{color:#ff7b72;border-color:rgba(255,123,114,.42);background:rgba(255,123,114,.14)}",
      "body[data-ds-dark-theme] .dg-badge-renamed{color:#79c0ff;border-color:rgba(121,192,255,.4);background:rgba(121,192,255,.14)}",
      "body[data-ds-dark-theme] .dg-badge-conflict{color:#ffa657;border-color:rgba(255,166,87,.45);background:rgba(255,166,87,.16)}",
      "body[data-ds-dark-theme] .dg-badge-untracked{color:#56d364;border-color:rgba(86,211,100,.36);background:rgba(86,211,100,.12)}",
      // The file name follows the status tone for additions/deletions/renames; a conflict is bold.
      ".dg-file-row-tone-del .dg-file-name{color:#cf222e}",
      "body[data-ds-dark-theme] .dg-file-row-tone-del .dg-file-name{color:#ff7b72}",
      ".dg-file-row-tone-add .dg-file-name,.dg-file-row-tone-untracked .dg-file-name{color:#1a7f37}",
      "body[data-ds-dark-theme] .dg-file-row-tone-add .dg-file-name,body[data-ds-dark-theme] .dg-file-row-tone-untracked .dg-file-name{color:#56d364}",
      ".dg-file-row-tone-renamed .dg-file-name{color:#0950b8}",
      "body[data-ds-dark-theme] .dg-file-row-tone-renamed .dg-file-name{color:#79c0ff}",
      ".dg-file-row-tone-conflict .dg-file-name{color:#bc4c00;font-weight:600}",
      "body[data-ds-dark-theme] .dg-file-row-tone-conflict .dg-file-name{color:#ffa657}",
      ".dg-file-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;unicode-bidi:plaintext}",
      ".dg-file-orig{color:var(--dsw-alias-label-tertiary,#6e7781);font-size:11px;margin-left:4px}",
      ".dg-row-actions{display:inline-flex;gap:3px;flex:none}",
      ".dg-mini-btn{padding:0 5px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}",
      ".dg-mini-btn:hover:not(:disabled){background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-mini-btn:disabled{opacity:.5;cursor:default}",
      ".dg-mini-btn-danger:hover:not(:disabled){background:rgba(248,81,73,.16)}",
      ".dg-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1 1 auto;min-height:120px;padding:18px;text-align:center;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-empty-icon{color:var(--dsw-alias-label-tertiary,#6e7781);flex:none}",
      ".dg-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-empty-body{font-size:12px;line-height:17px;max-width:280px;overflow-wrap:anywhere}",
      ".dg-loading{display:flex;align-items:center;justify-content:center;padding:18px;font-size:12px;color:var(--dsw-alias-label-tertiary,#6e7781);flex:none}",
      ".dg-confirm{display:flex;align-items:flex-start;gap:8px;margin:6px 8px 0;padding:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:10px;background:var(--dsw-specific-menu,transparent);box-shadow:var(--dsw-elevation-prominent,0 4px 16px rgba(0,0,0,.16));flex:none}",
      ".dg-confirm-icon{flex:none;margin-top:1px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-confirm-main{flex:1 1 auto;min-width:0}",
      ".dg-confirm-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-confirm-body{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#57606a);overflow-wrap:anywhere}",
      ".dg-confirm-actions{display:flex;flex-direction:column;gap:4px;flex:none}",
      ".dg-diff{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}",
      ".dg-diff-head{display:flex;align-items:center;gap:6px;padding:5px 8px;flex:none;min-width:0;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-diff-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      ".dg-mono{font-family:var(--dsh-font-mono,'Cascadia Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,ui-monospace,monospace)}",
      ".dg-diff-mode{flex:none;padding:0 5px;border-radius:5px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:16px}",
      ".dg-diff-stats{display:inline-flex;gap:6px;flex:none;font-size:11px;font-variant-numeric:tabular-nums}",
      ".dg-add{color:rgba(46,160,67,1)}",
      ".dg-del{color:rgba(248,81,73,1)}",
      ".dg-diff-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.08))}",
      ".dg-hunk-block{font-family:var(--dsh-font-mono,'Cascadia Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,ui-monospace,monospace);font-size:11px;line-height:17px;min-width:max-content}",
      ".dg-hunk{display:flex;align-items:center;gap:6px;padding:1px 8px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.22));color:var(--dsw-alias-label-tertiary,#6e7781);position:sticky;left:0;width:max-content}",
      ".dg-diff-row{display:flex;align-items:flex-start;min-width:max-content}",
      ".dg-diff-row-add{background:rgba(46,160,67,.16)}",
      ".dg-diff-row-del{background:rgba(248,81,73,.16)}",
      ".dg-ln{flex:none;width:34px;padding:0 4px;text-align:right;color:var(--dsw-alias-label-tertiary,#6e7781);font-variant-numeric:tabular-nums;user-select:none}",
      ".dg-diff-sign{flex:none;width:9px;text-align:center;color:var(--dsw-alias-label-secondary,#57606a);user-select:none}",
      ".dg-diff-text{flex:0 0 auto;padding-right:10px;white-space:pre;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-diff-notice{margin:6px 8px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.22));color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;flex:none}",
      ".dg-history{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;position:relative}",
      ".dg-history-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-history-body{display:flex;flex:1 1 auto;min-height:0;min-width:0}",
      ".dg-history-main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}",
      ".dg-history-range{flex:none;padding:3px 8px 4px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#6e7781);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dg-history-tree{flex:0 0 176px;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 4px 8px;border-right:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-history-tree-pop{position:absolute;left:0;top:0;bottom:0;z-index:20;width:200px;max-width:78%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.2))}",
      ".dg-history-tree-group{display:flex;flex-direction:column;gap:1px;min-width:0}",
      ".dg-history-tree-title{padding:4px 5px 1px;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-history-tree-item{display:flex;align-items:center;gap:5px;min-width:0;padding:2px 5px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:12px;line-height:17px;text-align:left;cursor:pointer}",
      ".dg-history-tree-item:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-history-tree-item-current{background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-history-tree-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#6e7781);opacity:.6}",
      ".dg-history-tree-dot-head{background:#2da44e;opacity:1;box-shadow:0 0 0 2px rgba(46,160,67,.18)}",
      ".dg-history-tree-dot-remote{background:#0969da;opacity:.85}",
      "body[data-ds-dark-theme] .dg-history-tree-dot-remote{background:#79c0ff}",
      ".dg-history-tree-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dg-history-tree-check{flex:none;color:#1a7f37;font-size:11px;line-height:14px}",
      "body[data-ds-dark-theme] .dg-history-tree-check{color:#56d364}",
      ".dg-history-tree-status{padding:2px 5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6e7781);overflow-wrap:anywhere}",
      ".dg-history-tree-toggle{flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dg-select{flex:1 1 auto;min-width:0;height:24px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:6px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px}",
      ".dg-commit-list{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 6px 10px;outline:none}",
      ".dg-commit-list:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.24));outline-offset:-1px}",
      ".dg-commit-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;align-items:center;column-gap:6px;padding:0 6px;border-radius:6px;cursor:pointer;min-width:0;height:44px}",
      ".dg-commit-main{display:flex;flex-direction:column;justify-content:center;gap:1px;min-width:0}",
      ".dg-commit-body{display:flex;flex-direction:column;justify-content:center;gap:1px;min-width:0;flex:1 1 auto}",
      ".dg-graph{flex:none;display:inline-flex;align-items:center;justify-content:center;align-self:stretch}",
      ".dg-graph-svg{display:block}",
      ".dg-commit-row:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14))}",
      ".dg-commit-row:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.24));outline-offset:-1px}",
      ".dg-commit-line{display:flex;align-items:baseline;gap:6px;min-width:0}",
      ".dg-sha{flex:none;font-family:var(--dsh-font-mono,'Cascadia Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,ui-monospace,monospace);font-size:11px;color:#0969da}",
      "body[data-ds-dark-theme] .dg-sha{color:#79c0ff}",
      ".dg-commit-subject{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      ".dg-commit-merge .dg-commit-subject{font-style:italic;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-commit-refs{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;white-space:nowrap}",
      ".dg-commit-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781);min-width:0}",
      ".dg-commit-author{width:96px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-commit-date{flex:none;min-width:96px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#6e7781);white-space:nowrap}",
      ".dg-commit-time{flex:none;font-variant-numeric:tabular-nums}",
      ".dg-hide-author .dg-commit-author{display:none}",
      ".dg-hide-hash .dg-commit-sha{display:none}",
      ".dg-ref-tag{display:inline-flex;align-items:center;gap:3px;flex:none;padding:0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:4px;color:var(--dsw-alias-label-secondary,#57606a);font-size:10px;line-height:14px;max-width:160px;overflow:hidden}",
      ".dg-ref-dot{flex:none;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.9}",
      ".dg-ref-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dg-ref-list{display:inline-flex;flex-wrap:wrap;gap:4px;min-width:0}",
      ".dg-ref-head{color:#116329;border-color:rgba(46,160,67,.45);background:rgba(46,160,67,.12)}",
      "body[data-ds-dark-theme] .dg-ref-head{color:#56d364;border-color:rgba(86,211,100,.4);background:rgba(86,211,100,.12)}",
      ".dg-ref-remote{color:#0950b8;border-color:rgba(47,129,247,.4);background:rgba(47,129,247,.1)}",
      "body[data-ds-dark-theme] .dg-ref-remote{color:#79c0ff;border-color:rgba(121,192,255,.36);background:rgba(121,192,255,.1)}",
      ".dg-load-more{padding:6px;text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-detail{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}",
      ".dg-detail-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px 10px 14px}",
      ".dg-detail-title{font-size:13px;font-weight:600;line-height:19px;overflow-wrap:anywhere}",
      ".dg-detail-grid{display:flex;flex-direction:column;gap:3px;margin-top:6px;font-size:12px}",
      ".dg-detail-row{display:flex;gap:8px;min-width:0}",
      ".dg-detail-label{flex:none;width:52px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-detail-value{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-body-text{margin:6px 0 0;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-secondary,#57606a);font-family:var(--dsh-font-mono,'Cascadia Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,ui-monospace,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto}",
      ".dg-section-title{margin:12px 0 4px;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-file-table{display:flex;flex-direction:column}",
      ".dg-file-table-row{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:6px;cursor:pointer;min-width:0}",
      ".dg-file-table-row:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14))}",
      ".dg-file-table-row:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.24));outline-offset:-1px}",
      ".dg-numstat{flex:none;display:inline-flex;gap:5px;font-size:11px;font-variant-numeric:tabular-nums}",
      // Session-header branch chip (VSCode status-bar idiom).
      // The desktop shell paints a -webkit-app-region: drag strip across the top of
      // the window; a drag region swallows clicks, and this chip lives inside that
      // band, so it opts out with no-drag (as the shell does for its own top-bar
      // controls). Without it the chip renders but onClick never runs.
      ".dg-chip-root{position:relative;display:inline-flex;align-items:center;-webkit-app-region:no-drag;app-region:no-drag}",
      ".dg-chip{display:inline-flex;align-items:center;gap:5px;min-height:24px;padding:1px 7px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:12px;line-height:18px;cursor:pointer;max-width:220px}",
      ".dg-chip:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-chip:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.24));outline-offset:0}",
      ".dg-chip-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#2da44e;box-shadow:0 0 0 2px rgba(46,160,67,.18)}",
      ".dg-chip-dot-dirty{background:#d29922;box-shadow:0 0 0 2px rgba(210,153,34,.2)}",
      // The chip inherits the host header font: no monospace, 12px/18px like the neighbouring capsules.
      ".dg-chip-branch{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}",
      ".dg-chip-count{flex:none;min-width:16px;padding:0 4px;border-radius:8px;background:rgba(210,153,34,.18);color:#9a6700;font-size:11px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums}",
      "body[data-ds-dark-theme] .dg-chip-count{background:rgba(227,179,65,.18);color:#e3b341}",
      ".dg-chip-ahead{flex:none;color:#1a7f37;font-size:11px;font-variant-numeric:tabular-nums}",
      "body[data-ds-dark-theme] .dg-chip-ahead{color:#56d364}",
      ".dg-chip-behind{flex:none;color:#cf222e;font-size:11px;font-variant-numeric:tabular-nums}",
      "body[data-ds-dark-theme] .dg-chip-behind{color:#ff7b72}",
      // `--dsw-specific-menu` is a translucent menu layer (≈58% alpha) meant to be
      // used together with a backdrop blur; on its own the content behind bleeds
      // through, so the panel uses the opaque theme layer instead.
      ".dg-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:1200;-webkit-app-region:no-drag;app-region:no-drag;box-sizing:border-box;width:340px;max-width:min(440px,82vw);max-height:min(460px,70vh);overflow:auto;padding:8px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;line-height:18px}",
      ".dg-pop-fixed{position:fixed;top:auto;right:auto;left:auto;z-index:1200}",
      ".dg-pop[popover]{inset:auto;margin:0;padding:8px}",
      ".dg-pop-branch{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-size:12px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums}",
      ".dg-pop-upstream{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;margin-left:auto}",
      ".dg-pop-group-title{display:flex;align-items:center;justify-content:space-between;padding:2px 4px;color:var(--dsw-alias-label-tertiary,#6e7781);font-size:11px;letter-spacing:.02em}",
      ".dg-pop-group-count{font-variant-numeric:tabular-nums}",
      ".dg-pop-foot{margin-top:4px;padding:6px 4px 2px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));color:var(--dsw-alias-label-tertiary,#6e7781);font-size:11px}",
      ".dg-title-icon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dg-title-branch{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;border-radius:5px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.2));color:var(--dsw-alias-label-secondary,#57606a);font-family:var(--dsh-font-mono,'Cascadia Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,ui-monospace,monospace);font-size:11px;line-height:16px}",
      ".dg-title-count{flex:none;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums}",
      // Branch panel (header chip popover): current branch, switching and branch ops.
      ".dg-branch-panel{width:340px;max-width:min(420px,84vw)}",
      ".dg-pop-section{padding:6px 4px 4px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-pop-section:first-of-type{border-top:0}",
      ".dg-pop-section-title{padding:0 4px 4px;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-pop-current-name{display:flex;align-items:center;gap:6px;padding:0 4px;min-width:0}",
      ".dg-pop-summary{padding:3px 4px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6e7781);overflow-wrap:anywhere}",
      ".dg-branch-row{display:flex;align-items:center;gap:2px;border-radius:6px;min-width:0}",
      ".dg-branch-row:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14))}",
      ".dg-branch-pick{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:3px 5px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}",
      ".dg-branch-pick:disabled{cursor:default}",
      ".dg-branch-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#6e7781);opacity:.55}",
      ".dg-branch-dot-current{background:#2da44e;opacity:1;box-shadow:0 0 0 2px rgba(46,160,67,.18)}",
      ".dg-branch-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
      ".dg-branch-check{flex:none;color:#1a7f37;font-size:12px;line-height:18px}",
      "body[data-ds-dark-theme] .dg-branch-check{color:#56d364}",
      ".dg-branch-busy{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-branch-actions{display:inline-flex;gap:2px;flex:none;padding-right:2px}",
      ".dg-branch-rename{display:flex;align-items:center;gap:4px;padding:3px 5px;min-width:0}",
      ".dg-branch-create{display:flex;align-items:center;gap:4px;padding:2px 4px}",
      ".dg-pop-input{flex:1 1 auto;min-width:0;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:6px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;outline:none}",
      ".dg-pop-input:focus{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.22))}",
      ".dg-pop-empty{padding:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-pop-confirm{margin:6px 4px 0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:8px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));font-size:11px;line-height:16px}",
      ".dg-pop-confirm-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-pop-confirm-body{margin-top:2px;color:var(--dsw-alias-label-secondary,#57606a);overflow-wrap:anywhere}",
      ".dg-pop-confirm-actions{display:flex;justify-content:flex-end;gap:4px;margin-top:6px}",
      ".dg-notice-info{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-secondary,#57606a)}",
      // History: filter bar, log range vs. checkout, HEAD emphasis.
      ".dg-history-filters{display:flex;align-items:center;gap:4px;padding:0 8px 6px;flex:none;flex-wrap:wrap}",
      ".dg-filter-input{flex:1 1 0;min-width:58px;height:22px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:6px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:11px;outline:none}",
      ".dg-filter-input::placeholder{color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-filter-input:focus{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.22))}",
      ".dg-filter-date{flex:0 0 auto;width:120px;padding:0 3px;font-size:10px;color-scheme:light dark}",
      ".dg-link-btn:disabled{opacity:.45;text-decoration:none;cursor:default}",
      ".dg-filter-active{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-commit-row-head,.dg-commit-head{background:rgba(247,129,102,.08)}",
      ".dg-commit-active{background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));box-shadow:inset 2px 0 0 var(--dsw-alias-label-primary,#1f2328)}",
      "body[data-ds-dark-theme] .dg-commit-row-head,body[data-ds-dark-theme] .dg-commit-head{background:rgba(247,129,102,.14)}",
      ".dg-graph-dot-head{stroke-width:2.1}",
      // Changes: directory tree, hunk actions, amend + recent commit messages.
      ".dg-tree-dir{display:flex;flex-direction:column;min-width:0}",
      ".dg-dir-row{display:flex;align-items:center;gap:4px;padding:3px 5px;border-radius:6px;cursor:pointer;min-width:0}",
      ".dg-dir-row:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14))}",
      ".dg-dir-row:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.24));outline-offset:-1px}",
      ".dg-dir-caret{flex:none;width:10px;text-align:center;color:var(--dsw-alias-label-tertiary,#6e7781);font-size:10px;line-height:14px}",
      ".dg-dir-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);unicode-bidi:plaintext}",
      ".dg-dir-count{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781);font-variant-numeric:tabular-nums}",
      ".dg-tree-children{display:flex;flex-direction:column;min-width:0}",
      ".dg-hunk-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dg-hunk-actions{display:inline-flex;gap:3px;flex:none}",
      ".dg-hunk-btn{padding:0 5px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:5px;background:var(--dsw-specific-menu,transparent);color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-family:inherit;font-size:10px;line-height:15px;white-space:nowrap;cursor:pointer}",
      ".dg-hunk-btn:hover:not(:disabled){background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-hunk-btn:disabled{opacity:.5;cursor:default}",
      ".dg-commit-options{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dg-amend{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer;flex:none}",
      ".dg-amend-check{width:12px;height:12px;margin:0}",
      ".dg-commit-history{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0}",
      ".dg-commit-history-title{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-history-chip{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;font-size:11px;line-height:16px;cursor:pointer}",
      ".dg-history-chip:hover{background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28))}",
    ].join("\n");

    /** Install the stylesheet once per document; repeated loads refresh its text. */
    function installStyles() {
      if (typeof document === "undefined" || !document.head) return;
      const selector = 'style[data-dg-style="' + STYLE_TAG + '"]';
      let tag = null;
      try {
        tag = document.querySelector(selector);
      } catch (error) {
        tag = null;
      }
      if (tag === null) {
        tag = document.createElement("style");
        tag.setAttribute("data-dg-style", STYLE_TAG);
        tag.setAttribute("data-plugin", ID);
        document.head.appendChild(tag);
      }
      tag.textContent = CSS_TEXT;
    }

    /** Drop the stylesheet on plugin unload unless a panel is still mounted. */
    function removeStyles() {
      if (typeof document === "undefined") return;
      try {
        if (document.querySelector('[data-dg-plugin="' + ID + '"]') !== null) return;
        const tag = document.querySelector('style[data-dg-style="' + STYLE_TAG + '"]');
        if (tag !== null && tag.parentNode !== null && tag.parentNode !== undefined) {
          tag.parentNode.removeChild(tag);
        }
      } catch (error) {
        // The tag may already be gone.
      }
    }

    // -------------------------------------------------------------------------
    // Dictionaries: the Chinese dictionary is the key-set source of truth.
    // -------------------------------------------------------------------------

    const zh = {
      "type.label": "Git",
      "guide.title": "源代码管理",
      // Session-header branch chip.
      "chip.aria": "Git 分支 {branch}，{count} 项变更",
      "chip.detached": "游离 HEAD",
      "chip.noUpstream": "无上游",
      "chip.popTitle": "源代码管理",
      "chip.popHint": "在右侧栏「源代码管理」中查看完整变更与提交历史。",
      "chip.aheadTitle": "领先上游 {count} 个提交",
      "chip.behindTitle": "落后上游 {count} 个提交",
      // Header chip popover: branch panel.
      "branch.current.title": "当前分支",
      "branch.current.tag": "当前分支",
      "branch.current.aria": "当前分支 {branch}",
      "branch.summary": "已暂存 {staged} · 变更 {unstaged} · 未跟踪 {untracked} · 冲突 {conflicted}",
      "branch.switch.title": "切换分支",
      "branch.switch.row": "切换到 {branch}",
      "branch.switch.success": "已切换到 {branch}",
      "branch.switch.failed": "切换分支失败：{message}",
      "branch.local": "本地分支",
      "branch.remote": "远端分支",
      "branch.remote.readonly": "远端分支 {branch}（只读，需先创建本地跟踪分支）",
      "branch.noBranches": "没有可切换的分支",
      "branch.ops.title": "分支操作",
      "branch.create.placeholder": "新分支名",
      "branch.create.button": "创建分支",
      "branch.create.success": "已创建分支 {branch}",
      "branch.create.failed": "创建分支失败：{message}",
      "branch.name.empty": "请先输入分支名",
      "branch.rename.button": "重命名",
      "branch.rename.aria": "重命名分支 {branch}",
      "branch.rename.placeholder": "新的分支名",
      "branch.rename.confirm": "确定",
      "branch.rename.cancel": "取消",
      "branch.rename.success": "已将 {from} 重命名为 {to}",
      "branch.rename.failed": "重命名分支失败：{message}",
      "branch.delete.button": "删除",
      "branch.delete.aria": "删除分支 {branch}",
      "branch.delete.current": "不能删除当前分支",
      "branch.delete.confirmTitle": "删除分支 {branch}？",
      "branch.delete.confirmBody": "该分支上的提交将不再被引用，未合并的提交可能丢失。",
      "branch.delete.confirmButton": "删除分支",
      "branch.delete.forceTitle": "分支 {branch} 尚未合并",
      "branch.delete.forceBody": "强制删除会丢弃该分支上尚未合并的提交，且无法恢复。",
      "branch.delete.forceButton": "强制删除",
      "branch.delete.success": "已删除分支 {branch}",
      "branch.delete.failed": "删除分支失败：{message}",
      "branch.retry": "重试",
      "guide.description": "查看分支、工作区变更与提交历史，暂存、放弃并提交更改",
      "tabs.aria": "Git 视图切换",
      "tabs.changes": "变更",
      "tabs.history": "历史",
      "summary.refresh": "刷新",
      "summary.detached": "HEAD 分离",
      "summary.detachedHead": "游离 HEAD",
      "summary.ahead": "领先 {count}",
      "summary.behind": "落后 {count}",
      "summary.noUpstream": "无上游",
      "state.loading": "正在读取 Git 状态…",
      "state.retry": "重试",
      "state.noCwdTitle": "没有工作目录",
      "state.noCwdBody": "当前会话没有工作目录，无法读取 Git 状态。",
      "state.noRepoTitle": "不是 Git 仓库",
      "state.noRepoBody": "{path} 下未找到 Git 仓库。",
      "error.banner": "加载失败：{message}",
      "error.render": "面板渲染出错",
      "error.unknown": "未知错误",
      "changes.empty.title": "工作区干净",
      "changes.empty.body": "没有待提交的变更。",
      "changes.group.staged": "已暂存",
      "changes.group.unstaged": "变更",
      "changes.group.untracked": "未跟踪",
      "changes.group.conflicted": "冲突",
      "changes.commit.placeholder": "提交信息（Ctrl+Enter 提交）",
      "changes.commit.button": "提交",
      "changes.commit.committing": "提交中…",
      "changes.commit.hint": "提交已暂存的更改",
      "changes.commit.all": "将自动暂存全部已跟踪的变更后提交",
      "changes.commit.empty": "请先填写提交信息",
      "changes.commit.nothing": "没有可提交的变更",
      "changes.commit.success": "已提交 {sha}",
      "changes.conflict.hint": "存在未解决的冲突，请使用外部工具处理后再提交。",
      "changes.action.stage": "暂存",
      "changes.action.unstage": "取消暂存",
      "changes.action.discard": "放弃",
      "changes.action.busy": "处理中…",
      "changes.action.failed": "操作失败：{message}",
      "changes.row.open": "查看 {path} 的差异",
      "changes.amend": "修补上一个提交",
      "changes.amend.hint": "用当前暂存内容替换上一个提交，提交信息可改写",
      "changes.amend.button": "修补提交",
      "changes.amend.success": "已修补提交 {sha}",
      "changes.commitHistory": "最近提交信息",
      "changes.tree.toggle": "折叠或展开 {path}",
      "changes.tree.collapsed": "所有目录都已折叠，点击目录可展开",
      "changes.hunk.stage": "暂存此块",
      "changes.hunk.unstage": "取消暂存此块",
      "changes.hunk.staged": "已暂存该块",
      "changes.hunk.unstaged": "已取消暂存该块",
      "changes.hunk.failed": "操作失败：{message}",
      "confirm.discard.title": "放弃这些更改？",
      "confirm.discard.tracked": "将丢弃 {path} 中未暂存的修改，且无法恢复。",
      "confirm.discard.untracked": "将删除未跟踪的文件 {path}，且无法恢复。",
      "confirm.confirm": "放弃更改",
      "confirm.cancel": "取消",
      "diff.back": "返回",
      "diff.loading": "正在加载差异…",
      "diff.empty": "该文件没有可显示的差异",
      "diff.binary": "二进制文件，无法显示文本差异",
      "diff.truncated": "差异较大，仅显示前 4000 行",
      "diff.error": "差异加载失败",
      "diff.mode.worktree": "工作区",
      "diff.mode.staged": "已暂存",
      "diff.mode.untracked": "未跟踪",
      "diff.mode.commit": "提交",
      "history.refRange": "日志范围",
      "history.checkout.button": "切换到此分支",
      "history.checkout.title": "切换到 {branch}",
      "history.checkout.hint": "先在「日志范围」里选择一个分支",
      "history.filter.grep": "筛选提交信息",
      "history.filter.author": "筛选作者",
      "history.filter.path": "筛选路径",
      "history.filter.clear": "清除",
      "history.filter.active": "已过滤",
      "history.tree.title": "分支/范围",
      "history.tree.toggle": "展开或折叠分支树",
      "history.tree.head": "HEAD",
      "history.tree.local": "本地分支",
      "history.tree.remote": "远端分支",
      "history.tree.all": "全部",
      "history.tree.entry": "以 {branch} 作为日志范围",
      "history.tree.loading": "正在读取分支…",
      "history.tree.empty": "没有可用的分支",
      "history.tree.error": "分支读取失败",
      "history.range": "范围：{ref}",
      "history.list.aria": "提交列表",
      "history.jumpToHead": "跳到 HEAD",
      "history.filter.since": "起始日期",
      "history.filter.until": "结束日期",
      "history.empty.dateRange": "所选日期范围内没有提交",
      "history.empty.filtered": "没有符合过滤条件的提交",
      "history.lanes.truncated": "分支泳道过多，只显示前 {max} 条分支线",
      "graph.headLabel": "当前 HEAD 所在的提交",
      "history.head": "HEAD（当前分支）",
      "history.loading": "正在加载提交…",
      "history.loadMore": "正在加载更多…",
      "history.noMore": "已加载全部提交",
      "history.empty": "暂无提交记录",
      "history.subject.empty": "（无提交信息）",
      "history.detail.title": "提交详情",
      "history.detail.back": "返回列表",
      "history.detail.sha": "提交",
      "history.detail.author": "作者",
      "history.detail.time": "时间",
      "history.detail.refs": "引用",
      "history.detail.parents": "父提交",
      "history.detail.message": "说明",
      "history.detail.noMessage": "（无说明）",
      "history.files": "变更文件（{count}）",
      "history.files.empty": "该提交没有文件变更",
      "history.file.back": "返回提交详情",
      "history.binary": "二进制",
      "status.M": "已修改",
      "status.A": "新增",
      "status.D": "已删除",
      "status.R": "重命名",
      "status.C": "复制",
      "status.T": "类型变更",
      "status.U": "冲突",
      "status.untracked": "未跟踪",
      "status.conflict": "冲突",
      "time.justNow": "刚刚",
      "time.minutes": "{count} 分钟前",
      "time.hours": "{count} 小时前",
      "time.days": "{count} 天前",
      "time.weeks": "{count} 周前",
      "time.months": "{count} 个月前",
      "time.years": "{count} 年前",
    };

    /** English dictionary, key-identical to the Chinese source of truth. */
    const en = {
      "type.label": "Git",
      "guide.title": "Source Control",
      // Session-header branch chip.
      "chip.aria": "Git branch {branch}, {count} changes",
      "chip.detached": "detached HEAD",
      "chip.noUpstream": "no upstream",
      "chip.popTitle": "Source Control",
      "chip.popHint": "Open the Source Control tab in the right sidebar for the full change list and history.",
      "chip.aheadTitle": "{count} commits ahead of upstream",
      "chip.behindTitle": "{count} commits behind upstream",
      // Header chip popover: branch panel.
      "branch.current.title": "Current branch",
      "branch.current.tag": "Current",
      "branch.current.aria": "Current branch {branch}",
      "branch.summary": "Staged {staged} · Changes {unstaged} · Untracked {untracked} · Conflicts {conflicted}",
      "branch.switch.title": "Switch branch",
      "branch.switch.row": "Switch to {branch}",
      "branch.switch.success": "Switched to {branch}",
      "branch.switch.failed": "Could not switch branch: {message}",
      "branch.local": "Local branches",
      "branch.remote": "Remote branches",
      "branch.remote.readonly": "Remote branch {branch} (read-only; create a local tracking branch first)",
      "branch.noBranches": "No branches to switch to",
      "branch.ops.title": "Branch actions",
      "branch.create.placeholder": "New branch name",
      "branch.create.button": "Create branch",
      "branch.create.success": "Created branch {branch}",
      "branch.create.failed": "Could not create branch: {message}",
      "branch.name.empty": "Enter a branch name first",
      "branch.rename.button": "Rename",
      "branch.rename.aria": "Rename branch {branch}",
      "branch.rename.placeholder": "New branch name",
      "branch.rename.confirm": "Confirm",
      "branch.rename.cancel": "Cancel",
      "branch.rename.success": "Renamed {from} to {to}",
      "branch.rename.failed": "Could not rename branch: {message}",
      "branch.delete.button": "Delete",
      "branch.delete.aria": "Delete branch {branch}",
      "branch.delete.current": "The current branch cannot be deleted",
      "branch.delete.confirmTitle": "Delete branch {branch}?",
      "branch.delete.confirmBody": "No ref will point at this branch's commits; unmerged work may be lost.",
      "branch.delete.confirmButton": "Delete branch",
      "branch.delete.forceTitle": "Branch {branch} is not merged",
      "branch.delete.forceBody": "Force deleting drops the unmerged commits on that branch; this cannot be undone.",
      "branch.delete.forceButton": "Force delete",
      "branch.delete.success": "Deleted branch {branch}",
      "branch.delete.failed": "Could not delete branch: {message}",
      "branch.retry": "Retry",
      "guide.description": "Review branches, working-tree changes and commit history; stage, discard and commit",
      "tabs.aria": "Git view switcher",
      "tabs.changes": "Changes",
      "tabs.history": "History",
      "summary.refresh": "Refresh",
      "summary.detached": "Detached HEAD",
      "summary.detachedHead": "Detached HEAD",
      "summary.ahead": "{count} ahead",
      "summary.behind": "{count} behind",
      "summary.noUpstream": "No upstream",
      "state.loading": "Reading Git status…",
      "state.retry": "Retry",
      "state.noCwdTitle": "No working directory",
      "state.noCwdBody": "This session has no working directory, so Git status cannot be read.",
      "state.noRepoTitle": "Not a Git repository",
      "state.noRepoBody": "No Git repository was found under {path}.",
      "error.banner": "Request failed: {message}",
      "error.render": "The panel failed to render",
      "error.unknown": "Unknown error",
      "changes.empty.title": "Working tree clean",
      "changes.empty.body": "There are no pending changes.",
      "changes.group.staged": "Staged",
      "changes.group.unstaged": "Changes",
      "changes.group.untracked": "Untracked",
      "changes.group.conflicted": "Conflicts",
      "changes.commit.placeholder": "Commit message (Ctrl+Enter to commit)",
      "changes.commit.button": "Commit",
      "changes.commit.committing": "Committing…",
      "changes.commit.hint": "Commits the staged changes",
      "changes.commit.all": "Staged automatically: all tracked changes are committed",
      "changes.commit.empty": "Write a commit message first",
      "changes.commit.nothing": "There is nothing to commit",
      "changes.commit.success": "Committed {sha}",
      "changes.conflict.hint": "Unresolved conflicts are present; resolve them with an external tool before committing.",
      "changes.action.stage": "Stage",
      "changes.action.unstage": "Unstage",
      "changes.action.discard": "Discard",
      "changes.action.busy": "Working…",
      "changes.action.failed": "Action failed: {message}",
      "changes.row.open": "Show the diff of {path}",
      "changes.amend": "Amend the previous commit",
      "changes.amend.hint": "Replace the previous commit with the current index; its message can be rewritten",
      "changes.amend.button": "Amend commit",
      "changes.amend.success": "Amended {sha}",
      "changes.commitHistory": "Recent messages",
      "changes.tree.toggle": "Collapse or expand {path}",
      "changes.tree.collapsed": "All directories are collapsed; click a directory to expand it",
      "changes.hunk.stage": "Stage this hunk",
      "changes.hunk.unstage": "Unstage this hunk",
      "changes.hunk.staged": "Hunk staged",
      "changes.hunk.unstaged": "Hunk unstaged",
      "changes.hunk.failed": "Action failed: {message}",
      "confirm.discard.title": "Discard these changes?",
      "confirm.discard.tracked": "Unstaged modifications in {path} will be thrown away and cannot be recovered.",
      "confirm.discard.untracked": "The untracked file {path} will be deleted and cannot be recovered.",
      "confirm.confirm": "Discard changes",
      "confirm.cancel": "Cancel",
      "diff.back": "Back",
      "diff.loading": "Loading the diff…",
      "diff.empty": "This file has no displayable diff",
      "diff.binary": "Binary file; the text diff cannot be shown",
      "diff.truncated": "Large diff; only the first 4000 lines are shown",
      "diff.error": "The diff could not be loaded",
      "diff.mode.worktree": "Working tree",
      "diff.mode.staged": "Staged",
      "diff.mode.untracked": "Untracked",
      "diff.mode.commit": "Commit",
      "history.refRange": "Log range",
      "history.checkout.button": "Switch to this branch",
      "history.checkout.title": "Switch to {branch}",
      "history.checkout.hint": "Pick a branch in the log range first",
      "history.filter.grep": "Filter messages",
      "history.filter.author": "Filter author",
      "history.filter.path": "Filter path",
      "history.filter.clear": "Clear",
      "history.filter.active": "Filtered",
      "history.tree.title": "Branches",
      "history.tree.toggle": "Show or hide the branch tree",
      "history.tree.head": "HEAD",
      "history.tree.local": "Local",
      "history.tree.remote": "Remote",
      "history.tree.all": "All",
      "history.tree.entry": "Use {branch} as the log range",
      "history.tree.loading": "Reading branches…",
      "history.tree.empty": "No branches available",
      "history.tree.error": "Branches could not be loaded",
      "history.range": "Range: {ref}",
      "history.list.aria": "Commit list",
      "history.jumpToHead": "Jump to HEAD",
      "history.filter.since": "From date",
      "history.filter.until": "To date",
      "history.empty.dateRange": "No commits in the selected date range",
      "history.empty.filtered": "No commits match the filters",
      "history.lanes.truncated": "Too many branch lanes; only the first {max} are drawn",
      "graph.headLabel": "The commit HEAD points at",
      "history.head": "HEAD (current branch)",
      "history.loading": "Loading commits…",
      "history.loadMore": "Loading more…",
      "history.noMore": "All commits loaded",
      "history.empty": "No commits yet",
      "history.subject.empty": "(no commit message)",
      "history.detail.title": "Commit details",
      "history.detail.back": "Back to the list",
      "history.detail.sha": "Commit",
      "history.detail.author": "Author",
      "history.detail.time": "Date",
      "history.detail.refs": "Refs",
      "history.detail.parents": "Parents",
      "history.detail.message": "Message",
      "history.detail.noMessage": "(no description)",
      "history.files": "Changed files ({count})",
      "history.files.empty": "This commit changed no files",
      "history.file.back": "Back to commit details",
      "history.binary": "Binary",
      "status.M": "Modified",
      "status.A": "Added",
      "status.D": "Deleted",
      "status.R": "Renamed",
      "status.C": "Copied",
      "status.T": "Type changed",
      "status.U": "Conflicted",
      "status.untracked": "Untracked",
      "status.conflict": "Conflicted",
      "time.justNow": "just now",
      "time.minutes": "{count}m ago",
      "time.hours": "{count}h ago",
      "time.days": "{count}d ago",
      "time.weeks": "{count}w ago",
      "time.months": "{count}mo ago",
      "time.years": "{count}y ago",
    };

    /** Translation fallback used only if the locale service did not inject one. */
    function defaultTranslate(key, params) {
      const template = typeof zh[key] === "string" ? zh[key] : key;
      return format(template, params);
    }

    // -------------------------------------------------------------------------
    // Client plugin body
    // -------------------------------------------------------------------------

    /** Required browser services: keyed slots, copy, the right-sidebar tab registry. */
    const inject = ["slots", "locale", "sidebarRightTabs", "sidebarRight", "shortcuts"];

    /** Client plugin body: register the stylesheet, dictionaries, tab type, body and title. */
    function apply(ctx) {
      ctx.effect(function () {
        installStyles();
        return function () {
          removeStyles();
        };
      }, "dsh-git-control: styles");
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-git-control: dictionaries");
      const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : defaultTranslate;
      ctx.effect(function () {
        return ctx.slots.inject("conversation.session.header.actions", function () {
          return ctx.slots.register({
            name: "conversation.session.header.actions",
            id: "git-branch",
            order: 15,
            locale: NS,
          }, GitBranchChip);
        });
      }, "dsh-git-control: header branch chip");
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          keepMounted: true,
          title: function () {
            return t("type.label");
          },
          guide: [{
            id: "git",
            order: 10,
            title: function () {
              return t("guide.title");
            },
            description: function () {
              return t("guide.description");
            },
            icon: GitGlyph,
          }],
        });
      }, "dsh-git-control: tab type");
      ctx.effect(function () {
        return ctx.slots.inject(BODY_SLOT, function () {
          return ctx.slots.register({ name: BODY_SLOT, key: ID, locale: NS }, GitBody);
        });
      }, "dsh-git-control: body");
      ctx.effect(function () {
        return ctx.slots.inject(TITLE_SLOT, function () {
          return ctx.slots.register({ name: TITLE_SLOT, key: ID, locale: NS }, GitTitle);
        });
      }, "dsh-git-control: title");
    }

    /** Offline test hook only: undefined unless the harness explicitly opts in. */
    const testHook = typeof window !== "undefined" && window.__DG_TEST__ === true
      ? {
        basename: basename,
        dirname: dirname,
        joinPath: joinPath,
        format: format,
        classifyDiffLine: classifyDiffLine,
        statusMeta: statusMeta,
        formatRelativeTime: formatRelativeTime,
        formatAbsoluteTime: formatAbsoluteTime,
        formatCommitDate: formatCommitDate,
        normalizeDateValue: normalizeDateValue,
        normalizeUntilValue: normalizeUntilValue,
        resolveHistoryLayout: resolveHistoryLayout,
        logQueryParams: logQueryParams,
        summarizeHistoryFilters: summarizeHistoryFilters,
        indexOfHeadCommit: indexOfHeadCommit,
        refTagNode: refTagNode,
        HISTORY_DEFAULT_WIDTH: HISTORY_DEFAULT_WIDTH,
        HISTORY_TREE_BREAKPOINT: HISTORY_TREE_BREAKPOINT,
        HISTORY_AUTHOR_BREAKPOINT: HISTORY_AUTHOR_BREAKPOINT,
        HISTORY_HASH_BREAKPOINT: HISTORY_HASH_BREAKPOINT,
        formatLineNumber: formatLineNumber,
        modeKey: modeKey,
        apiUrl: apiUrl,
        api: api,
        ROUTE_PREFIX: ROUTE_PREFIX,
        GitBody: GitBody,
        GitTitle: GitTitle,
        GitBranchChip: GitBranchChip,
        BranchPanel: BranchPanel,
        CommitGraph: CommitGraph,
        computeLanes: computeLanes,
        resolveUpstream: resolveUpstream,
        popoverFixedStyle: popoverFixedStyle,
        LANE_COLORS: LANE_COLORS,
        GRAPH_HEAD_COLOR: GRAPH_HEAD_COLOR,
        GRAPH_MAX_LANES: GRAPH_MAX_LANES,
        GRAPH_ROW_HEIGHT: GRAPH_ROW_HEIGHT,
        GRAPH_LANE_WIDTH: GRAPH_LANE_WIDTH,
        refTone: refTone,
        ChangesPane: ChangesPane,
        DiffView: DiffView,
        HistoryPane: HistoryPane,
        CommitDetail: CommitDetail,
        buildChangeTree: buildChangeTree,
        collectTreeDirs: collectTreeDirs,
        countTreeFiles: countTreeFiles,
        buildHunkPatch: buildHunkPatch,
        hunkBodyText: hunkBodyText,
        headShaOf: headShaOf,
        readCommitHistory: readCommitHistory,
        rememberCommitMessage: rememberCommitMessage,
        COMMIT_HISTORY_KEY: COMMIT_HISTORY_KEY,
        COMMIT_HISTORY_MAX: COMMIT_HISTORY_MAX,
        CSS_TEXT: CSS_TEXT,
        POLL_MS: POLL_MS,
        LOG_LIMIT: LOG_LIMIT,
      }
      : undefined;

    return {
      inject: inject,
      apply: apply,
      __test: testHook,
    };
  },
});
