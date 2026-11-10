import * as THREE from 'three';
import { MAX_SLOPE, gridSlopes } from '../trails/pathfind.js';
import { sampleHeightGrid } from '../trails/generator.js';
import { analyzeTerrain, skiDownFrom, isInside, FLAT } from './analysis.js';
import { showToast } from '../toast.js';

/**
 * Debug view of the mountain analysis, tinting the points by grid cell.
 * Temporary: it's for checking the analysis while mountain generation is
 * built. K cycles through the views (see main.js).
 */
const VIEWS = [
  { name: 'Terrain: gray edge (kept clear) · red too steep · blue flat · pink bases', paint: paintTerrain },
  { name: 'Can ski down to the best base (green)', paint: paintBaseCatchment },
  { name: 'Can ski to from the summit (yellow)', paint: paintSummitReach },
];

const RED = [230, 40, 30], BLUE = [50, 130, 255], PINK = [255, 50, 230], PURPLE = [150, 80, 255];
const GREEN = [50, 230, 80], YELLOW = [255, 215, 30], GRAY = [90, 90, 95];

export class AnalysisOverlay {
  /** Created once in setupTrails (main.js). */
  constructor({ terrain, uniforms }) {
    this.terrain = terrain;
    this.uniforms = uniforms;
    this.view = -1; // -1 = off
    this.grid = null;
    this.analysis = null;
    this.texture = null;
  }

  /** Show the next view, or turn off after the last. Used by the K key. */
  cycle() {
    this.view = this.view + 1 < VIEWS.length ? this.view + 1 : -1;
    if (this.view < 0) {
      this.uniforms.uHasOverlay.value = 0;
      showToast('Analysis overlay off');
      return;
    }
    this.#analyze();
    const { cols, rows } = this.grid;
    const rgba = this.texture.image.data;
    rgba.fill(0);
    // Tint cell c with a color at the given strength (0..1).
    const tint = (c, [r, g, b], a) => {
      rgba.set([r, g, b, Math.round(a * 255)], c * 4);
    };
    VIEWS[this.view].paint(this.grid, this.analysis, tint, cols * rows);
    this.texture.needsUpdate = true;
    this.uniforms.uHasOverlay.value = 1;
    showToast(VIEWS[this.view].name, 4000);
  }

  /** Run the analysis the first time a view is shown, and log a summary. */
  #analyze() {
    if (this.analysis) return;
    const t0 = performance.now();
    const grid = sampleHeightGrid(this.terrain);
    grid.slope = gridSlopes(grid);
    this.grid = grid;
    this.analysis = analyzeTerrain(grid);
    const { bases, areas } = this.analysis;
    console.log(
      `[mountain] analysis ${(performance.now() - t0).toFixed(0)} ms · ${grid.cols}×${grid.rows} cells · ` +
      `${areas.length} flat areas · ${bases.length} possible bases`
    );
    for (const [rank, b] of bases.slice(0, 8).entries()) {
      console.log(
        `[mountain] base ${rank + 1}: ${(b.area / 1e4).toFixed(1)} ha flat · serves ${(b.served / 1e4).toFixed(0)} ha · ` +
        `${b.vertical.toFixed(0)} m vertical · at ${b.x.toFixed(0)}, ${b.y.toFixed(0)} · height ${b.z.toFixed(0)}`
      );
    }

    this.texture = new THREE.DataTexture(new Uint8Array(grid.cols * grid.rows * 4), grid.cols, grid.rows);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.uniforms.uOverlay.value = this.texture;
    this.uniforms.uOverlayOrigin.value.set(grid.originX, grid.originY);
    this.uniforms.uOverlayCell.value = grid.cell;
  }
}

/** Too steep, flat, and the top base candidates. */
function paintTerrain(grid, { bases }, tint, n) {
  for (let c = 0; c < n; c++) {
    const i = c % grid.cols;
    if (!isInside(grid, i, (c - i) / grid.cols)) tint(c, GRAY, 0.75);
    else if (grid.slope[c] > MAX_SLOPE) tint(c, RED, 0.7);
    else if (grid.slope[c] < FLAT) tint(c, BLUE, 0.45);
  }
  bases.slice(0, 5).forEach((b, rank) => {
    for (const c of b.cells) tint(c, rank === 0 ? PINK : PURPLE, rank === 0 ? 0.9 : 0.6);
  });
}

/** Everywhere that can ski down to the best base, and the base itself. */
function paintBaseCatchment(grid, { bases }, tint, n) {
  const best = bases[0];
  if (!best) return;
  for (let c = 0; c < n; c++) if (best.catchment[c]) tint(c, GREEN, 0.55);
  for (const c of best.cells) tint(c, PINK, 0.9);
}

/** Everywhere reachable skiing down from the highest point. */
function paintSummitReach(grid, { summit }, tint, n) {
  const reach = skiDownFrom(grid, [summit]);
  for (let c = 0; c < n; c++) if (reach[c]) tint(c, YELLOW, 0.55);
  // Mark the summit itself, a few cells wide so it can be found.
  const { cols, rows } = grid;
  const si = summit % cols, sj = (summit - si) / cols;
  for (let j = Math.max(0, sj - 2); j <= Math.min(rows - 1, sj + 2); j++) {
    for (let i = Math.max(0, si - 2); i <= Math.min(cols - 1, si + 2); i++) tint(j * cols + i, PINK, 1);
  }
}

/**
 * GLSL added to the point shader: the overlay color and strength at a local
 * position (strength 0 outside the grid).
 */
export const overlayGLSL = /* glsl */ `
  uniform sampler2D uOverlay;
  uniform vec2 uOverlayOrigin;
  uniform float uOverlayCell;
  uniform float uHasOverlay;

  vec4 overlayAt(vec2 p) {
    ivec2 size = textureSize(uOverlay, 0);
    ivec2 c = ivec2(floor((p - uOverlayOrigin) / uOverlayCell));
    if (c.x < 0 || c.y < 0 || c.x >= size.x || c.y >= size.y) return vec4(0.0);
    return texelFetch(uOverlay, c, 0);
  }
`;
