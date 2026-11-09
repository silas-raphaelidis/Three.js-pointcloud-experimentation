import * as THREE from 'three';
import { fetchWithRetry } from './retry.js';
import { TRAIL_GROUND_SMOOTHING } from './difficulty.js';

/**
 * Bare-earth height map: decoded from the packed PNG written by
 * data-prep/05-heightmap.py, kept on the CPU for picking and slope queries,
 * and uploaded to the GPU for shaders.
 *
 * All coordinates here are LOCAL scene coordinates (UTM minus the scene
 * offset), the same space the point cloud is drawn in.
 */
export class Terrain {
  /**
   * Download and decode the height map, then build the Terrain.
   * Used by load() in main.js, in parallel with the point cloud.
   * @param {string} baseUrl   URL prefix for ascutney-height.{png,json}
   * @param {THREE.Vector3} offset  UTM position of the scene origin
   * @param {{ slopeSmoothing?: number }} [opts]  meters to smooth slope over
   */
  static async load(baseUrl, offset, { slopeSmoothing = 10 } = {}) {
    const [meta, bitmap] = await Promise.all([
      fetchWithRetry(`${baseUrl}.json`, 'height map metadata').then((r) => r.json()),
      fetchWithRetry(`${baseUrl}.png`, 'height map image')
        .then((r) => r.blob())
        // Decode the bytes exactly as stored: no color management, no alpha games.
        .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })),
    ]);

    const { width, height } = meta;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;

    // createImageBitmap/drawImage put PNG row 0 at the top (y = 0). The PNG's
    // row 0 is the south edge, so canvas row r holds grid row r. Heights are
    // stored relative to the scene origin to keep numbers small.
    const heights = new Float32Array(width * height);
    const zBase = meta.zMin - offset.z;
    for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
      heights[i] = zBase + (rgba[p] * 256 + rgba[p + 1]) * meta.zScale;
    }

    return new Terrain(meta, heights, offset, slopeSmoothing);
  }

  /**
   * Builds the GPU textures and the smoothed fields from decoded heights.
   * Called only by Terrain.load.
   */
  constructor(meta, heights, offset, slopeSmoothing = 10) {
    this.width = meta.width;
    this.height = meta.height;
    this.res = meta.resolution;
    this.heights = heights;
    // Local position of the grid's south-west corner.
    this.origin = new THREE.Vector2(meta.originX - offset.x, meta.originY - offset.y);

    let lo = Infinity, hi = -Infinity;
    for (const h of heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
    this.minZ = lo;
    this.maxZ = hi;

    // Single-channel float texture. Filtering is done manually in shaders
    // (32-bit float linear filtering isn't guaranteed in WebGL2).
    this.texture = new THREE.DataTexture(heights, this.width, this.height, THREE.RedFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;

    // Smoothed slope (rise/run) per cell, for the difficulty map colors and the
    // cursor readout: single rocks and bumps shouldn't flip a cell. Trail
    // ratings don't use this (see trailHeights below).
    this.slopes = new Float32Array(heights.length);
    this.slopeTexture = new THREE.DataTexture(this.slopes, this.width, this.height, THREE.RedFormat, THREE.FloatType);
    this.slopeTexture.minFilter = this.slopeTexture.magFilter = THREE.NearestFilter;
    this.setSlopeSmoothing(slopeSmoothing);

    // Lightly smoothed ground for measuring trail pitch (see trailStats).
    this.trailHeights = Terrain.#boxBlur(heights, this.width, this.height, this.res, TRAIL_GROUND_SMOOTHING);
  }

  /**
   * Recompute the smoothed slope map, averaging the ground over about `span` meters first.
   * Updates `slopes` and `slopeTexture` in place.
   * Used by the constructor and by the legend's smoothing slider (through main.js).
   */
  setSlopeSmoothing(span) {
    this.slopes.set(Terrain.#smoothedSlopes(this.heights, this.width, this.height, this.res, span));
    this.slopeTexture.needsUpdate = true;
    this.slopeSmoothing = span;
  }

  /**
   * Heights box-blurred over a window ~`span` meters wide.
   * Used by #smoothedSlopes and to build trailHeights.
   */
  static #boxBlur(heights, w, h, res, span) {
    // Window is (2r + 1) cells wide, e.g. at 2 m cells: 6, 10, 14 … 42 m.
    const r = Math.max(1, Math.round((span / res - 1) / 2));
    // One blur pass along every row or column, using a running sum.
    const blur = (src, horizontal) => {
      const out = new Float32Array(src.length);
      const n = horizontal ? w : h;
      const lines = horizontal ? h : w;
      for (let l = 0; l < lines; l++) {
        // Array index of position k along the current row or column.
        const idx = (k) => (horizontal ? l * w + k : k * w + l);
        // Running sum with clamped edges.
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[idx(Math.min(n - 1, Math.max(0, k)))];
        for (let k = 0; k < n; k++) {
          out[idx(k)] = sum / (2 * r + 1);
          sum += src[idx(Math.min(n - 1, k + r + 1))] - src[idx(Math.max(0, k - r))];
        }
      }
      return out;
    };
    return blur(blur(heights, true), false);
  }

  /**
   * Slope (rise/run) per cell of the ground averaged over ~`span` meters.
   * Used by setSlopeSmoothing.
   */
  static #smoothedSlopes(heights, w, h, res, span) {
    const smooth = Terrain.#boxBlur(heights, w, h, res, span);
    // Smoothed height at a cell, clamped to the map's edges.
    const at = (i, j) => smooth[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
    const slopes = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const dzdx = (at(i + 1, j) - at(i - 1, j)) / (2 * res);
        const dzdy = (at(i, j + 1) - at(i, j - 1)) / (2 * res);
        slopes[j * w + i] = Math.hypot(dzdx, dzdy);
      }
    }
    return slopes;
  }

  /**
   * Smoothed slope (rise/run) at local x, y, as shown on the difficulty map.
   * Used by updateCursor in main.js, so the readout matches the color under the cursor.
   */
  smoothSlopeAt(x, y) {
    return this.#bilinear(this.slopes, x, y);
  }

  /** Lightly smoothed ground height at local x, y. Used by trailStats to measure pitch. */
  trailHeightAt(x, y) {
    return this.#bilinear(this.trailHeights, x, y);
  }

  /**
   * Bilinear sample of any grid field at local x, y.
   * Used by heightAt, smoothSlopeAt and trailHeightAt.
   */
  #bilinear(field, x, y) {
    const [gx, gy] = this.#grid(x, y);
    const i = Math.floor(gx), j = Math.floor(gy);
    const fx = gx - i, fy = gy - j;
    const h00 = this.#at(field, i, j), h10 = this.#at(field, i + 1, j);
    const h01 = this.#at(field, i, j + 1), h11 = this.#at(field, i + 1, j + 1);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }

  /**
   * Grid-space coordinates (cell centers at integers) for a local x, y.
   * Used by #bilinear and contains.
   */
  #grid(x, y) {
    return [(x - this.origin.x) / this.res - 0.5, (y - this.origin.y) / this.res - 0.5];
  }

  /** A grid field's value at cell (i, j), clamped to the map's edges. Used by #bilinear. */
  #at(field, i, j) {
    i = Math.min(this.width - 1, Math.max(0, i));
    j = Math.min(this.height - 1, Math.max(0, j));
    return field[j * this.width + i];
  }

  /**
   * Is (x, y) over the map? Covers the full outer cells, matching the bounding box
   * raycast() clips to (cell centers sit half a cell in). Used by raycast.
   */
  contains(x, y) {
    const [gx, gy] = this.#grid(x, y);
    return gx >= -0.5 && gy >= -0.5 && gx <= this.width - 0.5 && gy <= this.height - 0.5;
  }

  /**
   * Bilinearly interpolated ground height at local x, y.
   * Used anywhere something sits on the ground: overlays, picking, the camera clamp, trail length.
   */
  heightAt(x, y) {
    return this.#bilinear(this.heights, x, y);
  }

  /**
   * Surface normal from central differences over one grid cell.
   * Used by updateCursor in main.js to lay the cursor ring on the ground, and by slopeAt.
   */
  normalAt(x, y, out = new THREE.Vector3()) {
    const d = this.res;
    const dzdx = (this.heightAt(x + d, y) - this.heightAt(x - d, y)) / (2 * d);
    const dzdy = (this.heightAt(x, y + d) - this.heightAt(x, y - d)) / (2 * d);
    return out.set(-dzdx, -dzdy, 1).normalize();
  }

  /** Unsmoothed slope as rise/run (0.4 = 40 %). Not called anywhere yet. */
  slopeAt(x, y) {
    const n = this.normalAt(x, y);
    return Math.sqrt(n.x * n.x + n.y * n.y) / n.z;
  }

  /**
   * First intersection of a ray with the terrain, or null.
   * Steps along the ray at half a cell, then refines by bisection.
   * Used for the cursor, editor picking, line-of-sight checks and camera retargeting.
   */
  raycast(ray, out = new THREE.Vector3()) {
    // Clip the ray to the terrain's bounding box first.
    const box = new THREE.Box3(
      new THREE.Vector3(this.origin.x, this.origin.y, this.minZ - 1),
      new THREE.Vector3(
        this.origin.x + this.width * this.res,
        this.origin.y + this.height * this.res,
        this.maxZ + 1
      )
    );
    // Start where the ray enters the box, or at its origin if it starts
    // inside (Ray.intersectBox returns the EXIT point in that case, which
    // made every pick fail once the camera dropped below the summit).
    let t = 0;
    if (!box.containsPoint(ray.origin)) {
      const enter = new THREE.Vector3();
      if (!ray.intersectBox(box, enter)) return null;
      t = Math.max(0, enter.sub(ray.origin).dot(ray.direction));
    }

    const step = this.res * 0.5;
    const p = new THREE.Vector3();
    // Height of the ray above the ground at distance tt; negative means underground.
    const above = (tt) => {
      ray.at(tt, p);
      return p.z - this.heightAt(p.x, p.y);
    };

    let prevT = t;
    if (above(t) < 0) return null; // starting underground
    for (let n = 0; n < 40000; n++) {
      t += step;
      ray.at(t, p);
      if (!this.contains(p.x, p.y) || p.z < this.minZ - 1) return null;
      const cur = p.z - this.heightAt(p.x, p.y);
      if (cur <= 0) {
        // Crossed the surface between prevT and t: bisect.
        let a = prevT, b = t;
        for (let k = 0; k < 16; k++) {
          const m = (a + b) / 2;
          if (above(m) > 0) a = m; else b = m;
        }
        ray.at(b, out);
        out.z = this.heightAt(out.x, out.y);
        return out;
      }
      prevT = t;
    }
    return null;
  }
}

/**
 * GLSL added to the point shader.
 * terrainHeight(p): bilinear ground height from the height texture, matching heightAt on the CPU.
 */
export const terrainGLSL = /* glsl */ `
  uniform sampler2D uHeight;
  uniform vec2 uHeightOrigin;
  uniform float uHeightRes;
  uniform float uHasHeight;

  float terrainHeight(vec2 p) {
    ivec2 size = textureSize(uHeight, 0);
    vec2 g = (p - uHeightOrigin) / uHeightRes - 0.5;
    ivec2 i0 = ivec2(floor(g));
    vec2 f = g - floor(g);
    ivec2 lo = ivec2(0), hi = size - 1;
    float h00 = texelFetch(uHeight, clamp(i0, lo, hi), 0).r;
    float h10 = texelFetch(uHeight, clamp(i0 + ivec2(1, 0), lo, hi), 0).r;
    float h01 = texelFetch(uHeight, clamp(i0 + ivec2(0, 1), lo, hi), 0).r;
    float h11 = texelFetch(uHeight, clamp(i0 + ivec2(1, 1), lo, hi), 0).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }
`;
