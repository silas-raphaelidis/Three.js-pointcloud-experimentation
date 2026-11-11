/**
 * Buttons at the bottom of the screen for what you can do right now, each
 * with its shortcut: finish or cancel a trail being drawn, delete or widen
 * the selected points, frame or delete the selected trail, and so on. The
 * editor decides which (TrailEditor.actions); this only draws them. Sits
 * bottom-center, or stacks above the trail panel when the screen is too
 * narrow for both side by side. Created once in main.js.
 */
export class ActionBar {
  /**
   * Builds the hidden bar.
   * @param {{ avoid: HTMLElement }} opts  the trail panel, which the bar must not cover
   */
  constructor({ avoid }) {
    this.avoid = avoid;
    this.key = '';
    this.el = document.createElement('div');
    this.el.id = 'action-bar';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    addEventListener('resize', () => this.#place());
  }

  /**
   * Show these actions, or hide the bar for none. Buttons are only rebuilt
   * when the list changes, since this runs on every mouse move.
   * Called from onStatus in main.js.
   * @param {Array<{label:string, key?:string, run:() => void, danger?:boolean,
   *   primary?:boolean, disabled?:boolean, active?:boolean} | {type:'separator'}>} actions
   *   `active` marks the picked one of a set of choices; a label may hold icon HTML.
   */
  render(actions) {
    const key = actions.map((a) => `${a.type}|${a.label}|${a.key}|${a.disabled ? 1 : 0}|${a.active ? 1 : 0}`).join(';');
    if (key !== this.key) {
      this.key = key;
      this.el.replaceChildren(...actions.map((a, i) => {
        if (a.type === 'separator') {
          const line = document.createElement('span');
          line.className = 'separator';
          return line;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = `<span>${a.label}</span>${a.key ? `<kbd>${a.key}</kbd>` : ''}`;
        b.classList.toggle('danger', !!a.danger);
        b.classList.toggle('primary', !!a.primary);
        b.classList.toggle('active', !!a.active);
        if (a.active !== undefined) b.setAttribute('aria-pressed', String(!!a.active));
        b.disabled = !!a.disabled;
        b.addEventListener('click', () => this.actions[i]?.run());
        return b;
      }));
      this.el.hidden = actions.length === 0;
    }
    // Keep the latest closures, so a click always acts on the current state.
    this.actions = actions;
    this.#place();
  }

  /** Center the bar, or move it above the trail panel if they would overlap. */
  #place() {
    if (this.el.hidden) return;
    this.el.classList.remove('stacked');
    this.el.style.bottom = '';
    if (this.avoid.hidden) return;
    const bar = this.el.getBoundingClientRect();
    const panel = this.avoid.getBoundingClientRect();
    if (bar.left < panel.right + 8 && bar.top < panel.bottom) {
      this.el.classList.add('stacked');
      this.el.style.bottom = `${innerHeight - panel.top + 8}px`;
    }
  }
}
