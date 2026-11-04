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
    // Components schedule timers inside effects; the hook harness below actually
    // runs those effects, so the (otherwise browser-provided) globals must exist.
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (callback, delay) => setInterval(callback, delay),
    clearInterval: (handle) => clearInterval(handle),
  };
  if (options !== null && options !== undefined && options.localStorage !== undefined) {
    sandbox.localStorage = options.localStorage;
  }
  sandbox.fetch = (url, options_) => {
    requests.push({ url, options: options_ });
    return Promise.resolve().then(() => controller.responder(url, options_));
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

test("apply registers the panel body, the title chip and the header branch chip", () => {
  assert.equal(STATE.slotRegistrations.length, 3);
  const body = STATE.slotRegistrations.find((entry) => entry.spec.name === "sidebar.right.pane.tab");
  const title = STATE.slotRegistrations.find((entry) => entry.spec.name === "sidebar.right.pane.tab.title");
  const chip = STATE.slotRegistrations.find((entry) => entry.spec.name === "conversation.session.header.actions");
  assert.ok(body, "the panel body slot must be registered");
  assert.ok(title, "the title chip slot must be registered");
  assert.ok(chip, "the session-header branch chip slot must be registered");
  for (const registration of [body, title]) {
    assert.equal(registration.spec.key, "dsh-git");
    assert.equal(registration.spec.locale, "git");
    assert.equal(typeof registration.component, "function");
  }
  assert.equal(body.component, INTERNALS.GitBody);
  assert.equal(title.component, INTERNALS.GitTitle);
  assert.equal(chip.component, INTERNALS.GitBranchChip);
  assert.equal(chip.spec.id, "git-branch");
  assert.equal(chip.spec.locale, "git");
  assert.equal(typeof chip.spec.order, "number");
  assert.deepEqual(Array.from(STATE.effectLabels), [
    "dsh-git: styles",
    "dsh-git: dictionaries",
    "dsh-git: header branch chip",
    "dsh-git: tab type",
    "dsh-git: body",
    "dsh-git: title",
  ]);
});

test("the commit graph lays out a linear history in one stable lane", () => {
  const graph = INTERNALS.computeLanes([
    { sha: "c3", parents: ["c2"] },
    { sha: "c2", parents: ["c1"] },
    { sha: "c1", parents: [] },
  ]);
  assert.equal(graph.rows.length, 3);
  assert.equal(graph.maxLanes, 1);
  for (const row of graph.rows) {
    assert.equal(row.lane, 0);
    assert.equal(row.width, 1);
    assert.ok(Array.from(row.passThrough).length === 0, "a linear history has no pass-through lanes");
    assert.ok(Array.from(row.merges).length === 0, "a linear history has no merging lanes");
  }
});

test("the commit graph keeps columns stable across a fork and a merge", () => {
  // m2 merges b1 into the main line; m1 is the fork point.
  const graph = INTERNALS.computeLanes([
    { sha: "m2", parents: ["m1", "b1"] },
    { sha: "b1", parents: ["m1"] },
    { sha: "m1", parents: [] },
  ]);
  assert.equal(graph.rows.length, 3);
  // The merge commit sits on lane 0 and spawns a second lane for its second parent.
  assert.equal(graph.rows[0].lane, 0);
  assert.ok(graph.rows[0].exits.length === 2, "a merge commit has two exits");
  assert.ok(graph.rows[0].width >= 2, "the merge row needs the second lane");
  // The branch commit lives on the second lane and passes the first one through.
  assert.equal(graph.rows[1].lane, 1);
  assert.deepEqual(Array.from(graph.rows[1].passThrough), [0]);
  // The fork point merges the branch lane back into lane 0.
  assert.equal(graph.rows[2].lane, 0);
  // Columns are stable: every exit of a row must be picked up by the next row's
  // entries at the very same column, otherwise lines would jump sideways.
  for (let index = 0; index < graph.rows.length - 1; index += 1) {
    const nextColumns = new Set(Array.from(graph.rows[index + 1].entries, (entry) => entry.col));
    for (const exit of graph.rows[index].exits) {
      assert.ok(nextColumns.has(exit.col), "row " + index + " exit at column " + exit.col + " is not continued");
    }
  }
});

test("the commit graph tolerates missing parents and empty input", () => {
  assert.equal(INTERNALS.computeLanes([]).rows.length, 0);
  const graph = INTERNALS.computeLanes([{ sha: "only" }, { parents: ["x"] }]);
  assert.equal(graph.rows.length, 2);
  assert.equal(graph.rows[0].lane, 0);
  assert.equal(typeof graph.rows[0].width, "number");
  assert.equal(typeof graph.rows[0].color, "number");
  for (const row of graph.rows) {
    assert.ok(Array.isArray(row.laneColors));
    assert.equal(row.laneColors.length, row.width);
  }
});

test("the inlined graph algorithm matches tools/graph-lanes.mjs row for row", async () => {
  const module = await import(new URL("../tools/graph-lanes.mjs", import.meta.url).href);
  const fixtures = [
    { name: "linear", commits: [
      { sha: "c3", parents: ["c2"] },
      { sha: "c2", parents: ["c1"] },
      { sha: "c1", parents: [] },
    ], headSha: "c3" },
    { name: "fork", commits: [
      { sha: "m", parents: ["a", "b"] },
      { sha: "a", parents: ["c"] },
      { sha: "b", parents: ["c"] },
      { sha: "c", parents: [] },
    ], headSha: "m" },
    { name: "merge", commits: [
      { sha: "m", parents: ["a", "b"] },
      { sha: "a", parents: ["c"] },
      { sha: "c", parents: ["d"] },
      { sha: "b", parents: ["d"] },
      { sha: "d", parents: [] },
    ], headSha: "a" },
    { name: "octopus", commits: [
      { sha: "t", parents: ["a", "b", "c"] },
      { sha: "a", parents: ["d"] },
      { sha: "b", parents: ["d"] },
      { sha: "c", parents: ["d"] },
      { sha: "d", parents: [] },
    ], headSha: "t" },
  ];
  for (const fixture of fixtures) {
    const expected = module.computeLanes(fixture.commits, { headSha: fixture.headSha });
    const actual = INTERNALS.computeLanes(fixture.commits, { headSha: fixture.headSha });
    assert.equal(actual.maxLanes, expected.maxLanes, fixture.name + ": maxLanes");
    assert.equal(actual.rows.length, expected.rows.length, fixture.name + ": row count");
    for (let index = 0; index < expected.rows.length; index += 1) {
      const want = expected.rows[index];
      const got = actual.rows[index];
      const label = fixture.name + " row " + index;
      assert.equal(got.lane, want.lane, label + ": lane");
      assert.equal(got.width, want.width, label + ": width");
      assert.equal(got.color, want.color, label + ": color");
      assert.equal(got.isHead, want.isHead, label + ": isHead");
      assert.deepEqual(Array.from(got.passThrough), Array.from(want.passThrough), label + ": passThrough");
      assert.deepEqual(Array.from(got.exits, (exit) => exit.col), Array.from(want.exits, (exit) => exit.col), label + ": exits");
      assert.deepEqual(Array.from(got.entries, (entry) => entry.col), Array.from(want.entries, (entry) => entry.col), label + ": entries");
      assert.deepEqual(Array.from(got.laneColors), Array.from(want.laneColors), label + ": laneColors");
    }
  }
});

test("ref pills map HEAD, remote-tracking and local branches to distinct tones", () => {
  assert.equal(INTERNALS.refTone("HEAD -> main"), "head");
  assert.equal(INTERNALS.refTone("origin/main"), "remote");
  assert.equal(INTERNALS.refTone("feature/x"), "remote");
  assert.equal(INTERNALS.refTone("main"), "local");
  assert.equal(INTERNALS.refTone(""), "local");
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


// ---------------------------------------------------------------------------
// 7. Hook-capable render harness (effects + state for the interaction tests)
//
// renderStatic() never runs effects and turns every useState setter into a
// no-op: enough for structural smoke tests, but it cannot observe the stateful
// flows added by git-idea-parity (branch switching, hunk staging, amend, log
// filters). This harness loads the bundle against a tiny React with real hook
// slots: effects run after every commit, setState schedules a re-render, and
// async Host calls are awaited before the tree is handed back.
// ---------------------------------------------------------------------------

function shallowSameList(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

function createHookRuntime() {
  const runtime = { ctx: null, markDirty: null };
  function createContext(isRoot) {
    return {
      root: isRoot === true,
      cursor: 0,
      values: [],
      refs: [],
      memos: [],
      effects: [],
      effectState: [],
    };
  }
  const React = {
    version: "0.0.0-hooks",
    Fragment: Symbol.for("react.fragment"),
    Component: function HookComponent(props) {
      this.props = props === undefined ? {} : props;
      this.state = {};
    },
    createElement(type, props) {
      const merged = Object.assign({}, props === null || props === undefined ? {} : props);
      delete merged.key;
      const children = Array.prototype.slice.call(arguments, 2);
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { $$typeof: Symbol.for("react.element"), type: type, key: null, props: merged };
    },
    useState(initial) {
      const ctx = runtime.ctx;
      const index = ctx.cursor;
      ctx.cursor += 1;
      if (!(index in ctx.values)) ctx.values[index] = typeof initial === "function" ? initial() : initial;
      const setValue = function (next) {
        const value = typeof next === "function" ? next(ctx.values[index]) : next;
        if (Object.is(value, ctx.values[index])) return;
        ctx.values[index] = value;
        if (ctx.root === true && typeof runtime.markDirty === "function") runtime.markDirty();
      };
      return [ctx.values[index], setValue];
    },
    useRef(initial) {
      const ctx = runtime.ctx;
      const index = ctx.cursor;
      ctx.cursor += 1;
      if (!(index in ctx.refs)) ctx.refs[index] = { current: initial === undefined ? null : initial };
      return ctx.refs[index];
    },
    useEffect(create, deps) {
      const ctx = runtime.ctx;
      const index = ctx.cursor;
      ctx.cursor += 1;
      ctx.effects.push({ index: index, create: create, deps: Array.isArray(deps) ? deps.slice() : null });
    },
    useCallback(fn, deps) {
      const ctx = runtime.ctx;
      const index = ctx.cursor;
      ctx.cursor += 1;
      const list = Array.isArray(deps) ? deps.slice() : null;
      const previous = ctx.memos[index];
      if (previous !== undefined && list !== null && shallowSameList(previous.deps, list)) return previous.value;
      ctx.memos[index] = { deps: list, value: fn };
      return fn;
    },
    useMemo(fn, deps) {
      const ctx = runtime.ctx;
      const index = ctx.cursor;
      ctx.cursor += 1;
      const list = Array.isArray(deps) ? deps.slice() : null;
      const previous = ctx.memos[index];
      if (previous !== undefined && list !== null && shallowSameList(previous.deps, list)) return previous.value;
      const value = fn();
      ctx.memos[index] = { deps: list, value: value };
      return value;
    },
  };
  React.Component.prototype.setState = function setState(partial) {
    const next = typeof partial === "function" ? partial(this.state) : partial;
    this.state = Object.assign({}, this.state, next);
  };
  return { React: React, runtime: runtime, createContext: createContext };
}

/** In-memory localStorage stand-in (quota and private-mode behaviour not modelled). */
function createMemoryStorage(seed) {
  const data = Object.assign({}, seed === undefined ? {} : seed);
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[String(key)] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

function collectText(node, out) {
  const bucket = Array.isArray(out) ? out : [];
  if (node === null || node === undefined || node === false || node === true) return bucket;
  if (typeof node === "string" || typeof node === "number") {
    bucket.push(String(node));
    return bucket;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, bucket);
    return bucket;
  }
  if (typeof node === "object" && node.props !== undefined) collectText(node.props.children, bucket);
  return bucket;
}

function nodeClasses(node) {
  if (node === null || node === undefined || typeof node !== "object" || node.props === undefined) return [];
  const value = typeof node.props.className === "string" ? node.props.className : "";
  return value.split(/\s+/).filter(Boolean);
}

function hasClass(node, name) {
  return nodeClasses(node).indexOf(name) !== -1;
}

function buttonText(node) {
  return collectText(node === null || node === undefined ? null : node.props.children, []).join("").replace(/\s+/g, " ").trim();
}

/**
 * Load client.js against the hook React and expose mount(component, props):
 * the returned handle renders, runs effects, settles async state and lets the
 * test invoke the real event handlers found in the tree.
 */
function createHookEnvironment(options) {
  const hook = createHookRuntime();
  const runtime = hook.runtime;
  const React = hook.React;
  const client = loadClient(React, createStubReactDom(), options);
  const internals = client.moduleExports.__test;

  function expand(node, ownerCtx) {
    if (node === null || node === undefined || node === false || node === true) return node;
    if (typeof node === "string" || typeof node === "number") return node;
    if (Array.isArray(node)) return node.map(function (item) { return expand(item, ownerCtx); });
    if (typeof node !== "object") return null;
    const type = node.type;
    if (type === React.Fragment) return expand(node.props.children, ownerCtx);
    if (typeof type === "function") {
      if (type.prototype !== undefined && type.prototype !== null && typeof type.prototype.render === "function") {
        const instance = new type(node.props);
        if (instance.state === undefined || instance.state === null) instance.state = {};
        return expand(instance.render(), ownerCtx);
      }
      const childCtx = hook.createContext(false);
      const previous = runtime.ctx;
      runtime.ctx = childCtx;
      let output;
      try {
        output = type(node.props);
      } finally {
        runtime.ctx = previous;
      }
      return expand(output, childCtx);
    }
    if (typeof type !== "string") return null;
    const props = Object.assign({}, node.props);
    if (props.children !== undefined) props.children = expand(props.children, ownerCtx);
    return { $$typeof: Symbol.for("react.element"), type: type, key: node.key, props: props };
  }

  function collectNodes(node, predicate, out) {
    const bucket = Array.isArray(out) ? out : [];
    if (node === null || node === undefined) return bucket;
    if (Array.isArray(node)) {
      for (const item of node) collectNodes(item, predicate, bucket);
      return bucket;
    }
    if (typeof node !== "object") return bucket;
    if (typeof node.type === "string" && predicate(node)) bucket.push(node);
    collectNodes(node.props.children, predicate, bucket);
    return bucket;
  }

  function findNode(node, predicate) {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = findNode(item, predicate);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    if (typeof node !== "object") return undefined;
    if (typeof node.type === "string" && predicate(node)) return node;
    return findNode(node.props.children, predicate);
  }

  function commitEffects(ctx) {
    const nextState = [];
    for (let index = 0; index < ctx.effects.length; index += 1) {
      const effect = ctx.effects[index];
      const previous = ctx.effectState[effect.index];
      const changed = previous === undefined
        || effect.deps === null
        || previous.deps === null
        || !shallowSameList(previous.deps, effect.deps);
      if (!changed) {
        nextState[effect.index] = previous;
        continue;
      }
      if (previous !== undefined && typeof previous.cleanup === "function") {
        try {
          previous.cleanup();
        } catch (error) {
          // A throwing cleanup must not break the render pass.
        }
      }
      let cleanup = null;
      try {
        const result = effect.create();
        cleanup = typeof result === "function" ? result : null;
      } catch (error) {
        cleanup = null;
      }
      nextState[effect.index] = { deps: effect.deps === null ? null : effect.deps.slice(), cleanup: cleanup };
    }
    for (let index = 0; index < ctx.effectState.length; index += 1) {
      const previous = ctx.effectState[index];
      if (previous === undefined || nextState[index] !== undefined) continue;
      if (typeof previous.cleanup === "function") {
        try {
          previous.cleanup();
        } catch (error) {
          // Same as above.
        }
      }
    }
    ctx.effectState = nextState;
  }

  function flush() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    }).then(function () {
      return new Promise(function (resolve) {
        setTimeout(resolve, 0);
      });
    });
  }

  function unmountRoot(ctx) {
    for (let index = 0; index < ctx.effectState.length; index += 1) {
      const slot = ctx.effectState[index];
      if (slot !== undefined && typeof slot.cleanup === "function") {
        try {
          slot.cleanup();
        } catch (error) {
          // Ignore.
        }
      }
    }
    ctx.effectState = [];
    runtime.markDirty = null;
  }

  async function mount(component, props) {
    const rootCtx = hook.createContext(true);
    let tree = null;
    let dirty = false;
    let passes = 0;
    runtime.markDirty = function () {
      dirty = true;
    };
    async function pass() {
      dirty = false;
      rootCtx.cursor = 0;
      rootCtx.effects = [];
      const previous = runtime.ctx;
      runtime.ctx = rootCtx;
      let output;
      try {
        output = component(props);
      } finally {
        runtime.ctx = previous;
      }
      tree = expand(output, rootCtx);
      commitEffects(rootCtx);
      await flush();
      if (dirty === true) {
        passes += 1;
        if (passes > 40) throw new Error("hook harness: the component did not settle");
        return pass();
      }
      return tree;
    }
    await pass();
    return {
      get tree() {
        return tree;
      },
      html() {
        return renderStatic(SHIM_REACT, tree);
      },
      rerender() {
        return pass();
      },
      async act(fn) {
        const result = fn();
        if (result !== null && result !== undefined && typeof result.then === "function") await result;
        await flush();
        await pass();
        return result;
      },
      find(predicate) {
        return findNode(tree, predicate);
      },
      findAll(predicate) {
        return collectNodes(tree, predicate, []);
      },
      unmount() {
        unmountRoot(rootCtx);
      },
    };
  }

  return { client: client, internals: internals, mount: mount, React: React };
}

function findButtonByText(handle, text) {
  return handle.find(function (node) {
    return node.type === "button" && buttonText(node) === text;
  });
}

function findButtonByAria(handle, aria) {
  return handle.find(function (node) {
    return node.type === "button" && node.props["aria-label"] === aria;
  });
}

function findInputByAria(handle, aria) {
  return handle.find(function (node) {
    return node.type === "input" && node.props["aria-label"] === aria;
  });
}

function findNodeByClass(handle, className) {
  return handle.find(function (node) {
    return hasClass(node, className);
  });
}

function findAllByClass(handle, className) {
  return handle.findAll(function (node) {
    return hasClass(node, className);
  });
}

/** Route-aware fetch responder: first matching prefix wins. */
function routeResponder(routes) {
  const prefixes = Object.keys(routes);
  return function (url, requestOptions) {
    for (const prefix of prefixes) {
      if (url.indexOf(prefix) !== 0) continue;
      const handler = routes[prefix];
      return typeof handler === "function" ? handler(url, requestOptions) : handler;
    }
    return jsonResponse({ ok: true });
  };
}


// ---------------------------------------------------------------------------
// 8. Fixtures for the interaction tests
// ---------------------------------------------------------------------------

const HOOK_STATUS = {
  ok: true,
  isRepo: true,
  root: "/tmp/repo",
  toplevel: "/tmp/repo",
  branch: { name: "main", detached: false, sha: "aaa111", shortSha: "aaa111", upstream: "origin/main", ahead: 1, behind: 0 },
  staged: [{ path: "src/staged.ts", origPath: null, status: "M" }],
  unstaged: [{ path: "src/worktree.ts", origPath: null, status: "M" }],
  untracked: [{ path: "notes.md", origPath: null, status: "?" }],
  conflicted: [],
  counts: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 },
};

