/**
 * Centripetal Catmull-Rom splines through a trail's nodes, and a cache of
 * sampled trails shared by the rasterizer, overlay, editor and stats.
 *
 * Centripetal (alpha = 0.5) passes through every control point without the
 * loops and cusps the uniform variant makes when points are unevenly spaced.
 */

const ALPHA = 0.5;
const EPS = 1e-4;

/**
 * Point on the centripetal Catmull-Rom segment p1 -> p2 at t in [0, 1].
 * Used by sampleSpline for every sample.
 */
function catmullRom(p0, p1, p2, p3, t) {
  // Parameter spacing between two points; this is what makes it centripetal.
  const knot = (a, b) => Math.max(EPS, Math.hypot(b.x - a.x, b.y - a.y) ** ALPHA);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;

  // Interpolate between two points at u, given their parameter values.
  const lerp = (a, b, ta, tb) => {
    const w = (u - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/** Smoothstep easing. Used by sampleSpline to blend width between stops. */
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Sample control points [{ x, y, width }] into roughly evenly spaced samples
 * [{ x, y, w, s, seg, t }]. s is distance along the trail, seg is the control segment
 * (seg i runs from point i to point i + 1), and t is the position within it.
 * Used by TrailGeometry.update and by the editor when naming a finished trail.
 */
export function sampleSpline(ctrl, step = 2) {
  const n = ctrl.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: ctrl[0].x, y: ctrl[0].y, w: ctrl[0].width, s: 0, seg: 0 }];

  // Phantom end points continue the first/last segment in a straight line.
  const first = { x: 2 * ctrl[0].x - ctrl[1].x, y: 2 * ctrl[0].y - ctrl[1].y };
  const last = { x: 2 * ctrl[n - 1].x - ctrl[n - 2].x, y: 2 * ctrl[n - 1].y - ctrl[n - 2].y };
  // Control point i, or a phantom end point when i is past either end.
  const P = (i) => (i < 0 ? first : i >= n ? last : ctrl[i]);

  const out = [];
  let s = 0;
  let prev = null;
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const count = Math.max(1, Math.ceil(chord / step));
    for (let k = i === 0 ? 0 : 1; k <= count; k++) {
      const t = k / count;
      const p = catmullRom(p0, p1, p2, p3, t);
      if (prev) s += Math.hypot(p.x - prev.x, p.y - prev.y);
      // Width eases between stops so it never overshoots or goes negative.
      const w = p1.width + (p2.width - p1.width) * smooth(t);
      const sample = { x: p.x, y: p.y, w, s, seg: i, t };
      out.push(sample);
      prev = sample;
    }
  }
  return out;
}

/**
 * Sampled geometry for every trail, refreshed only for trails that changed.
 * Also tracks each trail's footprint so callers know what area to redraw.
 */
export class TrailGeometry {
  /**
   * Used by setupTrails in main.js, which creates the single shared cache.
   * @param {import('./network.js').TrailNetwork} network
   * @param {number} feather soft edge added around every trail, meters
   */
  constructor(network, feather) {
    this.network = network;
    this.feather = feather;
    this.cache = new Map(); // trailId -> { samples, box }
  }

  /** Cached { samples, box } for a trail. Used by the view, editor and main.js. */
  get(trailId) { return this.cache.get(trailId); }
  /** Every cached trail. Used by TrailRasterizer to re-stamp overlapping trails. */
  entries() { return this.cache.entries(); }

  /**
   * A trail's stops as { x, y, width }, with node positions resolved.
   * Used by update and by the editor when naming a finished trail.
   */
  controlPoints(trail) {
    return trail.points.map((p) => {
      const n = this.network.node(p.node);
      return { x: n.x, y: n.y, width: p.width };
    });
  }

  /**
   * Re-sample the given trails. Returns the world-space box covering both their
   * old and new footprints (null if nothing to redraw).
   * Used by processTrails in main.js; the box tells the rasterizer what to recut.
   */
  update(trailIds) {
    let box = null;
    // Expand the combined box to include b.
    const grow = (b) => {
      if (!b) return;
      box = box
        ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) }
        : { ...b };
    };

    for (const id of trailIds) {
      grow(this.cache.get(id)?.box);
      const trail = this.network.trail(id);
      if (!trail) {
        this.cache.delete(id);
        continue;
      }
      const samples = sampleSpline(this.controlPoints(trail));
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const p of samples) {
        const r = p.w / 2 + this.feather;
        b.minX = Math.min(b.minX, p.x - r);
        b.minY = Math.min(b.minY, p.y - r);
        b.maxX = Math.max(b.maxX, p.x + r);
        b.maxY = Math.max(b.maxY, p.y + r);
      }
      this.cache.set(id, { samples, box: samples.length ? b : null });
      grow(samples.length ? b : null);
    }
    return box;
  }

  /**
   * Closest point on any trail to (x, y). Returns { trailId, dist, x, y, w, seg, t },
   * where seg and t locate it between control points, or null if there are no trails.
   * Used by the editor's #pick. The onlyTrailId filter isn't used by any caller yet.
   */
  nearest(x, y, onlyTrailId = null) {
    let best = null;
    for (const [id, { samples }] of this.cache) {
      if (onlyTrailId && id !== onlyTrailId) continue;
      for (let i = 0; i + 1 < samples.length; i++) {
        const a = samples[i], b = samples[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        let u = len2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : 0;
        u = Math.min(1, Math.max(0, u));
        const px = a.x + dx * u, py = a.y + dy * u;
        const dist = Math.hypot(x - px, y - py);
        if (!best || dist < best.dist) {
          best = {
            trailId: id,
            dist,
            x: px,
            y: py,
            w: a.w + (b.w - a.w) * u,
            seg: b.seg,
            // Which side of the control segment we're on (for inserting).
            t: a.seg === b.seg ? a.t + (b.t - a.t) * u : b.t * u,
          };
        }
      }
    }
    return best;
  }
}
