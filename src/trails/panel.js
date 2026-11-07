import { RATINGS } from '../difficulty.js';

/**
 * Bottom-left panel for the selected trail (or the one being drawn):
 * editable name, length, vertical, rating, and the pitch breakdown.
 *
 * It's updated in place rather than rebuilt, so typing in the name field
 * isn't interrupted by the many refreshes that happen as the mouse moves.
 */
export class TrailPanel {
  /** @param {{ onRename: (trailId: string, name: string) => void }} opts */
  constructor({ onRename }) {
    this.onRename = onRename;
    this.trailId = null;

    this.el = document.createElement('div');
    this.el.id = 'trail-panel';
    this.el.hidden = true;
    this.el.innerHTML = `
      <input class="name" type="text" spellcheck="false" maxlength="40" aria-label="Trail name">
      <div class="drawing"></div>
      <div class="stats"></div>
      <div class="bar"></div>
      <div class="breakdown"></div>
      <div class="point"></div>
      <div class="hint"></div>`;
    document.body.appendChild(this.el);

    this.name = this.el.querySelector('.name');
    const commit = () => {
      const v = this.name.value.trim();
      if (this.trailId && v && v !== this.currentName) this.onRename(this.trailId, v);
      else this.name.value = this.currentName ?? '';
    };
    this.name.addEventListener('change', commit);
    this.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.name.blur();
      if (e.key === 'Escape') { this.name.value = this.currentName ?? ''; this.name.blur(); }
      e.stopPropagation(); // typing here never triggers shortcuts
    });
  }

  /**
   * @param {null | {kind:'drawing', points:number}
   *   | {kind:'trail', trailId:string, name:string, stats:object|null,
   *      point: null | {index:number, count:number, junction:boolean, width:number}}} state
   */
  render(state) {
    this.el.hidden = !state;
    if (!state) { this.trailId = null; return; }
    const q = (sel) => this.el.querySelector(sel);

    if (state.kind === 'drawing') {
      this.trailId = null;
      this.name.hidden = true;
      q('.drawing').hidden = false;
      q('.drawing').innerHTML = `<b>New trail</b> · ${state.points} point${state.points === 1 ? '' : 's'}`;
      for (const s of ['.stats', '.bar', '.breakdown', '.point']) q(s).hidden = true;
      q('.hint').textContent = 'Click to add points · double-click or Enter to finish · Esc to cancel';
      return;
    }

    q('.drawing').hidden = true;
    this.name.hidden = false;
    // Only overwrite the field if it isn't being edited (or the trail changed).
    if (state.trailId !== this.trailId || document.activeElement !== this.name) {
      this.name.value = state.name;
    }
    this.trailId = state.trailId;
    this.currentName = state.name;

    const st = state.stats;
    for (const s of ['.stats', '.bar', '.breakdown']) q(s).hidden = !st;
    if (st) {
      q('.stats').innerHTML =
        `${st.length.toFixed(0)} m long · ${st.vertical.toFixed(0)} m vertical · ` +
        `<span class="rating" style="color:${st.rating.color}">${st.rating.name}</span>`;
      q('.bar').innerHTML = st.shares
        .map((f, i) => (f > 0 ? `<span style="flex:${f};background:${RATINGS[i].color}"></span>` : ''))
        .join('');
      q('.breakdown').textContent = st.shares
        .map((f, i) => [f, RATINGS[i].name])
        .filter(([f]) => f >= 0.005)
        .map(([f, name]) => `${Math.round(f * 100)}% ${name}`)
        .join(' · ');
    }

    const p = state.point;
    q('.point').hidden = !p;
    if (p) {
      q('.point').textContent =
        `Point ${p.index + 1}/${p.count}${p.junction ? ' (junction)' : ''} · width ${p.width.toFixed(0)} m`;
    }
    q('.hint').textContent = p
      ? 'Drag handles or − = for width · Del removes · B branches'
      : 'Double-click the trail to add a point · drag points to reshape · F to frame';
  }
}
