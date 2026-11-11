const SAVE_KEY = 'ascutney-collapsed-v1';

/** Which boxes were left collapsed, by name. */
function load() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) ?? {}; } catch { return {}; }
}

/**
 * The little arrow that collapses a box to its title row, or expands it.
 * The box gets the class `collapsed`, and its stylesheet hides the rest.
 * The state is remembered in this browser under `name`, unless `remember`
 * is false (the box then manages it itself, see DifficultyLegend).
 * Used by the info box (main.js), the trail panel and the difficulty panel.
 */
export class CollapseToggle {
  /**
   * @param {HTMLElement} box   the box that collapses
   * @param {{ name: string, label: string, collapsed?: boolean, remember?: boolean,
   *   onChange?: (collapsed: boolean) => void }} opts
   *   label: what the box is called, for the button's tooltip and screen readers;
   *   collapsed: the starting state when nothing is remembered yet.
   */
  constructor(box, { name, label, collapsed = false, remember = true, onChange }) {
    Object.assign(this, { box, name, label, remember, onChange });
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'collapse';
    this.button.addEventListener('click', () => {
      this.set(!this.collapsed);
      this.onChange?.(this.collapsed);
    });
    this.set(remember ? (load()[name] ?? collapsed) : collapsed, { save: false });
  }

  /** Collapse (true) or expand (false) the box, remembering it unless `save` is false. */
  set(collapsed, { save = true } = {}) {
    this.collapsed = collapsed;
    this.box.classList.toggle('collapsed', collapsed);
    this.button.setAttribute('aria-expanded', String(!collapsed));
    this.button.title = `${collapsed ? 'Expand' : 'Collapse'} ${this.label}`;
    this.button.setAttribute('aria-label', this.button.title);
    if (save && this.remember) {
      const all = load();
      all[this.name] = collapsed;
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(all)); } catch { /* storage blocked */ }
    }
  }
}
