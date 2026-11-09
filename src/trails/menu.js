/**
 * A small right-click menu. Items:
 *   { label, action }                         clickable row
 *   { type: 'header', label }                 non-clickable title
 *   { type: 'separator' }
 *   { type: 'number', label, value, min, max, step, suffix, onChange }
 *   { type: 'text', label, value, onSubmit }  Enter to apply
 *   { ..., danger: true }                     red row (deletes)
 */
export class ContextMenu {
  /** Builds the hidden menu and its close-on-outside listeners. Created once by TrailEditor. */
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'context-menu';
    this.el.hidden = true;
    document.body.appendChild(this.el);

    // Close on any press outside, Escape, scroll, or resize.
    addEventListener('pointerdown', (e) => { if (!this.el.contains(e.target)) this.close(); }, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) { e.stopPropagation(); this.close(); } }, true);
    addEventListener('wheel', () => this.close(), { capture: true, passive: true });
    addEventListener('resize', () => this.close());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Is the menu showing? Used by its own Escape handler. */
  get isOpen() { return !this.el.hidden; }

  /** Show the menu at a screen position, kept on screen. Used by TrailEditor.#openMenu. */
  open(x, y, items) {
    this.el.replaceChildren(...items.map((item) => this.#row(item)));
    this.el.hidden = false;
    // Keep it on screen.
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    this.el.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  }

  /** Hide the menu. Used by the close listeners and when a row is used. */
  close() { this.el.hidden = true; }

  /** Build the DOM for one menu item (see the item types at the top). Used by open. */
  #row(item) {
    const row = document.createElement('div');
    if (item.type === 'separator') {
      row.className = 'sep';
      return row;
    }
    if (item.type === 'header') {
      row.className = 'header';
      row.textContent = item.label;
      return row;
    }
    if (item.type === 'number' || item.type === 'text') {
      row.className = 'field';
      const label = document.createElement('label');
      label.textContent = item.label;
      const input = document.createElement('input');
      input.type = item.type;
      input.value = item.value;
      if (item.type === 'number') {
        Object.assign(input, { min: item.min, max: item.max, step: item.step ?? 1 });
        input.addEventListener('input', () => {
          const v = Number(input.value);
          if (Number.isFinite(v)) item.onChange(Math.min(item.max, Math.max(item.min, v)));
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.close(); });
      } else {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { item.onSubmit(input.value.trim()); this.close(); }
        });
      }
      label.appendChild(input);
      if (item.suffix) label.append(` ${item.suffix}`);
      row.appendChild(label);
      return row;
    }
    row.className = item.danger ? 'item danger' : 'item';
    row.textContent = item.label;
    row.addEventListener('click', () => { this.close(); item.action(); });
    return row;
  }
}
