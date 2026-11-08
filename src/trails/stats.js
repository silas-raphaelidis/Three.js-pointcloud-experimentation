import { rate, RATINGS, CRUX_MIN_LENGTH } from '../difficulty.js';

/**
 * Trail measurements from sampled geometry and the height map: length,
 * vertical, pitch breakdown by difficulty, and the trail's overall rating.
 */

/** Rating for a single slope (cursor readout), using the shared thresholds. */
export function difficulty(slope) {
  const r = rate(slope);
  return { name: r.name, color: r.text };
}

/**
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
