import * as THREE from 'three';
import { trailGLSL } from './trails/mask.js';
import { difficultyGLSL } from './difficulty.js';

/**
 * A solid ground surface built from the height map, drawn under the points.
 *
 * Two jobs:
 *  1. In the main pass (color + depth), it fills the gaps where the scanner
 *     never reached the ground, so Eye-Dome Lighting sees ground instead of
 *     empty background (which made every gap a black-rimmed hole), and
 *     cleared trails are solid snow.
 *  2. Drawn again depth-only after shading, it hides overlay lines and
 *     points behind hills (terrain only, so trees don't chop lines up).
 *
 * It sits slightly below the ground points so the two don't z-fight.
 */
export class GroundMesh {
  /**
   * Created once in main.js when the height map arrives.
   * @param {import('./terrain.js').Terrain} terrain
   * @param {object} uniforms  shared uniforms (height map, trail mask, time...)
   * @param {object} opts
   * @param {number} opts.step    sample every Nth height-map cell (2 -> 4 m)
   * @param {number} opts.sink    how far below the ground points, meters
   * @param {string} opts.colorGLSL  GLSL defining `vec3 groundRamp(float z)`
   */
  constructor(terrain, uniforms, { step = 2, sink = 0.5, colorGLSL }) {
    this.geometry = GroundMesh.#buildGeometry(terrain, step, sink);

    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vWorld = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uFallDuration;
          uniform vec3 uSnow;
          uniform float uColorMode;
          uniform sampler2D uHeight;
          uniform vec2 uHeightOrigin;
          uniform float uHeightRes;
          varying vec3 vWorld;
          ${colorGLSL}
          ${trailGLSL}
          ${difficultyGLSL}
          void main() {
            bool difficultyMode = uColorMode > 1.5;
            vec3 rated = difficultyMode ? difficultyColor(slopeAt(vWorld.xy)) : vec3(0.0);
            vec3 color = difficultyMode ? rated
              : uColorMode > 0.5 ? vec3(0.15, 0.35, 0.9)
              : groundRamp(vWorld.z);
            if (uHasTrail > 0.5) {
              vec2 trail = trailAt(vWorld.xy);
              float t = clamp((uTime - trail.y) / uFallDuration, 0.0, 1.0);
              // Same as the points: lightened rating in the difficulty view.
              vec3 trailColor = difficultyMode ? mix(rated, vec3(1.0), 0.38) : uSnow;
              color = mix(color, trailColor, trail.x * smoothstep(0.0, 1.0, t));
            }
            gl_FragColor = vec4(color, 1.0);
            #include <colorspace_fragment>
          }`,
      })
    );
    this.mesh.frustumCulled = false;

    // Depth-only copy for occluding the overlay. Pushed down a little more so
    // lines draped on the ground never dip under the coarser mesh.
    this.occluder = new THREE.Mesh(
      this.geometry,
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true })
    );
    this.occluder.position.z = -1.0;
    this.occluder.frustumCulled = false;
    this.occluder.renderOrder = -1;
  }

  /** Indexed triangle grid over the height map. Shared by the mesh and the occluder. */
  static #buildGeometry(terrain, step, sink) {
    const cols = Math.floor((terrain.width - 1) / step) + 1;
    const rows = Math.floor((terrain.height - 1) / step) + 1;
    const pos = new Float32Array(cols * rows * 3);
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const j = r * step;
      const y = terrain.origin.y + (j + 0.5) * terrain.res;
      for (let c = 0; c < cols; c++) {
        const i = c * step;
        pos[k++] = terrain.origin.x + (i + 0.5) * terrain.res;
        pos[k++] = y;
        pos[k++] = terrain.heights[j * terrain.width + i] - sink;
      }
    }
    const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
    k = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = e;
        idx[k++] = a; idx[k++] = e; idx[k++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}
