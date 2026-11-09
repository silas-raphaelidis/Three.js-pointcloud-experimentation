/**
 * Full-page loading screen with a progress bar. Covers the scene until
 * everything is ready, then fades out. Can also show a fatal error with a
 * Reload button.
 */
export class LoadingScreen {
  /** Builds the screen and shows it immediately. Created once in main.js. */
  constructor(title) {
    this.el = document.createElement('div');
    this.el.id = 'loading';
    this.el.innerHTML = `
      <div class="card">
        <h1>${title}</h1>
        <div class="bar"><div class="fill"></div></div>
        <div class="status">Starting…</div>
        <div class="detail"></div>
      </div>`;
    document.body.appendChild(this.el);
    this.fill = this.el.querySelector('.fill');
    this.status = this.el.querySelector('.status');
    this.detail = this.el.querySelector('.detail');
  }

  /**
   * Set the progress bar and status text. Used throughout load() in main.js.
   * @param {number} fraction 0..1   @param {string} status   @param {string} [detail]
   */
  update(fraction, status, detail = '') {
    this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    this.status.textContent = status;
    this.detail.textContent = detail;
  }

  /** Show a fatal error and a Reload button. Used when load() in main.js fails. */
  fail(message) {
    this.el.classList.add('failed');
    this.status.textContent = 'Couldn’t load the scene';
    this.detail.textContent = message;
    const button = document.createElement('button');
    button.textContent = 'Reload';
    button.addEventListener('click', () => location.reload());
    this.el.querySelector('.card').appendChild(button);
  }

  /** Fade out and remove. Resolves when the fade has finished. Used at the end of load() in main.js. */
  hide() {
    this.el.classList.add('done');
    return new Promise((resolve) => {
      setTimeout(() => { this.el.remove(); resolve(); }, 450);
    });
  }
}