const HOOK_BRANCHES = {
  ok: true,
  current: "main",
  detached: false,
  local: [
    { name: "main", sha: "aaa111", upstream: "origin/main", ahead: 1, behind: 0, isCurrent: true },
    { name: "dev", sha: "bbb222", upstream: null, ahead: 0, behind: 0, isCurrent: false },
    { name: "feature/x", sha: "ccc333", isCurrent: false },
  ],
  remote: [{ name: "origin/main", sha: "aaa111", isCurrent: false }],
};

const HOOK_LOG_COMMITS = [
  { sha: "aaa111", shortSha: "aaa111", author: "Wang", email: "w@x.io", time: 1700000000, subject: "feat: add git plugin", parents: [], refs: ["HEAD -> main"] },
  { sha: "bbb222", shortSha: "bbb222", author: "Li", email: "l@x.io", time: 1699900000, subject: "fix: tidy lanes", parents: ["aaa111"], refs: [] },
];

const DIFF_FIXTURE = {
  ok: true,
  path: "src/a.ts",
  mode: "worktree",
  binary: false,
  truncated: false,
  additions: 2,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1,3 +1,4 @@",
      oldStart: 1, oldLines: 3, newStart: 1, newLines: 4,
      lines: [
        { type: "context", text: "const a = 1;", oldLine: 1, newLine: 1 },
        { type: "del", text: "const b = 2;", oldLine: 2, newLine: null },
        { type: "add", text: "const b = 3;", oldLine: null, newLine: 2 },
        { type: "context", text: "export {};", oldLine: 3, newLine: 3 },
      ],
    },
    {
      header: "@@ -10,2 +11,3 @@",
      oldStart: 10, oldLines: 2, newStart: 11, newLines: 3,
      lines: [
        { type: "context", text: "x", oldLine: 10, newLine: 11 },
        { type: "add", text: "y", oldLine: null, newLine: 12 },
      ],
    },
  ],
};

