// Smoke tests for the dsh-git browser half (client.js).
//
// The bundle is a classic script, so it is materialised inside a fake window with a
// stubbed module loader and executed with node:vm. No DOM is involved.
//
// Two render strategies are used:
//   1. react-dom/server.renderToStaticMarkup, when a version-compatible react and
//      react-dom pair can be resolved (the installed profile ships react 18 with
//      react-dom 19, which cannot server-render, so that path currently skips);
//   2. a dependency-free harness: the bundle is loaded a second time with a tiny
//      React shim (createElement / Fragment / useState / useEffect / useRef) and the
//      element tree is serialised directly. This always runs and exercises the real
//      component render paths.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const CLIENT_PATH = path.join(PROJECT_ROOT, "client.js");
const SOURCE = readFileSync(CLIENT_PATH, "utf8");

/** Backslash as a value, so path literals stay readable without escapes. */
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

/** Where the installed DSH profiles keep their node_modules. */
const PROFILE_NODE_MODULES = "C:/Users/wangxiao13/.dsh/profiles/node_modules";

/** Module roots searched for a usable react/react-dom pair, most specific first. */
const MODULE_ROOTS = [
  process.env.DSH_GIT_TEST_MODULES,
  PROFILE_NODE_MODULES,
  path.join(PROJECT_ROOT, "node_modules"),
].filter((root) => typeof root === "string" && root.length > 0);

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

function versionMajor(value) {
  const text = typeof value === "string" ? value : "";
  const major = Number(text.split(".")[0]);
  return Number.isFinite(major) ? major : 0;
}

function requireFrom(root, request) {
  if (!existsSync(root)) return null;
  try {
    return createRequire(path.join(root, "noop.js"))(request);
  } catch (error) {
    return null;
  }
}

/** True when this pair can actually render a React element on the server. */
function probeRender(react, server) {
  if (react === null || server === null) return false;
  try {
    const html = server.renderToStaticMarkup(react.createElement("div", null, "probe"));
    return typeof html === "string" && html.indexOf("probe") !== -1;
  } catch (error) {
    return false;
  }
}

/**
 * Find a react/react-dom/server triple. A candidate counts as renderable when the two
 * packages share a major version and a probe render succeeds; the first loadable
 * candidate is kept as a fallback so the registration tests always run.
 */
function resolveEnvironment() {
  let fallback = null;
  for (const root of MODULE_ROOTS) {
    const react = requireFrom(root, "react");
    if (react === null) continue;
    const reactDom = requireFrom(root, "react-dom");
    const server = requireFrom(root, "react-dom/server");
    const reactMajor = versionMajor(react.version);
    const domMajor = versionMajor(reactDom === null ? "" : reactDom.version);
    const sameMajor = domMajor === 0 || reactMajor === domMajor;
    const candidate = {
      root,
      react,
      reactDom,
      server,
      reactMajor,
      domMajor,
      compatible: sameMajor && probeRender(react, server),
    };
    if (fallback === null) fallback = candidate;
    if (candidate.compatible) return candidate;
  }
  return fallback;
}

const ENVIRONMENT = resolveEnvironment();

function describeEnvironment() {
  if (ENVIRONMENT === null) return "react and react-dom could not be loaded from any known module root";
  return "react " + String(ENVIRONMENT.react && ENVIRONMENT.react.version)
    + " with react-dom " + String(ENVIRONMENT.reactDom && ENVIRONMENT.reactDom.version)
    + " from " + ENVIRONMENT.root;
}

// ---------------------------------------------------------------------------
// Dependency-free React shim and element-tree serialiser (render strategy 2)
// ---------------------------------------------------------------------------

