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
 * Only the changed part of each row is re-uploaded to the GPU.
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

    this.dirty = new Map(); // row -> [first, last] column awaiting upload
    // 1 for cells being rebuilt right now: painting only touches those (see rebuildRegions).
    this.stencil = new Uint8Array(this.width * this.height);
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
   * with a soft `feather` edge. Only cells inside `clip` that are being
   * rebuilt (see rebuildRegions) are touched.
   * Used by TrailRasterizer for every pair of samples, inside rebuildRegions.
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
    const data = this.data, stencil = this.stencil;
    for (let j = j0; j <= j1; j++) {
      const y = this.origin.y + (j + 0.5) * this.res;
      for (let i = i0; i <= i1; i++) {
        const c = j * this.width + i, k = c * 4;
        // Outside the rebuild, or already fully cleared at least as early: nothing to add.
        if (!stencil[c] || (data[k] >= 1 && data[k + 1] <= time)) continue;
        const x = this.origin.x + (i + 0.5) * this.res;
        let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
        t = Math.min(1, Math.max(0, t));
        const ex = x - (ax + t * dx), ey = y - (ay + t * dy);
        const inner = (wa + (wb - wa) * t) / 2;
        const outer = inner + feather;
        const d2 = ex * ex + ey * ey;
        if (d2 >= outer * outer) continue;
        const d = Math.sqrt(d2);
        const e = d <= inner ? 1 : 1 - (d - inner) / feather;
        const s = e * e * (3 - 2 * e);
        if (s > data[k]) data[k] = s;
        if (time < data[k + 1]) data[k + 1] = time;
      }
    }
  }

  /**
   * Redraw some regions (cell rectangles, which may overlap) from scratch.
   * Every cell in them is cleared once, then `paint(bounds)` must stamp every
   * trail that overlaps them (with time = now), where `bounds` is one
   * rectangle around them all; painting only lands in the regions' cells.
   * Cells that were already cleared keep their original cut time, so editing
   * a trail doesn't replay its whole animation; newly cleared cells animate
   * from `now`; uncleared cells grow back. Used by TrailRasterizer.rebuild.
   */
  rebuildRegions(clips, now, paint) {
    const cells = [];
    const bounds = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity };
    for (const { i0, i1, j0, j1 } of clips) {
      bounds.i0 = Math.min(bounds.i0, i0); bounds.i1 = Math.max(bounds.i1, i1);
      bounds.j0 = Math.min(bounds.j0, j0); bounds.j1 = Math.max(bounds.j1, j1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = j * this.width + i;
          if (!this.stencil[c]) { this.stencil[c] = 1; cells.push(c); }
        }
      }
    }
    const oldS = new Float32Array(cells.length), oldT = new Float32Array(cells.length);
    cells.forEach((c, o) => {
      oldS[o] = this.data[c * 4];
      oldT[o] = this.data[c * 4 + 1];
      this.data[c * 4] = 0;
      this.data[c * 4 + 1] = NEVER;
    });

    paint(bounds);

    cells.forEach((c, o) => {
      const k = c * 4;
      if (this.data[k] <= 0) this.data[k + 1] = NEVER;
      else if (oldS[o] > 0) this.data[k + 1] = Math.min(oldT[o], now);
      this.stencil[c] = 0;
    });
    for (const clip of clips) this.#markDirty(clip);
  }

  /**
   * Add a region to what's awaiting upload: per row, one span covering every
   * changed region in it (so many small regions don't mean many uploads).
   * Used by rebuildRegions.
   */
  #markDirty({ i0, i1, j0, j1 }) {
    for (let j = j0; j <= j1; j++) {
      const span = this.dirty.get(j);
      this.dirty.set(j, span ? [Math.min(span[0], i0), Math.max(span[1], i1)] : [i0, i1]);
    }
  }

  /**
   * Mark the changed part of each row for upload to the GPU; three.js sends
   * them at the next render. Called once per frame from the render loop in main.js.
   */
  flush() {
    if (!this.dirty.size) return;
    for (const [j, [i0, i1]] of this.dirty) {
      this.texture.addUpdateRange((j * this.width + i0) * 4, (i1 - i0 + 1) * 4);
    }
    this.texture.needsUpdate = true;
    this.dirty.clear();
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