/** One commit with twelve parents: the lane cap must kick in. */
const TRUNCATED_LANES_COMMITS = (function () {
  const parents = [];
  for (let index = 0; index < 12; index += 1) parents.push("p" + String(index));
  const list = [{
    sha: "m",
    shortSha: "m",
    author: "A",
    email: "a@x.io",
    time: 1700000000,
    subject: "octopus merge",
    parents: parents,
    refs: ["HEAD -> main"],
  }];
  for (let index = 0; index < 12; index += 1) {
    list.push({
      sha: "p" + String(index),
      shortSha: "p" + String(index),
      author: "A",
      email: "a@x.io",
      time: 1699000000 - index,
      subject: "parent " + String(index),
      parents: [],
      refs: [],
    });
  }
  return list;
})();

// ---------------------------------------------------------------------------
// 9. Group 3: chip typography and branch management
// ---------------------------------------------------------------------------

test("the branch chip inherits the host font instead of the monospace stack", () => {
  const lines = INTERNALS.CSS_TEXT.split(NL);
  function ruleFor(selector) {
    return lines.find((line) => line.indexOf(selector + "{") === 0);
  }
  const chipBranch = ruleFor(".dg-chip-branch");
  const popBranch = ruleFor(".dg-pop-branch");
  assert.ok(chipBranch, ".dg-chip-branch must be styled");
  assert.ok(popBranch, ".dg-pop-branch must be styled");
  for (const rule of [chipBranch, popBranch]) {
    assert.ok(!rule.includes("dsh-font-mono"), "the branch text must not force the monospace font: " + rule);
    assert.ok(!rule.includes("font-mono"), "the branch text must not force the monospace font: " + rule);
    assert.ok(rule.includes("font:inherit"), "the branch text must inherit the host font: " + rule);
    assert.ok(rule.includes("tabular-nums"), "digits keep the tabular alignment: " + rule);
  }
  assert.ok(chipBranch.includes("font-size:12px"));
  assert.ok(chipBranch.includes("line-height:18px"));
  const chip = ruleFor(".dg-chip");
  assert.ok(chip, ".dg-chip must be styled");
  assert.ok(chip.includes("font-size:12px"), "the chip matches the host header capsules");
  assert.ok(chip.includes("line-height:18px"));
  assert.ok(chip.includes("gap:5px"));
  const dot = ruleFor(".dg-chip-dot");
  assert.ok(dot.includes("width:7px"));
  assert.ok(dot.includes("height:7px"));
  assert.ok(!INTERNALS.CSS_TEXT.includes(".dg-chip-branch{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family"));
});