function createShimReact() {
  function Component(props) {
    this.props = props === undefined ? {} : props;
    this.state = null;
  }
  Component.prototype.setState = function setState(partial) {
    const next = typeof partial === "function" ? partial(this.state) : partial;
    this.state = Object.assign({}, this.state, next);
  };
  return {
    version: "0.0.0-shim",
    Fragment: Symbol.for("react.fragment"),
    Component,
    createElement(type, props) {
      const merged = Object.assign({}, props === null || props === undefined ? {} : props);
      delete merged.key;
      const children = Array.prototype.slice.call(arguments, 2);
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { $$typeof: Symbol.for("react.element"), type, key: null, props: merged, _owner: null, _store: {} };
    },
    useState(initial) {
      const value = typeof initial === "function" ? initial() : initial;
      return [value, () => {}];
    },
    useRef(current) {
      return { current: current === undefined ? null : current };
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
  };
}

function createStubReactDom() {
  return { version: "0.0.0-stub", createPortal: (node) => node };
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escapeText(value) {
  return String(value).replace(/[&<>"]/g, (character) => ESCAPES[character]);
}

/** Serialise an element tree produced by the shim React; effects are not executed. */
function renderStatic(react, node) {
  function renderValue(value) {
    if (value === null || value === undefined || value === false || value === true) return "";
    if (typeof value === "string") return escapeText(value);
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) {
      let out = "";
      for (const child of value) out += renderValue(child);
      return out;
    }
    if (typeof value !== "object") return "";
    if (typeof value.type === "function") {
      const prototype = value.type.prototype;
      if (prototype !== undefined && prototype !== null && typeof prototype.render === "function") {
        const instance = new value.type(value.props);
        if (instance.props === undefined) instance.props = value.props;
        if (instance.state === undefined || instance.state === null) instance.state = {};
        return renderValue(instance.render());
      }
      return renderValue(value.type(value.props));
    }
    if (value.type === react.Fragment) return renderValue(value.props.children);
    if (typeof value.type !== "string") return "";
    const props = value.props === null || value.props === undefined ? {} : value.props;
    let attributes = "";
    for (const name of Object.keys(props)) {
      if (name === "children") continue;
      const raw = props[name];
      if (raw === undefined || raw === null || raw === false) continue;
      if (typeof raw === "function" || typeof raw === "object") continue;
      if (raw === true) {
        attributes += " " + name;
        continue;
      }
      attributes += " " + name + '="' + escapeText(raw) + '"';
    }
    return "<" + value.type + attributes + ">" + renderValue(props.children) + "</" + value.type + ">";
  }
  return renderValue(node);
}

// ---------------------------------------------------------------------------
// Client bundle materialisation
// ---------------------------------------------------------------------------

function loadClient(react, reactDom, options) {
  let captured = null;
  const requests = [];
  const controller = {
    responder() {
      return jsonResponse({ ok: true });
    },
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          captured = registration;
        },
      },
      __DG_TEST__: options === null || options === undefined || options.testHook !== false,
    },
    document: options !== null && options !== undefined && options.document !== undefined ? options.document : undefined,
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.fetch = (url, options) => {
    requests.push({ url, options });
    return Promise.resolve().then(() => controller.responder(url, options));
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "client.js" });
  if (captured === null) throw new Error("client.js did not call window.__ModuleLoader__.load");
  const moduleExports = captured.factory((request) => {
    if (request === "react") return react;
    if (request === "react-dom") return reactDom;
    throw new Error("client.js required an unexpected module: " + String(request));
  });
  return { registration: captured, moduleExports, requests, controller };
}

function jsonResponse(body, status) {
  const code = status === undefined ? 200 : status;
  return { ok: code >= 200 && code < 300, status: code, json: () => Promise.resolve(body) };
}

const REAL_REACT = ENVIRONMENT === null || ENVIRONMENT.react === null ? null : ENVIRONMENT.react;
const REACT_FOR_BUNDLE = REAL_REACT === null ? createShimReact() : REAL_REACT;
const REACT_DOM_FOR_BUNDLE = ENVIRONMENT === null || ENVIRONMENT.reactDom === null ? createStubReactDom() : ENVIRONMENT.reactDom;

const CLIENT = loadClient(REACT_FOR_BUNDLE, REACT_DOM_FOR_BUNDLE);
const INTERNALS = CLIENT.moduleExports.__test;

const SHIM_REACT = createShimReact();
const SHIM_CLIENT = loadClient(SHIM_REACT, createStubReactDom());
const SHIM_INTERNALS = SHIM_CLIENT.moduleExports.__test;

function staticRender(component, props) {
  return renderStatic(SHIM_REACT, SHIM_REACT.createElement(component, props));
}

/** True when the real react-dom/server path is available and version-compatible. */
function canServerRender() {
  return ENVIRONMENT !== null && ENVIRONMENT.compatible === true;
}

// ---------------------------------------------------------------------------
// apply() capture: dictionaries, tab type, body and title registrations
// ---------------------------------------------------------------------------

function fillPlaceholders(template, params) {
  if (params === null || params === undefined || typeof params !== "object") return template;
  let out = template;
  for (const name of Object.keys(params)) out = out.split("{" + name + "}").join(String(params[name]));
  return out;
}

