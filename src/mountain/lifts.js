/**
 * Lift placement for mountain generation. Plain data and math, run in the
 * mountain worker.
 *
 * Lifts are added one at a time. Each new lift is the one that opens up the
 * most new terrain: ground you can ski to from some lift's top that also
 * drains back to some lift's bottom ("served" terrain). The first lift starts
 * at a base. Every lift after it must connect both ways: you can ski to its
 * bottom from an existing lift, and from its top to an existing lift's bottom,
 * so every lift can always reach every other. Lifts starting at a base are
 * preferred, so several fan out from a base to different peaks as at real
 * resorts (lifts from different bases may share a peak).
 * Randomness picks among the good options rather than always the best, so
 * every seed gives a different but sensible layout.
 */
import { skiDownFrom, skiDownTo, isInside } from './analysis.js';

const STATION_SLOPE = 0.2;    // steepest ground a lift terminal can sit on
const LATTICE = 4;            // candidate terminals every this many cells
const HIGH_TOPS = 30;         // highest candidate tops, always considered
const RANDOM_TOPS = 220;      // plus this many other tops, chosen at random
const LOW_BOTTOMS = 15;       // lowest reachable bottoms considered each round
const RANDOM_BOTTOMS = 25;    // plus this many other bottoms, chosen at random
const BASE_BOTTOMS = 15;      // plus this many spots in the bases
const BASE_RADIUS = 150;      // meters around a base's first lift that count as the base
const BASE_PREFERENCE = 1.5;  // a lift from a base counts as opening this much more terrain
const MIN_RISE = 80;          // meters a lift must climb
const MIN_LENGTH = 250;       // horizontal meters
const MAX_LENGTH = 2000;
const MIN_LINE_PITCH = 0.18;  // gentlest average climb (rise/run): lifts go up, not along ridges
const MAX_LINE_PITCH = 0.7;   // steepest average climb of a lift line
const TOWER_CLEARANCE = 15;   // how far ground may rise above the straight line (towers)
const MIN_TERMINAL_GAP = 40;  // meters between terminals of different lifts
const MIN_TOP_GAP = 250;      // meters between tops of lifts from the same base, so they reach different peaks
const MIN_BASE_SPACING = 800; // meters between bases
const BASE_CHOICES = 5;       // a base is chosen among this many of the best
const MIN_GAIN = 30000;       // m² of new terrain a lift must open up (3 ha)
const CHOICE_SPREAD = 0.7;    // choose among options at least this good relative to the best

/**
 * Choose bases and place lifts.
 * Returns { bases: [{x, y}], lifts: [{ bottom: {x, y}, top: {x, y}, rise, length, gain }],
 * served (m²), plan }. `plan` stays in the worker for planning runs (it can't be posted).
 * Fewer bases or lifts than asked for come back when the terrain can't fit them.
 *
 * @param {object} grid  height grid with slope (see analyzeTerrain)
 * @param {ReturnType<import('./analysis.js').analyzeTerrain>} analysis
 * @param {{ bases:number, lifts:number, random:ReturnType<import('./random.js').createRandom> }} opts
 */
export function placeLifts(grid, analysis, { bases: baseCount, lifts: liftCount, random }) {
  const plan = new LiftPlan(grid, random);
  const wanted = Math.min(baseCount, liftCount);
  const bases = [];
  // Bases that couldn't connect yet; they get another chance after the next lift.
  let skipped = new Set();
  while (plan.lifts.length < liftCount) {
    const basesLeft = wanted - bases.length;
    const base = basesLeft > 0 ? tryBase(plan, analysis.bases, bases, skipped, random) : null;
    if (base) { bases.push(base); continue; }
    // Keep enough lifts for the bases still to come.
    if (liftCount - plan.lifts.length <= basesLeft || !plan.addLift()) break;
    skipped = new Set();
  }
  return {
    bases: bases.map((b) => ({ x: b.x, y: b.y })),
    lifts: plan.lifts.map((l) => {
      const bottom = plan.xy(l.bottom), top = plan.xy(l.top);
      return {
        bottom, top, gain: l.gain,
        rise: grid.z[l.top] - grid.z[l.bottom],
        length: Math.hypot(top.x - bottom.x, top.y - bottom.y),
      };
    }),
    served: plan.servedArea(),
    plan,
  };
}

