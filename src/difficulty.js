import * as THREE from 'three';

/**
 * Trail difficulty ratings by slope: one shared set of thresholds used by
 * the slope-difficulty view (shaders), the cursor readout, trail stats and
 * the legend. Thresholds are editable on the legend's slider and saved locally.
 *
 * Slopes are rise/run (0.25 = 25 %). Rough North American guide:
 *   beginner (green) < 25 %  ·  intermediate (blue) 25–40 %
 *   advanced (black) 40–55 %  ·  expert (double black) > 55 %
 */

const DEFAULTS = [0.25, 0.4, 0.55];
// Earlier defaults (double black at 60 %, then briefly 50 %). A save that
// still holds exactly one of these was never customized, so it gets the new defaults.
const OLD_DEFAULTS = [[0.25, 0.4, 0.6], [0.25, 0.4, 0.5]];
const SAVE_KEY = 'ascutney-difficulty-v1';

export const RATINGS = [
  // Plain names, so someone who doesn't ski can follow; the colors keep the
  // usual trail-sign meaning (green, blue, black, double black).
  // `color` is what the map and legend show; `text` is readable on the dark HUD.
  { name: 'beginner', color: '#3ec46d', text: '#3ec46d' },     // green
  { name: 'intermediate', color: '#4c8dff', text: '#4c8dff' }, // blue
  { name: 'advanced', color: '#e04848', text: '#ff7a7a' },     // black, shown as red
  { name: 'expert', color: '#26262b', text: '#c9d0d8' },       // double black, charcoal
];

/** A rating's name with a capital first letter, for labels and menus. */
export function ratingLabel(index) {
  const name = RATINGS[index].name;
  return name[0].toUpperCase() + name.slice(1);
}

/**
 * HTML for a rating's trail-sign shape in its color: a circle (beginner),
 * square (intermediate), diamond (advanced) or two diamonds (expert), as on
 * real trail signs, so the levels can be told apart without relying on
 * color. Styled by .sign in style.css. Used wherever a rating is labeled.
 */
export function ratingIcon(index) {
  const shape = (cls) => `<span class="sign ${cls}" style="--sign:${RATINGS[index].color}"></span>`;
  if (index === 3) return `<span class="signs">${shape('diamond dark')}${shape('diamond dark')}</span>`;
  return shape(['circle', 'square', 'diamond'][index]);
}

const listeners = new Set();
let thresholds = load();

/** Saved thresholds, or the defaults. Runs once when this module loads. */
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
    const valid = Array.isArray(saved) && saved.length === 3 && saved.every(Number.isFinite);
    if (valid && !OLD_DEFAULTS.some((old) => saved.every((v, i) => v === old[i]))) return saved;
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
 * Used by the legend's slider.
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

/** Steepest slope on the legend's slider (80 % is about 39°). */
const SLIDER_MAX = 0.8;

/**
 * Legend panel (right side): the four difficulties, a slider with a handle
 * on each boundary between them, and the map's smoothing. Shown with the
 * slope difficulty view, or on its own (opened from the small trail-color
 * key) to adjust how trails are rated without recoloring the mountain.
 */
