/**
 * dsh-git — commit-graph lane layout.
 *
 * Pure, dependency-free ESM. Turns the `commits` array of `GET /git/log`
 * (docs/contract.md §1.3: newest → oldest, `{ sha, parents?: string[] }`) into a
 * per-row lane description that the client paints as SVG.
 *
 * ## Coordinate model — columns are GLOBALLY STABLE
 *
 * A lane column keeps its index for the whole page; it is never shifted and no
 * column is ever compacted away. When a column runs out of work (the commit it
 * expected was emitted and left nothing behind) the column is simply marked
 * empty and is recycled later by the next branch that needs a column — always
 * at the very same index. A renderer can therefore use a constant
 * `x = column * columnWidth` mapping for every row of the page.
 *
 * Every row covers `y ∈ [0, 1]`; the commit dot of the row sits at `y = 0.5`.
 *
 * ## Row fields
 *
 * | field         | meaning                                                              |
 * |---------------|----------------------------------------------------------------------|
 * | `lane`        | column of the commit dot (0-based)                                     |
 * | `width`       | columns this row spans = right-most used column + 1, clamped          |
 * | `passThrough` | columns whose line runs straight from `(col, 0)` to `(col, 1)`        |
 * | `entries`     | columns carrying a line in from the previous row (`col === fromLane`) |
 * | `exits`       | lines leaving the dot: reach `(col, 1)` and continue at `col` below  |
 * | `merges`      | columns bending into the dot column (`to === lane`); defensive only   |
 * | `color`       | palette index of the commit dot                                       |
 * | `laneColors`  | palette index per column, `length === width`                          |
 *
 * Every line of a row is exactly one of: `passThrough` (vertical), one of the
 * dot's `exits` (leaves the dot), or one of `merges` (bends into the dot).
 * The three lists never overlap. Because columns never move, `exits[].col` of
 * row `r` is exactly the column that same line occupies in row `r + 1`.
 *
 * ## Colours
 *
 * The colour index belongs to the column slot, so a line keeps its colour for
 * as long as it stays in that column — a branch never changes colour. The first
 * parent inherits the colour of the dot it leaves, and a column that was
 * released and picked up by a new branch reuses the slot's colour. Colours are
 * handed out as the least used palette index, so two neighbouring lanes only
 * share a colour when the page has more lanes than palette entries.
 *
 * ## Robustness
 *
 * Missing / non-array `parents`, non-string entries, duplicated parents, shas
 * that never appear in the page and an empty `commits` array are all accepted.
 * Unresolved parents keep their column reserved until the end of the page.
 */

/** Default maximum number of rendered lane columns. */
export const DEFAULT_MAX_LANES = 12;

/** Number of distinct colour indexes handed out before the palette wraps. */
export const PALETTE_SIZE = 8;

const NO_PARENTS = Object.freeze([]);

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

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asNumberArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "number") : [];
}

/**
 * @param {unknown} value
 * @param {number} width
 * @returns {number}
 */
function clampColumn(value, width) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  if (n < 0) return 0;
  if (n > width - 1) return width - 1;
  return n;
}

/* ------------------------------------------------------------------------ */
/* computeLanes                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Lay out the commit graph lanes for a page of commits (newest → oldest).
 *
 * @param {Array<{ sha?: string, parents?: string[] }>} commits
 * @param {{ maxLanes?: number }} [options]
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
export function computeLanes(commits, options = {}) {
  const limit = normalizeMaxLanes(options && typeof options === "object" ? options.maxLanes : undefined);
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
      colors[lane] = allocColor(lanes, colors);
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

/* ------------------------------------------------------------------------ */
/* renderAscii                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Paint the rows as ASCII, one text line per row, so tests and humans can check
 * the layout without a browser.
 *
 * Glyphs (one lane column per character, one space between columns):
 *
 *   `*`  commit dot (`lane`)
 *   `|`  a line running through the row (`passThrough`)
 *   `/`  a line bending one column to the left  (exit / merge)
 *   `\`  a line bending one column to the right (exit / merge)
 *
 * An exit is drawn on the column it arrives at, i.e. `exits[].col`. Trailing
 * blanks are trimmed unless `options.width` forces a fixed width.
 *
 * @param {Array<object>} rows rows returned by {@link computeLanes}
 * @param {{ width?: number }} [options]
 * @returns {string}
 */
export function renderAscii(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const opts = options && typeof options === "object" ? options : {};
  const forcedWidth = typeof opts.width === "number" && Number.isFinite(opts.width) ? Math.trunc(opts.width) : 0;
  const lines = [];

  for (const item of list) {
    const row = item && typeof item === "object" ? item : {};
    const width = Math.max(
      1,
      forcedWidth > 0 ? forcedWidth : 0,
      typeof row.width === "number" && Number.isFinite(row.width) ? Math.trunc(row.width) : 0,
    );
    const lane = clampColumn(row.lane, width);
    const cells = new Array(width).fill(" ");

    for (const col of asNumberArray(row.passThrough)) {
      cells[clampColumn(col, width)] = "|";
    }
    for (const exit of Array.isArray(row.exits) ? row.exits : []) {
      const col = clampColumn(exit && exit.col, width);
      if (col === lane) continue;
      cells[col] = col < lane ? "/" : "\\";
    }
    for (const merge of Array.isArray(row.merges) ? row.merges : []) {
      const from = clampColumn(merge && merge.from, width);
      const to = clampColumn(merge && merge.to, width);
      if (from === lane) continue;
      cells[from] = to < from ? "/" : "\\";
    }
    cells[lane] = "*";

    const line = cells.join(" ");
    lines.push(forcedWidth > 0 ? line : line.replace(/ +$/, ""));
  }

  return lines.join("\n");
}
