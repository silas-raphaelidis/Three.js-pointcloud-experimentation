import * as THREE from 'three';

/** Cells the cut hasn't reached hold this "time". */
const NEVER = 1e9;

/**
 * Where trails are cut, as a texture lined up with the height map.
 *
 * Per cell (RGBA float):
 *   R  trail strength, 0 = forest .. 1 = fully cleared (soft at the edges)
 *   G  time in seconds when the cut reached this cell (drives the animation)
 *   B  spare (e.g. difficulty or trail id later)
 *   A  spare
 *
 * Only rows that change are re-uploaded to the GPU.
 */
export class TrailMask {
  /**
   * Created once in setupTrails (main.js), lined up with the height map.
   * @param {import('../terrain.js').Terrain} terrain
   */
  constructor(terrain) {
    this.width = terrain.width;
    this.height = terrain.height;
    this.res = terrain.res;
    this.origin = terrain.origin.clone();

    this.data = new Float32Array(this.width * this.height * 4);
    this.texture = new THREE.DataTexture(this.data, this.width, this.height, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    for (let k = 0; k < this.data.length; k += 4) this.data[k + 1] = NEVER;
    this.texture.needsUpdate = true;

    this.dirty = null; // cell rectangle awaiting upload
  }

  /**
   * Cell rectangle covering a world-space box, clamped to the grid, or null if off the map.
   * Used by TrailRasterizer.rebuild.
   */
  cellsForBox({ minX, minY, maxX, maxY }) {
    const i0 = Math.max(0, Math.floor((minX - this.origin.x) / this.res - 0.5));
    const i1 = Math.min(this.width - 1, Math.ceil((maxX - this.origin.x) / this.res - 0.5));
    const j0 = Math.max(0, Math.floor((minY - this.origin.y) / this.res - 0.5));
    const j1 = Math.min(this.height - 1, Math.ceil((maxY - this.origin.y) / this.res - 0.5));
    return i0 > i1 || j0 > j1 ? null : { i0, i1, j0, j1 };
  }

  /**
   * Stamp a segment from a to b whose cleared width tapers from wa to wb,
   * with a soft `feather` edge. Only cells inside `clip` are touched.
   * Used by TrailRasterizer for every pair of samples, inside rebuildRegion.
   */
  paintSegment(ax, ay, bx, by, wa, wb, feather, time, clip) {
    const r = (Math.max(wa, wb) / 2 + feather) / this.res;
    // World x to grid column.
    const toI = (x) => (x - this.origin.x) / this.res - 0.5;
    // World y to grid row.
    const toJ = (y) => (y - this.origin.y) / this.res - 0.5;
    const i0 = Math.max(clip.i0, Math.floor(Math.min(toI(ax), toI(bx)) - r));
    const i1 = Math.min(clip.i1, Math.ceil(Math.max(toI(ax), toI(bx)) + r));
    const j0 = Math.max(clip.j0, Math.floor(Math.min(toJ(ay), toJ(by)) - r));
    const j1 = Math.min(clip.j1, Math.ceil(Math.max(toJ(ay), toJ(by)) + r));
    if (i0 > i1 || j0 > j1) return;

    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let j = j0; j <= j1; j++) {
      const y = this.origin.y + (j + 0.5) * this.res;
      for (let i = i0; i <= i1; i++) {
        const x = this.origin.x + (i + 0.5) * this.res;
        let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
        t = Math.min(1, Math.max(0, t));
        const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        const inner = (wa + (wb - wa) * t) / 2;
        if (d >= inner + feather) continue;
        const e = d <= inner ? 1 : 1 - (d - inner) / feather;
        const s = e * e * (3 - 2 * e);
        const k = (j * this.width + i) * 4;
        if (s > this.data[k]) this.data[k] = s;
        if (time < this.data[k + 1]) this.data[k + 1] = time;
      }
    }
  }

  /**
   * Redraw one region from scratch. `paint(clip)` must stamp every trail that
   * overlaps it (with time = now). Cells that were already cleared keep their
   * original cut time, so editing a trail doesn't replay its whole animation;
   * newly cleared cells animate from `now`; uncleared cells grow back.
   * Used by TrailRasterizer.rebuild.
   */
  rebuildRegion(clip, now, paint) {
    const { i0, i1, j0, j1 } = clip;
    const w = i1 - i0 + 1;
    const oldS = new Float32Array(w * (j1 - j0 + 1));
    const oldT = new Float32Array(oldS.length);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = (j * this.width + i) * 4, o = (j - j0) * w + (i - i0);
        oldS[o] = this.data[k];
        oldT[o] = this.data[k + 1];
        this.data[k] = 0;
        this.data[k + 1] = NEVER;
      }
    }

    paint(clip);

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = (j * this.width + i) * 4, o = (j - j0) * w + (i - i0);
        if (this.data[k] <= 0) this.data[k + 1] = NEVER;
        else if (oldS[o] > 0) this.data[k + 1] = Math.min(oldT[o], now);
      }
    }
    this.#markDirty(clip);
  }

  /** Grow the pending upload rectangle to cover a region. Used by rebuildRegion. */
  #markDirty({ i0, i1, j0, j1 }) {
    const d = this.dirty;
    this.dirty = d
      ? { i0: Math.min(d.i0, i0), i1: Math.max(d.i1, i1), j0: Math.min(d.j0, j0), j1: Math.max(d.j1, j1) }
      : { i0, i1, j0, j1 };
  }

  /**
   * Mark the changed rows for upload to the GPU; three.js sends them at the next render.
   * Called once per frame from the render loop in main.js.
   */
  flush() {
    if (!this.dirty) return;
    const { i0, i1, j0, j1 } = this.dirty;
    for (let j = j0; j <= j1; j++) {
      this.texture.addUpdateRange((j * this.width + i0) * 4, (i1 - i0 + 1) * 4);
    }
    this.texture.needsUpdate = true;
    this.dirty = null;
  }
}

/**
 * GLSL added to the point and ground shaders.
 * trailAt(p): trail strength (x) and cut time (y) at a local position.
 */
export const trailGLSL = /* glsl */ `
  uniform sampler2D uTrail;
  uniform float uHasTrail;

  vec2 trailAt(vec2 p) {
    ivec2 size = textureSize(uTrail, 0);
    vec2 g = (p - uHeightOrigin) / uHeightRes - 0.5;
    ivec2 i0 = ivec2(floor(g));
    vec2 f = g - floor(g);
    ivec2 lo = ivec2(0), hi = size - 1;
    vec2 a = texelFetch(uTrail, clamp(i0, lo, hi), 0).rg;
    vec2 b = texelFetch(uTrail, clamp(i0 + ivec2(1, 0), lo, hi), 0).rg;
    vec2 c = texelFetch(uTrail, clamp(i0 + ivec2(0, 1), lo, hi), 0).rg;
    vec2 d = texelFetch(uTrail, clamp(i0 + ivec2(1, 1), lo, hi), 0).rg;
    // Strength blends smoothly; the cut time is the earliest of the four, so
    // edge cells never blend with the "never cut" value.
    float strength = mix(mix(a.x, b.x, f.x), mix(c.x, d.x, f.x), f.y);
    float cutTime = min(min(a.y, b.y), min(c.y, d.y));
    return vec2(strength, cutTime);
  }
`;