function createFakeContext() {
  const state = {
    effectLabels: [],
    disposers: [],
    localeCalls: [],
    tabRegistrations: [],
    slotRegistrations: [],
    dictionaries: {},
  };
  const context = {
    effect(fn, label) {
      state.effectLabels.push(label);
      const dispose = typeof fn === "function" ? fn() : undefined;
      const disposable = typeof dispose === "function" ? dispose : () => {};
      state.disposers.push(disposable);
      return disposable;
    },
    locale: {
      register(namespace, dictionaries) {
        state.localeCalls.push({ namespace, dictionaries });
        state.dictionaries[namespace] = dictionaries;
        return () => {};
      },
      bind(namespace) {
        return (key, params) => {
          const dictionaries = state.dictionaries[namespace] || {};
          const zh = dictionaries.zh || {};
          const template = typeof zh[key] === "string" ? zh[key] : key;
          return fillPlaceholders(template, params);
        };
      },
    },
    sidebarRightTabs: {
      register(spec) {
        state.tabRegistrations.push(spec);
        return () => {};
      },
    },
    slots: {
      inject(name, callback) {
        const dispose = callback();
        return typeof dispose === "function" ? dispose : () => {};
      },
      register(spec, component) {
        state.slotRegistrations.push({ spec, component });
        return () => {};
      },
    },
  };
  return { context, state };
}

const APPLIED = createFakeContext();
CLIENT.moduleExports.apply(APPLIED.context);
const STATE = APPLIED.state;
const DICTIONARIES = STATE.dictionaries.git;
const T = APPLIED.context.locale.bind("git");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATUS_FIXTURE = {
  ok: true,
  isRepo: true,
  root: "/tmp/repo",
  toplevel: "/tmp/repo",
  branch: { name: "main", detached: false, sha: "0123456789abcdef", shortSha: "0123456", upstream: "origin/main", ahead: 1, behind: 2 },
  staged: [{ path: "src/staged.ts", origPath: null, status: "M" }],
  unstaged: [{ path: "src/worktree.ts", origPath: null, status: "M" }],
  untracked: [{ path: "notes.md", origPath: null, status: "?" }],
  conflicted: [],
  counts: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 },
};

// ---------------------------------------------------------------------------
// 1. Bundle identity and shape
// ---------------------------------------------------------------------------

test("client.js registers itself with the module loader as dsh-git", () => {
  assert.equal(CLIENT.registration.id, "dsh-git");
  assert.equal(typeof CLIENT.registration.factory, "function");
});

test("client.js stays a classic, react-only bundle", () => {
  for (const line of SOURCE.split(NL)) {
    const trimmed = line.trim();
    assert.ok(!trimmed.startsWith("import "), "top-level import found; the loader cannot parse ESM");
    assert.ok(!trimmed.startsWith("export "), "top-level export found; the loader cannot parse ESM");
  }
  const names = new Set();
  let index = SOURCE.indexOf("require(");
  while (index !== -1) {
    let cursor = index + "require(".length;
    while (cursor < SOURCE.length && SOURCE[cursor] === " ") cursor += 1;
    const quote = SOURCE[cursor];
    if (quote === '"' || quote === "'") {
      const close = SOURCE.indexOf(quote, cursor + 1);
      if (close !== -1) names.add(SOURCE.slice(cursor + 1, close));
    }
    index = SOURCE.indexOf("require(", index + 1);
  }
  assert.ok(names.size > 0, "expected at least one require() of the react baseline");
  for (const name of names) assert.ok(name === "react" || name === "react-dom", "unexpected require(" + name + ")");
  assert.ok(!SOURCE.includes("window.document"), "the bundle must not reach for window.document");
});

// ---------------------------------------------------------------------------
// 2. Factory exports
// ---------------------------------------------------------------------------

test("the test hook stays hidden unless the harness opts in", () => {
  const production = loadClient(createShimReact(), createStubReactDom(), { testHook: false });
  assert.equal(production.moduleExports.__test, undefined, "__test must not be exported in production");
  assert.equal(typeof production.moduleExports.apply, "function");
  assert.deepEqual(Array.from(production.moduleExports.inject), ["slots", "locale", "sidebarRightTabs", "sidebarRight", "shortcuts"]);
});

test("factory returns apply and the documented inject list", () => {
  assert.equal(typeof CLIENT.moduleExports.apply, "function");
  assert.deepEqual(Array.from(CLIENT.moduleExports.inject), ["slots", "locale", "sidebarRightTabs", "sidebarRight", "shortcuts"]);
});

// ---------------------------------------------------------------------------
// 3. apply() registrations
// ---------------------------------------------------------------------------

test("apply registers the git dictionaries with identical zh/en key sets", () => {
  assert.equal(STATE.localeCalls.length, 1);
  assert.equal(STATE.localeCalls[0].namespace, "git");
  assert.ok(DICTIONARIES !== null && typeof DICTIONARIES === "object");
  const zhKeys = Array.from(Object.keys(DICTIONARIES.zh)).sort();
  const enKeys = Array.from(Object.keys(DICTIONARIES.en)).sort();
  assert.deepEqual(enKeys, zhKeys);
  assert.ok(zhKeys.length >= 60, "expected a complete dictionary, got " + String(zhKeys.length) + " keys");
  for (const key of zhKeys) {
    assert.equal(typeof DICTIONARIES.zh[key], "string", "zh value for " + key + " must be a string");
    assert.ok(DICTIONARIES.zh[key].length > 0, "zh value for " + key + " must not be empty");
    assert.equal(typeof DICTIONARIES.en[key], "string", "en value for " + key + " must be a string");
    assert.ok(DICTIONARIES.en[key].length > 0, "en value for " + key + " must not be empty");
  }
  for (const key of ["type.label", "guide.title", "guide.description", "tabs.changes", "tabs.history", "changes.empty.title"]) {
    assert.ok(zhKeys.includes(key), "missing required i18n key " + key);
  }
});

