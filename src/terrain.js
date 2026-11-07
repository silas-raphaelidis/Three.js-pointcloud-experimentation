import * as THREE from 'three';
import { fetchWithRetry } from './retry.js';

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
   * @param {string} baseUrl   URL prefix for ascutney-height.{png,json}
   * @param {THREE.Vector3} offset  UTM position of the scene origin
   */
  static async load(baseUrl, offset) {
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

    return new Terrain(meta, heights, offset);
  }

  constructor(meta, heights, offset) {
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
  }

  /** Grid-space coordinates (cell centers at integers) for a local x, y. */
  #grid(x, y) {
    return [(x - this.origin.x) / this.res - 0.5, (y - this.origin.y) / this.res - 0.5];
  }

  #at(i, j) {
    i = Math.min(this.width - 1, Math.max(0, i));
    j = Math.min(this.height - 1, Math.max(0, j));
    return this.heights[j * this.width + i];
  }

  /** Is (x, y) over the map? Covers the full outer cells, matching the
   *  bounding box raycast() clips to (cell centers sit half a cell in). */
  contains(x, y) {
    const [gx, gy] = this.#grid(x, y);
    return gx >= -0.5 && gy >= -0.5 && gx <= this.width - 0.5 && gy <= this.height - 0.5;
  }

  /** Bilinearly interpolated ground height at local x, y. */
  heightAt(x, y) {
    const [gx, gy] = this.#grid(x, y);
    const i = Math.floor(gx), j = Math.floor(gy);
    const fx = gx - i, fy = gy - j;
    const h00 = this.#at(i, j), h10 = this.#at(i + 1, j);
    const h01 = this.#at(i, j + 1), h11 = this.#at(i + 1, j + 1);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }

  /** Surface normal from central differences over one grid cell. */
  normalAt(x, y, out = new THREE.Vector3()) {
    const d = this.res;
    const dzdx = (this.heightAt(x + d, y) - this.heightAt(x - d, y)) / (2 * d);
    const dzdy = (this.heightAt(x, y + d) - this.heightAt(x, y - d)) / (2 * d);
    return out.set(-dzdx, -dzdy, 1).normalize();
  }

  /** Slope as rise/run (0.4 = 40 %). */
  slopeAt(x, y) {
    const n = this.normalAt(x, y);
    return Math.sqrt(n.x * n.x + n.y * n.y) / n.z;
  }

  /**
   * First intersection of a ray with the terrain, or null.
   * Steps along the ray at half a cell, then refines by bisection.
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
    const enter = new THREE.Vector3();
    if (!ray.intersectBox(box, enter)) return null;
    let t = Math.max(0, enter.sub(ray.origin).dot(ray.direction));

    const step = this.res * 0.5;
    const p = new THREE.Vector3();
    const above = (tt) => {
      ray.at(tt, p);
      return p.z - this.heightAt(p.x, p.y);
    };

    let prevT = t;
    let prev = above(t);
    if (prev < 0) return null; // starting underground
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
      prev = cur;
    }
    return null;
  }
}

/** GLSL helper: bilinear ground height from the height texture. */
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