test("the branch panel lists the current branch, both groups and the current tick", async () => {
  const env = createHookEnvironment();
  env.client.controller.responder = routeResponder({
    "/git/branches": jsonResponse(HOOK_BRANCHES),
  });
  const handle = await env.mount(env.internals.BranchPanel, { root: "/tmp/repo", status: HOOK_STATUS, t: T });
  try {
    const html = handle.html();
    assert.match(html, /dg-branch-panel/);
    assert.match(html, /当前分支/);
    assert.match(html, /切换分支/);
    assert.match(html, /本地分支/);
    assert.match(html, /远端分支/);
    assert.match(html, /origin\/main/);
    assert.match(html, /已暂存 1 · 变更 1 · 未跟踪 1 · 冲突 0/);
    assert.match(html, /↑1/);
    const currentRows = findAllByClass(handle, "dg-branch-current");
    assert.equal(currentRows.length, 1, "exactly one row is ticked");
    const currentHtml = renderStatic(SHIM_REACT, currentRows[0]);
    assert.match(currentHtml, /main/);
    assert.match(currentHtml, /✓/);
    const currentPick = findButtonByAria(handle, T("branch.current.aria", { branch: "main" }));
    assert.ok(currentPick, "the current branch row exists");
    assert.equal(currentPick.props.disabled, true, "the current branch is not clickable");
    const devPick = findButtonByAria(handle, T("branch.switch.row", { branch: "dev" }));
    assert.ok(devPick, "the other local branch is clickable");
    const localRow = findAllByClass(handle, "dg-branch-row").find(function (row) {
      return renderStatic(SHIM_REACT, row).includes(">dev<");
    });
    assert.ok(localRow);
  } finally {
    handle.unmount();
  }
});

test("clicking a branch in the panel checks it out once and reports the switch", async () => {
  const env = createHookEnvironment();
  let refreshes = 0;
  env.client.controller.responder = routeResponder({
    "/git/branches": jsonResponse(HOOK_BRANCHES),
    "/git/checkout": jsonResponse({ ok: true }),
  });
  const handle = await env.mount(env.internals.BranchPanel, {
    root: "/tmp/repo",
    status: HOOK_STATUS,
    t: T,
    onChanged: function () { refreshes += 1; },
  });
  try {
    const pick = findButtonByAria(handle, T("branch.switch.row", { branch: "dev" }));
    assert.ok(pick);
    await handle.act(function () { return pick.props.onClick(); });
    const checkouts = env.client.requests.filter((request) => request.url === "/git/checkout");
    assert.equal(checkouts.length, 1, "clicking a branch checks out exactly once");
    assert.equal(checkouts[0].options.method, "POST");
    assert.deepEqual(JSON.parse(checkouts[0].options.body), { root: "/tmp/repo", branch: "dev" });
    assert.ok(refreshes >= 1, "a successful switch refreshes the status");
    assert.match(handle.html(), /已切换到 dev/);
  } finally {
    handle.unmount();
  }
});

test("a failed checkout keeps the panel open and shows the Host message", async () => {
  const env = createHookEnvironment();
  const hostMessage = "error: Your local changes to the following files would be overwritten by checkout";
  let fail = true;
  env.client.controller.responder = routeResponder({
    "/git/branches": jsonResponse(HOOK_BRANCHES),
    "/git/checkout": function () {
      if (!fail) return jsonResponse({ ok: true });
      return jsonResponse({ ok: false, code: "git-failed", message: hostMessage }, 422);
    },
  });
  const handle = await env.mount(env.internals.BranchPanel, { root: "/tmp/repo", status: HOOK_STATUS, t: T });
  try {
    const pick = findButtonByAria(handle, T("branch.switch.row", { branch: "dev" }));
    await handle.act(function () { return pick.props.onClick(); });
    const html = handle.html();
    assert.match(html, /dg-branch-panel/, "the panel must stay open after a failure");
    assert.ok(html.includes(hostMessage), "the Host message must be shown verbatim");
    assert.match(html, /重试/);
    assert.ok(!html.includes("已切换到"), "no success notice on failure");
    fail = false;
    const retry = findButtonByText(handle, "重试");
    assert.ok(retry, "the panel offers a retry action");
    await handle.act(function () { return retry.props.onClick(); });
    assert.equal(env.client.requests.filter((request) => request.url === "/git/checkout").length, 2);
    assert.match(handle.html(), /已切换到 dev/);
  } finally {
    handle.unmount();
  }
});

