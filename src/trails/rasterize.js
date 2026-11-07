/**
 * Draws the trail network into the TrailMask. Given the world-space box that
 * changed, it rebuilds just that region by re-stamping every trail that
 * overlaps it, so crossings and junctions stay correct.
 */
export class TrailRasterizer {
  /**
   * @param {import('./spline.js').TrailGeometry} geometry
   * @param {import('./mask.js').TrailMask} mask
   */
  constructor(geometry, mask) {
    this.geometry = geometry;
    this.mask = mask;
  }

  rebuild(box, now) {
    if (!box) return;
    const clip = this.mask.cellsForBox(box);
    if (!clip) return;
    const feather = this.geometry.feather;

    this.mask.rebuildRegion(clip, now, (c) => {
      for (const [, { samples, box: tb }] of this.geometry.entries()) {
        if (!tb || tb.maxX < box.minX || tb.minX > box.maxX || tb.maxY < box.minY || tb.minY > box.maxY) continue;
        for (let i = 0; i + 1 < samples.length; i++) {
          const a = samples[i], b = samples[i + 1];
          this.mask.paintSegment(a.x, a.y, b.x, b.y, a.w, b.w, feather, now, c);
        }
      }
    });
  }
}
