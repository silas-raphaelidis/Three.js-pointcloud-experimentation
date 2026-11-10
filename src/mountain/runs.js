/**
 * Plans the runs of a generated mountain, one at a time. Plain data and math,
 * run in the mountain worker. The main thread routes each planned run with the
 * ordinary trail generator and reports back what it got (see tried()), so the
 * planner always knows where the runs actually went.
 *
 * Runs are planned in three passes:
 *   1. required: from every lift's top, a green or blue way down, so nobody
 *      is stuck at the top of a lift. It goes to another lift when it can,
 *      which links the lifts up as it goes, so few connectors are needed.
 *   2. connect: runs between lifts, at a difficulty that suits the slope,
 *      until you can get from every lift to every other, riding lifts up and
 *      skiing runs down. Lift placement guarantees the terrain allows it; a
 *      route that fails is retried between another pair of lifts.
 *   3. fill: aimed at the served terrain farthest from any run, until all
 *      but CROSSCUT_SHARE of the requested runs are placed.
 *   4. crosscuts, which start and end partway along other runs, alternating:
 *      - steep shots: aimed at double black at the steepest patches, from a
 *        run or lift top above the patch to a different run or lift bottom
 *        below it. Kept only if they rate black or harder.
 *      - bail-outs: from the upper part of a black run to an easier run
 *        nearby below it. Kept only if they rate green or blue.
 *   5. fill again, if crosscuts ran out before the requested count.
 * The first two always run, even past the requested count.
 *
 * A planned run is { from, to, target (rating index), width (m), pass, gap? },
 * where each end is { lift, end: 'top' | 'bottom' } or { run, x, y }: a spot
 * on the run kept in that order (0 = the first run kept).
 */
import { isInside, skiDownFrom } from './analysis.js';

const COVER_RADIUS = 80;  // meters around a run that count as covered by it
const NEAR_RADIUS = 20;   // a new run this close to an old one overlaps it
const MAX_OVERLAP = 0.5;  // share of a fill run allowed to overlap older runs
const MIN_NEW = 0.25;     // share of a fill run that must cover new ground
const END_SKIP = 60;      // meters at each end not counted (runs meet at lifts)
const MIN_GAP = 150;      // stop filling when nothing served is farther than this from a run
const GAP_SPREAD = 0.8;   // pick a gap among cells at least this far relative to the farthest
const TRIED_RADIUS = 150; // meters around a gap that failed, skipped from then on
// Widths, meters. Each run picks a base width in its range, which then varies along it.
const RUN_WIDTHS = [[30, 70], [28, 60], [22, 45], [16, 32]]; // by rating, green to double black
const SHOT_WIDTHS = [12, 20];  // steep shots: chutes
const TRACK_WIDTHS = [12, 18]; // bail-outs: cat tracks across the slope
const MIN_WIDTH = 10, MAX_WIDTH = 90;
const TRAVERSE_NARROWING = 0.45; // share narrower where a run cuts straight across the slope
const STEEP_NARROWING = 0.8;     // factor on pitches steeper than black
const BOTTOM_WIDENING = 0.3;     // share wider at the bottom, where runs merge near the lifts
const WOBBLE = 0.15;             // slow random change along a run, up to this share
const WOBBLE_STEP = 3;           // control points between wobble values
const CROSSCUT_SHARE = 0.25; // share of the requested runs saved for crosscuts
const STEEP_MIN_CELLS = 3;   // smallest double-black patch worth a steep shot (cells)
const SHOT_REACH = 300;      // meters from a patch to look for ends above and below it
const SHOT_DROP = 10;        // meters a shot's ends must be above and below the patch
const SHOT_SPACING = 200;    // meters: a shot uses up the other patches this close to it
const BAIL_START = 0.4;      // a bail-out leaves a black run within this share of its length
const BAIL_REACH = 250;      // meters a bail-out can cross to an easier run
const BAIL_DROP = 5;         // meters a bail-out must drop