test("branch create, delete (with force) and rename post to /git/branches", async () => {
  const env = createHookEnvironment();
  env.client.controller.responder = routeResponder({
    "/git/branches": function (url, requestOptions) {
      if (requestOptions.method === "GET") return jsonResponse(HOOK_BRANCHES);
      const body = JSON.parse(requestOptions.body);
      if (body.action === "delete" && body.force !== true) {
        return jsonResponse({ ok: false, code: "git-failed", message: "error: the branch 'dev' is not fully merged" }, 422);
      }
      return jsonResponse({ ok: true, name: body.name });
    },
  });
  const handle = await env.mount(env.internals.BranchPanel, { root: "/tmp/repo", status: HOOK_STATUS, t: T });
  try {
    function branchPosts() {
      return env.client.requests.filter(function (request) {
        return request.url === "/git/branches" && request.options.method === "POST";
      });
    }

    // create
    const createInput = findInputByAria(handle, T("branch.create.placeholder"));
    assert.ok(createInput);
    await handle.act(function () { return createInput.props.onChange({ target: { value: "new-branch" } }); });
    const createButton = findButtonByText(handle, T("branch.create.button"));
    assert.ok(createButton);
    assert.notEqual(createButton.props.disabled, true);
    await handle.act(function () { return createButton.props.onClick(); });
    assert.deepEqual(JSON.parse(branchPosts()[0].options.body), { root: "/tmp/repo", action: "create", name: "new-branch" });
    assert.match(handle.html(), /已创建分支 new-branch/);

    // delete needs a confirmation, then escalates to the force dialog
    const deleteDev = findButtonByAria(handle, T("branch.delete.aria", { branch: "dev" }));
    assert.ok(deleteDev);
    await handle.act(function () { return deleteDev.props.onClick(); });
    assert.match(handle.html(), /删除分支 dev？/);
    const confirmDelete = findButtonByText(handle, T("branch.delete.confirmButton"));
    assert.ok(confirmDelete);
    await handle.act(function () { return confirmDelete.props.onClick(); });
    let posts = branchPosts();
    assert.deepEqual(JSON.parse(posts[posts.length - 1].options.body), { root: "/tmp/repo", action: "delete", name: "dev", force: false });
    assert.match(handle.html(), /尚未合并/);
    const forceDelete = findButtonByText(handle, T("branch.delete.forceButton"));
    assert.ok(forceDelete, "the unmerged branch offers force deletion");
    await handle.act(function () { return forceDelete.props.onClick(); });
    posts = branchPosts();
    assert.deepEqual(JSON.parse(posts[posts.length - 1].options.body), { root: "/tmp/repo", action: "delete", name: "dev", force: true });

    // rename
    const renameButton = findButtonByAria(handle, T("branch.rename.aria", { branch: "feature/x" }));
    assert.ok(renameButton);
    await handle.act(function () { return renameButton.props.onClick(); });
    const renameInput = findInputByAria(handle, T("branch.rename.placeholder"));
    assert.ok(renameInput);
    await handle.act(function () { return renameInput.props.onChange({ target: { value: "feature/y" } }); });
    const confirmRename = findButtonByText(handle, T("branch.rename.confirm"));
    assert.ok(confirmRename);
    await handle.act(function () { return confirmRename.props.onClick(); });
    posts = branchPosts();
    assert.deepEqual(JSON.parse(posts[posts.length - 1].options.body), {
      root: "/tmp/repo",
      action: "rename",
      name: "feature/x",
      newName: "feature/y",
    });
    assert.match(handle.html(), /已将 feature\/x 重命名为 feature\/y/);
  } finally {
    handle.unmount();
  }
});

test("the log range selector and the explicit checkout action are distinct", () => {
  const html = staticRender(SHIM_INTERNALS.HistoryPane, { cwd: "/tmp/repo", t: T });
  assert.match(html, /dg-history/);
  assert.ok(html.includes('aria-label="' + T("history.refRange") + '"'), "the selector is labelled as the log range");
  assert.ok(html.includes(T("history.checkout.button")), "an explicit checkout action is present");
  assert.notEqual(T("history.refRange"), T("history.checkout.button"));
  assert.ok(html.includes('aria-label="' + T("history.filter.grep") + '"'));
  assert.ok(html.includes('aria-label="' + T("history.filter.author") + '"'));
  assert.ok(html.includes('aria-label="' + T("history.filter.path") + '"'));
  assert.ok(html.includes(T("history.filter.clear")));
});

test("changing the log range only reloads the log; the explicit action checks out", async () => {
  const env = createHookEnvironment();
  let refreshes = 0;
  env.client.controller.responder = routeResponder({
    "/git/log": jsonResponse({ ok: true, commits: HOOK_LOG_COMMITS, hasMore: false }),
    "/git/branches": jsonResponse(HOOK_BRANCHES),
    "/git/checkout": jsonResponse({ ok: true }),
  });
  const handle = await env.mount(env.internals.HistoryPane, {
    cwd: "/tmp/repo",
    t: T,
    onChanged: function () { refreshes += 1; },
  });
  try {
    const select = handle.find(function (node) { return node.type === "select"; });
    assert.ok(select);
    await handle.act(function () { return select.props.onChange({ target: { value: "dev" } }); });
    const logCalls = env.client.requests.filter(function (request) { return request.url.indexOf("/git/log") === 0; });
    assert.ok(logCalls.length >= 2, "changing the range re-requests the log");
    assert.ok(logCalls[logCalls.length - 1].url.includes("ref=dev"));
    assert.equal(env.client.requests.filter(function (request) { return request.url === "/git/checkout"; }).length, 0, "the range selector must not check out");

    const checkoutButton = findNodeByClass(handle, "dg-checkout-btn");
    assert.ok(checkoutButton);
    assert.notEqual(checkoutButton.props.disabled, true);
    await handle.act(function () { return checkoutButton.props.onClick(); });
    const checkouts = env.client.requests.filter(function (request) { return request.url === "/git/checkout"; });
    assert.equal(checkouts.length, 1);
    assert.deepEqual(JSON.parse(checkouts[0].options.body), { root: "/tmp/repo", branch: "dev" });
    assert.match(handle.html(), /已切换到 dev/);
    assert.ok(refreshes >= 1);
  } finally {
    handle.unmount();
  }
});

// ---------------------------------------------------------------------------
// 10. Group 4: commit graph HEAD emphasis and history filtering
// ---------------------------------------------------------------------------

