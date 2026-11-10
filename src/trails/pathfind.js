/**
 * Route search for generated trails: A* over a coarse height grid, where the
 * cost of each step describes what makes a good ski run. Plain data and math
 * only (no Three.js, no DOM), because it runs inside a Web Worker.
 *
 * A search state is a grid cell plus the direction of travel. Remembering the
 * direction is what lets turns have a cost, so routes flow and switchback
 * instead of zigzagging.
 */

// The 16 moves, in order of angle, so a difference in index is a turn angle
// (one index is about 22.5 degrees).
const MOVES = [
  [1, 0], [2, 1], [1, 1], [1, 2], [0, 1], [-1, 2], [-1, 1], [-2, 1],
  [-1, 0], [-2, -1], [-1, -1], [-1, -2], [0, -1], [1, -2], [1, -1], [2, -1],
];
const HEADINGS = MOVES.length;
const MOVE_LENGTH = MOVES.map(([dx, dy]) => Math.hypot(dx, dy));

// Extra cost of a turn, in meters of travel, by how many headings it changes.
const TURN_COST = [0, 6, 24, 80];

const MAX_UPHILL = 0.08;    // steepest climb allowed on any step (rise/run)
// Shared with the mountain analysis, so it agrees on what can be skied.
export const MAX_SLOPE = 1.3;       // steeper ground than this is treated as a cliff
export const MAX_CROSS_SLOPE = 0.9; // steepest side slope a traverse can cross
const COMFORTABLE_CROSS = 0.35; // side slope that starts to cost extra
const END_ZONE = 40;        // meters around each endpoint exempt from limits
// The scan is cropped at the map's edge, so routes keep off it. Shared with
// the mountain analysis, which plans nothing inside the margin either.
export const EDGE_MARGIN = 150; // meters along the edge routes may not enter
const EDGE_SOFT = 150;      // beyond the margin, meters over which nearing it costs extra
const EDGE_COST = 4;        // extra cost per meter right at the margin, fading to 0
const SEARCH_WEIGHT = 1.25; // over 1 trades a little route quality for speed
const MAX_EXPANSIONS = 4e6; // give up rather than search forever

/**
 * Ground slope (rise/run) at every cell of a height grid, from central
 * differences. Used by prepareGrid and by the mountain analysis.
 * @param {{cols:number, rows:number, cell:number, z:Float32Array}} grid
 */
export function gridSlopes({ cols, rows, cell, z }) {
  const slope = new Float32Array(cols * rows);
  // Height at a cell, clamped to the edges of the grid.
  const at = (i, j) => z[Math.min(rows - 1, Math.max(0, j)) * cols + Math.min(cols - 1, Math.max(0, i))];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      slope[j * cols + i] = Math.hypot(at(i + 1, j) - at(i - 1, j), at(i, j + 1) - at(i, j - 1)) / (2 * cell);
    }
  }
  return slope;
}

/**
 * Add per-cell ground slope to a height grid and allocate the search's
 * memory, so repeated searches don't reallocate it. Used once by the worker.
 * @param {{cols:number, rows:number, cell:number, originX:number, originY:number, z:Float32Array}} grid
 */
export function prepareGrid(grid) {
  const states = grid.cols * grid.rows * HEADINGS;
  return {
    ...grid,
    slope: gridSlopes(grid),
    g: new Float32Array(states),
    length: new Float32Array(states),
    parent: new Int32Array(states),
    closed: new Uint8Array(states),
  };
}

/** Min-heap of search states ordered by priority. Used by findRoute. */
class StateHeap {
  constructor() {
    this.keys = new Float64Array(1 << 16);
    this.values = new Int32Array(1 << 16);
    this.size = 0;
  }

  /** Add a state, doubling the storage when full. */
  push(key, value) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2), values = new Int32Array(this.size * 2);
      keys.set(this.keys);
      values.set(this.values);
      this.keys = keys;
      this.values = values;
    }
    let i = this.size++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (this.keys[up] <= key) break;
      this.keys[i] = this.keys[up];
      this.values[i] = this.values[up];
      i = up;
    }
    this.keys[i] = key;
    this.values[i] = value;
  }

  /** Remove and return the state with the lowest priority. */
  pop() {
    const top = this.values[0];
    const key = this.keys[--this.size];
    const value = this.values[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (key <= this.keys[child]) break;
      this.keys[i] = this.keys[child];
      this.values[i] = this.values[child];
      i = child;
    }
    this.keys[i] = key;
    this.values[i] = value;
    return top;
  }
}

/**
 * Find the cheapest downhill route. Pitch outside the target band is a soft
 * cost, so a route usually exists even when the target can't be met (the
 * caller checks the real rating); only cliffs, climbs, the edge margin and
 * the length cap block it outright. Returns { path, expansions } or null if
 * no route exists.
 * Used by the generator's worker.
 *
 * @param {ReturnType<typeof prepareGrid>} grid
 * @param {object} req
 * @param {{x:number,y:number}} req.start  upper end of the run, local meters
 * @param {{x:number,y:number}} req.goal   lower end of the run
 * @param {number} req.lo  gentlest pitch of the target band (rise/run)
 * @param {number} req.hi  steepest pitch of the target band
 * @param {number} req.belowWeight  how strongly to avoid being too gentle
 * @param {number} req.maxLength  longest allowed route, meters
 * @param {Uint8Array} req.avoid  1 for cells close to existing trails
 */
