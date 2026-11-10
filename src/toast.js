let el = null;
let timer = 0;

/**
 * Brief message at the bottom of the screen. Used by the trail lock and by
 * the editor for generation warnings.
 * @param {string} text
 * @param {number} [ms]  how long it stays up
 */
export function showToast(text, ms = 2200) {
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
    void el.offsetWidth; // let the first message fade in like the others
  }
  el.textContent = text;
  el.classList.add('visible');
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('visible'), ms);
}
