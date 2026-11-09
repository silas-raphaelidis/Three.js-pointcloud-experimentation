/**
 * Trail lock: a button on the left edge of the screen. While locked, trails
 * can't be selected or edited. nudge() is called when someone tries anyway:
 * the button shakes and a message appears at the bottom of the screen.
 */

const ICON_LOCKED = `
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/>
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/>
  </svg>`;
const ICON_UNLOCKED = `
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/>
    <path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7" fill="none" stroke="currentColor" stroke-width="2"/>
  </svg>`;

export class TrailLock {
  /**
   * Creates the button and toast message. Created once in main.js.
   * @param {{ onChange: (locked: boolean) => void }} opts
   */
  constructor({ onChange }) {
    this.onChange = onChange;
    this.locked = false;

    this.button = document.createElement('button');
    this.button.id = 'trail-lock';
    this.button.addEventListener('click', () => { this.toggle(); this.button.blur(); });
    document.body.appendChild(this.button);

    this.toast = document.createElement('div');
    this.toast.id = 'toast';
    document.body.appendChild(this.toast);
    this.toastTimer = 0;

    this.#render();
  }

  /** Flip the lock. Used by the button and the L key (main.js). */
  toggle() { this.set(!this.locked); }

  /** Apply a lock state, update the icon, notify onChange and show a message. Used by toggle. */
  set(locked) {
    this.locked = locked;
    this.#render();
    this.onChange?.(locked);
    this.show(locked ? 'Trail selection locked' : 'Trail selection unlocked', 1200);
  }

  /**
   * Someone tried to select a trail while locked: shake the button and say so.
   * Passed to TrailEditor as onLocked (main.js).
   */
  nudge() {
    this.show('Trail selection is locked · press L or the lock to unlock');
    this.button.classList.remove('shake');
    void this.button.offsetWidth; // restart the animation
    this.button.classList.add('shake');
  }

  /** Brief message at the bottom of the screen. Used by set and nudge. */
  show(text, ms = 2200) {
    this.toast.textContent = text;
    this.toast.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('visible'), ms);
  }

  /** Update the icon, tooltip and pressed state. Used by the constructor and set. */
  #render() {
    this.button.innerHTML = this.locked ? ICON_LOCKED : ICON_UNLOCKED;
    this.button.classList.toggle('locked', this.locked);
    this.button.title = this.locked ? 'Trails locked: click or press L to unlock' : 'Lock trail selection (L)';
    this.button.setAttribute('aria-pressed', String(this.locked));
  }
}