export function findRoute(grid, { start, goal, lo, hi, belowWeight, maxLength, avoid }) {
  const { cols, rows, cell, originX, originY, z, slope, g, length, parent, closed } = grid;
  // Grid cell index containing a local position, clamped to the grid.
  const cellOf = ({ x, y }) => {
    const i = Math.min(cols - 1, Math.max(0, Math.floor((x - originX) / cell)));
    const j = Math.min(rows - 1, Math.max(0, Math.floor((y - originY) / cell)));
    return j * cols + i;
  };
  const startCell = cellOf(start), goalCell = cellOf(goal);
  const goalI = goalCell % cols, goalJ = (goalCell - goalI) / cols;
  const startI = startCell % cols, startJ = (startCell - startI) / cols;
  const zGoal = z[goalCell];
  const endZoneCells = END_ZONE / cell;
  // Cells from (i, j) to the nearest edge of the map.
  const edgeDist = (i, j) => Math.min(i, j, cols - 1 - i, rows - 1 - j);
  const marginCells = EDGE_MARGIN / cell, softCells = EDGE_SOFT / cell;
  // The margin is off limits only when both ends are clear of it; a trail
  // someone starts or ends near the edge just gets pushed away from it.
  const hardEdge = edgeDist(startI, startJ) >= marginCells && edgeDist(goalI, goalJ) >= marginCells;

  // Lower bound on the remaining cost: straight-line distance, or the
  // distance needed to lose the remaining height without exceeding `hi`.
  const estimate = (i, j, height) =>
    Math.max(Math.hypot(i - goalI, j - goalJ) * cell, (height - zGoal) / hi);

  g.fill(Infinity);
  closed.fill(0);
  parent.fill(-1);
  const heap = new StateHeap();
  // Any starting direction is free.
  for (let h = 0; h < HEADINGS; h++) {
    const s = startCell * HEADINGS + h;
    g[s] = 0;
    length[s] = 0;
    heap.push(estimate(startI, startJ, z[startCell]), s);
  }

  let expansions = 0;
  while (heap.size) {
    const s = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    if (++expansions > MAX_EXPANSIONS) return null;

    const c = Math.floor(s / HEADINGS), heading = s - c * HEADINGS;
    if (c === goalCell) return { path: reconstruct(grid, s, start, goal), expansions };
    const i = c % cols, j = (c - i) / cols;

    for (let d = 0; d < HEADINGS; d++) {
      const diff = Math.abs(d - heading);
      const turn = Math.min(diff, HEADINGS - diff);
      if (turn >= TURN_COST.length) continue;

      const ni = i + MOVES[d][0], nj = j + MOVES[d][1];
      if (ni < 1 || nj < 1 || ni >= cols - 1 || nj >= rows - 1) continue;
      const nc = nj * cols + ni;
      const ns = nc * HEADINGS + d;
      if (closed[ns]) continue;

      const ds = MOVE_LENGTH[d] * cell;
      const newLength = length[s] + ds;
      if (newLength > maxLength) continue;

      const pitch = (z[c] - z[nc]) / ds; // positive means going downhill
      const ground = slope[nc];
      const side = Math.sqrt(Math.max(0, ground * ground - pitch * pitch));
      const nearEnd = Math.min(Math.hypot(ni - startI, nj - startJ), Math.hypot(ni - goalI, nj - goalJ)) <= endZoneCells;
      if (!nearEnd && (pitch < -MAX_UPHILL || ground > MAX_SLOPE || side > MAX_CROSS_SLOPE)) continue;
      const edge = edgeDist(ni, nj);
      if (hardEdge && edge < marginCells) continue;

      let penalty = 0;
      if (pitch > hi) penalty += 20 + 200 * (pitch - hi);
      else if (pitch < lo) penalty += belowWeight * (0.5 + 4 * (lo - pitch));
      if (pitch < 0) penalty += 5 + 60 * -pitch;
      if (side > COMFORTABLE_CROSS) penalty += 8 * (side - COMFORTABLE_CROSS);
      if (avoid[nc] && !nearEnd) penalty += 3;
      if (edge < marginCells + softCells) penalty += EDGE_COST * Math.min(1, (marginCells + softCells - edge) / softCells);

      const cost = g[s] + ds * (1 + penalty) + TURN_COST[turn];
      if (cost < g[ns]) {
        g[ns] = cost;
        length[ns] = newLength;
        parent[ns] = s;
        heap.push(cost + SEARCH_WEIGHT * estimate(ni, nj, z[nc]), ns);
      }
    }
  }
  return null;
}

/** Walk parents back from the goal into a list of positions. Used by findRoute. */
function reconstruct({ cols, cell, originX, originY, parent }, end, start, goal) {
  const path = [];
  for (let s = end; s !== -1; s = parent[s]) {
    const c = Math.floor(s / HEADINGS), i = c % cols, j = (c - i) / cols;
    path.push({ x: originX + (i + 0.5) * cell, y: originY + (j + 0.5) * cell });
  }
  path.reverse();
  // The route starts and ends exactly where it was asked to.
  path[0] = { x: start.x, y: start.y };
  path[path.length - 1] = { x: goal.x, y: goal.y };
  return path;
}

/**
 * Reduce a dense path to the points that define its shape (Douglas-Peucker).
 * Keeps both ends. Used by the generator to turn a route into control points.
 * @param {Array<{x:number,y:number}>} path
 * @param {number} tolerance  how far the result may stray from the path, meters
 */
export function simplifyPath(path, tolerance) {
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = path[a], B = path[b];
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1, farDist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dx * (A.y - path[i].y) - (A.x - path[i].x) * dy) / len;
      if (d > farDist) { farDist = d; far = i; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return path.filter((_, i) => keep[i]);
}