test("the HEAD commit gets an enlarged, ringed graph dot", () => {
  const commits = [
    { sha: "c2", parents: ["c1"], refs: ["HEAD -> main"] },
    { sha: "c1", parents: [], refs: [] },
  ];
  const graph = INTERNALS.computeLanes(commits, { headSha: "c2" });
  assert.equal(graph.rows[0].isHead, true);
  assert.equal(graph.rows[0].color, 8, "HEAD owns the dedicated colour slot");
  const head = staticRender(SHIM_INTERNALS.CommitGraph, { row: graph.rows[0], headLabel: "HEAD row" });
  const plain = staticRender(SHIM_INTERNALS.CommitGraph, { row: graph.rows[1] });
  assert.match(head, /dg-graph-dot-head/);
  assert.match(head, /dg-graph-dot-ring/);
  assert.match(head, /r="4.8"/);
  assert.match(head, /title="HEAD row"/);
  assert.match(head, /#f78166/);
  assert.ok(!plain.includes("dg-graph-dot-head"));
  assert.ok(!plain.includes("dg-graph-dot-ring"));
  assert.match(plain, /r="3.6"/);
  assert.equal(INTERNALS.headShaOf(commits), "c2");
  assert.equal(INTERNALS.headShaOf([{ sha: "z", refs: [] }, { sha: "y", refs: ["HEAD -> dev"] }]), "y");
  assert.equal(INTERNALS.headShaOf([{ sha: "z", refs: [] }]), "z");
  assert.equal(INTERNALS.headShaOf([]), "");
});

test("history filters send grep, author and path, and clear drops them", async () => {
  const env = createHookEnvironment();
  env.client.controller.responder = routeResponder({
    "/git/log": jsonResponse({ ok: true, commits: HOOK_LOG_COMMITS, hasMore: false }),
    "/git/branches": jsonResponse(HOOK_BRANCHES),
  });
  const handle = await env.mount(env.internals.HistoryPane, { cwd: "/tmp/repo", t: T });
  try {
    function lastLogUrl() {
      const calls = env.client.requests.filter(function (request) { return request.url.indexOf("/git/log") === 0; });
      return calls[calls.length - 1].url;
    }
    function typeInto(ariaLabel, value) {
      const input = findInputByAria(handle, ariaLabel);
      assert.ok(input, "missing filter input " + ariaLabel);
      return handle.act(function () { return input.props.onChange({ target: { value: value } }); });
    }
    await typeInto(T("history.filter.grep"), "fix");
    assert.ok(lastLogUrl().includes("grep=fix"), "the grep filter travels in the query string");
    await typeInto(T("history.filter.author"), "Wang");
    assert.ok(lastLogUrl().includes("author=Wang"));
    await typeInto(T("history.filter.path"), "src/a.ts");
    assert.ok(lastLogUrl().includes("path=src%2Fa.ts"));
    assert.match(handle.html(), /已过滤/);

    const clear = findNodeByClass(handle, "dg-filter-clear");
    assert.ok(clear);
    await handle.act(function () { return clear.props.onClick(); });
    const cleared = lastLogUrl();
    assert.ok(!cleared.includes("grep="), "clear drops the grep parameter");
    assert.ok(!cleared.includes("author="), "clear drops the author parameter");
    assert.ok(!cleared.includes("path="), "clear drops the path parameter");
  } finally {
    handle.unmount();
  }
});

test("history shows filtered-empty, truncated-lane and empty-history states", async () => {
  const filteredEnv = createHookEnvironment();
  filteredEnv.client.controller.responder = routeResponder({
    "/git/log": jsonResponse({ ok: true, commits: [], hasMore: false }),
    "/git/branches": jsonResponse(HOOK_BRANCHES),
  });
  const filtered = await filteredEnv.mount(filteredEnv.internals.HistoryPane, { cwd: "/tmp/repo", t: T });
  try {
    const input = findInputByAria(filtered, T("history.filter.grep"));
    await filtered.act(function () { return input.props.onChange({ target: { value: "nope" } }); });
    assert.ok(filtered.html().includes(T("history.empty.filtered")));
  } finally {
    filtered.unmount();
  }

  const emptyEnv = createHookEnvironment();
  emptyEnv.client.controller.responder = routeResponder({
    "/git/log": jsonResponse({ ok: true, commits: [], hasMore: false }),
    "/git/branches": jsonResponse(HOOK_BRANCHES),
  });
  const empty = await emptyEnv.mount(emptyEnv.internals.HistoryPane, { cwd: "/tmp/repo", t: T });
  try {
    assert.ok(empty.html().includes(T("history.empty")), "an empty history keeps its own message");
    assert.ok(!empty.html().includes(T("history.empty.filtered")));
  } finally {
    empty.unmount();
  }

  const graph = INTERNALS.computeLanes(TRUNCATED_LANES_COMMITS, { maxLanes: INTERNALS.GRAPH_MAX_LANES });
  assert.equal(graph.maxLanes, INTERNALS.GRAPH_MAX_LANES, "the fixture really hits the lane cap");
  const truncatedEnv = createHookEnvironment();
  truncatedEnv.client.controller.responder = routeResponder({
    "/git/log": jsonResponse({ ok: true, commits: TRUNCATED_LANES_COMMITS, hasMore: false }),
    "/git/branches": jsonResponse(HOOK_BRANCHES),
  });
  const truncated = await truncatedEnv.mount(truncatedEnv.internals.HistoryPane, { cwd: "/tmp/repo", t: T });
  try {
    assert.ok(truncated.html().includes(T("history.lanes.truncated", { max: INTERNALS.GRAPH_MAX_LANES })));
  } finally {
    truncated.unmount();
  }
});


// ---------------------------------------------------------------------------
// 11. Group 5: change tree, stats, hunk staging, amend and commit history
// ---------------------------------------------------------------------------

test("buildChangeTree nests paths into sorted directories without touching the input", () => {
  const input = [
    { path: "src/deep/b.ts", origPath: null, status: "M" },
    { path: "src/a.ts", origPath: null, status: "A" },
    { path: "notes.md", origPath: null, status: "?" },
    { path: "文档/说明.md", origPath: null, status: "M" },
    { path: "foo", origPath: null, status: "M" },
    { path: "foo/bar.ts", origPath: null, status: "M" },
    { path: "a/b/c/d.txt", origPath: null, status: "M" },
  ];
  const snapshot = JSON.stringify(input);
  const tree = INTERNALS.buildChangeTree(input);
  assert.equal(JSON.stringify(input), snapshot, "the input must not be modified");

  assert.equal(tree.length, 6, "directories sort before files");
  assert.deepEqual(Array.from(tree, (node) => node.type + ":" + node.name), [
    "dir:a",
    "dir:foo",
    "dir:src",
    "dir:文档",
    "file:foo",
    "file:notes.md",
  ]);
  // deep directory chain
  assert.equal(tree[0].path, "a");
  assert.equal(tree[0].children[0].type, "dir");
  assert.equal(tree[0].children[0].path, "a/b");
  assert.equal(tree[0].children[0].children[0].path, "a/b/c");
  assert.equal(tree[0].children[0].children[0].children[0].type, "file");
  assert.equal(tree[0].children[0].children[0].children[0].path, "a/b/c/d.txt");
  assert.equal(tree[0].children[0].children[0].children[0].name, "d.txt");
  // directories before files inside a directory
  assert.deepEqual(Array.from(tree[2].children, (node) => node.type + ":" + node.name), ["dir:deep", "file:a.ts"]);
  assert.equal(tree[2].children[0].children[0].path, "src/deep/b.ts");
  // a directory and a file may share a name
  assert.equal(tree[1].type, "dir");
  assert.equal(tree[1].name, "foo");
  assert.equal(tree[4].type, "file");
  assert.equal(tree[4].name, "foo");
  assert.equal(tree[4].path, "foo");
  // non-ASCII paths keep their text and the entry identity
  assert.equal(tree[3].name, "文档");
  assert.equal(tree[3].children[0].name, "说明.md");
  assert.equal(tree[3].children[0].path, "文档/说明.md");
  assert.equal(tree[4].entry, input[4], "file nodes keep the original entry");
  // defensive input handling
  assert.deepEqual(Array.from(INTERNALS.buildChangeTree(null)), []);
  // Cross-realm objects: compare structurally through JSON.
  assert.deepEqual(
    JSON.parse(JSON.stringify(INTERNALS.buildChangeTree([{ path: "" }, null, { path: "x" }]))),
    [{ type: "file", name: "x", path: "x", entry: { path: "x" } }],
  );
});

test("the changes pane renders a collapsible directory tree with per-file stats", async () => {
  const env = createHookEnvironment();
  env.client.controller.responder = routeResponder({
    "/git/stats": jsonResponse({
      ok: true,
      staged: { "src/staged.ts": { additions: 3, deletions: 1, binary: false } },
      unstaged: { "src/worktree.ts": { additions: 0, deletions: 4, binary: false } },
    }),
  });
  const handle = await env.mount(env.internals.ChangesPane, {
    cwd: "/tmp/repo",
    t: T,
    status: HOOK_STATUS,
    onChanged: function () {},
  });
  try {
    let html = handle.html();
    assert.match(html, /dg-dir-row/, "directories are rendered as tree nodes");
    assert.match(html, /dg-dir-count/);
    assert.match(html, /\+3/);
    assert.match(html, /-1/);
    assert.match(html, /-4/);
    function fileRowMatching(path) {
      return findAllByClass(handle, "dg-file-row").find(function (row) {
        return typeof row.props.title === "string" && row.props.title.indexOf(path) !== -1;
      });
    }
    const stagedRow = fileRowMatching("src/staged.ts");
    assert.ok(stagedRow);
    assert.match(renderStatic(SHIM_REACT, stagedRow), /dg-numstat/);
    const untrackedRow = fileRowMatching("notes.md");
    assert.ok(untrackedRow);
    assert.ok(!renderStatic(SHIM_REACT, untrackedRow).includes("dg-numstat"), "untracked files have no line stats");

    // collapse the staged directory: its file row disappears
    let dirRows = findAllByClass(handle, "dg-dir-row");
    assert.equal(dirRows.length, 2, "one src directory per group");
    await handle.act(function () { return dirRows[0].props.onClick(); });
    html = handle.html();
    assert.ok(!html.includes("查看 src/staged.ts"), "a collapsed directory hides its files");
    assert.ok(html.includes("查看 src/worktree.ts"), "the other group stays expanded");

    dirRows = findAllByClass(handle, "dg-dir-row");
    await handle.act(function () { return dirRows[1].props.onClick(); });
    html = handle.html();
    assert.ok(!html.includes("查看 src/worktree.ts"));
    assert.ok(html.includes(T("changes.tree.collapsed")), "all-collapsed directories get an explicit hint");

    // expanding again restores the rows and clears the hint
    dirRows = findAllByClass(handle, "dg-dir-row");
    await handle.act(function () { return dirRows[0].props.onClick(); });
    html = handle.html();
    assert.ok(html.includes("查看 src/staged.ts"));
    assert.ok(!html.includes(T("changes.tree.collapsed")));
  } finally {
    handle.unmount();
  }
});

test("hunk actions appear only for worktree and staged diffs", async () => {
  const cases = [
    { mode: "worktree", expected: "暂存此块", unexpected: "取消暂存此块" },
    { mode: "staged", expected: "取消暂存此块", unexpected: "暂存此块" },
    { mode: "commit", expected: null, unexpected: null },
    { mode: "untracked", expected: null, unexpected: null },
  ];
  for (const scenario of cases) {
    const env = createHookEnvironment();
    env.client.controller.responder = routeResponder({ "/git/diff": jsonResponse(DIFF_FIXTURE) });
    const handle = await env.mount(env.internals.DiffView, {
      cwd: "/tmp/repo",
      path: "src/a.ts",
      mode: scenario.mode,
      rev: scenario.mode === "commit" ? "abc123" : undefined,
      t: T,
    });
    try {
      const html = handle.html();
      assert.match(html, /dg-hunk-block/);
      const buttons = findAllByClass(handle, "dg-hunk-btn");
      const labels = buttons.map(function (node) { return buttonText(node); });
      if (scenario.expected === null) {
        assert.equal(buttons.length, 0, scenario.mode + " must not offer hunk staging");
        continue;
      }
      assert.equal(buttons.length, 2, "one action per hunk");
      for (const label of labels) {
        assert.equal(label, scenario.expected, scenario.mode + " offers " + scenario.expected);
        assert.notEqual(label, scenario.unexpected, scenario.mode + " must not offer " + scenario.unexpected);
      }
    } finally {
      handle.unmount();
    }
  }
});

test("staging one hunk posts the rebuilt single-hunk patch with the right direction", async () => {
  const expectedPatch = "diff --git a/src/a.ts b/src/a.ts\n"
    + "--- a/src/a.ts\n"
    + "+++ b/src/a.ts\n"
    + "@@ -1,3 +1,4 @@\n"
    + " const a = 1;\n"
    + "-const b = 2;\n"
    + "+const b = 3;\n"
    + " export {};\n";
  assert.equal(INTERNALS.buildHunkPatch("src/a.ts", DIFF_FIXTURE.hunks[0]), expectedPatch);
  assert.equal(INTERNALS.buildHunkPatch("src" + BS + "a.ts", DIFF_FIXTURE.hunks[0]), expectedPatch, "windows separators are normalised");

  const env = createHookEnvironment();
  let refreshes = 0;
  env.client.controller.responder = routeResponder({
    "/git/diff": jsonResponse(DIFF_FIXTURE),
    "/git/apply-hunk": jsonResponse({ ok: true }),
  });
  const handle = await env.mount(env.internals.DiffView, {
    cwd: "/tmp/repo",
    path: "src/a.ts",
    mode: "worktree",
    t: T,
    onChanged: function () { refreshes += 1; },
  });
  try {
    const button = findButtonByText(handle, "暂存此块");
    assert.ok(button);
    await handle.act(function () { return button.props.onClick(); });
    const applies = env.client.requests.filter(function (request) { return request.url === "/git/apply-hunk"; });
    assert.equal(applies.length, 1);
    assert.deepEqual(JSON.parse(applies[0].options.body), {
      root: "/tmp/repo",
      path: "src/a.ts",
      direction: "stage",
      patch: expectedPatch,
    });
    assert.equal(refreshes, 1, "a successful hunk stage refreshes the working tree");
    assert.match(handle.html(), /已暂存该块/);
    const diffCalls = env.client.requests.filter(function (request) { return request.url.indexOf("/git/diff") === 0; });
    assert.ok(diffCalls.length >= 2, "the diff is reloaded after staging the hunk");
  } finally {
    handle.unmount();
  }

  const stagedEnv = createHookEnvironment();
  stagedEnv.client.controller.responder = routeResponder({
    "/git/diff": jsonResponse(DIFF_FIXTURE),
    "/git/apply-hunk": jsonResponse({ ok: true }),
  });
  const staged = await stagedEnv.mount(stagedEnv.internals.DiffView, {
    cwd: "/tmp/repo",
    path: "src/a.ts",
    mode: "staged",
    t: T,
  });
  try {
    const button = findButtonByText(staged, "取消暂存此块");
    assert.ok(button);
    await staged.act(function () { return button.props.onClick(); });
    const applies = stagedEnv.client.requests.filter(function (request) { return request.url === "/git/apply-hunk"; });
    assert.equal(applies.length, 1);
    const body = JSON.parse(applies[0].options.body);
    assert.equal(body.direction, "unstage");
    assert.equal(body.patch, expectedPatch);
  } finally {
    staged.unmount();
  }
});

test("a failed hunk apply shows an error bar inside the diff", async () => {
  const env = createHookEnvironment();
  env.client.controller.responder = routeResponder({
    "/git/diff": jsonResponse(DIFF_FIXTURE),
    "/git/apply-hunk": jsonResponse({ ok: false, code: "conflict", message: "error: patch does not apply" }, 409),
  });
  const handle = await env.mount(env.internals.DiffView, {
    cwd: "/tmp/repo",
    path: "src/a.ts",
    mode: "worktree",
    t: T,
  });
  try {
    const button = findButtonByText(handle, "暂存此块");
    assert.ok(button);
    await handle.act(function () { return button.props.onClick(); });
    const html = handle.html();
    assert.match(html, /dg-notice-error/);
    assert.ok(html.includes("error: patch does not apply"), "the Host message must be visible");
    assert.match(html, /dg-hunk-btn/, "the hunk action stays available for a second attempt");
    assert.ok(!html.includes("已暂存该块"));
  } finally {
    handle.unmount();
  }
});

test("the commit box exposes amend and the recent commit messages", async () => {
  const storage = createMemoryStorage({});
  const env = createHookEnvironment({ localStorage: storage });
  assert.deepEqual(Array.from(env.internals.readCommitHistory(storage)), []);
  let list = env.internals.rememberCommitMessage(storage, "feat: first");
  assert.deepEqual(Array.from(list), ["feat: first"]);
  list = env.internals.rememberCommitMessage(storage, "fix: second");
  assert.deepEqual(Array.from(list), ["fix: second", "feat: first"]);
  list = env.internals.rememberCommitMessage(storage, "feat: first");
  assert.deepEqual(Array.from(list), ["feat: first", "fix: second"], "reused messages move to the front");
  list = env.internals.rememberCommitMessage(storage, "   ");
  assert.deepEqual(Array.from(list), ["feat: first", "fix: second"], "blank messages are ignored");
  for (let index = 0; index < 15; index += 1) {
    list = env.internals.rememberCommitMessage(storage, "msg-" + String(index));
  }
  assert.equal(list.length, env.internals.COMMIT_HISTORY_MAX);
  assert.equal(list[0], "msg-14");
  assert.deepEqual(Array.from(env.internals.readCommitHistory(createMemoryStorage({ [env.internals.COMMIT_HISTORY_KEY]: "not json" }))), []);
  assert.equal(env.internals.COMMIT_HISTORY_KEY, "dsh.git.commitMessages.v1");

  const seeded = createMemoryStorage({ [env.internals.COMMIT_HISTORY_KEY]: JSON.stringify(["feat: one", "fix: two"]) });
  const seededEnv = createHookEnvironment({ localStorage: seeded });
  seededEnv.client.controller.responder = routeResponder({
    "/git/stats": jsonResponse({ ok: true, staged: {}, unstaged: {} }),
  });
  const handle = await seededEnv.mount(seededEnv.internals.ChangesPane, {
    cwd: "/tmp/repo",
    t: T,
    status: HOOK_STATUS,
    onChanged: function () {},
  });
  try {
    const html = handle.html();
    assert.match(html, /dg-amend-check/);
    assert.ok(html.includes(T("changes.amend")));
    assert.ok(html.includes(T("changes.commitHistory")));
    assert.ok(html.includes("feat: one"));
    assert.ok(html.includes("fix: two"));
    const chip = findButtonByText(handle, "feat: one");
    assert.ok(chip, "recent messages are clickable");
    await handle.act(function () { return chip.props.onClick(); });
    const textarea = handle.find(function (node) { return node.type === "textarea"; });
    assert.equal(textarea.props.value, "feat: one", "clicking a recent message refills the box");
  } finally {
    handle.unmount();
  }
});

test("amend posts to /git/amend while a normal commit posts to /git/commit", async () => {
  const storage = createMemoryStorage({});
  const env = createHookEnvironment({ localStorage: storage });
  env.client.controller.responder = routeResponder({
    "/git/stats": jsonResponse({ ok: true, staged: {}, unstaged: {} }),
    "/git/commit": jsonResponse({ ok: true, sha: "def5678", shortSha: "def5678" }),
    "/git/amend": jsonResponse({ ok: true, sha: "abc1234", shortSha: "abc1234" }),
  });
  const handle = await env.mount(env.internals.ChangesPane, {
    cwd: "/tmp/repo",
    t: T,
    status: HOOK_STATUS,
    onChanged: function () {},
  });
  try {
    let textarea = handle.find(function (node) { return node.type === "textarea"; });
    await handle.act(function () { return textarea.props.onChange({ target: { value: "feat: normal" } }); });
    let commitButton = findNodeByClass(handle, "dg-btn-primary");
    assert.ok(commitButton);
    assert.equal(buttonText(commitButton), T("changes.commit.button"));
    assert.notEqual(commitButton.props.disabled, true);
    await handle.act(function () { return commitButton.props.onClick(); });
    let commits = env.client.requests.filter(function (request) { return request.url === "/git/commit"; });
    assert.equal(commits.length, 1);
    assert.deepEqual(JSON.parse(commits[0].options.body), { root: "/tmp/repo", message: "feat: normal", all: false });
    assert.match(handle.html(), /已提交 def5678/);

    const amendCheck = handle.find(function (node) {
      return node.type === "input" && hasClass(node, "dg-amend-check");
    });
    assert.ok(amendCheck, "the commit box has an amend switch");
    await handle.act(function () { return amendCheck.props.onChange({ target: { checked: true } }); });
    textarea = handle.find(function (node) { return node.type === "textarea"; });
    await handle.act(function () { return textarea.props.onChange({ target: { value: "fix: amended" } }); });
    commitButton = findNodeByClass(handle, "dg-btn-primary");
    assert.equal(buttonText(commitButton), T("changes.amend.button"));
    await handle.act(function () { return commitButton.props.onClick(); });
    const amends = env.client.requests.filter(function (request) { return request.url === "/git/amend"; });
    assert.equal(amends.length, 1, "amend goes to POST /git/amend");
    assert.deepEqual(JSON.parse(amends[0].options.body), { root: "/tmp/repo", message: "fix: amended" });
    assert.equal(env.client.requests.filter(function (request) { return request.url === "/git/commit"; }).length, 1, "no extra normal commit");
    assert.match(handle.html(), /已修补提交 abc1234/);
    assert.ok(handle.html().includes("fix: amended"), "the used message joins the recent list");
  } finally {
    handle.unmount();
  }
});

test("all git-idea-parity client i18n keys exist in both dictionaries", () => {
  const zhKeys = new Set(Object.keys(DICTIONARIES.zh));
  const enKeys = new Set(Object.keys(DICTIONARIES.en));
  assert.equal(zhKeys.size, enKeys.size, "zh and en must stay key-identical");
  assert.ok(zhKeys.size >= 140, "the dictionaries grew with this change, got " + String(zhKeys.size));
  const required = [
    "branch.current.title",
    "branch.switch.title",
    "branch.switch.success",
    "branch.switch.failed",
    "branch.local",
    "branch.remote",
    "branch.create.button",
    "branch.create.success",
    "branch.rename.button",
    "branch.rename.success",
    "branch.delete.button",
    "branch.delete.current",
    "branch.delete.confirmTitle",
    "branch.delete.forceTitle",
    "branch.delete.forceButton",
    "branch.retry",
    "history.refRange",
    "history.checkout.button",
    "history.checkout.title",
    "history.filter.grep",
    "history.filter.author",
    "history.filter.path",
    "history.filter.clear",
    "history.filter.active",
    "history.empty.filtered",
    "history.lanes.truncated",
    "graph.headLabel",
    "changes.amend",
    "changes.amend.button",
    "changes.commitHistory",
    "changes.tree.toggle",
    "changes.tree.collapsed",
    "changes.hunk.stage",
    "changes.hunk.unstage",
    "changes.hunk.staged",
    "changes.hunk.unstaged",
    "changes.hunk.failed",
  ];
  for (const key of required) {
    assert.ok(zhKeys.has(key), "zh is missing " + key);
    assert.ok(enKeys.has(key), "en is missing " + key);
    assert.ok(String(DICTIONARIES.zh[key]).length > 0);
    assert.ok(String(DICTIONARIES.en[key]).length > 0);
  }
  assert.notEqual(DICTIONARIES.zh["history.refRange"], DICTIONARIES.en["history.refRange"]);
  assert.ok(!zhKeys.has("history.branch"), "the old ambiguous 'branch' label is gone");
});
