/**
 * dsh-git — commit graph lane tests.
 *
 * Fully offline: node:test + node:assert/strict only.
 * Run with: node --test test/graph-lanes.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_LANES,
  HEAD_COLOR,
  PALETTE_SIZE,
  computeLanes,
  renderAscii,
} from "../tools/graph-lanes.mjs";

/* ------------------------------------------------------------------------ */
/* graphs used by the tests (newest -> oldest, as GET /git/log returns)      */
/* ------------------------------------------------------------------------ */

const LINEAR = [
  { sha: "c3", parents: ["c2"] },
  { sha: "c2", parents: ["c1"] },
  { sha: "c1", parents: [] },
];

const FORK = [
  { sha: "m", parents: ["a", "b"] },
  { sha: "a", parents: ["c"] },
  { sha: "b", parents: ["c"] },
  { sha: "c", parents: [] },
];

const MERGE = [
  { sha: "m", parents: ["a", "b"] },
  { sha: "a", parents: ["c"] },
  { sha: "c", parents: ["d"] },
  { sha: "b", parents: ["d"] },
  { sha: "d", parents: [] },
];

const OCTOPUS = [
  { sha: "t", parents: ["a", "b", "c"] },
  { sha: "a", parents: ["d"] },
  { sha: "b", parents: ["d"] },
  { sha: "c", parents: ["d"] },
  { sha: "d", parents: [] },
];

const REUSE = [
  { sha: "m", parents: ["a", "b"] },
  { sha: "a", parents: ["d"] },
  { sha: "b", parents: [] },
  { sha: "d", parents: ["e", "f"] },
  { sha: "e", parents: [] },
  { sha: "f", parents: [] },
];

const ROOTS = [
  { sha: "root-a", parents: [] },
  { sha: "root-b", parents: [] },
];

/* ------------------------------------------------------------------------ */
/* helpers                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Every documented field must exist, be well typed and stay inside the row, so
 * the renderer never has to guard against undefined.
 */
function assertWellFormed(rows, limit) {
  assert.ok(Array.isArray(rows), "rows is an array");
  for (const row of rows) {
    assert.equal(typeof row.lane, "number", "lane is a number");
    assert.ok(Number.isInteger(row.lane) && row.lane >= 0, "lane is a non-negative integer");
    assert.ok(row.lane < limit, "lane fits the rendered width");

    assert.equal(typeof row.width, "number", "width is a number");
    assert.ok(Number.isInteger(row.width) && row.width >= 1 && row.width <= limit, "width is within bounds");

    assert.ok(Array.isArray(row.passThrough), "passThrough is an array");
    for (const col of row.passThrough) {
      assert.ok(Number.isInteger(col) && col >= 0 && col < row.width, "passThrough column is within width");
      assert.notEqual(col, row.lane, "passThrough never contains the dot column");
    }

    assert.ok(Array.isArray(row.entries), "entries is an array");
    for (const entry of row.entries) {
      assert.ok(Number.isInteger(entry.col) && entry.col >= 0 && entry.col < row.width, "entry column is within width");
      assert.equal(typeof entry.fromLane, "number", "entry.fromLane is a number");
    }

    assert.ok(Array.isArray(row.exits), "exits is an array");
    for (const exit of row.exits) {
      assert.ok(Number.isInteger(exit.col) && exit.col >= 0 && exit.col < row.width, "exit column is within width");
      assert.equal(typeof exit.toCommit, "string", "exit.toCommit is a string");
    }

    assert.ok(Array.isArray(row.merges), "merges is an array");
    for (const merge of row.merges) {
      assert.ok(Number.isInteger(merge.from) && merge.from >= 0 && merge.from < row.width, "merge.from is within width");
      assert.equal(merge.to, row.lane, "merges bend into the dot column");
    }

    assert.equal(typeof row.color, "number", "color is a number");
    assert.ok(Number.isInteger(row.color) && row.color >= 0 && row.color < PALETTE_SIZE, "color is a palette index");

    assert.ok(Array.isArray(row.laneColors), "laneColors is an array");
    assert.equal(row.laneColors.length, row.width, "laneColors covers exactly the row width");
    for (const color of row.laneColors) {
      assert.ok(Number.isInteger(color) && color >= 0 && color < PALETTE_SIZE, "laneColors entries are palette indexes");
    }
    assert.equal(row.laneColors[row.lane], row.color, "the dot colour equals laneColors[lane]");
  }
}