test("apply registers exactly one right-sidebar tab type for dsh-git", () => {
  assert.equal(STATE.tabRegistrations.length, 1);
  const spec = STATE.tabRegistrations[0];
  assert.equal(spec.id, "dsh-git");
  assert.equal(spec.kind, "git");
  assert.equal(spec.keepMounted, true);
  assert.equal(typeof spec.title, "function");
  assert.ok(spec.title().length > 0);
  assert.ok(Array.isArray(spec.guide));
  assert.equal(spec.guide.length, 1);
  assert.equal(spec.guide[0].id, "git");
  assert.equal(typeof spec.guide[0].icon, "function");
  assert.equal(typeof spec.guide[0].title, "function");
  assert.equal(typeof spec.guide[0].description, "function");
  assert.ok(spec.guide[0].title().length > 0);
  assert.ok(spec.guide[0].description().length > 0);
});

test("apply registers the panel body and the title chip keyed by dsh-git", () => {
  assert.equal(STATE.slotRegistrations.length, 2);
  const body = STATE.slotRegistrations[0];
  const title = STATE.slotRegistrations[1];
  assert.equal(body.spec.name, "sidebar.right.pane.tab");
  assert.equal(title.spec.name, "sidebar.right.pane.tab.title");
  for (const registration of STATE.slotRegistrations) {
    assert.equal(registration.spec.key, "dsh-git");
    assert.equal(registration.spec.locale, "git");
    assert.equal(typeof registration.component, "function");
  }
  assert.equal(body.component, INTERNALS.GitBody);
  assert.equal(title.component, INTERNALS.GitTitle);
  assert.deepEqual(Array.from(STATE.effectLabels), [
    "dsh-git: styles",
    "dsh-git: dictionaries",
    "dsh-git: tab type",
    "dsh-git: body",
    "dsh-git: title",
  ]);
});

test("panel components keep the injected props contract", () => {
  assert.equal(typeof INTERNALS.GitBody, "function");
  assert.equal(typeof INTERNALS.GitTitle, "function");
  assert.equal(INTERNALS.GitBody.length, 1, "GitBody must take a single props object");
  assert.equal(INTERNALS.GitTitle.length, 1, "GitTitle must take a single props object");
  assert.ok(INTERNALS.GitBody.toString().includes("dg-root"), "GitBody should render the dg- prefixed panel root");
  assert.equal(INTERNALS.ROUTE_PREFIX, "/git");
  assert.ok(INTERNALS.GitBody.toString().includes("dg-summary"), "GitBody should render the branch summary row");
});

// ---------------------------------------------------------------------------
// 4. Render smoke tests
// ---------------------------------------------------------------------------

test("renders the Git title chip", (t) => {
  const props = { useTabInfo: () => ({ tab: { title: "", visible: true } }), t: T };
  let html;
  if (canServerRender()) {
    html = ENVIRONMENT.server.renderToStaticMarkup(ENVIRONMENT.react.createElement(INTERNALS.GitTitle, props));
  } else {
    t.diagnostic("falling back to the dependency-free render harness (" + describeEnvironment() + ")");
    html = staticRender(SHIM_INTERNALS.GitTitle, props);
  }
  assert.match(html, /dg-title/);
  assert.match(html, /Git/);
});

test("title chip prefers the registered tab title and survives missing props", (t) => {
  let named;
  let bare;
  if (canServerRender()) {
    const react = ENVIRONMENT.react;
    const server = ENVIRONMENT.server;
    named = server.renderToStaticMarkup(react.createElement(INTERNALS.GitTitle, {
      useTabInfo: () => ({ tab: { title: "Source Control", visible: true } }),
      t: T,
    }));
    bare = server.renderToStaticMarkup(react.createElement(INTERNALS.GitTitle, {}));
  } else {
    t.diagnostic("falling back to the dependency-free render harness");
    named = staticRender(SHIM_INTERNALS.GitTitle, {
      useTabInfo: () => ({ tab: { title: "Source Control", visible: true } }),
      t: T,
    });
    bare = staticRender(SHIM_INTERNALS.GitTitle, {});
  }
  assert.match(named, /Source Control/);
  assert.match(bare, /dg-title/);
  assert.match(bare, /Git/);
});

