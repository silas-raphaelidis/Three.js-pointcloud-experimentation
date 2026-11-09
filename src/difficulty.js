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

/** Saved thresholds, or the defaults. Runs once when this module loads. */
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (Array.isArray(saved) && saved.length === 3 && saved.every(Number.isFinite)) return saved;
  } catch { /* no storage or bad data */ }
  return [...DEFAULTS];
}

/**
 * Copy of the current boundaries [green|blue, blue|black, black|double].
 * Used by changed() to pass them to listeners.
 */
export function getThresholds() { return [...thresholds]; }

/**
 * Set one boundary (index 0..2), kept in order with at least 1 % between.
 * Used by the legend's number fields.
 */
export function setThreshold(index, value) {
  const lo = index === 0 ? 0.01 : thresholds[index - 1] + 0.01;
  const hi = index === 2 ? 3 : thresholds[index + 1] - 0.01;
  thresholds[index] = Math.min(hi, Math.max(lo, value));
  changed();
}

/** Restore the default boundaries. Used by the legend's Reset button. */
export function resetThresholds() {
  thresholds = [...DEFAULTS];
  changed();
}

// ---------- Slope smoothing ----------
// How far (meters) the ground is averaged before measuring slope. Wider
// windows give calmer, broader bands; narrower ones show more local detail.
export const SMOOTHING = { min: 6, max: 42, step: 4, default: 10 };
const SMOOTH_KEY = 'ascutney-slope-smoothing-v1';
const smoothingListeners = new Set();
/** Current smoothing distance: the saved value if valid, else the default. */
let smoothing = (() => {
  try {
    const v = Number(localStorage.getItem(SMOOTH_KEY));
    if (v >= SMOOTHING.min && v <= SMOOTHING.max) return v;
  } catch { /* no storage */ }
  return SMOOTHING.default;
})();

/** Current smoothing distance, meters. Used by load() in main.js to build the slope map. */
export function getSmoothing() { return smoothing; }

/**
 * Set the smoothing distance, clamp it, save it and notify listeners.
 * Used by the legend's slider and Reset button.
 */
export function setSmoothing(meters) {
  const v = Math.min(SMOOTHING.max, Math.max(SMOOTHING.min, Math.round(meters)));
  if (v === smoothing) return;
  smoothing = v;
  try { localStorage.setItem(SMOOTH_KEY, String(v)); } catch { /* ignore */ }
  for (const fn of smoothingListeners) fn(v);
}

/**
 * Call fn whenever the smoothing distance changes. Returns an unsubscribe function.
 * Used by main.js to recompute the slope map, and by the legend to update its display.
 */
export function onSmoothingChange(fn) {
  smoothingListeners.add(fn);
  return () => smoothingListeners.delete(fn);
}

/**
 * Call fn whenever thresholds change. Returns an unsubscribe function.
 * Used by bindUniforms, main.js (cursor readout and trail colors) and the legend.
 */
export function onThresholdsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Save the thresholds and notify listeners. Used by setThreshold and resetThresholds. */
function changed() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(thresholds)); } catch { /* ignore */ }
  for (const fn of listeners) fn(getThresholds());
}

/**
 * A trail is rated by its crux, like real runs: the hardest level that has a
 * CONTINUOUS stretch at least this many meters long at that pitch or steeper.
 * A mostly flat run with one 50 m double-black wall is double black; scattered
 * short steep bumps (or a height-map glitch) don't count.
 */
export const CRUX_MIN_LENGTH = 40;

/**
 * Meters the ground is averaged over before measuring a trail's pitch, about
 * the width of a run. Fixed on purpose: the legend's smoothing slider is a
 * display setting and must not change a trail's rating.
 */
export const TRAIL_GROUND_SMOOTHING = 10;

/**
 * Rating for a slope: { name, color, text, index }.
 * Used by trailStats for every trail segment and by difficulty() for the cursor.
 */
