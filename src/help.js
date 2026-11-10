/**
 * The Controls panel: every mouse and keyboard control, grouped by what
 * you're doing, one action per row with its keys on the right. Opens over
 * everything with the page dimmed behind it; closes with ×, Esc, or a click
 * outside. Created once in main.js and opened by the Controls button and ?.
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
    row('Finish the trail', or('Double-click', key('Enter'))),
    row('Place a lift’s top', 'Click once more'),
    row('Generate a trail', 'Right-click, pick a difficulty, click its end'),
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
    row('Change the width', or('Drag a side handle', `${key('−')} ${key('=')}`)),
    row('Branch a new trail', or('Shift-click', key('B'))),
    row('Remove a point', key('Delete')),
    row('More options', 'Right-click'),
    row('Lock or unlock editing', key('L')),
  ]),
  section('View', [
    row('Vegetation', key('V')),
    row('Ground surface', key('M')),
    row('Shading', key('E')),
    row('Color by height above ground', key('H')),
    row('Color by slope difficulty', key('D')),
    row('Trail and lift lines', key('T')),
    row('Ghost trails behind terrain', key('G')),
    row('Point size', `${key('[')} ${key(']')}`),
    row('FPS counter', key('P')),
    row('This panel', key('?')),
  ]),
];

export class HelpPanel {
  /** Builds the hidden panel and its close handlers. */
  constructor() {
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
      </div>`;
    document.body.appendChild(this.el);

    this.el.querySelector('.close').addEventListener('click', () => this.close());
    // A click on the dimmed page around the panel closes it.
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
    // Esc closes it before anything else sees the key.
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) { e.stopPropagation(); this.close(); }
    }, true);
  }

  /** Is the panel showing? */
  get isOpen() { return !this.el.hidden; }

  /** Show the panel. */
  open() { this.el.hidden = false; }

  /** Hide the panel. */
  close() { this.el.hidden = true; }

  /** Open if closed, close if open. Used by the Controls button and the ? key. */
  toggle() { this.el.hidden = !this.el.hidden; }
}