test("panel body renders a cwd-less empty state instead of blank output", () => {
  const html = staticRender(SHIM_INTERNALS.GitBody, {
    sessionId: "s1",
    useTabInfo: () => ({ tab: { visible: true } }),
    t: T,
  });
  assert.match(html, /dg-root/);
  assert.match(html, /没有工作目录/);
  assert.match(html, /dg-summary/);
});

test("panel body renders the not-a-repository state and the loading state", () => {
  const noRepo = staticRender(SHIM_INTERNALS.GitBody, {
    sessionId: "s1",
    useSessions: (selector) => selector({ byId: { s1: { cwd: "/tmp/not-a-repo" } } }),
    useTabInfo: () => ({ tab: { visible: true } }),
    t: T,
  });
  assert.match(noRepo, /dg-root/);
  assert.match(noRepo, /dg-tabs/);
  assert.match(noRepo, /变更/);
  assert.match(noRepo, /历史/);
  assert.match(noRepo, /正在读取 Git 状态/);
});

test("changes pane renders the four groups, badges and row actions", () => {
  const html = staticRender(SHIM_INTERNALS.ChangesPane, {
    cwd: "/tmp/repo",
    t: T,
    status: STATUS_FIXTURE,
    onChanged: () => {},
  });
  assert.match(html, /dg-commit-box/);
  assert.match(html, /提交信息（Ctrl\+Enter 提交）/);
  assert.match(html, /dg-textarea/);
  assert.match(html, /已暂存/);
  assert.match(html, /src\/staged\.ts/);
  assert.match(html, /取消暂存/);
  assert.match(html, /src\/worktree\.ts/);
  assert.match(html, /暂存/);
  assert.match(html, /放弃/);
  assert.match(html, /notes\.md/);
  assert.match(html, /dg-badge-mod/);
  assert.match(html, /dg-badge-untracked/);
  assert.ok(!html.includes("冲突"), "empty groups must not render");
});

test("changes pane renders the clean working tree empty state", () => {
  const html = staticRender(SHIM_INTERNALS.ChangesPane, {
    cwd: "/tmp/repo",
    t: T,
    status: { isRepo: true, staged: [], unstaged: [], untracked: [], conflicted: [] },
    onChanged: () => {},
  });
  assert.match(html, /工作区干净/);
  assert.ok(!html.includes("dg-group-head"), "no group container for an empty working tree");
});

test("diff view renders its header, mode badge and loading state", () => {
  const html = staticRender(SHIM_INTERNALS.DiffView, {
    cwd: "/tmp/repo",
    path: "src/a.ts",
    mode: "worktree",
    t: T,
  });
  assert.match(html, /dg-diff/);
  assert.match(html, /dg-diff-head/);
  assert.match(html, /src\/a\.ts/);
  assert.match(html, /工作区/);
  assert.match(html, /正在加载差异/);
});

test("history pane renders the branch selector and its loading state", () => {
  const html = staticRender(SHIM_INTERNALS.HistoryPane, { cwd: "/tmp/repo", t: T });
  assert.match(html, /dg-history/);
  assert.match(html, /dg-history-head/);
  assert.match(html, /HEAD（当前分支）/);
  assert.match(html, /正在加载提交/);
});

test("commit detail renders its shell and loading state", () => {
  const html = staticRender(SHIM_INTERNALS.CommitDetail, {
    cwd: "/tmp/repo",
    sha: "0123456789abcdef",
    t: T,
    onBack: () => {},
  });
  assert.match(html, /dg-detail/);
  assert.match(html, /提交详情/);
  assert.match(html, /正在读取 Git 状态/);
});

// ---------------------------------------------------------------------------
// 4b. Stylesheet injection (a real browser always has a document)
// ---------------------------------------------------------------------------

function createFakeDocument() {
  function matches(node, attribute, value) {
    if (node.attributes === undefined) return false;
    if (node.attributes[attribute] === undefined) return false;
    return value === null || node.attributes[attribute] === value;
  }
  const head = {
    children: [],
    appendChild(node) {
      node.parentNode = head;
      head.children.push(node);
      return node;
    },
    removeChild(node) {
      const index = head.children.indexOf(node);
      if (index !== -1) head.children.splice(index, 1);
      node.parentNode = null;
      return node;
    },
  };
  const body = {
    children: [],
    appendChild(node) {
      body.children.push(node);
      node.parentNode = body;
      return node;
    },
  };
  const document = {
    head,
    body,
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        attributes: {},
        textContent: "",
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name];
        },
      };
    },
    querySelector(selector) {
      let attribute = null;
      let value = null;
      const open = selector.indexOf("[");
      if (open !== -1) {
        const close = selector.indexOf("]", open);
        const inside = selector.slice(open + 1, close);
        const equals = inside.indexOf("=");
        if (equals === -1) {
          attribute = inside;
        } else {
          attribute = inside.slice(0, equals);
          value = inside.slice(equals + 1).split('"').join("");
        }
      }
      if (attribute === null) return null;
      const all = head.children.concat(body.children);
      for (const node of all) if (matches(node, attribute, value)) return node;
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return document;
}