/**
 * Columns are globally stable: a line that leaves row i at column c is the very
 * same column that carries it into row i + 1 (no shifting, no compaction).
 */
function assertColumnsStable(rows) {
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const nextColumns = new Set(rows[i + 1].entries.map((entry) => entry.col));
    for (const exit of rows[i].exits) {
      assert.ok(
        nextColumns.has(exit.col),
        "row " + i + " exit @" + exit.col + " (" + exit.toCommit + ") must continue at the same column in row " + (i + 1),
      );
    }
    // a pass-through line either continues a line from above or was opened by
    // this very row's dot (a parent that got a fresh column)
    const ownColumns = new Set(rows[i].entries.map((entry) => entry.col));
    for (const exit of rows[i].exits) ownColumns.add(exit.col);
    for (const col of rows[i].passThrough) {
      assert.ok(ownColumns.has(col), "row " + i + " passThrough @" + col + " has no source line");
    }
  }
}

/* ------------------------------------------------------------------------ */
/* 1. linear history                                                        */
/* ------------------------------------------------------------------------ */

test("linear history keeps every commit in lane 0", () => {
  const result = computeLanes(LINEAR);

  assert.equal(result.maxLanes, 1);
  assert.deepEqual(result.rows.map((row) => row.lane), [0, 0, 0]);
  assert.deepEqual(result.rows.map((row) => row.passThrough), [[], [], []]);
  assert.deepEqual(result.rows.map((row) => row.merges), [[], [], []]);
  assert.deepEqual(result.rows.map((row) => row.exits), [
    [{ col: 0, toCommit: "c2" }],
    [{ col: 0, toCommit: "c1" }],
    [],
  ]);
  assert.equal(renderAscii(result.rows), "*\n*\n*");
  assertWellFormed(result.rows, result.maxLanes);
  assertColumnsStable(result.rows);
});

/* ------------------------------------------------------------------------ */
/* 2. two parallel branches                                                 */
/* ------------------------------------------------------------------------ */

test("two parallel branches fork and merge back together", () => {
  const result = computeLanes(FORK);

  assert.equal(result.maxLanes, 2);
  assert.deepEqual(result.rows.map((row) => row.lane), [0, 0, 1, 0]);
  // row 0 forks: first parent stays in the dot column, second opens column 1
  assert.deepEqual(result.rows[0].exits, [
    { col: 0, toCommit: "a" },
    { col: 1, toCommit: "b" },
  ]);
  // row 1 still carries the untouched "b" column through
  assert.deepEqual(result.rows[1].passThrough, [1]);
  // row 2 is "b": its parent already owns column 0, so the dot line joins it
  assert.deepEqual(result.rows[2].exits, [{ col: 0, toCommit: "c" }]);
  assert.deepEqual(result.rows[2].passThrough, [0]);
  // row 3 is the shared parent: it lands in column 0 again
  assert.equal(result.rows[3].lane, 0);
  assert.equal(renderAscii(result.rows), "* \\\n* |\n/ *\n*");
  assertWellFormed(result.rows, result.maxLanes);
  assertColumnsStable(result.rows);
});

/* ------------------------------------------------------------------------ */
/* 3. merge commit with two parents                                         */
/* ------------------------------------------------------------------------ */

test("a merge commit exposes two exits", () => {
  const result = computeLanes(MERGE);

  assert.equal(result.rows.length, MERGE.length);
  assert.equal(result.rows[0].exits.length, 2, "two parents give two exits");
  assert.deepEqual(result.rows[0].exits.map((exit) => exit.toCommit), ["a", "b"]);
  assert.deepEqual(result.rows[0].exits.map((exit) => exit.col), [0, 1]);
  assert.equal(result.rows[0].lane, 0, "the dot sits in the first parent column");

  // the second branch (b) is carried by column 1 and only disappears when "b"
  // is emitted; from then on the graph is single-column again
  assert.deepEqual(result.rows.map((row) => row.lane), [0, 0, 0, 1, 0]);
  assert.deepEqual(result.rows.map((row) => row.width), [2, 2, 2, 2, 1]);
  assert.equal(renderAscii(result.rows), "* \\\n* |\n* |\n/ *\n*");
  assertWellFormed(result.rows, result.maxLanes);
  assertColumnsStable(result.rows);
});

