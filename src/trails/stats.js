import { rate, RATINGS, SIGNIFICANT_SHARE } from '../difficulty.js';

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
  const half = window / 2;
  const pitch = new Float32Array(n);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (s[i] - s[lo] > half) lo++;
    while (hi < n - 1 && s[hi + 1] - s[i] <= half) hi++;
    const ds = s[hi] - s[lo];
    pitch[i] = ds > 0 ? Math.abs(z[hi] - z[lo]) / ds : 0;
  }

  // Share of the trail's length in each difficulty band.
  const shares = [0, 0, 0, 0];
  let maxPitch = 0;
  for (let i = 1; i < n; i++) {
    const p = (pitch[i - 1] + pitch[i]) / 2;
    shares[rate(p).index] += s[i] - s[i - 1];
    if (p > maxPitch) maxPitch = p;
  }
  for (let b = 0; b < 4; b++) shares[b] = run > 0 ? shares[b] / run : 0;

  // Overall rating: the hardest band where that band plus anything steeper
  // covers at least SIGNIFICANT_SHARE of the trail.
  let index = 0;
  let atLeast = 0;
  for (let b = 3; b >= 0; b--) {
    atLeast += shares[b];
    if (atLeast >= SIGNIFICANT_SHARE) { index = b; break; }
  }
  const r = RATINGS[index];

  return {
    length,
    vertical,
    averageSlope: run > 0 ? vertical / run : 0,
    maxSustained: maxPitch,
    shares,
    rating: { index, name: r.name, color: r.text, mapColor: r.color },
  };
}
