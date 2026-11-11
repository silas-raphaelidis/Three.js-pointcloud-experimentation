import { randomSeed } from './random.js';

const LIMITS = { bases: [1, 3], lifts: [1, 12], runs: [3, 40] };
const DEFAULTS = { bases: 2, lifts: 6, runs: 25 };
const SAVE_KEY = 'ascutney-mountain-settings';
const MAX_SEED = 999999;

/**
 * The Generate ski resort panel, opened from its button on the top bar: how
 * many bases, lifts and runs to aim for, and the seed. A new random seed is
 * filled in every time it opens, so each generation differs; typing a seed
 * repeats a mountain. The counts are remembered between visits.
 */
export class MountainDialog {
  /**
   * Builds the hidden panel. Created once in main.js.
   * @param {{ anchor: HTMLElement, onGenerate: (settings: {bases:number, lifts:number, runs:number, seed:number}) => void }} opts
   *   anchor: the top bar button the panel opens under
   */
  constructor({ anchor, onGenerate }) {
    this.anchor = anchor;
    this.onGenerate = onGenerate;

    this.el = document.createElement('div');
    this.el.id = 'mountain-dialog';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="title">Generate ski resort</div>
      ${stepper('bases', 'Bases')}
      ${stepper('lifts', 'Lifts')}
      ${stepper('runs', 'Runs')}
      <div class="field">
        <span>Seed</span>
        <div class="seed">
          <input name="seed" type="number" min="0" max="${MAX_SEED}" aria-label="Seed">
          <button class="reroll" title="New random seed" aria-label="New random seed">🎲</button>
        </div>
      </div>
      <p class="note">Replaces your trails and lifts. Ctrl+Z undoes it.</p>
      <div class="actions">
        <button class="cancel">Cancel</button>
        <button class="go">Generate</button>
      </div>`;
    document.body.appendChild(this.el);

    this.inputs = Object.fromEntries(['bases', 'lifts', 'runs', 'seed'].map((k) => [k, this.el.querySelector(`[name=${k}]`)]));
    for (const button of this.el.querySelectorAll('[data-step]')) {
      button.addEventListener('click', () => {
        const input = this.inputs[button.dataset.field];
        input.value = Number(input.value) + Number(button.dataset.step);
        this.#clamp(button.dataset.field);
      });
    }
    for (const k of ['bases', 'lifts', 'runs']) this.inputs[k].addEventListener('change', () => this.#clamp(k));
    this.el.querySelector('.reroll').addEventListener('click', () => { this.inputs.seed.value = randomSeed(); });
    this.el.querySelector('.cancel').addEventListener('click', () => this.close());
    this.el.querySelector('.go').addEventListener('click', () => this.#generate());

    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.#generate(); }
      if (e.key === 'Escape') this.close();
      e.stopPropagation(); // typing here never triggers shortcuts
    });
    // Close on a press anywhere else (the button toggles it itself).
    addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target) && !this.anchor.contains(e.target)) this.close();
    }, true);
    addEventListener('resize', () => this.close());
  }

  /** Is the panel showing? */
  get isOpen() { return !this.el.hidden; }

  /** Open under the anchor with the remembered counts and a new seed. Used by the top bar button. */
  open() {
    const saved = loadSettings();
    for (const k of ['bases', 'lifts', 'runs']) this.inputs[k].value = saved[k];
    this.inputs.seed.value = randomSeed();
    this.#clamp('bases');
    this.el.hidden = false; // shown first, so its width can be measured
    const r = this.anchor.getBoundingClientRect();
    this.el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - this.el.offsetWidth - 8))}px`;
    this.el.querySelector('.go').focus();
  }

  /** Hide the panel. Focus leaves it too, so keys (like Esc to cancel) reach the app again. */
  close() {
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
    this.el.hidden = true;
  }

  /** Open if closed, close if open. Used by the top bar button. */
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /**
   * Keep a field and the ones after it in range: lifts at least the bases
   * (each base needs one), runs at least the lifts (each lift needs a way down).
   */
  #clamp(field) {
    const order = ['bases', 'lifts', 'runs'];
    for (const k of order.slice(order.indexOf(field))) {
      const prev = order[order.indexOf(k) - 1];
      const lo = Math.max(LIMITS[k][0], prev ? Number(this.inputs[prev].value) : 0);
      const v = Math.round(Number(this.inputs[k].value)) || lo;
      this.inputs[k].value = Math.min(LIMITS[k][1], Math.max(lo, v));
    }
  }

  /** Read the fields, remember the counts, close and start generating. */
  #generate() {
    this.#clamp('bases');
    const settings = Object.fromEntries(['bases', 'lifts', 'runs'].map((k) => [k, Number(this.inputs[k].value)]));
    const seed = Math.round(Number(this.inputs.seed.value));
    settings.seed = this.inputs.seed.value !== '' && seed >= 0 && seed <= MAX_SEED ? seed : randomSeed();
    saveSettings(settings);
    this.close();
    this.onGenerate(settings);
  }
}

/** HTML for one count with − and + buttons. Used by the constructor. */
function stepper(name, label) {
  const [min, max] = LIMITS[name];
  return `
    <div class="field">
      <span>${label}</span>
      <div class="stepper">
        <button data-field="${name}" data-step="-1" aria-label="Fewer ${name}">−</button>
        <input name="${name}" type="number" min="${min}" max="${max}" aria-label="${label}">
        <button data-field="${name}" data-step="1" aria-label="More ${name}">+</button>
      </div>
    </div>`;
}

/** The counts used last time, or the defaults. Storage can be blocked, so this never throws. */
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (saved) return { ...DEFAULTS, ...saved };
  } catch { /* blocked or bad data: use the defaults */ }
  return { ...DEFAULTS };
}

/** Remember the counts (not the seed, which is new each time). */
function saveSettings({ bases, lifts, runs }) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ bases, lifts, runs }));
  } catch { /* storage blocked: just don't remember */ }
}
