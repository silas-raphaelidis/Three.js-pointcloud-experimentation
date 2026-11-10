// Samples are 2 m apart; painting every third one as a straight piece cuts the
// work to a third, and on a curve a 6 m piece strays from it by about 0.2 m,
// a tenth of a mask cell.
const PAINT_STRIDE = 3;

/**
 * Draws the trail network into the TrailMask. Given the world-space boxes that
 * changed, it rebuilds just those regions by re-stamping every trail that
 * overlaps each one, so crossings and junctions stay correct.
 */
export class TrailRasterizer {
  /**
   * Created once in setupTrails (main.js).
   * @param {import('./spline.js').TrailGeometry} geometry
   * @param {import('./mask.js').TrailMask} mask
   */
  constructor(geometry, mask) {
    this.geometry = geometry;
    this.mask = mask;
  }

  /**
   * Recut the forest mask inside world-space boxes. `now` starts the falling-trees animation.
   * Called by processTrails in main.js with the boxes from TrailGeometry.update.
   */
  rebuild(boxes, now) {
    if (!boxes?.length) return;
    const clips = boxes.map((b) => this.mask.cellsForBox(b)).filter(Boolean);
    if (!clips.length) return;
    const feather = this.geometry.feather;
    // Does a world-space box touch any of the changed boxes?
    const overlaps = (b) => boxes.some((x) => !(b.maxX < x.minX || b.minX > x.maxX || b.maxY < x.minY || b.minY > x.maxY));

    // Every segment near a changed box is painted once; the mask keeps it to the changed cells.
    this.mask.rebuildRegions(clips, now, (bounds) => {
      for (const [, { samples, box: tb }] of this.geometry.entries()) {
        if (!tb || !overlaps(tb)) continue;
        for (let i = 0; i + 1 < samples.length; i += PAINT_STRIDE) {
          const a = samples[i], b = samples[Math.min(i + PAINT_STRIDE, samples.length - 1)];
          const r = Math.max(a.w, b.w) / 2 + feather;
          const seg = {
            minX: Math.min(a.x, b.x) - r, maxX: Math.max(a.x, b.x) + r,
            minY: Math.min(a.y, b.y) - r, maxY: Math.max(a.y, b.y) + r,
          };
          if (overlaps(seg)) this.mask.paintSegment(a.x, a.y, b.x, b.y, a.w, b.w, feather, now, bounds);
        }
      }
    });
  }
}