/* ------------------------------------------------------------------------ */
/* 4. octopus merge (three parents)                                         */
/* ------------------------------------------------------------------------ */

test("an octopus merge exposes three exits", () => {
  const result = computeLanes(OCTOPUS);

  assert.equal(result.rows[0].exits.length, 3, "three parents give three exits");
  assert.deepEqual(result.rows[0].exits, [
    { col: 0, toCommit: "a" },
    { col: 1, toCommit: "b" },
    { col: 2, toCommit: "c" },
  ]);
  assert.deepEqual(result.rows.map((row) => row.lane), [0, 0, 1, 2, 0]);
  assert.equal(result.maxLanes, 3);
  // "d" is expected in three columns at once; only column 0 owns the dot line,
  // the other two columns are plain pass-through lines that join it later.
  assert.deepEqual(result.rows[2].passThrough, [0, 2]);
  assert.deepEqual(result.rows[3].passThrough, [0]);
  assert.equal(renderAscii(result.rows), "* \\ \\\n* | |\n/ * |\n/   *\n*");
  assertWellFormed(result.rows, result.maxLanes);
  assertColumnsStable(result.rows);
});

/* ------------------------------------------------------------------------ */
/* 5. root commit                                                           */
/* ------------------------------------------------------------------------ */

test("a root commit ends its lane", () => {
  const result = computeLanes(ROOTS);

  assert.equal(result.rows.length, 2);
  for (const row of result.rows) {
    assert.deepEqual(row.exits, [], "a parentless commit has no exits");
    assert.equal(row.width, 1);
  }
  assert.deepEqual(result.rows.map((row) => row.lane), [0, 0]);
  // the column released by the root is recycled by the next tip
  assert.equal(result.maxLanes, 1);
  assert.equal(renderAscii(result.rows), "*\n*");
  assertWellFormed(result.rows, result.maxLanes);
});

/* ------------------------------------------------------------------------ */
/* 6. tolerance                                                             */
/* ------------------------------------------------------------------------ */

test("tolerates commits without a parents field", () => {
  const result = computeLanes([{ sha: "a" }, { sha: "b" }]);

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => row.exits), [[], []]);
  assert.deepEqual(result.rows.map((row) => row.lane), [0, 0]);
  assert.equal(renderAscii(result.rows), "*\n*");
  assertWellFormed(result.rows, result.maxLanes);
});

test("tolerates a parent that is missing from the page", () => {
  const result = computeLanes([
    { sha: "a", parents: ["ghost"] },
    { sha: "b", parents: [] },
  ]);

  // "ghost" never appears, so its column stays reserved for the rest of the page
  assert.deepEqual(result.rows[0].exits, [{ col: 0, toCommit: "ghost" }]);
  assert.equal(result.rows[0].width, 1);
  assert.deepEqual(result.rows[1].lane, 1, "the unresolved column is still held");
  assert.deepEqual(result.rows[1].passThrough, [0]);
  assert.equal(renderAscii(result.rows), "*\n| *");
  assertWellFormed(result.rows, result.maxLanes);
  assertColumnsStable(result.rows);
});

test("an empty commit list yields no rows", () => {
  const result = computeLanes([]);

  assert.deepEqual(result, { rows: [], maxLanes: 0 });
  assert.equal(renderAscii(result.rows), "");
});

test("a single commit yields a lone dot", () => {
  const result = computeLanes([{ sha: "solo", parents: [] }]);

  assert.equal(result.maxLanes, 1);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], {
    lane: 0,
    width: 1,
    passThrough: [],
    entries: [],
    exits: [],
    merges: [],
    color: 0,
    isHead: false,
    laneColors: [0],
  });
  assert.equal(renderAscii(result.rows), "*");
});

/* ------------------------------------------------------------------------ */
/* 7. maxLanes truncation                                                   */
/* ------------------------------------------------------------------------ */