export class RunPlanner {
  /**
   * @param {object} grid  the analysis grid
   * @param {import('./lifts.js').LiftPlan} plan  the placed lifts and what they serve
   * @param {{ runs:number, thresholds:number[], random:object }} opts
   *   runs: how many runs to aim for; thresholds: the difficulty pitch limits
   */
  constructor(grid, plan, { runs, thresholds, random }) {
    this.grid = grid;
    this.plan = plan;
    this.lifts = plan.lifts;
    this.runs = runs;
    this.thresholds = thresholds;
    this.random = random;
    const n = grid.cols * grid.rows;
    this.covered = new Uint8Array(n); // within COVER_RADIUS of a run
    this.near = new Uint8Array(n);    // within NEAR_RADIUS of a run
    this.failedGaps = new Uint8Array(n);   // around fill gaps that didn't work out
    this.links = new Set();           // "a>b": a run from lift a's top to lift b's bottom
    this.nextRequired = 0;
    this.connectTried = new Set();    // "a>b" connector runs already tried
    this.accepted = 0;
    this.failures = 0;
    this.kept = [];                   // runs kept, in order: { samples: [{x, y, s, c, z}], rating }
    this.patches = this.#steepPatches();
    this.nextPatch = 0;
    this.bailed = new Set();          // indexes of black runs already given a bail-out
    this.shotTurn = true;             // crosscuts alternate, starting with a steep shot
  }

  /** The next run to try, or null when the mountain is done. */
  next() {
    while (this.nextRequired < this.lifts.length) {
      const run = this.#required(this.nextRequired++);
      if (run) return run;
    }
    const link = this.#connector();
    if (link) return link;
    const fill = this.#nextFill(this.runs - Math.round(this.runs * CROSSCUT_SHARE));
    if (fill) return fill;
    if (this.accepted < this.runs) {
      const crosscut = this.#crosscut();
      if (crosscut) return crosscut;
    }
    return this.#nextFill(this.runs);
  }