test("styles are injected once and removed again on unload", () => {
  const fakeDocument = createFakeDocument();
  const styleClient = loadClient(createShimReact(), createStubReactDom(), { document: fakeDocument });
  const applied = createFakeContext();
  styleClient.moduleExports.apply(applied.context);
  assert.equal(fakeDocument.head.children.length, 1, "exactly one style tag is injected");
  const tag = fakeDocument.head.children[0];
  assert.equal(tag.getAttribute("data-plugin"), "dsh-git");
  assert.equal(tag.getAttribute("data-dg-style"), "dsh-git/styles");
  const css = tag.textContent;
  assert.ok(css.length > 2000, "the stylesheet should be substantial, got " + String(css.length) + " chars");
  assert.ok(css.includes(".dg-root{"), "panel root styles are present");
  assert.ok(css.includes(".dg-diff-row-add{background:rgba(46,160,67,.16)}"), "diff add tint follows the contract");
  assert.ok(css.includes(".dg-diff-row-del{background:rgba(248,81,73,.16)}"), "diff del tint follows the contract");
  assert.ok(css.includes("var(--dsw-alias-label-primary,#1f2328)"), "theme tokens keep their fallbacks");
  assert.ok(css.includes('content:""'), "the active tab underline rule is intact");
  assert.ok(!css.includes(String.fromCharCode(92) + String.fromCharCode(34)), "no escaped quotes leaked into the CSS text");

  styleClient.moduleExports.apply(createFakeContext().context);
  assert.equal(fakeDocument.head.children.length, 1, "repeated applies reuse the style tag");

  const panel = fakeDocument.createElement("div");
  panel.setAttribute("data-dg-plugin", "dsh-git");
  fakeDocument.body.appendChild(panel);
  for (const dispose of applied.state.disposers) dispose();
  assert.equal(fakeDocument.head.children.length, 1, "unload keeps styles while a panel is mounted");

  fakeDocument.body.children.length = 0;
  const second = createFakeContext();
  styleClient.moduleExports.apply(second.context);
  for (const dispose of second.state.disposers) dispose();
  assert.equal(fakeDocument.head.children.length, 0, "unload removes the style tag");
});

// ---------------------------------------------------------------------------
// 5. Pure helpers
// ---------------------------------------------------------------------------

test("path helpers normalize repository-relative paths", () => {
  const { basename, dirname, joinPath } = INTERNALS;
  assert.equal(basename("src/a.ts"), "a.ts");
  assert.equal(basename("notes.md"), "notes.md");
  assert.equal(basename("D:" + BS + "code" + BS + "x" + BS), "x");
  assert.equal(basename("a/b/c/"), "c");
  assert.equal(basename(""), "");
  assert.equal(basename("/"), "");
  assert.equal(basename("D:/"), "D:");
  assert.equal(dirname("D:/code/x/a.ts"), "D:/code/x");
  assert.equal(dirname("/a/b"), "/a");
  assert.equal(dirname("a.ts"), "");
  assert.equal(dirname("D:/a"), "D:/");
  assert.equal(joinPath("D:" + BS + "code" + BS + "x", "src/a.ts"), "D:/code/x/src/a.ts");
  assert.equal(joinPath("/tmp/repo", "a"), "/tmp/repo/a");
  assert.equal(joinPath("/", "a"), "/a");
  assert.equal(joinPath("D:/code/x/", ""), "D:/code/x");
});

test("diff lines classify into add / del / context rows", () => {
  const { classifyDiffLine } = INTERNALS;
  const add = classifyDiffLine({ type: "add", text: "x", oldLine: null, newLine: 3 });
  assert.equal(add.kind, "add");
  assert.equal(add.sign, "+");
  assert.equal(add.rowClass, "dg-diff-row dg-diff-row-add");
  const del = classifyDiffLine({ type: "del", text: "y", oldLine: 2, newLine: null });
  assert.equal(del.kind, "del");
  assert.equal(del.sign, "-");
  assert.equal(del.rowClass, "dg-diff-row dg-diff-row-del");
  const context = classifyDiffLine({ type: "context", text: "z", oldLine: 1, newLine: 1 });
  assert.equal(context.kind, "context");
  assert.equal(context.rowClass, "dg-diff-row dg-diff-row-context");
  for (const input of [null, undefined, {}, { type: "whatever" }]) {
    assert.equal(classifyDiffLine(input).kind, "context");
  }
});