export function rate(slope) {
  const i = slope < thresholds[0] ? 0 : slope < thresholds[1] ? 1 : slope < thresholds[2] ? 2 : 3;
  return { ...RATINGS[i], index: i };
}

/**
 * Shader uniforms for the thresholds and band colors.
 * Used by main.js when building the shared uniforms. Pair with bindUniforms to keep them current.
 */
export function difficultyUniforms() {
  return {
    uThresh: { value: new THREE.Vector3(...thresholds) },
    uRate0: { value: new THREE.Color(RATINGS[0].color) },
    uRate1: { value: new THREE.Color(RATINGS[1].color) },
    uRate2: { value: new THREE.Color(RATINGS[2].color) },
    uRate3: { value: new THREE.Color(RATINGS[3].color) },
  };
}

/** Keep uThresh in step with the thresholds. Used once by main.js. */
export function bindUniforms(uniforms) {
  onThresholdsChange((t) => uniforms.uThresh.value.set(...t));
}

/**
 * GLSL added to the point and ground shaders.
 * slopeAt(p): bilinear lookup in the smoothed slope map (uSlope, same grid as the height map).
 * difficultyColor(s): band color for a slope. Hard bands with a thin soft edge (EDGE, in slope units).
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

/** Slope (rise/run) as whole degrees. Used by the legend's "In degrees" line. */
const toDegrees = (slope) => Math.round(THREE.MathUtils.radToDeg(Math.atan(slope)));

/** Legend panel (right side) with editable thresholds. */
export class DifficultyLegend {
  /**
   * Builds the hidden legend and keeps it in step with any threshold or smoothing change.
   * Created once in main.js.
   */
  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'legend';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.#render();
    onThresholdsChange(() => this.#syncInputs());
    onSmoothingChange(() => this.#syncInputs());
  }

  /** Show or hide the legend. Used by setColorMode in main.js for the difficulty view. */
  show(on) { this.el.hidden = !on; }

  /** Build the legend's HTML and wire up its inputs. Runs once, from the constructor. */
  #render() {
    // Slope as a whole percentage.
    const pct = (v) => Math.round(v * 100);
    const t = thresholds;
    // HTML for the number field editing threshold i.
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
      <div class="smoothing">
        <div class="label"><span>Smoothing</span><span class="value"></span></div>
        <input type="range" min="${SMOOTHING.min}" max="${SMOOTHING.max}" step="${SMOOTHING.step}" value="${smoothing}">
        <div class="hint">Wider = broader, calmer bands · narrower = more local detail</div>
      </div>
      <button class="reset">Reset to defaults</button>`;

    const slider = this.el.querySelector('.smoothing input');
    slider.addEventListener('input', () => setSmoothing(Number(slider.value)));

    this.el.querySelectorAll('input[data-i]').forEach((el) => {
      el.addEventListener('change', () => {
        const v = Number(el.value);
        if (Number.isFinite(v)) setThreshold(Number(el.dataset.i), v / 100);
        else this.#syncInputs();
      });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    });
    this.el.querySelector('.reset').addEventListener('click', () => {
      resetThresholds();
      setSmoothing(SMOOTHING.default);
    });
    this.#syncInputs();
  }

  /**
   * Copy current values into the inputs, skipping the one being typed in.
   * Runs after any threshold or smoothing change.
   */
  #syncInputs() {
    const t = thresholds;
    this.el.querySelectorAll('input[data-i]').forEach((el) => {
      if (document.activeElement !== el) el.value = Math.round(t[Number(el.dataset.i)] * 100);
    });
    this.el.querySelector('.degrees').textContent = `In degrees: ${t.map((v) => `${toDegrees(v)}°`).join(' · ')}`;
    const slider = this.el.querySelector('.smoothing input');
    if (document.activeElement !== slider) slider.value = smoothing;
    this.el.querySelector('.smoothing .value').textContent = `${smoothing} m`;
  }
}
