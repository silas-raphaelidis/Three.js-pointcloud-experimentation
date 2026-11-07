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
 * Painting only re-uploads the rows that changed.
 */
export class TrailMask {
  /** @param {import('./terrain.js').Terrain} terrain */
  constructor(terrain) {
    this.terrain = terrain;
    this.width = terrain.width;
    this.height = terrain.height;
    this.res = terrain.res;
    this.origin = terrain.origin.clone();

    this.data = new Float32Array(this.width * this.height * 4);
    this.texture = new THREE.DataTexture(this.data, this.width, this.height, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.clear();

    this.dirty = null; // {i0, i1, j0, j1} cell rectangle awaiting upload
  }

  /** Remove every trail (the forest grows back). */
  clear() {
    for (let k = 0; k < this.data.length; k += 4) {
      this.data[k] = 0;
      this.data[k + 1] = NEVER;
    }
    this.texture.clearUpdateRanges();
    this.texture.needsUpdate = true;
    this.dirty = null;
  }

  /**
   * Paint a trail segment from a to b (local x, y).
   * @param {number} width   cleared width in meters
   * @param {number} feather soft edge on each side in meters
   * @param {number} time    cut time to record (seconds)
   */
  paintSegment(ax, ay, bx, by, width, feather, time) {
    const inner = width / 2;
    const outer = inner + feather;
    const r = outer / this.res;

    // Cell rectangle covering the segment plus brush radius.
    const toI = (x) => (x - this.origin.x) / this.res - 0.5;
    const toJ = (y) => (y - this.origin.y) / this.res - 0.5;
    const i0 = Math.max(0, Math.floor(Math.min(toI(ax), toI(bx)) - r));
    const i1 = Math.min(this.width - 1, Math.ceil(Math.max(toI(ax), toI(bx)) + r));
    const j0 = Math.max(0, Math.floor(Math.min(toJ(ay), toJ(by)) - r));
    const j1 = Math.min(this.height - 1, Math.ceil(Math.max(toJ(ay), toJ(by)) + r));
    if (i0 > i1 || j0 > j1) return;

    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;

    for (let j = j0; j <= j1; j++) {
      const y = this.origin.y + (j + 0.5) * this.res;
      for (let i = i0; i <= i1; i++) {
        const x = this.origin.x + (i + 0.5) * this.res;
        // Distance from the cell center to the segment.
        let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
        t = Math.min(1, Math.max(0, t));
        const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (d >= outer) continue;

        // Smooth falloff across the feather band.
        const e = d <= inner ? 1 : 1 - (d - inner) / feather;
        const s = e * e * (3 - 2 * e);
        const k = (j * this.width + i) * 4;
        if (s > this.data[k]) this.data[k] = s;
        if (time < this.data[k + 1]) this.data[k + 1] = time;
      }
    }

    const d = this.dirty;
    this.dirty = d
      ? { i0: Math.min(d.i0, i0), i1: Math.max(d.i1, i1), j0: Math.min(d.j0, j0), j1: Math.max(d.j1, j1) }
      : { i0, i1, j0, j1 };
  }

  /** Upload changed rows to the GPU. Call once per frame. */
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

/** GLSL helper: trail strength (x) and cut time (y) at a local position. */
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
