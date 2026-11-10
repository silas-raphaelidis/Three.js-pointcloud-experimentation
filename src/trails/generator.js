import { getThresholds, RATINGS } from '../difficulty.js';
import { simplifyPath } from './pathfind.js';
import { sampleSpline } from './spline.js';
import { trailStats } from './stats.js';

const CELL = 10;            // meters per cell of the search grid
const AVOID_RADIUS = 35;    // meters around existing trails that cost extra
const STEEPEST_RUN = 1.2;   // top of the double-black band (rise/run)

// Each try is stricter than the last: smoothing into a spline can change a
// route's pitch, so a near miss can often be fixed by aiming further inside
// the band and following the route more closely.
const ATTEMPTS = [
  { hiScale: 0.95, belowWeight: 1, tolerance: 8 },
  { hiScale: 0.88, belowWeight: 2.5, tolerance: 5 },
  { hiScale: 0.8, belowWeight: 5, tolerance: 3 },
];

/**
 * The smoothed ground sampled onto a coarse grid, the input to route search
 * and the mountain analysis. Plain data, so it can be posted to a worker.
 * Used by TrailGenerator and the mountain analysis overlay.
 * @param {import('../terrain.js').Terrain} t
 */
export function sampleHeightGrid(t, cell = CELL) {
  const cols = Math.floor((t.width * t.res) / cell);
  const rows = Math.floor((t.height * t.res) / cell);
  const z = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      z[j * cols + i] = t.trailHeightAt(t.origin.x + (i + 0.5) * cell, t.origin.y + (j + 0.5) * cell);
    }
  }
  return { cols, rows, cell, originX: t.origin.x, originY: t.origin.y, z };
}

/**
 * Builds generated trails: asks the worker for routes, turns them into
 * control points, and checks each result with the same rating real trails
 * get. Reads the network but never edits it; the editor adds the result.
 */
export class TrailGenerator {
  /** Created once in setupTrails (main.js) and handed to the editor. */
  constructor({ network, geometry, terrain }) {
    Object.assign(this, { network, geometry, terrain });
    this.worker = null;
    this.grid = null;
    this.nextId = 1;
    this.waiting = new Map(); // request id -> resolve
  }

  /**
   * Find a run between two points, from whichever is higher to whichever is lower.
   * Returns null when no route exists, otherwise { points, rating, target }, where
   * points are trail stops; an end given as {trail, x, y} stays that way for the
   * editor to join. `rating` may differ from `target` when the terrain doesn't
   * allow it. Used by TrailEditor and MountainGenerator.
   *
   * @param {{node?:string, trail?:string, x?:number, y?:number}} from  an existing node, a
   *   position, or a position on a trail ({trail, x, y}: the editor joins the trail there)
   * @param {{node?:string, trail?:string, x?:number, y?:number}} to
   * @param {number} target  rating index, 0 green .. 3 double black
   * @param {number} width   width of the new trail, meters
   * @param {{ coarseness?: number }} [opts]  scales how loosely the route is
   *   simplified into control points: 2 gives about half as many (mountain generation)
   */
  async generate(from, to, target, width, { coarseness = 1 } = {}) {
    this.#startWorker();
    const a = this.#position(from), b = this.#position(to);
    const aHigher = this.terrain.trailHeightAt(a.x, a.y) >= this.terrain.trailHeightAt(b.x, b.y);
    const [topEnd, bottomEnd] = aHigher ? [from, to] : [to, from];
    const top = aHigher ? a : b, bottom = aHigher ? b : a;
    const { lo, hi } = this.#band(target);
    const avoid = this.#avoidMask();
    const maxLength = this.#maxLength(top, bottom, hi);

    let best = null;
    for (const attempt of ATTEMPTS) {
      const route = await this.#request({
        start: top, goal: bottom, lo, avoid, maxLength,
        hi: hi * attempt.hiScale,
        belowWeight: attempt.belowWeight,
      });
      if (!route) break; // cliffs or the length cap: stricter costs can't help

      const middle = simplifyPath(route.path, attempt.tolerance * coarseness).slice(1, -1);
      const ctrl = [top, ...middle, bottom].map((p) => ({ x: p.x, y: p.y, width }));
      const rating = trailStats(sampleSpline(ctrl), this.terrain)?.rating.index ?? 0;
      const miss = Math.abs(rating - target);
      if (!best || miss < best.miss) best = { miss, rating, middle };
      if (miss === 0) break;
    }
    if (!best) return null;

    const stop = (end) => (end.node ? { node: end.node, width }
      : end.trail ? { trail: end.trail, x: end.x, y: end.y, width }
      : { x: end.x, y: end.y, width });
    return {
      points: [stop(topEnd), ...best.middle.map((p) => ({ x: p.x, y: p.y, width })), stop(bottomEnd)],
      rating: best.rating,
      target,
    };
  }

  /** Start the worker and send it the height grid, the first time it's needed. */
  #startWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./generator.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      this.waiting.get(data.id)?.(data.route);
      this.waiting.delete(data.id);
    };
    // A crashed search counts as no route, so the editor never waits forever.
    this.worker.onerror = (e) => {
      console.error('[generate] route search failed:', e.message);
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
    };
    this.grid = sampleHeightGrid(this.terrain);
    this.worker.postMessage({ type: 'grid', grid: this.grid });
  }

  /** Send one search to the worker and wait for its answer. Used by generate. */
  #request(params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ type: 'route', id, ...params });
    });
  }

  /** Position of an endpoint given as a node or as coordinates. Used by generate. */
  #position(end) {
    return end.node ? this.network.node(end.node) : end;
  }

  /** Pitch range of a rating, from the current thresholds. Used by generate. */
  #band(target) {
    const t = getThresholds();
    return { lo: target === 0 ? 0 : t[target - 1], hi: target === RATINGS.length - 1 ? STEEPEST_RUN : t[target] };
  }

  /**
   * Longest acceptable route: room to wander, or to switchback enough to lose
   * the height at this difficulty, without becoming an endless zigzag. Used by generate.
   */
  #maxLength(top, bottom, hi) {
    const straight = Math.hypot(top.x - bottom.x, top.y - bottom.y);
    const drop = this.terrain.trailHeightAt(top.x, top.y) - this.terrain.trailHeightAt(bottom.x, bottom.y);
    return Math.max(400, straight * 3, (drop / hi) * 2);
  }

  /** Mark the search cells close to existing trails. Used by generate. */
  #avoidMask() {
    const { cols, rows, originX, originY } = this.grid;
    const mask = new Uint8Array(cols * rows);
    const r = Math.ceil(AVOID_RADIUS / CELL);
    for (const [, { samples }] of this.geometry.entries()) {
      // A sample per cell is plenty; samples are about 2 m apart.
      for (let k = 0; k < samples.length; k += 5) {
        const ci = Math.floor((samples[k].x - originX) / CELL);
        const cj = Math.floor((samples[k].y - originY) / CELL);
        for (let j = Math.max(0, cj - r); j <= Math.min(rows - 1, cj + r); j++) {
          for (let i = Math.max(0, ci - r); i <= Math.min(cols - 1, ci + r); i++) {
            if ((i - ci) ** 2 + (j - cj) ** 2 <= r * r) mask[j * cols + i] = 1;
          }
        }
      }
    }
    return mask;
  }
}