test("status letters map to the documented badges and labels", () => {
  const { statusMeta } = INTERNALS;
  const modified = statusMeta("M", "unstaged");
  assert.equal(modified.letter, "M");
  assert.equal(modified.tone, "mod");
  assert.equal(modified.labelKey, "status.M");
  assert.equal(statusMeta("A", "staged").tone, "add");
  assert.equal(statusMeta("D", "staged").tone, "del");
  assert.equal(statusMeta("R", "staged").tone, "add");
  assert.equal(statusMeta("C", "staged").labelKey, "status.C");
  assert.equal(statusMeta("T", "staged").tone, "mod");
  const untracked = statusMeta("?", "untracked");
  assert.equal(untracked.letter, "U", "untracked rows show the U letter");
  assert.equal(untracked.tone, "untracked");
  assert.equal(untracked.labelKey, "status.untracked");
  const conflicted = statusMeta("U", "conflicted");
  assert.equal(conflicted.letter, "!", "conflicted rows show the ! letter");
  assert.equal(conflicted.tone, "conflict");
  assert.equal(conflicted.labelKey, "status.conflict");
  const unknown = statusMeta("Z", "staged");
  assert.equal(unknown.letter, "M");
  assert.equal(unknown.labelKey, "status.M");
  assert.equal(statusMeta(undefined, null).letter, "M");
});

test("relative time formatting covers every bucket", () => {
  const { formatRelativeTime } = INTERNALS;
  const nowMs = 1700000000000;
  const nowSeconds = Math.floor(nowMs / 1000);
  assert.equal(formatRelativeTime(null, nowMs, T), "");
  assert.equal(formatRelativeTime(0, nowMs, T), "");
  assert.equal(formatRelativeTime(nowSeconds - 10, nowMs, T), "刚刚");
  assert.equal(formatRelativeTime(nowSeconds - 90, nowMs, T), "1 分钟前");
  assert.equal(formatRelativeTime(nowSeconds - 3 * 3600, nowMs, T), "3 小时前");
  assert.equal(formatRelativeTime(nowSeconds - 2 * 86400, nowMs, T), "2 天前");
  assert.equal(formatRelativeTime(nowSeconds - 10 * 86400, nowMs, T), "1 周前");
  assert.equal(formatRelativeTime(nowSeconds - 70 * 86400, nowMs, T), "2 个月前");
  assert.equal(formatRelativeTime(nowSeconds - 800 * 86400, nowMs, T), "2 年前");
  assert.equal(formatRelativeTime(nowSeconds - 5, nowMs), "刚刚", "the built-in fallback translator is usable");
});

test("absolute time, line numbers and diff modes are stable", () => {
  const { formatAbsoluteTime, formatLineNumber, modeKey, format } = INTERNALS;
  assert.equal(formatLineNumber(3), "3");
  assert.equal(formatLineNumber(0), "0");
  assert.equal(formatLineNumber(null), "");
  assert.equal(formatLineNumber("4"), "");
  assert.equal(modeKey("worktree"), "diff.mode.worktree");
  assert.equal(modeKey("staged"), "diff.mode.staged");
  assert.equal(modeKey("untracked"), "diff.mode.untracked");
  assert.equal(modeKey("commit"), "diff.mode.commit");
  assert.equal(modeKey("anything-else"), "diff.mode.worktree");
  assert.equal(typeof formatAbsoluteTime(1700000000), "string");
  assert.ok(formatAbsoluteTime(1700000000).length > 0);
  assert.equal(formatAbsoluteTime(null), "");
  assert.equal(formatAbsoluteTime(-5), "");
  assert.equal(format("{a}+{b}", { a: 1, b: "x" }), "1+x");
  assert.equal(format("no placeholders", { a: 1 }), "no placeholders");
  assert.equal(format("{missing}", {}), "");
  assert.equal(format(null, { a: 1 }), "");
});

// ---------------------------------------------------------------------------
// 6. Host route shape (docs/contract.md section 1)
// ---------------------------------------------------------------------------

function resetRequests() {
  CLIENT.requests.length = 0;
}

function lastRequest() {
  return CLIENT.requests[CLIENT.requests.length - 1];
}

test("status reads use GET /git/status with the session root", async () => {
  resetRequests();
  CLIENT.controller.responder = () => jsonResponse({ ok: true, isRepo: true, branch: { name: "main" } });
  const payload = await INTERNALS.api.status("/tmp/repo");
  assert.equal(payload.isRepo, true);
  const request = lastRequest();
  assert.equal(request.url, "/git/status?root=%2Ftmp%2Frepo");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin");
});

