const SEEN_KEY = 'ascutney-intro-seen';

/**
 * A short welcome for first-time visitors: what they're looking at and what
 * they can do, with buttons to generate a ski resort, see the controls, or
 * just explore. Shown once per browser (remembered in localStorage). The page
 * behind is only lightly dimmed, so the trails clearing the forest still
 * shows. Created once in main.js.
 */
export class IntroCard {
  /**
   * Builds the hidden card.
   * @param {{ onGenerate: () => void, onControls: () => void }} opts  what its buttons open
   */
  constructor({ onGenerate, onControls }) {
    this.el = document.createElement('div');
    this.el.id = 'intro';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="card" role="dialog" aria-labelledby="intro-title">
        <button class="close" aria-label="Close">×</button>
        <h2 id="intro-title">Mount Ascutney, Vermont</h2>
        <p class="points"></p>
        <p>Draw ski trails and the forest is cleared along them, each rated by how steep it is.
          Or generate a whole ski area, lifts and runs, in a few seconds.</p>
        <div class="actions">
          <button class="primary generate">Generate ski resort</button>
          <button class="controls">See the controls</button>
          <button class="explore">Just explore</button>
        </div>
      </div>`;
    document.body.appendChild(this.el);

    const on = (cls, fn) => this.el.querySelector(cls).addEventListener('click', fn);
    on('.close', () => this.close());
    on('.explore', () => this.close());
    on('.generate', () => { this.close(); onGenerate(); });
    on('.controls', () => { this.close(); onControls(); });
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) { e.stopPropagation(); this.close(); }
    }, true);
  }

  /**
   * Show the card unless this browser has seen it before. `points` is how many
   * points were loaded, for the description. Called by main.js once loading finishes.
   */
  showIfFirstVisit(points) {
    try {
      if (localStorage.getItem(SEEN_KEY)) return;
    } catch { /* storage blocked: show it every time rather than never */ }
    this.el.querySelector('.points').textContent =
      `A LiDAR scan of the whole mountain: ${(points / 1e6).toFixed(1)} million laser points ` +
      'showing every tree and the ground beneath them.';
    this.el.hidden = false;
    this.el.querySelector('.generate').focus();
  }

  /** Hide the card and remember it was seen. */
  close() {
    this.el.hidden = true;
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage blocked: nothing to remember */ }
  }
}
