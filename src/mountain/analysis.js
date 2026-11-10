/**
 * Terrain analysis for mountain generation, on the same coarse height grid
 * the route search uses: where a skier can get to, where lift stations fit,
 * and which flat areas make good bases. Plain data and math only, so it can
 * run in a worker.
 *
 * "Can ski from A to B" uses the same limits as the route search (cliffs,
 * side slopes) but allows almost no climbing, so anything it says is
 * reachable, the route search can also find.
 *
 * Nothing is planned within EDGE_MARGIN of the map's edge: the scan is
 * cropped there, so the ground just past it is unknown.
 */
import { MAX_SLOPE, MAX_CROSS_SLOPE, EDGE_MARGIN } from '../trails/pathfind.js';

const NEIGHBORS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const MAX_SKATE = 0.03;      // steepest climb still counted as skiing (rise/run)
export const FLAT = 0.12;    // slope gentle enough for a lift station
// Gentle enough for a base area. Steeper than a station allows, since inside
// the edge margin this mountain has almost no ground under 12%.
const BASE_SLOPE = 0.2;
const MIN_BASE_AREA = 4000;  // m² of flat ground a base needs
const SKI_TERRAIN = 0.08;    // slope that counts as ski terrain when sizing a base

/**
 * Is cell (i, j) far enough from the map's edge to use?
 * Used by the flood fills, flatAreas and analyzeTerrain.
 */
export function isInside({ cols, rows, cell }, i, j) {
  const m = Math.ceil(EDGE_MARGIN / cell);
  return i >= m && j >= m && i < cols - m && j < rows - m;
}

/**
 * Can a skier go from cell `from` to its neighbor `to`, `dist` meters away?
 * Used by the flood fills.
 */
function canStep({ z, slope }, from, to, dist) {
  const pitch = (z[from] - z[to]) / dist; // positive means downhill
  if (pitch < -MAX_SKATE) return false;
  const ground = slope[to];
  if (ground > MAX_SLOPE) return false;
  // Side slope across the direction of travel.
  return ground * ground - pitch * pitch <= MAX_CROSS_SLOPE * MAX_CROSS_SLOPE;
}

/**
 * Breadth-first flood over skiable steps. Forward finds where skiers starting
 * at `seeds` can get to; reverse finds where skiers can start to reach `seeds`.
 * Returns 1 per reached cell. Used by skiDownFrom and skiDownTo.
 */
function flood(grid, seeds, reverse) {
  const { cols, rows, cell } = grid;
  const seen = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  let head = 0, tail = 0;
  for (const c of seeds) {
    if (!seen[c]) { seen[c] = 1; queue[tail++] = c; }
  }
  while (head < tail) {
    const c = queue[head++];
    const i = c % cols, j = (c - i) / cols;
    for (const [dx, dy] of NEIGHBORS) {
      const ni = i + dx, nj = j + dy;
      if (!isInside(grid, ni, nj)) continue;
      const n = nj * cols + ni;
      if (seen[n]) continue;
      const dist = (dx && dy ? Math.SQRT2 : 1) * cell;
      if (reverse ? canStep(grid, n, c, dist) : canStep(grid, c, n, dist)) {
        seen[n] = 1;
        queue[tail++] = n;
      }
    }
  }
  return seen;
}

/** Every cell a skier can reach starting from any of `cells`. */
export function skiDownFrom(grid, cells) {
  return flood(grid, cells, false);
}

/** Every cell a skier can start from and still reach one of `cells`. */
export function skiDownTo(grid, cells) {
  return flood(grid, cells, true);
}

/**
 * Connected patches of gentle ground (8-neighbor), largest first.
 * Each is { cells, area (m²), x, y (local center), z (mean height) }.
 * Used by analyzeTerrain, for lift stations and (with a gentler limit) bases.
 */
export function flatAreas(grid, maxSlope = FLAT) {
  const { cols, rows, cell, originX, originY, z, slope } = grid;
  const done = new Uint8Array(cols * rows);
  const stack = new Int32Array(cols * rows);
  const areas = [];
  // Gentle and away from the edge.
  const usable = (i, j) => isInside(grid, i, j) && slope[j * cols + i] < maxSlope;
  for (let start = 0; start < cols * rows; start++) {
    const si0 = start % cols;
    if (done[start] || !usable(si0, (start - si0) / cols)) continue;
    done[start] = 1;
    let top = 0;
    stack[top++] = start;
    const cells = [];
    let si = 0, sj = 0, sz = 0;
    while (top) {
      const c = stack[--top];
      const i = c % cols, j = (c - i) / cols;
      cells.push(c);
      si += i; sj += j; sz += z[c];
      for (const [dx, dy] of NEIGHBORS) {
        const ni = i + dx, nj = j + dy;
        if (!usable(ni, nj)) continue;
        const n = nj * cols + ni;
        if (done[n]) continue;
        done[n] = 1;
        stack[top++] = n;
      }
    }
    const k = cells.length;
    areas.push({
      cells,
      area: k * cell * cell,
      x: originX + (si / k + 0.5) * cell,
      y: originY + (sj / k + 0.5) * cell,
      z: sz / k,
    });
  }
  return areas.sort((a, b) => b.area - a.area);
}

/**
 * Flat areas big enough for a base, best first: the more ski terrain drains
 * into one, the more mountain it can serve. Each gets `catchment` (1 for
 * every cell that can ski down to it), `served` (m² of ski terrain in that
 * catchment) and `vertical` (meters from its highest skiable cell).
 */
export function findBases(grid, areas) {
  const { cell, z, slope } = grid;
  const bases = [];
  for (const a of areas) {
    if (a.area < MIN_BASE_AREA) continue;
    const catchment = skiDownTo(grid, a.cells);
    let served = 0, top = a.z;
    for (let c = 0; c < catchment.length; c++) {
      if (!catchment[c]) continue;
      if (slope[c] >= SKI_TERRAIN) served++;
      if (z[c] > top) top = z[c];
    }
    bases.push({ ...a, catchment, served: served * cell * cell, vertical: top - a.z });
  }
  return bases.sort((a, b) => b.served - a.served);
}

/**
 * Everything the mountain generator needs to know about the terrain.
 * @param {{cols:number, rows:number, cell:number, originX:number, originY:number,
 *          z:Float32Array, slope:Float32Array}} grid
 */
export function analyzeTerrain(grid) {
  const areas = flatAreas(grid);
  // Highest cell away from the edge.
  const { cols, z } = grid;
  let summit = -1;
  for (let c = 0; c < z.length; c++) {
    const i = c % cols;
    if (isInside(grid, i, (c - i) / cols) && (summit < 0 || z[c] > z[summit])) summit = c;
  }
  return { areas, bases: findBases(grid, flatAreas(grid, BASE_SLOPE)), summit };
}