  /**
   * A fill run, while fewer than `limit` runs are kept. Gives up after too
   * many misses, so generation always ends.
   */
  #nextFill(limit) {
    while (this.accepted < limit && this.failures < this.runs + 8) {
      const gap = this.#farthestGap();
      if (gap < 0) return null;
      const run = this.#fill(gap);
      if (run) return run;
      this.#markTried(gap);
      this.failures++;
    }
    return null;
  }

  /**
   * Report what routing a planned run produced: its samples along the spline
   * ([{x, y, s}], s = meters along it), rating, and control points ([{x, y}],
   * top end first), or null samples if no route was found. Returns the width
   * for each control point if the run should be kept, otherwise null. Fill
   * runs that mostly repeat older runs are turned down, and so are crosscuts
   * that came out the wrong difficulty (a steep shot that isn't steep, a
   * bail-out that isn't easy).
   */
  tried(run, samples, rating, ctrl) {
    const crosscut = run.pass === 'shot' || run.pass === 'bail';
    if (!samples || samples.length < 2) {
      if (!crosscut) this.failures++;
      if (run.gap != null) this.#markTried(run.gap);
      return null;
    }
    if (run.pass === 'fill' && !this.#addsEnough(samples)) {
      this.failures++;
      this.#markTried(run.gap);
      return null;
    }
    if (run.pass === 'shot' && (rating < 2 || !this.#addsEnough(samples, 0))) return null;
    if (run.pass === 'bail' && rating > 1) return null;
    this.accepted++;
    const widths = this.#widthsAlong(run, ctrl);
    if (run.from.lift != null && run.to.lift != null) this.links.add(`${run.from.lift}>${run.to.lift}`);
    this.kept.push({
      rating, ctrl, widths,
      samples: samples.map((p) => {
        const c = this.#cellAt(p);
        return { ...p, c, z: c < 0 ? 0 : this.grid.z[c] };
      }).filter((p) => p.c >= 0),
    });
    for (const p of samples) {
      this.#stamp(this.covered, p, COVER_RADIUS);
      this.#stamp(this.near, p, NEAR_RADIUS);
    }
    return widths;
  }

  /**
   * A green or blue run from lift k's top, to the nearest lift bottom it can
   * reach outside the group of lifts k already connects with; failing that,
   * its own bottom or the nearest it can reach.
   */
  #required(k) {
    const top = this.lifts[k].top;
    const reach = this.plan.reachFrom(top).cells;
    const canReach = (j) => reach[this.lifts[j].bottom] === 1;
    const group = this.#groups();
    let to = this.#nearestLift((j) => group[j] !== group[k] && canReach(j), top, 'bottom');
    if (to < 0) to = canReach(k) ? k : this.#nearestLift(canReach, top, 'bottom');
    if (to < 0) return null;
    return this.#run(k, to, this.random.next() < 0.5 ? 0 : 1, 'required');
  }

  /** Can you get from every lift to every other? Asked by the worker once planning ends. */
  connected() {
    return new Set(this.#groups()).size <= 1;
  }

  /**
   * A run that brings the lifts closer to all connecting, or null once they
   * all are (or nothing left to try would help). Groups of lifts you can
   * already get around between are found first; a run is planned out of a
   * group with no way out, or into a group with no way in, between the
   * closest pair of lifts the terrain allows.
   */
  #connector() {
    const group = this.#groups();
    if (new Set(group).size <= 1) return null;
    const hasExit = new Set(), hasEntry = new Set();
    for (const link of this.links) {
      const [a, b] = link.split('>').map(Number);
      if (group[a] !== group[b]) { hasExit.add(group[a]); hasEntry.add(group[b]); }
    }
    let best = null;
    for (let a = 0; a < this.lifts.length; a++) {
      for (let b = 0; b < this.lifts.length; b++) {
        if (group[a] === group[b] || this.connectTried.has(`${a}>${b}`)) continue;
        if (hasExit.has(group[a]) && hasEntry.has(group[b])) continue; // wouldn't fix a dead end
        if (!this.plan.reachFrom(this.lifts[a].top).cells[this.lifts[b].bottom]) continue;
        const p = this.plan.xy(this.lifts[a].top), q = this.plan.xy(this.lifts[b].bottom);
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    if (!best) return null;
    this.connectTried.add(`${best.a}>${best.b}`);
    // Aim for what the ground halfway between suits.
    const p = this.plan.xy(this.lifts[best.a].top), q = this.plan.xy(this.lifts[best.b].bottom);
    const middle = this.#cellAt({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    return this.#run(best.a, best.b, this.#targetFor(middle), 'connect');
  }

  /**
   * For each lift, a group id shared by every lift it can get to and back
   * from (ride a lift up, ski a run down to another lift's bottom, repeat).
   */
  #groups() {
    const n = this.lifts.length;
    const next = Array.from({ length: n }, () => []);
    for (const link of this.links) {
      const [a, b] = link.split('>').map(Number);
      next[a].push(b);
    }
    // reach[a][b]: lift b can be reached from lift a.
    const reach = Array.from({ length: n }, (_, a) => {
      const seen = new Uint8Array(n);
      const stack = [a];
      seen[a] = 1;
      while (stack.length) {
        for (const b of next[stack.pop()]) if (!seen[b]) { seen[b] = 1; stack.push(b); }
      }
      return seen;
    });
    return Array.from({ length: n }, (_, a) => {
      for (let b = 0; b < n; b++) if (reach[a][b] && reach[b][a]) return b;
      return a;
    });
  }

  /**
   * A run meant to pass near gap cell `gap`: from a top that can reach it to
   * the nearest bottom it drains to, at a difficulty that suits its slope.
   */
  #fill(gap) {
    const tops = [], bottoms = [];
    for (let j = 0; j < this.lifts.length; j++) {
      if (this.plan.reachFrom(this.lifts[j].top).cells[gap]) tops.push(j);
      if (this.plan.drainsTo(this.lifts[j].bottom).cells[gap]) bottoms.push(j);
    }
    if (!tops.length || !bottoms.length) return null;
    const from = tops[Math.floor(this.random.next() * tops.length)];
    const to = this.#nearestLift((j) => bottoms.includes(j), gap, 'bottom');
    return { ...this.#run(from, to, this.#targetFor(gap), 'fill'), gap };
  }

  /** Assemble a planned run from lift `from`'s top to lift `to`'s bottom. */
  #run(from, to, target, pass) {
    return this.#runBetween({ lift: from, end: 'top' }, { lift: to, end: 'bottom' }, target, pass);
  }

  /**
   * Assemble a planned run between any two ends, with a base width that suits
   * what it is: chutes and cat tracks narrow, other runs anywhere in the range
   * for their difficulty, so some come out wide boulevards and some tight trails.
   */
  #runBetween(from, to, target, pass) {
    const [lo, hi] = pass === 'shot' ? SHOT_WIDTHS : pass === 'bail' ? TRACK_WIDTHS : RUN_WIDTHS[target];
    const width = Math.round(lo + (hi - lo) * this.random.next());
    return { from, to, target, width, pass };
  }

  /**
   * Width at each control point of a kept run (top end first): its base width,
   * narrower where it traverses the slope or drops steeper than black, wider
   * toward the bottom of a main run, with a slow random wobble; eased between
   * neighbors. An end that joins another run meets that run's width halfway.
   */
  #widthsAlong(run, ctrl) {
    const n = ctrl.length;
    const z = ctrl.map((p) => this.grid.z[Math.max(0, this.#cellAt(p))]);
    const main = run.pass !== 'shot' && run.pass !== 'bail';
    const knots = Array.from({ length: Math.ceil(n / WOBBLE_STEP) + 2 }, () => 1 + (this.random.next() * 2 - 1) * WOBBLE);
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    let widths = ctrl.map((p, i) => {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const along = Math.hypot(ctrl[b].x - ctrl[a].x, ctrl[b].y - ctrl[a].y) || 1;
      const pitch = Math.abs(z[a] - z[b]) / along;
      const c = this.#cellAt(p);
      const ground = c < 0 ? pitch : this.grid.slope[c];
      const side = Math.sqrt(Math.max(0, ground * ground - pitch * pitch));
      let f = 1 - TRAVERSE_NARROWING * clamp01((side - 0.2) / 0.4);
      if (pitch > this.thresholds[2]) f *= STEEP_NARROWING;
      if (main && n > 1) f *= 1 + BOTTOM_WIDENING * clamp01((i / (n - 1) - 0.7) / 0.3);
      const k = i / WOBBLE_STEP, k0 = Math.floor(k), u = k - k0, e = u * u * (3 - 2 * u);
      f *= knots[k0] * (1 - e) + knots[k0 + 1] * e;
      return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, run.width * f));
    });
    // Ease sudden jumps between neighboring points.
    for (let pass = 0; pass < 2; pass++) {
      widths = widths.map((w, i) => (i === 0 || i === n - 1 ? w : 0.25 * widths[i - 1] + 0.5 * w + 0.25 * widths[i + 1]));
    }
    // Ends joining another run meet its width halfway.
    for (const i of [0, n - 1]) {
      const host = this.#hostWidth(run, ctrl[i]);
      if (host != null) widths[i] = (widths[i] + host) / 2;
    }
    return widths.map(Math.round);
  }

  /**
   * Width of the kept run that an end of `run` at position `p` joins (the
   * width at its nearest control point), or null if that end isn't on a run.
   */
  #hostWidth(run, p) {
    const at = (end) => (end.lift != null ? this.plan.xy(this.lifts[end.lift][end.end]) : end);
    const ends = [run.from, run.to];
    const end = ends.reduce((best, e) => (Math.hypot(at(e).x - p.x, at(e).y - p.y) < Math.hypot(at(best).x - p.x, at(best).y - p.y) ? e : best));
    if (end.run == null) return null;
    const host = this.kept[end.run];
    let best = 0, bestD = Infinity;
    host.ctrl.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return host.widths[best];
  }

  /**
   * Difficulty to aim for through cell `c`: the band of its slope, one easier
   * or one harder about half the time for variety. Used for fill runs and connectors.
   */
  #targetFor(c) {
    const slope = this.grid.slope[c];
    let band = this.thresholds.filter((t) => slope >= t).length;
    const r = this.random.next();
    if (r < 0.25) band--;
    else if (r > 0.75) band++;
    return Math.max(0, Math.min(3, band));
  }

  /**
   * The served cell farthest from any run (one of the farthest, at random),
   * or -1 when everything served is within MIN_GAP of a run.
   */
  #farthestGap() {
    const { cell } = this.grid;
    const dist = this.#distanceToRuns();
    let best = 0;
    for (let c = 0; c < dist.length; c++) {
      if (this.plan.served[c] && !this.failedGaps[c] && dist[c] > best) best = dist[c];
    }
    if (best * cell < MIN_GAP) return -1;
    const options = [];
    for (let c = 0; c < dist.length; c++) {
      if (this.plan.served[c] && !this.failedGaps[c] && dist[c] >= best * GAP_SPREAD) options.push(c);
    }
    return options.length ? this.random.weighted(options, (c) => dist[c]) : -1;
  }

  /**
   * Distance in cells from every cell to the nearest covered one, counting a
   * diagonal step as one (close enough for finding gaps). With no runs yet,
   * everything is far.
   */
  #distanceToRuns() {
    const { cols, rows } = this.grid;
    const dist = new Float32Array(cols * rows).fill(Infinity);
    const queue = new Int32Array(cols * rows);
    let head = 0, tail = 0;
    for (let c = 0; c < dist.length; c++) {
      if (this.covered[c]) { dist[c] = 0; queue[tail++] = c; }
    }
    if (!tail) return dist.fill(1e6);
    while (head < tail) {
      const c = queue[head++];
      const i = c % cols, j = (c - i) / cols;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const n = nj * cols + ni;
          if (dist[n] !== Infinity) continue;
          dist[n] = dist[c] + 1;
          queue[tail++] = n;
        }
      }
    }
    return dist;
  }

  /**
   * Does a run cover at least `minNew` of new ground without retracing older
   * runs? Used for fill runs and (only the retracing part) steep shots.
   */
  #addsEnough(samples, minNew = MIN_NEW) {
    const total = samples[samples.length - 1].s;
    let counted = 0, overlapping = 0, fresh = 0;
    for (const p of samples) {
      if (p.s < END_SKIP || p.s > total - END_SKIP) continue;
      const c = this.#cellAt(p);
      if (c < 0) continue;
      counted++;
      if (this.near[c]) overlapping++;
      if (!this.covered[c]) fresh++;
    }
    // Nothing left between the ends: a fill run that short adds nothing, a steep shot can be that short.
    if (!counted) return minNew <= 0;
    return overlapping / counted <= MAX_OVERLAP && fresh / counted >= minNew;
  }

  /**
   * The lift (index) whose top or bottom is closest to cell `c`, among those
   * that pass `ok`. -1 if none do.
   */
  #nearestLift(ok, c, end) {
    const p = this.plan.xy(c);
    let best = -1, bestD = Infinity;
    for (let j = 0; j < this.lifts.length; j++) {
      if (!ok(j)) continue;
      const q = this.plan.xy(this.lifts[j][end]);
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bestD) { bestD = d; best = j; }
    }
    return best;
  }

  /** Grid cell under a local position, or -1 off the grid. */
  #cellAt({ x, y }) {
    const { cols, rows, cell, originX, originY } = this.grid;
    const i = Math.floor((x - originX) / cell), j = Math.floor((y - originY) / cell);
    return i < 0 || j < 0 || i >= cols || j >= rows ? -1 : j * cols + i;
  }

  /** Set every cell within `radius` meters of a position. */
  #stamp(field, p, radius) {
    const { cols, rows, cell } = this.grid;
    const c = this.#cellAt(p);
    if (c < 0) return;
    const ci = c % cols, cj = (c - ci) / cols;
    const r = Math.ceil(radius / cell);
    for (let j = Math.max(0, cj - r); j <= Math.min(rows - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(cols - 1, ci + r); i++) {
        if ((i - ci) ** 2 + (j - cj) ** 2 <= r * r) field[j * cols + i] = 1;
      }
    }
  }

  /** The next crosscut, alternating steep shots and bail-outs; null when neither has a spot left. */
  #crosscut() {
    const order = this.shotTurn ? [() => this.#steepShot(), () => this.#bailOut()] : [() => this.#bailOut(), () => this.#steepShot()];
    this.shotTurn = !this.shotTurn;
    for (const plan of order) {
      const run = plan();
      if (run) return run;
    }
    return null;
  }

  /**
   * A double-black shot through the next unused steep patch: from the nearest
   * end above it (a spot on a run, or a lift top) that can ski through the
   * patch, to the nearest end below it on a different run (or a lift bottom)
   * that it can reach.
   */
  #steepShot() {
    while (this.nextPatch < this.patches.length) {
      const patch = this.patches[this.nextPatch++];
      if (patch.used) continue;
      const { uppers, lowers } = this.#endsAround(patch);
      for (const upper of uppers.slice(0, 4)) {
        const reach = skiDownFrom(this.grid, [upper.c]);
        if (!patch.cells.some((c) => reach[c])) continue;
        const lower = lowers.find((l) => (l.run == null || l.run !== upper.run) && reach[l.c]);
        if (!lower) continue;
        for (const other of this.patches) {
          if (Math.hypot(other.x - patch.x, other.y - patch.y) < SHOT_SPACING) other.used = true;
        }
        return this.#runBetween(upper.ref, lower.ref, 3, 'shot');
      }
    }
    return null;
  }

  /**
   * Ends above and below a patch within SHOT_REACH, nearest first: on kept runs
   * (each run's closest qualifying spot) and at lift tops (above) and bottoms (below).
   */
  #endsAround(patch) {
    const uppers = [], lowers = [];
    const dist = (p) => Math.hypot(p.x - patch.x, p.y - patch.y);
    this.kept.forEach((r, k) => {
      let up = null, down = null;
      for (const p of r.samples) {
        const d = dist(p);
        if (d > SHOT_REACH) continue;
        if (p.z >= patch.zTop + SHOT_DROP && (!up || d < up.d)) up = { d, c: p.c, run: k, ref: { run: k, x: p.x, y: p.y } };
        if (p.z <= patch.zBottom - SHOT_DROP && (!down || d < down.d)) down = { d, c: p.c, run: k, ref: { run: k, x: p.x, y: p.y } };
      }
      if (up) uppers.push(up);
      if (down) lowers.push(down);
    });
    this.lifts.forEach((l, k) => {
      const top = this.plan.xy(l.top), bottom = this.plan.xy(l.bottom);
      if (this.grid.z[l.top] >= patch.zTop + SHOT_DROP && dist(top) <= SHOT_REACH) {
        uppers.push({ d: dist(top), c: l.top, ref: { lift: k, end: 'top' } });
      }
      if (this.grid.z[l.bottom] <= patch.zBottom - SHOT_DROP && dist(bottom) <= SHOT_REACH) {
        lowers.push({ d: dist(bottom), c: l.bottom, ref: { lift: k, end: 'bottom' } });
      }
    });
    uppers.sort((a, b) => a.d - b.d);
    lowers.sort((a, b) => a.d - b.d);
    return { uppers, lowers };
  }

  /**
   * An easier way off the next black run that doesn't have one: from a spot in
   * its upper part to the nearest spot below it on a green or blue run that
   * it can reach, aiming at that run's rating.
   */
  #bailOut() {
    for (let k = 0; k < this.kept.length; k++) {
      const black = this.kept[k];
      if (black.rating < 2 || this.bailed.has(k)) continue;
      this.bailed.add(k);
      const total = black.samples[black.samples.length - 1]?.s ?? 0;
      const upper = black.samples.filter((p) => p.s > END_SKIP && p.s < total * BAIL_START);
      const start = upper[Math.floor(upper.length / 2)];
      if (!start) continue;
      const reach = skiDownFrom(this.grid, [start.c]);
      let best = null;
      this.kept.forEach((r, q) => {
        if (q === k || r.rating > 1) return;
        for (const p of r.samples) {
          const d = Math.hypot(p.x - start.x, p.y - start.y);
          if (d > BAIL_REACH || p.z > start.z - BAIL_DROP || !reach[p.c]) continue;
          if (!best || d < best.d) best = { d, q, p };
        }
      });
      if (!best) continue;
      return this.#runBetween(
        { run: k, x: start.x, y: start.y },
        { run: best.q, x: best.p.x, y: best.p.y },
        this.kept[best.q].rating, 'bail');
    }
    return null;
  }

  /**
   * Connected patches of ground at least as steep as double black (away from
   * the edge), at least STEEP_MIN_CELLS, largest first. Each is
   * { cells, x, y (center), zTop, zBottom, used }.
   */
  #steepPatches() {
    const { cols, rows, cell, originX, originY, z, slope } = this.grid;
    const steep = (i, j) => isInside(this.grid, i, j) && slope[j * cols + i] >= this.thresholds[2];
    const done = new Uint8Array(cols * rows);
    const patches = [];
    for (let start = 0; start < cols * rows; start++) {
      const si = start % cols, sj = (start - si) / cols;
      if (done[start] || !steep(si, sj)) continue;
      done[start] = 1;
      const cells = [], stack = [start];
      while (stack.length) {
        const c = stack.pop();
        cells.push(c);
        const i = c % cols, j = (c - i) / cols;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di, nj = j + dj, n = nj * cols + ni;
            if (!steep(ni, nj) || done[n]) continue;
            done[n] = 1;
            stack.push(n);
          }
        }
      }
      if (cells.length < STEEP_MIN_CELLS) continue;
      let x = 0, y = 0, zTop = -Infinity, zBottom = Infinity;
      for (const c of cells) {
        x += c % cols; y += Math.floor(c / cols);
        zTop = Math.max(zTop, z[c]); zBottom = Math.min(zBottom, z[c]);
      }
      patches.push({
        cells, zTop, zBottom, used: false,
        x: originX + (x / cells.length + 0.5) * cell,
        y: originY + (y / cells.length + 0.5) * cell,
      });
    }
    return patches.sort((a, b) => b.cells.length - a.cells.length);
  }

  /** Skip the area around a gap that didn't produce a run. */
  #markTried(gap) {
    this.#stamp(this.failedGaps, this.plan.xy(gap), TRIED_RADIUS);
  }
}
