/**
 * Top menu bar (Unity-style): dropdown menus and toggle buttons.
 *
 * Menu items:
 *   { type: 'toggle', label, shortcut, get: () => bool, set: (bool) => void }
 *   { type: 'radio',  label, shortcut, get: () => bool, set: () => void }   one of a group
 *   { type: 'header', label }                                                 section title
 *   { type: 'range',  label, min, max, step, get: () => number, set: (n) => void, format?: (n) => string }
 *   { type: 'action', label, shortcut, action: () => void, enabled?: () => bool }
 *   { type: 'separator' }
 *
 * Items read their state through get(), so menus always show the truth even
 * when something changed via a keyboard shortcut; call refresh() after such
 * changes to update anything already on screen.
 */
export class MenuBar {
  constructor() {
    this.el = document.createElement('nav');
    this.el.id = 'menubar';
    document.body.appendChild(this.el);
    this.menus = [];     // { button, panel, items }
    this.buttons = [];   // { el, get }
    this.open = null;

    addEventListener('pointerdown', (e) => { if (this.open && !this.el.contains(e.target)) this.close(); }, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.open) { e.stopPropagation(); this.close(); } }, true);
    addEventListener('resize', () => this.close());
  }

  /** A dropdown menu. */
  addMenu(label, items) {
    const wrap = document.createElement('div');
    wrap.className = 'menu';
    const button = document.createElement('button');
    button.className = 'menu-button';
    button.innerHTML = `${label} <span class="caret">▾</span>`;
    const panel = document.createElement('div');
    panel.className = 'menu-panel';
    panel.hidden = true;
    wrap.append(button, panel);
    this.el.appendChild(wrap);

    const menu = { button, panel, items };
    this.menus.push(menu);
    button.addEventListener('click', () => (this.open === menu ? this.close() : this.#openMenu(menu)));
    // Like desktop menu bars: once one menu is open, hovering another opens it.
    button.addEventListener('pointerenter', () => { if (this.open && this.open !== menu) this.#openMenu(menu); });
    return menu;
  }

  /** A button on the bar that toggles something on and off. */
  addToggleButton({ label, shortcut, get, set }) {
    const el = document.createElement('button');
    el.className = 'bar-toggle';
    el.innerHTML = `${label}${shortcut ? ` <kbd>${shortcut}</kbd>` : ''}`;
    el.addEventListener('click', () => { set(!get()); this.refresh(); el.blur(); });
    this.el.appendChild(el);
    this.buttons.push({ el, get });
    this.refresh();
    return el;
  }

  /** A plain button on the bar. */
  addButton({ label, shortcut, action }) {
    const el = document.createElement('button');
    el.className = 'bar-button';
    el.innerHTML = `${label}${shortcut ? ` <kbd>${shortcut}</kbd>` : ''}`;
    el.addEventListener('click', () => { action(); el.blur(); });
    this.el.appendChild(el);
    return el;
  }

  /** Re-read every item's state (after a shortcut changed something). */
  refresh() {
    for (const b of this.buttons) b.el.classList.toggle('active', !!b.get());
    if (this.open) this.#render(this.open);
  }

  close() {
    if (!this.open) return;
    this.open.panel.hidden = true;
    this.open.button.classList.remove('open');
    this.open = null;
  }

  #openMenu(menu) {
    this.close();
    this.open = menu;
    menu.button.classList.add('open');
    menu.panel.hidden = false;
    this.#render(menu);
  }

  #render(menu) {
    menu.panel.replaceChildren(...menu.items.map((item) => this.#row(item)));
  }

  #row(item) {
    const row = document.createElement('div');
    if (item.type === 'separator') {
      row.className = 'sep';
      return row;
    }
    const kbd = item.shortcut ? `<kbd>${item.shortcut}</kbd>` : '';

    if (item.type === 'header') {
      row.className = 'header';
      row.textContent = item.label;
      return row;
    }

    if (item.type === 'radio') {
      const on = !!item.get();
      row.className = `row radio${on ? ' on' : ''}`;
      row.innerHTML = `<span class="check">${on ? '●' : ''}</span><span class="label">${item.label}</span>${kbd}`;
      row.addEventListener('click', () => { item.set(); this.refresh(); });
      return row;
    }

    if (item.type === 'toggle') {
      const on = !!item.get();
      row.className = `row toggle${on ? ' on' : ''}`;
      row.innerHTML = `<span class="check">${on ? '✓' : ''}</span><span class="label">${item.label}</span>${kbd}`;
      row.addEventListener('click', () => { item.set(!item.get()); this.refresh(); });
      return row;
    }

    if (item.type === 'range') {
      row.className = 'row range';
      const fmt = item.format ?? ((v) => v.toFixed(1));
      row.innerHTML = `<span class="check"></span><span class="label">${item.label}</span><span class="value">${fmt(item.get())}</span>`;
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: item.min, max: item.max, step: item.step, value: item.get() });
      input.addEventListener('input', () => {
        item.set(Number(input.value));
        row.querySelector('.value').textContent = fmt(item.get());
      });
      row.appendChild(input);
      return row;
    }

    // action
    const enabled = item.enabled ? item.enabled() : true;
    row.className = `row action${enabled ? '' : ' disabled'}`;
    row.innerHTML = `<span class="check"></span><span class="label">${item.label}</span>${kbd}`;
    if (enabled) row.addEventListener('click', () => { this.close(); item.action(); });
    return row;
  }
}