export class DifficultyLegend {
  /**
   * Builds the hidden legend and keeps it in step with any threshold or smoothing change.
   * Created once in main.js.
   */
  constructor() {
    this.viewOn = false;   // the slope difficulty view is showing
    this.settings = false; // opened on its own from the small key
    this.dragging = null;  // index of the boundary being dragged
    this.onToggle = null;  // called when opened or closed on its own (main.js updates the key)
    this.el = document.createElement('div');
    this.el.id = 'legend';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.#render();
    onThresholdsChange(() => this.#sync());
    onSmoothingChange(() => this.#sync());
  }

  /**
   * Show or hide the legend with the difficulty view. Turning the view off
   * also closes it if it was opened on its own. Used by setColorMode in main.js.
   */
  show(on) {
    this.viewOn = on;
    if (!on) this.settings = false;
    this.#apply();
  }

  /** Is it showing on its own (not with the difficulty view)? */
  get settingsOpen() { return this.settings && !this.viewOn; }

  /** Open or close it on its own. Used by clicking the small trail-color key (main.js) and its ×. */
  toggleSettings() {
    this.settings = !this.settingsOpen;
    this.#apply();
    this.onToggle?.();
  }

  /** Show it for the view or on its own; on its own it has a close button and no smoothing. */
  #apply() {
    this.el.hidden = !(this.viewOn || this.settings);
    this.el.classList.toggle('settings', this.settingsOpen);
  }

  /** Build the legend's HTML and wire up its controls. Runs once, from the constructor. */
  #render() {
    const row = (i) => `<div class="row"><span class="sw">${ratingIcon(i)}</span>` +
      `<span class="name">${ratingLabel(i)}</span><span class="range" data-r="${i}"></span></div>`;
    const between = ['Beginner to intermediate', 'Intermediate to advanced', 'Advanced to expert'];
    this.el.innerHTML = `
      <div class="title"><span>Slope difficulty</span><button class="close" aria-label="Close">×</button></div>
      <div class="note">Trails are rated by these slopes · press D to color the mountain by them</div>
      <div class="rows">${[0, 1, 2, 3].map(row).join('')}</div>
      <div class="slider">
        <div class="track">${[0, 1, 2, 3].map((i) => `<span style="background:${RATINGS[i].color}"></span>`).join('')}</div>
        ${between.map((label, i) => `<div class="thumb" data-i="${i}" tabindex="0" role="slider"
          aria-label="${label}" aria-valuemin="0" aria-valuemax="${SLIDER_MAX * 100}"></div>`).join('')}
      </div>
      <div class="scale"><span>0%</span><span>Drag the handles</span><span>${SLIDER_MAX * 100}%</span></div>
      <div class="degrees"></div>
      <div class="smoothing">
        <div class="label"><span>Smoothing</span><span class="value"></span></div>
        <input type="range" min="${SMOOTHING.min}" max="${SMOOTHING.max}" step="${SMOOTHING.step}" value="${smoothing}">
        <div class="hint">Wider = broader, calmer bands · narrower = more local detail</div>
      </div>
      <button class="reset">Reset to defaults</button>`;

    const smooth = this.el.querySelector('.smoothing input');
    smooth.addEventListener('input', () => setSmoothing(Number(smooth.value)));
    this.el.querySelector('.close').addEventListener('click', () => this.toggleSettings());
    this.el.querySelector('.reset').addEventListener('click', () => {
      resetThresholds();
      setSmoothing(SMOOTHING.default);
    });

    // Dragging: a press anywhere on the slider takes the nearest handle there.
    const slider = this.el.querySelector('.slider');
    const thumbs = [...slider.querySelectorAll('.thumb')];
    const valueAt = (clientX) => {
      const r = slider.getBoundingClientRect();
      return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * SLIDER_MAX * 100) / 100;
    };
    slider.addEventListener('pointerdown', (e) => {
      const v = valueAt(e.clientX);
      // Nearest handle; where two sit together, the one that can move that way.
      let i = 0, best = Infinity;
      thresholds.forEach((t, k) => {
        const d = Math.abs(t - v);
        if (d < best - 1e-9 || (Math.abs(d - best) < 1e-9 && v > t)) { best = d; i = k; }
      });
      e.preventDefault();
      this.dragging = i;
      try { slider.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      thumbs[i].focus();
      setThreshold(i, v);
    });
    slider.addEventListener('pointermove', (e) => {
      if (this.dragging !== null) setThreshold(this.dragging, valueAt(e.clientX));
    });
    const stop = () => { this.dragging = null; };
    slider.addEventListener('pointerup', stop);
    slider.addEventListener('pointercancel', stop);
    // Arrow keys nudge the focused handle 1 % (5 % with Shift).
    thumbs.forEach((thumb, i) => thumb.addEventListener('keydown', (e) => {
      const dir = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      setThreshold(i, Math.round((thresholds[i] + dir * (e.shiftKey ? 0.05 : 0.01)) * 100) / 100);
    }));
    this.#sync();
  }

  /** Show the current thresholds and smoothing. Runs after any change to either. */
  #sync() {
    const t = thresholds;
    const pct = (v) => `${Math.round(v * 100)}%`;
    const ranges = [`below ${pct(t[0])}`, `${pct(t[0])} – ${pct(t[1])}`, `${pct(t[1])} – ${pct(t[2])}`, `${pct(t[2])} and up`];
    this.el.querySelectorAll('.range').forEach((el) => { el.textContent = ranges[Number(el.dataset.r)]; });
    // Band widths and handle positions along the slider.
    const at = (v) => Math.min(1, Math.max(0, v / SLIDER_MAX));
    const edges = [0, at(t[0]), at(t[1]), at(t[2]), 1];
    this.el.querySelectorAll('.track span').forEach((el, i) => { el.style.flexBasis = `${(edges[i + 1] - edges[i]) * 100}%`; });
    this.el.querySelectorAll('.thumb').forEach((el, i) => {
      el.style.left = `${edges[i + 1] * 100}%`;
      el.setAttribute('aria-valuenow', String(Math.round(t[i] * 100)));
      el.setAttribute('aria-valuetext', `${pct(t[i])} (${toDegrees(t[i])}°)`);
      el.title = `${pct(t[i])} · ${toDegrees(t[i])}°`;
    });
    this.el.querySelector('.degrees').textContent = `In degrees: ${t.map((v) => `${toDegrees(v)}°`).join(' · ')}`;
    const smooth = this.el.querySelector('.smoothing input');
    if (document.activeElement !== smooth) smooth.value = smoothing;
    this.el.querySelector('.smoothing .value').textContent = `${smoothing} m`;
  }
}
