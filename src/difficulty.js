import * as THREE from 'three';

/**
 * Trail difficulty ratings by slope: one shared set of thresholds used by
 * the slope-difficulty view (shaders), the cursor readout, trail stats and
 * the legend. Thresholds are editable in the legend and saved locally.
 *
 * Slopes are rise/run (0.25 = 25 %). Rough North American guide:
 *   green < 25 %  ·  blue 25–40 %  ·  black 40–60 %  ·  double black > 60 %
 */

const DEFAULTS = [0.25, 0.4, 0.6];
const SAVE_KEY = 'ascutney-difficulty-v1';

export const RATINGS = [
  // `color` is what the map and legend show; `text` is readable on the dark HUD.
  { name: 'green', color: '#3ec46d', text: '#3ec46d' },
  { name: 'blue', color: '#4c8dff', text: '#4c8dff' },
  { name: 'black', color: '#e04848', text: '#ff7a7a' },      // shown as red
  { name: 'double black', color: '#26262b', text: '#c9d0d8' }, // charcoal
];

const listeners = new Set();
let thresholds = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (Array.isArray(saved) && saved.length === 3 && saved.every(Number.isFinite)) return saved;
  } catch { /* no storage or bad data */ }
  return [...DEFAULTS];
}

/** Current boundaries [green|blue, blue|black, black|double]. */
export function getThresholds() { return [...thresholds]; }

/** Set one boundary (index 0..2); kept in order with at least 1 % between. */
export function setThreshold(index, value) {
  const lo = index === 0 ? 0.01 : thresholds[index - 1] + 0.01;
  const hi = index === 2 ? 3 : thresholds[index + 1] - 0.01;
  thresholds[index] = Math.min(hi, Math.max(lo, value));
  changed();
}

export function resetThresholds() {
  thresholds = [...DEFAULTS];
  changed();
}

/** Call fn whenever thresholds change. Returns an unsubscribe function. */
export function onThresholdsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(thresholds)); } catch { /* ignore */ }
  for (const fn of listeners) fn(getThresholds());
}

/** Rating for a slope: { name, color, text, index }. */
export function rate(slope) {
  const i = slope < thresholds[0] ? 0 : slope < thresholds[1] ? 1 : slope < thresholds[2] ? 2 : 3;
  return { ...RATINGS[i], index: i };
}

/** Uniforms for the shaders; keep them updated with `bindUniforms`. */
export function difficultyUniforms() {
  return {
    uThresh: { value: new THREE.Vector3(...thresholds) },
    uRate0: { value: new THREE.Color(RATINGS[0].color) },
    uRate1: { value: new THREE.Color(RATINGS[1].color) },
    uRate2: { value: new THREE.Color(RATINGS[2].color) },
    uRate3: { value: new THREE.Color(RATINGS[3].color) },
  };
}

export function bindUniforms(uniforms) {
  onThresholdsChange((t) => uniforms.uThresh.value.set(...t));
}

/**
 * GLSL: smoothed slope lookup (uSlope, same grid as the height map) and the
 * band colors. Hard bands with a thin soft edge (EDGE, in slope units).
 */
export const difficultyGLSL = /* glsl */ `
  uniform sampler2D uSlope;
  uniform vec3 uThresh;
  uniform vec3 uRate0, uRate1, uRate2, uRate3;

  float slopeAt(vec2 p) {
    ivec2 size = textureSize(uSlope, 0);
    vec2 g = (p - uHeightOrigin) / uHeightRes - 0.5;
    ivec2 i0 = ivec2(floor(g));
    vec2 f = g - floor(g);
    ivec2 lo = ivec2(0), hi = size - 1;
    float a = texelFetch(uSlope, clamp(i0, lo, hi), 0).r;
    float b = texelFetch(uSlope, clamp(i0 + ivec2(1, 0), lo, hi), 0).r;
    float c = texelFetch(uSlope, clamp(i0 + ivec2(0, 1), lo, hi), 0).r;
    float d = texelFetch(uSlope, clamp(i0 + ivec2(1, 1), lo, hi), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  vec3 difficultyColor(float s) {
    const float EDGE = 0.012;
    vec3 c = uRate0;
    c = mix(c, uRate1, smoothstep(uThresh.x - EDGE, uThresh.x + EDGE, s));
    c = mix(c, uRate2, smoothstep(uThresh.y - EDGE, uThresh.y + EDGE, s));
    c = mix(c, uRate3, smoothstep(uThresh.z - EDGE, uThresh.z + EDGE, s));
    return c;
  }
`;

const toDegrees = (slope) => Math.round(THREE.MathUtils.radToDeg(Math.atan(slope)));

/** Legend panel (right side) with editable thresholds. */
export class DifficultyLegend {
  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'legend';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.#render();
    onThresholdsChange(() => this.#syncInputs());
  }

  show(on) { this.el.hidden = !on; }

  #render() {
    const pct = (v) => Math.round(v * 100);
    const t = thresholds;
    const input = (i) => `<input type="number" data-i="${i}" min="1" max="300" step="1" value="${pct(t[i])}">%`;
    this.el.innerHTML = `
      <div class="title">Slope difficulty</div>
      <div class="rows">
        <div class="row"><span class="sw" style="background:${RATINGS[0].color}"></span><span class="name">Green</span><span class="range">below ${input(0)}</span></div>
        <div class="row"><span class="sw" style="background:${RATINGS[1].color}"></span><span class="name">Blue</span><span class="range">to ${input(1)}</span></div>
        <div class="row"><span class="sw" style="background:${RATINGS[2].color}"></span><span class="name">Black</span><span class="range">to ${input(2)}</span></div>
        <div class="row"><span class="sw dbl" style="background:${RATINGS[3].color}"></span><span class="name">Double black</span><span class="range">above</span></div>
      </div>
      <div class="degrees"></div>
      <button class="reset">Reset to defaults</button>`;
    this.el.querySelectorAll('input').forEach((el) => {
      el.addEventListener('change', () => {
        const v = Number(el.value);
        if (Number.isFinite(v)) setThreshold(Number(el.dataset.i), v / 100);
        else this.#syncInputs();
      });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    });
    this.el.querySelector('.reset').addEventListener('click', () => resetThresholds());
    this.#syncInputs();
  }

  #syncInputs() {
    const t = thresholds;
    this.el.querySelectorAll('input').forEach((el) => {
      if (document.activeElement !== el) el.value = Math.round(t[Number(el.dataset.i)] * 100);
    });
    this.el.querySelector('.degrees').textContent =
      `In degrees: ${t.map((v) => `${toDegrees(v)}°`).join(' · ')} · slope measured over ~10 m`;
  }
}