test("truncates the graph to maxLanes columns", () => {
  const tips = Array.from({ length: 14 }, (_, index) => "t" + index);
  const commits = [{ sha: "hub", parents: tips }].concat(tips.map((sha) => ({ sha, parents: [] })));

  const full = computeLanes(commits);
  assert.equal(full.maxLanes, DEFAULT_MAX_LANES, "14 parallel lanes are capped at the default 12");
  assert.ok(full.rows.every((row) => row.width <= DEFAULT_MAX_LANES));
  assert.ok(full.rows.every((row) => row.lane < DEFAULT_MAX_LANES));
  assert.equal(full.rows[0].exits.length, DEFAULT_MAX_LANES, "exits of the dropped columns are gone");
  assert.ok(full.rows[0].exits.every((exit) => exit.col < DEFAULT_MAX_LANES));
  assertWellFormed(full.rows, full.maxLanes);

  const narrow = computeLanes(commits, { maxLanes: 4 });
  assert.equal(narrow.maxLanes, 4);
  assert.ok(narrow.rows.every((row) => row.width <= 4));
  assert.ok(narrow.rows.every((row) => row.lane <= 3));
  assert.equal(narrow.rows[0].exits.length, 4);
  assert.equal(renderAscii(narrow.rows, { width: 4 }).split("\n")[0], "* \\ \\ \\");
  assertWellFormed(narrow.rows, narrow.maxLanes);
});

test("clamps a dot that falls outside maxLanes", () => {
  const result = computeLanes(OCTOPUS, { maxLanes: 2 });

  // "c" normally lives in column 2; with only two columns it is clamped to 1
  assert.equal(result.rows[3].lane, 1);
  assert.ok(result.rows.every((row) => row.lane < 2 && row.width <= 2));
  assert.equal(renderAscii(result.rows), "* \\\n* |\n/ *\n/ *\n*");
  assertWellFormed(result.rows, result.maxLanes);
});

test("normalizes the maxLanes option", () => {
  assert.equal(DEFAULT_MAX_LANES, 12);
  assert.equal(computeLanes(OCTOPUS).maxLanes, 3);
  assert.equal(computeLanes(OCTOPUS, {}).maxLanes, 3);
  assert.equal(computeLanes(OCTOPUS, { maxLanes: 99 }).maxLanes, 3);
  assert.equal(computeLanes(OCTOPUS, { maxLanes: 0 }).maxLanes, 1);
  assert.equal(computeLanes(OCTOPUS, { maxLanes: -3 }).maxLanes, 1);
  assert.equal(computeLanes(OCTOPUS, { maxLanes: Number.NaN }).maxLanes, 3);
});

/* ------------------------------------------------------------------------ */
/* 8. colours                                                               */
/* ------------------------------------------------------------------------ */

test("keeps one colour per branch across consecutive rows", () => {
  const linear = computeLanes(LINEAR);
  for (const row of linear.rows) {
    assert.equal(row.laneColors[0], 0, "the only lane keeps colour 0");
    assert.equal(row.color, 0);
  }

  const fork = computeLanes(FORK);
  const bColor = fork.rows[0].laneColors[1];
  const aColor = fork.rows[0].laneColors[0];
  assert.equal(fork.rows[1].laneColors[1], bColor, "the second branch keeps its colour while it waits");
  assert.equal(fork.rows[2].color, bColor, "the dot of that branch uses the same colour");
  assert.equal(fork.rows[1].laneColors[0], aColor, "the first branch keeps the colour of the merge dot");
  assert.equal(fork.rows[3].color, aColor, "the shared parent keeps the first-branch colour");

  const octopus = computeLanes(OCTOPUS);
  for (let i = 1; i <= 3; i += 1) {
    assert.equal(octopus.rows[i].laneColors[0], octopus.rows[1].laneColors[0], "the 'd' line keeps its colour");
  }
  assert.equal(octopus.rows[4].color, octopus.rows[1].laneColors[0]);
});

/* ------------------------------------------------------------------------ */
/* column reuse                                                             */
/* ------------------------------------------------------------------------ */

test("reuses a freed column instead of moving columns", () => {
  const result = computeLanes(REUSE);

  // "b" is a root in column 1 and releases it; "d" then hands its second
  // parent ("f") exactly that column back instead of opening column 2
  assert.deepEqual(result.rows[2].exits, [], "the root commit frees its column");
  assert.deepEqual(result.rows[3].exits, [
    { col: 0, toCommit: "e" },
    { col: 1, toCommit: "f" },
  ]);
  assert.equal(result.maxLanes, 2);
  assert.equal(renderAscii(result.rows), "* \\\n* |\n| *\n* \\\n* |\n  *");
  assertWellFormed(result.rows, result.maxLanes);
  assertColumnsStable(result.rows);
});

