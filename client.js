// Browser half of the dsh-git plugin.
//
// A single self-contained client bundle (classic script, no build step, no
// dependencies beyond the shell's static "react" baseline). It registers one
// right-sidebar tab type (kind: "git"), its panel body and its title chip:
//
//   * sidebarRightTabs.register  -> the tab type ("dsh-git" / "git")
//   * slots register "sidebar.right.pane.tab"        -> GitBody  (panel content)
//   * slots register "sidebar.right.pane.tab.title"  -> GitTitle (title chip)
//
// Everything the panel shows comes from the Host half's /git/* HTTP contract in
// docs/contract.md; when a route fails the panel keeps rendering and shows an
// inline error banner with a retry action.
window.__ModuleLoader__.load({
  id: "dsh-git",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const Fragment = React.Fragment;

    // -------------------------------------------------------------------------
    // Identity and wire constants
    // -------------------------------------------------------------------------

    /** This implementation's identity in the tab system and the body/title slot key. */
    const ID = "dsh-git";
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
    // Diff viewer: hunk headers, line numbers, add/del tinting
    // -------------------------------------------------------------------------

    function DiffView(props) {
      const t = typeof props.t === "function" ? props.t : defaultTranslate;
      const stateRef = React.useState({ loading: true, error: null, data: null });
      const state = stateRef[0];
      const setState = stateRef[1];
      const attemptRef = React.useState(0);
      const attempt = attemptRef[0];
      const setAttempt = attemptRef[1];

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
        return h("div", { className: "dg-hunk-block", key: "hunk-" + String(index) },
          h("div", { className: "dg-hunk" }, header),
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
        body);
    }

    // -------------------------------------------------------------------------
    // Changes tab: commit box, four groups, row actions, inline confirm, diff
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

      const canCommit = message.trim().length > 0 && (staged.length > 0 || unstaged.length > 0);
      const autoStageAll = staged.length === 0 && unstaged.length > 0;

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
        if (!canCommit) {
          setActionError(t("changes.commit.nothing"));
          return;
        }
        runWrite("commit", function () {
          return api.commitChanges(props.cwd, trimmed, autoStageAll).then(function (payload) {
            setMessage("");
            const shortSha = payload !== null && typeof payload === "object" && isNonEmptyString(payload.shortSha)
              ? payload.shortSha
              : isNonEmptyString(payload.sha) ? payload.sha.slice(0, 7) : "";
            setNotice(t("changes.commit.success", { sha: shortSha }));
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

      function renderRow(item, group) {
        const path = item !== null && typeof item === "object" && isNonEmptyString(item.path) ? item.path : "";
        if (path === "") return null;
        const origPath = item !== null && typeof item === "object" && isNonEmptyString(item.origPath) ? item.origPath : "";
        const meta = statusMeta(item ? item.status : "M", group.section);
        const selected = diff !== null && diff.path === path;
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
          className: "dg-file-row" + (selected ? " dg-file-row-selected" : ""),
          role: "button",
          tabIndex: 0,
          "aria-pressed": selected ? "true" : "false",
          title: t("changes.row.open", { path: path }),
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
            path,
            origPath === "" ? null : h("span", { className: "dg-file-orig" }, " <- " + origPath)),
          actions.length > 0 ? h("span", { className: "dg-row-actions" }, actions) : null);
      }

      const groups = [
        { section: "staged", titleKey: "changes.group.staged", items: staged, diffMode: "staged", actions: ["unstage"] },
        { section: "unstaged", titleKey: "changes.group.unstaged", items: unstaged, diffMode: "worktree", actions: ["stage", "discard"] },
        { section: "untracked", titleKey: "changes.group.untracked", items: untracked, diffMode: "untracked", actions: ["stage", "discard"] },
        { section: "conflicted", titleKey: "changes.group.conflicted", items: conflicted, diffMode: "worktree", actions: [] },
      ].filter(function (group) {
        return group.items.length > 0;
      });

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
        h("div", { className: "dg-commit-actions" },
          h("button", {
            type: "button",
            className: "dg-btn dg-btn-primary",
            disabled: !canCommit || busy !== null,
            onClick: submitCommit,
          }, busy === "commit" ? t("changes.commit.committing") : t("changes.commit.button")),
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
            h("div", { className: "dg-file-list" }, group.items.map(function (item) {
              return renderRow(item, group);
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
        rows.push(detailRow(t("history.detail.refs"), h("span", null, refs.map(function (tag, index) {
          return h("span", { className: "dg-ref-tag", key: "ref-" + String(index) }, String(tag));
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

    function HistoryPane(props) {
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
      const commitsRef = React.useState([]);
      const commits = commitsRef[0];
      const setCommits = commitsRef[1];
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
      const tokenRef = React.useState(0);
      const token = tokenRef[0];
      const setToken = tokenRef[1];

      const seqRef = React.useRef(0);
      const appendingRef = React.useRef(false);
      const refreshTokenRef = React.useRef(props.refreshToken);
      const commitsLenRef = React.useRef(0);
      commitsLenRef.current = commits.length;

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

      React.useEffect(function () {
        if (refreshTokenRef.current === props.refreshToken) return undefined;
        refreshTokenRef.current = props.refreshToken;
        setToken(function (value) {
          return value + 1;
        });
        return undefined;
      }, [props.refreshToken]);

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
        api.log(props.cwd, { limit: LOG_LIMIT, skip: skip, ref: refName }).then(function (payload) {
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
      }, [props.cwd, refName]);

      React.useEffect(function () {
        loadPage(false);
      }, [loadPage, token]);

      useEscape(detail !== null, function () {
        setDetail(null);
      });

      function onScroll(event) {
        const node = event.currentTarget;
        if (node === null || node === undefined) return;
        if (hasMore !== true || loading === true || loadingMore === true) return;
        const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
        if (remaining <= SCROLL_SLACK) loadPage(true);
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

      const header = h("div", { className: "dg-history-head" },
        h("select", {
          className: "dg-select",
          value: refName,
          "aria-label": t("history.branch"),
          onChange: function (event) {
            setRefName(event.target.value);
          },
        }, options),
        h("button", {
          type: "button",
          className: "dg-icon-btn",
          title: t("summary.refresh"),
          "aria-label": t("summary.refresh"),
          onClick: function () {
            setToken(token + 1);
          },
        }, h(RefreshIcon)));

      const banner = (logError === null && branchError === null) ? null : h("div", { className: "dg-error-banner", role: "alert" },
        h(AlertIcon, { className: "dg-error-icon" }),
        h("span", { className: "dg-error-text" }, describeFailure(t, "error.banner", logError !== null ? logError : branchError)),
        h("button", {
          type: "button",
          className: "dg-link-btn",
          onClick: function () {
            setToken(token + 1);
          },
        }, t("state.retry")));

      const commitRows = commits.map(function (commit, index) {
        const sha = commit !== null && typeof commit === "object" && isNonEmptyString(commit.sha) ? commit.sha : "";
        const shortSha = commit !== null && typeof commit === "object" && isNonEmptyString(commit.shortSha) ? commit.shortSha : sha.slice(0, 7);
        const subject = commit !== null && typeof commit === "object" && isNonEmptyString(commit.subject) ? commit.subject : t("history.subject.empty");
        const refs = commit !== null && typeof commit === "object" && Array.isArray(commit.refs) ? commit.refs : [];
        const author = commit !== null && typeof commit === "object" && isNonEmptyString(commit.author) ? commit.author : "";
        const time = commit !== null && typeof commit === "object" ? commit.time : null;
        return h("div", {
          className: "dg-commit-row",
          key: sha === "" ? "commit-" + String(index) : sha,
          role: "button",
          tabIndex: 0,
          title: subject,
          onClick: function () {
            setDetail({ sha: sha });
          },
          onKeyDown: function (event) {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (typeof event.preventDefault === "function") event.preventDefault();
            setDetail({ sha: sha });
          },
        },
          h("div", { className: "dg-commit-line" },
            h("span", { className: "dg-sha" }, shortSha),
            h("span", { className: "dg-commit-subject" }, subject)),
          h("div", { className: "dg-commit-meta" },
            refs.map(function (tag, refIndex) {
              return h("span", { className: "dg-ref-tag", key: "ref-" + String(refIndex) }, String(tag));
            }),
            author === "" ? null : h("span", { className: "dg-commit-author" }, author),
            time === null ? null : h("span", { className: "dg-commit-time" }, formatRelativeTime(time, Date.now(), t))));
      });

      let listContent;
      if (loading === true) {
        listContent = h("div", { className: "dg-loading" }, t("history.loading"));
      } else if (commits.length === 0) {
        listContent = h("div", { className: "dg-empty" },
          h("div", { className: "dg-empty-title" }, t("history.empty")));
      } else {
        listContent = commitRows;
      }

      return h("div", { className: "dg-history" },
        header,
        banner,
        h("div", { className: "dg-commit-list", onScroll: onScroll },
          listContent,
          loadingMore === true ? h("div", { className: "dg-load-more" }, t("history.loadMore")) : null,
          loading !== true && loadingMore !== true && commits.length > 0 && hasMore !== true
            ? h("div", { className: "dg-load-more" }, t("history.noMore"))
            : null));
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

      const repo = status !== null && typeof status === "object" && status.isRepo === true;
      const branch = repo && status.branch !== null && typeof status.branch === "object" ? status.branch : null;
      const counts = repo && status.counts !== null && typeof status.counts === "object" ? status.counts : null;
      const changeCount = counts === null
        ? 0
        : toCount(counts.staged) + toCount(counts.unstaged) + toCount(counts.untracked);
      const branchName = branch !== null && isNonEmptyString(branch.name) ? branch.name : "";
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
            ? h("span", { className: "dg-branch-name", title: branchName }, branchName === "" ? t("summary.detached") : branchName)
            : h("span", { className: "dg-branch-name dg-muted" }, t("type.label")),
          branch !== null && branch.detached === true && branchName !== "" ? h("span", { className: "dg-track" }, t("summary.detached")) : null,
          branch !== null && toCount(branch.ahead) > 0 ? h("span", { className: "dg-track" }, t("summary.ahead", { count: toCount(branch.ahead) })) : null,
          branch !== null && toCount(branch.behind) > 0 ? h("span", { className: "dg-track" }, t("summary.behind", { count: toCount(branch.behind) })) : null,
          repo && branch !== null && !isNonEmptyString(branch.upstream) ? h("span", { className: "dg-track dg-muted" }, t("summary.noUpstream")) : null,
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
    // Stylesheet (one <style data-dg-plugin="dsh-git">, removed on unload)
    // -------------------------------------------------------------------------

    const CSS_TEXT = [
      ".dg-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f2328);background:transparent;font-size:13px;line-height:18px}",
      ".dg-summary{display:flex;align-items:center;gap:6px;min-height:34px;padding:0 6px 0 10px;flex:none;min-width:0;box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-summary-main{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;overflow:hidden}",
      ".dg-summary-icon{flex:none;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-branch-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-primary,#1f2328)}",
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
      ".dg-badge{flex:none;width:15px;height:15px;border-radius:4px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-primary,#1f2328);font-size:10px;font-weight:600;line-height:15px;text-align:center}",
      ".dg-badge-add{background:rgba(46,160,67,.2)}",
      ".dg-badge-del{background:rgba(248,81,73,.2)}",
      ".dg-badge-mod{background:rgba(210,153,34,.22)}",
      ".dg-badge-conflict{background:rgba(163,113,247,.24)}",
      ".dg-badge-untracked{background:rgba(110,118,129,.2)}",
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
      ".dg-mono{font-family:var(--dsh-font-mono,ui-monospace,monospace)}",
      ".dg-diff-mode{flex:none;padding:0 5px;border-radius:5px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:16px}",
      ".dg-diff-stats{display:inline-flex;gap:6px;flex:none;font-size:11px;font-variant-numeric:tabular-nums}",
      ".dg-add{color:rgba(46,160,67,1)}",
      ".dg-del{color:rgba(248,81,73,1)}",
      ".dg-diff-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.08))}",
      ".dg-hunk-block{font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:11px;line-height:17px;min-width:max-content}",
      ".dg-hunk{padding:1px 8px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.22));color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-diff-row{display:flex;align-items:flex-start;min-width:max-content}",
      ".dg-diff-row-add{background:rgba(46,160,67,.16)}",
      ".dg-diff-row-del{background:rgba(248,81,73,.16)}",
      ".dg-ln{flex:none;width:34px;padding:0 4px;text-align:right;color:var(--dsw-alias-label-tertiary,#6e7781);font-variant-numeric:tabular-nums;user-select:none}",
      ".dg-diff-sign{flex:none;width:9px;text-align:center;color:var(--dsw-alias-label-secondary,#57606a);user-select:none}",
      ".dg-diff-text{flex:0 0 auto;padding-right:10px;white-space:pre;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dg-diff-notice{margin:6px 8px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.22));color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;flex:none}",
      ".dg-history{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}",
      ".dg-history-head{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}",
      ".dg-select{flex:1 1 auto;min-width:0;height:24px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:6px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px}",
      ".dg-commit-list{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 6px 10px}",
      ".dg-commit-row{display:flex;flex-direction:column;gap:1px;padding:5px 6px;border-radius:6px;cursor:pointer;min-width:0}",
      ".dg-commit-row:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14))}",
      ".dg-commit-row:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.24));outline-offset:-1px}",
      ".dg-commit-line{display:flex;align-items:baseline;gap:6px;min-width:0}",
      ".dg-sha{flex:none;font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-commit-subject{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
      ".dg-commit-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781);min-width:0}",
      ".dg-commit-author{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}",
      ".dg-commit-time{flex:none;font-variant-numeric:tabular-nums}",
      ".dg-ref-tag{flex:none;padding:0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:4px;color:var(--dsw-alias-label-secondary,#57606a);font-size:10px;line-height:14px}",
      ".dg-load-more{padding:6px;text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-detail{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}",
      ".dg-detail-scroll{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px 10px 14px}",
      ".dg-detail-title{font-size:13px;font-weight:600;line-height:19px;overflow-wrap:anywhere}",
      ".dg-detail-grid{display:flex;flex-direction:column;gap:3px;margin-top:6px;font-size:12px}",
      ".dg-detail-row{display:flex;gap:8px;min-width:0}",
      ".dg-detail-label{flex:none;width:52px;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-detail-value{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-body-text{margin:6px 0 0;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14));color:var(--dsw-alias-label-secondary,#57606a);font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto}",
      ".dg-section-title{margin:12px 0 4px;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6e7781)}",
      ".dg-file-table{display:flex;flex-direction:column}",
      ".dg-file-table-row{display:flex;align-items:center;gap:6px;padding:3px 5px;border-radius:6px;cursor:pointer;min-width:0}",
      ".dg-file-table-row:hover{background:var(--dsw-alias-fill-l1,rgba(175,184,193,.14))}",
      ".dg-file-table-row:focus-visible{outline:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.24));outline-offset:-1px}",
      ".dg-numstat{flex:none;display:inline-flex;gap:5px;font-size:11px;font-variant-numeric:tabular-nums}",
      ".dg-title-icon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dg-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dg-title-branch{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;border-radius:5px;background:var(--dsw-alias-fill-l1,rgba(175,184,193,.2));color:var(--dsw-alias-label-secondary,#57606a);font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px}",
      ".dg-title-count{flex:none;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(175,184,193,.28));color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums}",
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
      "guide.description": "查看分支、工作区变更与提交历史，暂存、放弃并提交更改",
      "tabs.aria": "Git 视图切换",
      "tabs.changes": "变更",
      "tabs.history": "历史",
      "summary.refresh": "刷新",
      "summary.detached": "HEAD 分离",
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
      "history.branch": "分支",
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
      "guide.description": "Review branches, working-tree changes and commit history; stage, discard and commit",
      "tabs.aria": "Git view switcher",
      "tabs.changes": "Changes",
      "tabs.history": "History",
      "summary.refresh": "Refresh",
      "summary.detached": "Detached HEAD",
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
      "history.branch": "Branch",
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
      }, "dsh-git: styles");
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-git: dictionaries");
      const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : defaultTranslate;
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
      }, "dsh-git: tab type");
      ctx.effect(function () {
        return ctx.slots.inject(BODY_SLOT, function () {
          return ctx.slots.register({ name: BODY_SLOT, key: ID, locale: NS }, GitBody);
        });
      }, "dsh-git: body");
      ctx.effect(function () {
        return ctx.slots.inject(TITLE_SLOT, function () {
          return ctx.slots.register({ name: TITLE_SLOT, key: ID, locale: NS }, GitTitle);
        });
      }, "dsh-git: title");
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
        formatLineNumber: formatLineNumber,
        modeKey: modeKey,
        apiUrl: apiUrl,
        api: api,
        ROUTE_PREFIX: ROUTE_PREFIX,
        GitBody: GitBody,
        GitTitle: GitTitle,
        ChangesPane: ChangesPane,
        DiffView: DiffView,
        HistoryPane: HistoryPane,
        CommitDetail: CommitDetail,
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