/**
 * Give a new base its first lift: chosen at random among the best candidates
 * far enough from the bases already placed. A candidate whose lift can't open
 * enough terrain or connect to the others is added to `skipped`. Returns the
 * base, or null if none works right now. Used by placeLifts.
 */
function tryBase(plan, candidates, placed, skipped, random) {
  for (;;) {
    const eligible = candidates
      .filter((c) => !skipped.has(c) && placed.every((b) => Math.hypot(b.x - c.x, b.y - c.y) >= MIN_BASE_SPACING))
      .slice(0, BASE_CHOICES);
    if (!eligible.length) return null;
    const base = random.weighted(eligible, (b) => b.served);
    if (plan.addBaseLift(base, placed.length)) return base;
    skipped.add(base);
  }
}

/**
 * The lifts placed so far and what they serve, plus caches of the flood
 * fills from each candidate terminal. Built by placeLifts, then used by the
 * run planner (runs.js) for the same reachability questions.
 */
export class LiftPlan {
  constructor(grid, random) {
    this.grid = grid;
    this.random = random;
    const n = grid.cols * grid.rows;
    this.reachAll = new Uint8Array(n); // can ski to from some lift's top
    this.drains = new Uint8Array(n);   // can ski down to some lift's bottom
    this.served = new Uint8Array(n);   // both
    this.lifts = [];                   // { bottom, top, gain, base } as cell indexes; base -1 if none
    this.baseCells = new Map();        // terminal spot in a base -> that base's index
    this.reachCache = new Map();       // top cell -> { cells, box }
    this.catchCache = new Map();       // bottom cell -> { cells, box }
    this.stations = this.#stationCells();
    this.tops = this.#candidateTops();
  }

  /** Local position of a cell's center. */
  xy(c) {
    const { cols, cell, originX, originY } = this.grid;
    const i = c % cols, j = (c - i) / cols;
    return { x: originX + (i + 0.5) * cell, y: originY + (j + 0.5) * cell };
  }

  /** Served terrain in m². */
  servedArea() {
    let n = 0;
    for (const v of this.served) n += v;
    return n * this.grid.cell * this.grid.cell;
  }