/* ------------------------------------------------------------------------ */
/* robustness                                                               */
/* ------------------------------------------------------------------------ */

test("accepts malformed input without throwing", () => {
  assert.deepEqual(computeLanes(undefined), { rows: [], maxLanes: 0 });
  assert.deepEqual(computeLanes(null), { rows: [], maxLanes: 0 });
  assert.deepEqual(computeLanes("not a list"), { rows: [], maxLanes: 0 });

  const result = computeLanes([
    null,
    42,
    "x",
    { sha: 7, parents: [null, 7, "", "   ", "self", "self"] },
  ]);

  assert.equal(result.rows.length, 4);
  assertWellFormed(result.rows, result.maxLanes);
  // duplicated / blank / non-string parents are filtered out
  const exits = result.rows[3].exits;
  assert.deepEqual(exits.map((exit) => exit.toCommit), ["self"]);
  assert.equal(renderAscii(result.rows).split("\n").length, 4);
});

test("renderAscii keeps one line per row and trims trailing blanks", () => {
  const result = computeLanes(FORK);
  const ascii = renderAscii(result.rows);
  const lines = ascii.split("\n");

  assert.equal(lines.length, result.rows.length);
  for (const line of lines) {
    assert.equal(line, line.replace(/ +$/, ""), "no trailing blanks");
  }
  assert.equal(renderAscii([]), "");

  // an explicit width pads every line to the same size (2 * width - 1 chars)
  const padded = renderAscii(result.rows, { width: 4 }).split("\n");
  assert.equal(padded.length, result.rows.length);
  assert.ok(padded.every((line) => line.length === 7));
});

/* ------------------------------------------------------------------------ */
/* git-idea-parity 1.2/1.3 — colour follows the branch life, HEAD is reserved */
/* ------------------------------------------------------------------------ */

test("a linear history paints the whole HEAD life with the reserved head colour", () => {
  const graph = computeLanes(LINEAR, { headSha: "c3" });
  assert.equal(graph.rows.length, 3);
  for (const row of graph.rows) {
    assert.equal(row.lane, 0);
    assert.equal(row.laneColors[0], HEAD_COLOR, "the single lane is the HEAD branch life");
    assert.ok(row.color === HEAD_COLOR && row.laneColors[row.lane] === row.color);
  }
  assert.deepEqual(Array.from(graph.rows, (row) => row.isHead), [true, false, false]);
});

test("two parallel branches never share a colour while they coexist", () => {
  const graph = computeLanes(FORK, { headSha: "m" });
  const first = graph.rows[0];
  assert.ok(first.width >= 2, "the fork row needs the second lane");
  const live = new Set([first.lane, ...first.passThrough, ...first.exits.map((exit) => exit.col)]);
  const colours = Array.from(live, (column) => first.laneColors[column]);
  assert.equal(new Set(colours).size, colours.length, "coexisting lanes must not share a colour");
  assert.equal(first.laneColors[first.lane], HEAD_COLOR);
});

test("a branch keeps its colour for the whole life", () => {
  const graph = computeLanes(FORK, { headSha: "m" });
  // The side branch owns column 1 from the fork row until it merges back into
  // "c"; every row that still carries column 1 must use the same colour.
  const branchColours = graph.rows
    .filter((row) => row.width > 1)
    .map((row) => row.laneColors[1]);
  assert.ok(branchColours.length >= 3, "the side branch should span the fork rows");
  assert.equal(new Set(branchColours).size, 1, "a branch life must not change colour");
});

test("colours fall back to least-used when lanes outnumber the palette", () => {
  const parents = [];
  const commits = [];
  for (let index = 0; index < 11; index += 1) parents.push("p" + index);
  commits.push({ sha: "t", parents });
  for (const parent of parents) commits.push({ sha: parent, parents: [] });
  const graph = computeLanes(commits, { headSha: "t" });
  const lanes = new Set();
  const colours = new Set();
  for (const row of graph.rows) {
    lanes.add(row.width);
    for (const colour of row.laneColors) {
      assert.ok(colour >= 0 && colour <= HEAD_COLOR, "colour index must be within the palette contract");
      colours.add(colour);
    }
  }
  assert.ok(lanes.size >= 1);
  assert.ok(colours.size <= PALETTE_SIZE + 1, "at most the palette plus the reserved head slot");
});
