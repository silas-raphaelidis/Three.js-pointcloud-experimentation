/**
 * The Controls panel: every mouse and keyboard control, grouped by what
 * you're doing, one action per row with its keys on the right. A single
 * scrolling column that opens on the Camera controls, with the rest below.
 * Opens over everything with the page dimmed behind it; closes with ×, Esc,
 * or a click outside. Created once in main.js and opened by the Controls
 * button, ? and the welcome card.
 */

/** Keys pressed together, as key caps: key('Ctrl', 'Z'). */
const key = (...keys) => keys.map((k) => `<kbd>${k}</kbd>`).join('<span class="join">+</span>');
/** Alternatives for the same action. */
const or = (...ways) => ways.join('<span class="join">or</span>');
/** One action and how to do it. */
const row = (what, how) => `<div class="row"><span class="what">${what}</span><span class="how">${how}</span></div>`;
/** A titled group of rows. */
const section = (title, rows) => `<section><h4>${title}</h4>${rows.join('')}</section>`;

const SECTIONS = [
  section('Camera', [
    row('Orbit', 'Drag'),
    row('Pan', `${key('Shift')} + drag`),
    row('Zoom to the cursor', 'Wheel'),
    row('Zoom', `${key('Ctrl')} + middle-drag`),
    row('Orbit on a trackpad', `${key('Alt')} + drag`),
    row('Pan on a trackpad', `${key('Shift')} + ${key('Alt')} + drag`),
    row('Frame the selected trail', key('F')),
    row('Frame the whole mountain', key('Home')),
  ]),
  section('Drawing trails and lifts', [
    row('Start a trail or lift', 'Right-click terrain'),
    row('Add a point', 'Click'),
    row('Route the next stretch at a difficulty', `${key('1')} – ${key('4')}`),
    row('Draw by hand again', key('H')),
    row('Generate a trail', 'Pick a difficulty, click its end'),
    row('Finish the trail', or('Double-click', key('Enter'))),
    row('Remove the last point or stretch', key('Ctrl', 'Z')),
    row('Place a lift’s top', 'Click once more'),
    row('Cancel', key('Esc')),
  ]),
  section('Undo', [
    row('Undo', key('Ctrl', 'Z')),
    row('Redo', key('Ctrl', 'Shift', 'Z')),
    row('Cancel generating a mountain', key('Esc')),
  ]),
  section('Editing a trail', [
    row('Show its points', 'Hover it'),
    row('Select it', 'Click it'),
    row('Add a point', 'Double-click it'),
    row('Move a point', 'Drag it'),
    row('Merge two points', 'Drag one onto its neighbor'),
    row('Select more points', 'Shift-click them'),
    row('Change the width', or('Drag a side handle', `${key('−')} ${key('=')}`)),
    row('Start a trail from a point', or('Right-click it', key('B'))),
    row('Delete the selected points or trail', key('Delete')),
    row('More options', 'Right-click'),
    row('Lock or unlock editing', key('L')),
  ]),
  section('View', [
    row('Vegetation', key('V')),
    row('Color by slope difficulty', key('D')),
    row('Adjust the difficulty slopes', 'Click the trail color key'),
    row('Trail and lift lines', key('T')),
    row('Point size', `${key('[')} ${key(']')}`),
    row('FPS counter', key('P')),
    row('This panel', key('?')),
  ]),
];

export class HelpPanel {
  /** Builds the hidden panel and its close handlers. */
  constructor() {
    this.onClose = null; // called once when the panel next closes (see open)
    this.el = document.createElement('div');
    this.el.id = 'help';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="dialog" role="dialog" aria-label="Controls">
        <div class="head">
          <h3>Controls</h3>
          <button class="close" aria-label="Close">×</button>
        </div>
        <div class="sections">${SECTIONS.join('')}</div>
        <div class="more" aria-hidden="true">Scroll for more ↓</div>
      </div>`;
    document.body.appendChild(this.el);
    this.dialog = this.el.querySelector('.dialog');
    this.more = this.el.querySelector('.more');

    this.el.querySelector('.close').addEventListener('click', () => this.close());
    // A click on the dimmed page around the panel closes it.
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
    // Esc closes it, and nothing else sees that key press: not even the
    // welcome card, which closing can bring back.
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) { e.stopImmediatePropagation(); this.close(); }
    }, true);
    // The "scroll for more" cue goes once you reach the bottom.
    this.dialog.addEventListener('scroll', () => this.#updateCue());
    addEventListener('resize', () => { if (this.isOpen) this.#fitToCamera(); });
  }

  /** Is the panel showing? */
  get isOpen() { return !this.el.hidden; }

  /**
   * Show the panel at the top, sized so the Camera controls (the ones
   * everyone needs) fill the first view and the rest is a scroll away.
   * `onClose`, if given, runs once when it's next closed: the welcome card
   * uses it to come back.
   */
  open(onClose = null) {
    this.onClose = onClose;
    this.el.hidden = false;
    this.dialog.scrollTop = 0;
    this.#fitToCamera();
  }

  /** Hide the panel, then run the onClose given to open, if any. */
  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    const then = this.onClose;
    this.onClose = null;
    then?.();
  }

  /** Open if closed, close if open. Used by the Controls button and the ? key. */
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /**
   * Limit the panel's height to the Camera section plus a peek at the next
   * heading, so it opens on the camera controls with the rest below.
   */
  #fitToCamera() {
    this.dialog.style.maxHeight = '';
    const camera = this.el.querySelector('section');
    const next = camera.nextElementSibling?.querySelector('h4');
    const peek = next ? next.offsetHeight + 34 : 0;
    const wanted = camera.offsetTop + camera.offsetHeight + peek + this.more.offsetHeight;
    this.dialog.style.maxHeight = `${Math.min(innerHeight - 32, wanted)}px`;
    this.#updateCue();
  }

  /** Show the scroll cue unless everything is already in view. */
  #updateCue() {
    const d = this.dialog;
    this.more.classList.toggle('done', d.scrollTop + d.clientHeight >= d.scrollHeight - 4);
  }
}