test("diff, log, commit and branches reads target their documented routes", async () => {
  resetRequests();
  CLIENT.controller.responder = () => jsonResponse({ ok: true, hunks: [] });
  await INTERNALS.api.diff("/tmp/repo", "src/a.ts", "worktree");
  assert.ok(lastRequest().url.startsWith("/git/diff?"), "diff must be GET /git/diff");
  assert.ok(lastRequest().url.includes("path=src%2Fa.ts"));
  assert.ok(lastRequest().url.includes("mode=worktree"));
  await INTERNALS.api.diff("/tmp/repo", "src/a.ts", "commit", "abc123");
  assert.ok(lastRequest().url.includes("rev=abc123"));

  CLIENT.controller.responder = () => jsonResponse({ ok: true, commits: [], hasMore: false });
  await INTERNALS.api.log("/tmp/repo", { limit: 50, skip: 0, ref: "HEAD" });
  assert.equal(lastRequest().url, "/git/log?root=%2Ftmp%2Frepo&limit=50&skip=0&ref=HEAD");

  CLIENT.controller.responder = () => jsonResponse({ ok: true, commit: {}, files: [] });
  await INTERNALS.api.commitDetail("/tmp/repo", "abc123");
  assert.equal(lastRequest().url, "/git/commit?root=%2Ftmp%2Frepo&sha=abc123");

  CLIENT.controller.responder = () => jsonResponse({ ok: true, local: [], remote: [] });
  await INTERNALS.api.branches("/tmp/repo");
  assert.equal(lastRequest().url, "/git/branches?root=%2Ftmp%2Frepo");
});

test("write routes post JSON bodies the Host can read", async () => {
  resetRequests();
  CLIENT.controller.responder = () => jsonResponse({ ok: true });
  await INTERNALS.api.stage("/tmp/repo", ["a.ts", "b c.md"]);
  let request = lastRequest();
  assert.equal(request.url, "/git/stage");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.options.body), { root: "/tmp/repo", paths: ["a.ts", "b c.md"] });

  await INTERNALS.api.unstage("/tmp/repo", ["a.ts"]);
  request = lastRequest();
  assert.equal(request.url, "/git/unstage");
  assert.deepEqual(JSON.parse(request.options.body), { root: "/tmp/repo", paths: ["a.ts"] });

  await INTERNALS.api.discard("/tmp/repo", ["a.ts"]);
  request = lastRequest();
  assert.equal(request.url, "/git/discard");
  assert.equal(JSON.parse(request.options.body).confirm, true, "discard must always carry the explicit confirmation flag");

  await INTERNALS.api.commitChanges("/tmp/repo", "feat: x", true);
  request = lastRequest();
  assert.equal(request.url, "/git/commit");
  assert.deepEqual(JSON.parse(request.options.body), { root: "/tmp/repo", message: "feat: x", all: true });

  await INTERNALS.api.commitChanges("/tmp/repo", "feat: x", false);
  assert.equal(JSON.parse(lastRequest().options.body).all, false);

  await INTERNALS.api.checkout("/tmp/repo", "dev");
  request = lastRequest();
  assert.equal(request.url, "/git/checkout");
  assert.deepEqual(JSON.parse(request.options.body), { root: "/tmp/repo", branch: "dev" });
});

test("Host failures surface as coded errors instead of silent payloads", async () => {
  resetRequests();
  CLIENT.controller.responder = () => jsonResponse({ ok: false, code: "git-failed", message: "fatal: bad revision" }, 422);
  await assert.rejects(
    () => INTERNALS.api.status("/tmp/repo"),
    (error) => error.code === "git-failed" && error.message === "fatal: bad revision",
  );

  CLIENT.controller.responder = () => jsonResponse({ ok: false, code: "not-a-repo", message: "not a git repository" }, 409);
  await assert.rejects(
    () => INTERNALS.api.commitChanges("/tmp/repo", "x", false),
    (error) => error.code === "not-a-repo" && error.message === "not a git repository",
  );

  CLIENT.controller.responder = () => {
    throw new Error("socket down");
  };
  await assert.rejects(
    () => INTERNALS.api.status("/tmp/repo"),
    (error) => error.code === "network" && error.message === "socket down",
  );

  CLIENT.controller.responder = () => ({ ok: true, status: 200, json: () => Promise.reject(new Error("not json")) });
  await assert.rejects(
    () => INTERNALS.api.status("/tmp/repo"),
    (error) => typeof error.code === "string" && error.code.length > 0,
  );
});

test("apiUrl keeps the /git prefix for every route", () => {
  const { apiUrl } = INTERNALS;
  for (const name of ["status", "diff", "log", "commit", "branches", "stage", "unstage", "discard", "checkout", "health"]) {
    assert.ok(apiUrl(name, null).startsWith("/git/" + name), "route " + name + " must live under /git");
  }
  assert.equal(apiUrl("status", { root: undefined, branch: "" }), "/git/status");
});