  /**
   * Add the first lift from a base (number `index`), starting at the base's
   * middle. Like every lift after the first, it must connect both ways to
   * the lifts already placed. Returns false if nothing fits.
   */
  addBaseLift(base, index) {
    const bottom = this.#nearestCell(base.cells, base.x, base.y);
    const options = this.tops
      .filter((top) => this.#valid(bottom, top, index) && this.#connects(bottom, top))
      .map((top) => ({ bottom, top, base: index, ...this.#gain(bottom, top) }));
    if (!this.#choose(options)) return false;
    // Anywhere gentle near the first lift is part of the base, for later lifts to start from.
    const at = this.xy(bottom);
    for (const c of [...base.cells, ...this.#allStations()]) {
      const p = this.xy(c);
      if (!this.baseCells.has(c) && Math.hypot(p.x - at.x, p.y - at.y) <= BASE_RADIUS) this.baseCells.set(c, index);
    }
    return true;
  }

  /**
   * Add the lift that opens up the most new terrain (roughly), preferring
   * lifts from a base. Returns false if none is worth adding.
   */
  addLift() {
    const options = [];
    for (const bottom of this.#candidateBottoms()) {
      const base = this.baseCells.get(bottom) ?? -1;
      const preference = base >= 0 ? BASE_PREFERENCE : 1;
      for (const top of this.tops) {
        if (!this.#valid(bottom, top, base) || !this.#connects(bottom, top)) continue;
        const option = { bottom, top, base, ...this.#gain(bottom, top) };
        options.push({ ...option, score: option.gain * preference });
      }
    }
    return this.#choose(options);
  }

  /**
   * Pick one of the best options worth building at random, weighted by score
   * (gain, unless a preference applies), and add it. Used by both add methods.
   */
  #choose(options) {
    const worthwhile = options.filter((o) => o.gain >= MIN_GAIN);
    const score = (o) => o.score ?? o.gain;
    const best = worthwhile.reduce((m, o) => Math.max(m, score(o)), 0);
    if (!best) return false;
    const pick = this.random.weighted(worthwhile.filter((o) => score(o) >= best * CHOICE_SPREAD), score);
    this.#commit(pick);
    return true;
  }

  /**
   * Would a lift from `bottom` to `top` join the network both ways? You can ski
   * to its bottom from some lift's top, and from its top to some lift's bottom.
   * Always true for the first lift.
   */
  #connects(bottom, top) {
    if (!this.lifts.length) return true;
    const reach = this.reachFrom(top).cells;
    return this.reachAll[bottom] === 1 && this.lifts.some((l) => reach[l.bottom]);
  }

  /** Record a lift and update what the network serves. */
  #commit({ bottom, top, gain, base }) {
    const reach = this.reachFrom(top).cells, drain = this.drainsTo(bottom).cells;
    for (let c = 0; c < this.served.length; c++) {
      this.reachAll[c] |= reach[c];
      this.drains[c] |= drain[c];
      this.served[c] = this.reachAll[c] & this.drains[c];
    }
    this.lifts.push({ bottom, top, gain, base });
  }

  /**
   * Roughly how much new terrain (m²) a lift from `bottom` to `top` would serve,
   * sampling every other cell.
   */
  #gain(bottom, top) {
    const { cols, cell } = this.grid;
    const reach = this.reachFrom(top), drain = this.drainsTo(bottom);
    // New served cells lie inside the new reach or the new catchment.
    const i0 = Math.min(reach.box.i0, drain.box.i0), i1 = Math.max(reach.box.i1, drain.box.i1);
    const j0 = Math.min(reach.box.j0, drain.box.j0), j1 = Math.max(reach.box.j1, drain.box.j1);
    let count = 0;
    for (let j = j0; j <= j1; j += 2) {
      for (let i = i0; i <= i1; i += 2) {
        const c = j * cols + i;
        const fromNewTop = reach.cells[c] === 1;
        if (!fromNewTop && !this.reachAll[c]) continue;
        if (!this.served[c] && (this.drains[c] || drain.cells[c])) count++;
      }
    }
    return { gain: count * 4 * cell * cell };
  }

  /**
   * Can a lift run from `bottom` up to `top`? Length, steepness, ground
   * clearance and other lifts. `base` is the base it starts from, or -1.
   */
  #valid(bottom, top, base) {
    const { z } = this.grid;
    const rise = z[top] - z[bottom];
    if (rise < MIN_RISE) return false;
    const b = this.xy(bottom), t = this.xy(top);
    const length = Math.hypot(t.x - b.x, t.y - b.y);
    if (length < MIN_LENGTH || length > MAX_LENGTH) return false;
    if (rise / length < MIN_LINE_PITCH || rise / length > MAX_LINE_PITCH) return false;

    for (const lift of this.lifts) {
      const lb = this.xy(lift.bottom), lt = this.xy(lift.top);
      for (const p of [lb, lt]) {
        for (const q of [b, t]) if (Math.hypot(p.x - q.x, p.y - q.y) < MIN_TERMINAL_GAP) return false;
      }
      if (base >= 0 && lift.base === base && Math.hypot(lt.x - t.x, lt.y - t.y) < MIN_TOP_GAP) return false;
      if (segmentsCross(b, t, lb, lt)) return false;
    }

    // Towers can lift the cable over bumps, but not over a ridge.
    const steps = Math.ceil(length / (this.grid.cell / 2));
    for (let s = 1; s < steps; s++) {
      const f = s / steps;
      const ground = heightAt(this.grid, b.x + (t.x - b.x) * f, b.y + (t.y - b.y) * f);
      if (ground - (z[bottom] + rise * f) > TOWER_CLEARANCE) return false;
    }
    return true;
  }

  /** Every cell you can ski to from `top`, as { cells, box }, cached. */
  reachFrom(top) {
    let r = this.reachCache.get(top);
    if (!r) this.reachCache.set(top, (r = withBox(this.grid, skiDownFrom(this.grid, [top]))));
    return r;
  }

  /** Every cell that can ski down to `bottom`, as { cells, box }, cached. */
  drainsTo(bottom) {
    let r = this.catchCache.get(bottom);
    if (!r) this.catchCache.set(bottom, (r = withBox(this.grid, skiDownTo(this.grid, [bottom]))));
    return r;
  }

  /** Every cell (not just the lattice) away from the edge on ground gentle enough for a terminal. */
  #allStations() {
    const { cols, rows, slope } = this.grid;
    this.allStationCells ??= Array.from({ length: cols * rows }, (_, c) => c)
      .filter((c) => slope[c] < STATION_SLOPE && isInside(this.grid, c % cols, Math.floor(c / cols)));
    return this.allStationCells;
  }

  /** Lattice cells away from the edge on ground gentle enough for a terminal. */
  #stationCells() {
    const { cols, rows, slope } = this.grid;
    const out = [];
    for (let j = 0; j < rows; j += LATTICE) {
      for (let i = 0; i < cols; i += LATTICE) {
        const c = j * cols + i;
        if (isInside(this.grid, i, j) && slope[c] < STATION_SLOPE) out.push(c);
      }
    }
    return out;
  }

  /** The highest stations, plus a random sample of the rest. Chosen once per generation. */
  #candidateTops() {
    const byHeight = [...this.stations].sort((a, b) => this.grid.z[b] - this.grid.z[a]);
    const rest = this.random.shuffle(byHeight.slice(HIGH_TOPS));
    return [...byHeight.slice(0, HIGH_TOPS), ...rest.slice(0, RANDOM_TOPS)];
  }

