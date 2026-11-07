/**
 * Trail measurements from sampled geometry and the height map. Used for the
 * readout now, and later to score and label generated trails.
 */

/** North American trail rating from a slope (rise/run). Rough guide. */
export function difficulty(slope) {
  if (slope < 0.25) return { name: 'green', color: '#3ec46d' };
  if (slope < 0.4) return { name: 'blue', color: '#4c8dff' };
  if (slope < 0.6) return { name: 'black', color: '#e6e9ee' };
  return { name: 'double black', color: '#e6e9ee' };
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
