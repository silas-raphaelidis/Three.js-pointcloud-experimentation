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
 *   3. fill: aimed at the served terrain farthest from any run, until the
 *      requested number of runs is reached or the mountain is covered.
 * The first two always run, even past the requested count.
 *
 * A planned run is { from: {lift, end:'top'}, to: {lift, end:'bottom'},
 * target (rating index), width (m), pass, gap? }.
 */

const COVER_RADIUS = 80;  // meters around a run that count as covered by it
const NEAR_RADIUS = 20;   // a new run this close to an old one overlaps it
const MAX_OVERLAP = 0.5;  // share of a fill run allowed to overlap older runs
const MIN_NEW = 0.25;     // share of a fill run that must cover new ground
const END_SKIP = 60;      // meters at each end not counted (runs meet at lifts)
const MIN_GAP = 150;      // stop filling when nothing served is farther than this from a run
const GAP_SPREAD = 0.8;   // pick a gap among cells at least this far relative to the farthest
const TRIED_RADIUS = 150; // meters around a gap that failed, skipped from then on
const WIDTHS = [40, 36, 32, 28]; // typical run width by rating, meters
const WIDTH_JITTER = 6;

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
  }

  /** The next run to try, or null when the mountain is done. */
  next() {
    while (this.nextRequired < this.lifts.length) {
      const run = this.#required(this.nextRequired++);
      if (run) return run;
    }
    const link = this.#connector();
    if (link) return link;
    // Give up on filling after too many misses, so generation always ends.
    while (this.accepted < this.runs && this.failures < this.runs + 8) {
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
   * ([{x, y, s}], s = meters along it) or null if no route was found.
   * Returns true if the run should be kept. Fill runs that mostly repeat
   * older runs are turned down.
   */
  tried(run, samples) {
    if (!samples || samples.length < 2) {
      this.failures++;
      if (run.gap != null) this.#markTried(run.gap);
      return false;
    }
    if (run.pass === 'fill' && !this.#addsEnough(samples)) {
      this.failures++;
      this.#markTried(run.gap);
      return false;
    }
    this.accepted++;
    this.links.add(`${run.from.lift}>${run.to.lift}`);
    for (const p of samples) {
      this.#stamp(this.covered, p, COVER_RADIUS);
      this.#stamp(this.near, p, NEAR_RADIUS);
    }
    return true;
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

  /** Assemble a planned run, with a width that suits its difficulty. */
  #run(from, to, target, pass) {
    const width = WIDTHS[target] + Math.round((this.random.next() * 2 - 1) * WIDTH_JITTER);
    return { from: { lift: from, end: 'top' }, to: { lift: to, end: 'bottom' }, target, width, pass };
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

  /** Does a fill run cover enough new ground without retracing older runs? */
  #addsEnough(samples) {
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
    if (!counted) return false;
    return overlapping / counted <= MAX_OVERLAP && fresh / counted >= MIN_NEW;
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

  /** Skip the area around a gap that didn't produce a run. */
  #markTried(gap) {
    this.#stamp(this.failedGaps, this.plan.xy(gap), TRIED_RADIUS);
  }
}
