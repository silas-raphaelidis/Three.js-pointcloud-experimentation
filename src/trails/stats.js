import { rate } from '../difficulty.js';

/**
 * Trail measurements from sampled geometry and the height map. Used for the
 * readout now, and later to score and label generated trails.
 */

/** Rating for a slope, using the shared (editable) thresholds. */
export function difficulty(slope) {
  const r = rate(slope);
  return { name: r.name, color: r.text };
}

/**
 * @param {Array<{x:number,y:number,s:number}>} samples
 * @param {import('../terrain.js').Terrain} terrain
 * @param {number} window  distance over which "sustained" pitch is measured, m
 */
export function trailStats(samples, terrain, window = 30) {
  if (samples.length < 2) return null;
  const z = samples.map((p) => terrain.heightAt(p.x, p.y));

  let length = 0;
  for (let i = 1; i < samples.length; i++) {
    const ds = samples[i].s - samples[i - 1].s;
    length += Math.hypot(ds, z[i] - z[i - 1]);
  }
  const run = samples[samples.length - 1].s;
  const vertical = Math.abs(z[0] - z[z.length - 1]);

  // Steepest pitch held over `window` meters (ratings follow the steepest
  // sustained section, not a single steep step).
  let maxSustained = 0;
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    while (j < samples.length && samples[j].s - samples[i].s < window) j++;
    if (j >= samples.length) break;
    const slope = Math.abs(z[j] - z[i]) / (samples[j].s - samples[i].s);
    if (slope > maxSustained) maxSustained = slope;
  }
  if (run < window) maxSustained = run > 0 ? vertical / run : 0;

  return {
    length,
    vertical,
    averageSlope: run > 0 ? vertical / run : 0,
    maxSustained,
    rating: difficulty(maxSustained),
  };
}
