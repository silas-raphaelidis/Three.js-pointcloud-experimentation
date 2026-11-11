import { rate, RATINGS, CRUX_MIN_LENGTH } from '../difficulty.js';

/**
 * Trail measurements from sampled geometry and the height map: length,
 * vertical, pitch breakdown by difficulty, and the trail's overall rating.
 */

/**
 * Rating for a single slope as { name, color }, using the shared thresholds.
 * Used by updateCursor in main.js for the cursor readout.
 */
export function difficulty(slope) {
  const r = rate(slope);
  return { name: r.name, color: r.text, index: r.index };
}

/**
 * Measure a trail: length, vertical, pitch breakdown, and overall rating (its crux).
 * Returns null for fewer than 2 samples. Used by the trail panel, the trail line color,
 * and automatic naming.
 * @param {Array<{x:number,y:number,s:number}>} samples  sampled spline
 * @param {import('../terrain.js').Terrain} terrain
 * @param {number} window  distance the pitch is measured over along the trail, m
 */
export function trailStats(samples, terrain, window = 30) {
  if (samples.length < 2) return null;
  const n = samples.length;
  const z = samples.map((p) => terrain.heightAt(p.x, p.y));
  const s = samples.map((p) => p.s);

  let length = 0;
  for (let i = 1; i < n; i++) length += Math.hypot(s[i] - s[i - 1], z[i] - z[i - 1]);
  const run = s[n - 1];
  const vertical = Math.abs(z[0] - z[n - 1]);

  // Pitch at each sample: the drop along the trail over `window` meters
  // centered on it (shorter near the ends). This is the trail's own pitch,
  // so a traverse across a steep face rates easier than the fall line.
  // Measured on lightly smoothed ground, so a bump right under the centerline
  // (or nudging the line a few meters) doesn't change the rating.
  const groundZ = samples.map((p) => terrain.trailHeightAt(p.x, p.y));
  const half = window / 2;
  const pitch = new Float32Array(n);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (s[i] - s[lo] > half) lo++;
    while (hi < n - 1 && s[hi + 1] - s[i] <= half) hi++;
    const ds = s[hi] - s[lo];
    pitch[i] = ds > 0 ? Math.abs(groundZ[hi] - groundZ[lo]) / ds : 0;
  }

  // Band of each segment, and the share of the trail's length in each band
  // (for the breakdown bar).
  const shares = [0, 0, 0, 0];
  const segBand = new Uint8Array(n);
  let maxPitch = 0;
  for (let i = 1; i < n; i++) {
    const p = (pitch[i - 1] + pitch[i]) / 2;
    segBand[i] = rate(p).index;
    shares[segBand[i]] += s[i] - s[i - 1];
    if (p > maxPitch) maxPitch = p;
  }
  for (let b = 0; b < 4; b++) shares[b] = run > 0 ? shares[b] / run : 0;

  // Overall rating: the crux. The hardest band with a continuous stretch at
  // least CRUX_MIN_LENGTH long at that band or steeper (a trail shorter than
  // that only needs to be that steep along its whole length).
  const needed = Math.min(CRUX_MIN_LENGTH, run);
  let index = 0;
  let cruxLength = run;
  for (let b = 3; b >= 1; b--) {
    let stretch = 0, longest = 0;
    for (let i = 1; i < n; i++) {
      stretch = segBand[i] >= b ? stretch + (s[i] - s[i - 1]) : 0;
      if (stretch > longest) longest = stretch;
    }
    if (longest >= needed - 1e-6) { index = b; cruxLength = longest; break; }
  }
  const r = RATINGS[index];

  return {
    length,
    vertical,
    averageSlope: run > 0 ? vertical / run : 0,
    maxSustained: maxPitch,
    shares,
    // cruxLength: the longest continuous stretch at the rated level or steeper.
    rating: { index, name: r.name, color: r.text, mapColor: r.color, cruxLength },
  };
}

/** Meters a run must climb in one go to count as uphill: more than you'd coast over. */
export const UPHILL_MIN_RISE = 3;
/** A climb ends once the ground drops this far below its highest point, meters. */
const UPHILL_END_DROP = 1;

/**
 * Stretches where a run climbs, going the way it's skied: from its higher
 * end down to its lower end. A stretch starts at the lowest point before the
 * climb and ends at the top of it, and only counts if it rises at least
 * UPHILL_MIN_RISE. Heights are the lightly smoothed trail ground, as for
 * the rating. Returns [{ from, to, rise, length }], with from < to as
 * indexes into `samples`. Used by the trail panel (through the editor) and
 * the uphill highlight on the map (TrailView).
 * @param {Array<{x:number,y:number,s:number}>} samples  sampled spline
 * @param {import('../terrain.js').Terrain} terrain
 */
export function uphillStretches(samples, terrain) {
  const n = samples.length;
  if (n < 2) return [];
  const height = samples.map((p) => terrain.trailHeightAt(p.x, p.y));
  // Indexes in skiing order, from the higher end.
  const order = [...Array(n).keys()];
  if (height[0] < height[n - 1]) order.reverse();
  const z = (k) => height[order[k]];

  const found = [];
  // Close a climb from step `a` (its low point) to step `b` (its top).
  const add = (a, b) => {
    const i = order[a], j = order[b];
    found.push({
      from: Math.min(i, j), to: Math.max(i, j),
      rise: z(b) - z(a), length: Math.abs(samples[j].s - samples[i].s),
    });
  };
  let low = 0;      // lowest point since the last climb
  let top = -1;     // highest point of the climb in progress, or -1
  for (let k = 1; k < n; k++) {
    if (top < 0) {
      if (z(k) < z(low)) low = k;
      else if (z(k) - z(low) >= UPHILL_MIN_RISE) top = k;
    } else if (z(k) > z(top)) {
      top = k;
    } else if (z(top) - z(k) >= UPHILL_END_DROP) {
      add(low, top);
      low = k;
      top = -1;
    }
  }
  if (top >= 0) add(low, top);
  return found;
}