  /**
   * The lowest stations you can already ski to, a random sample of the others,
   * and spots in the bases. Chosen each round.
   */
  #candidateBottoms() {
    const reachable = this.stations.filter((c) => this.reachAll[c]).sort((a, b) => this.grid.z[a] - this.grid.z[b]);
    const rest = this.random.shuffle(reachable.slice(LOW_BOTTOMS));
    const atBases = this.random.shuffle([...this.baseCells.keys()]).slice(0, BASE_BOTTOMS);
    return [...new Set([...reachable.slice(0, LOW_BOTTOMS), ...rest.slice(0, RANDOM_BOTTOMS), ...atBases])];
  }

  /** The cell among `cells` closest to x, y. Used to put a base's lift in the base's middle. */
  #nearestCell(cells, x, y) {
    let best = cells[0], bestD = Infinity;
    for (const c of cells) {
      const p = this.xy(c);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }
}

/** Attach the bounding box of a flood fill's cells, so gain checks can skip the rest of the grid. */
function withBox({ cols, rows }, cells) {
  let i0 = cols, i1 = -1, j0 = rows, j1 = -1;
  for (let c = 0; c < cells.length; c++) {
    if (!cells[c]) continue;
    const i = c % cols, j = (c - i) / cols;
    if (i < i0) i0 = i;
    if (i > i1) i1 = i;
    if (j < j0) j0 = j;
    if (j > j1) j1 = j;
  }
  return { cells, box: { i0, i1, j0, j1 } };
}

/** Bilinear ground height on the grid at local x, y. Used for lift clearance. */
function heightAt({ cols, rows, cell, originX, originY, z }, x, y) {
  const gx = Math.min(cols - 1, Math.max(0, (x - originX) / cell - 0.5));
  const gy = Math.min(rows - 1, Math.max(0, (y - originY) / cell - 0.5));
  const i = Math.min(cols - 2, Math.floor(gx)), j = Math.min(rows - 2, Math.floor(gy));
  const fx = gx - i, fy = gy - j;
  const at = (a, b) => z[b * cols + a];
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
}

/** Do segments a1-a2 and b1-b2 cross? Used so lifts never cross each other. */
function segmentsCross(a1, a2, b1, b2) {
  const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return side(a1, a2, b1) !== side(a1, a2, b2) && side(b1, b2, a1) !== side(b1, b2, a2);
}
