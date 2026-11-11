import { RATINGS, ratingIcon, ratingLabel } from '../difficulty.js';
import { CollapseToggle } from '../collapse.js';

/**
 * Bottom-left panel for the selected trail (or the one being drawn):
 * editable name, length, vertical, rating, and the pitch breakdown.
 *
 * It's updated in place rather than rebuilt, so typing in the name field
 * isn't interrupted by the many refreshes that happen as the mouse moves.
 */
export class TrailPanel {
  /**
   * Builds the hidden panel and wires up the name field. Created once in main.js.
   * @param {{ onRename: (trailId: string, name: string) => void }} opts
   */
  constructor({ onRename }) {
    this.onRename = onRename;
    this.trailId = null;

    this.el = document.createElement('div');
    this.el.id = 'trail-panel';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="head">
        <input class="name" type="text" spellcheck="false" maxlength="40" aria-label="Trail name">
        <div class="drawing"></div>
      </div>
      <div class="stats"></div>
      <div class="bar"></div>
      <div class="breakdown"></div>
      <div class="uphill"></div>
      <div class="point"></div>
      <div class="hint"></div>`;
    document.body.appendChild(this.el);
    // The arrow collapses it to the trail's name.
    this.toggle = new CollapseToggle(this.el, { name: 'trail', label: 'trail details' });
    this.el.querySelector('.head').appendChild(this.toggle.button);

    this.name = this.el.querySelector('.name');
    // Apply a changed name, or restore the old one if the field is empty.
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
   * Show the given state, or hide the panel for null.
   * Called from onStatus in main.js on every editor refresh.
   * @param {null | {kind:'drawing', lift:boolean, points:number, mode:string|null, routing:boolean}
   *   | {kind:'trail', lift:boolean, trailId:string, name:string, stats:object|null,
   *      serves: number[]|null (a lift's: ratings of the runs off its top),
   *      uphill: Array<{rise:number, length:number}> (a run's climbs, see uphillStretches),
   *      point: null | {index:number, count:number, junction:boolean, width:number,
   *        selected:number, minWidth:number, maxWidth:number}}} state
   */
  render(state) {
    this.el.hidden = !state;
    if (!state) { this.trailId = null; return; }
    // Find an element inside the panel.
    const q = (sel) => this.el.querySelector(sel);

    if (state.kind === 'drawing') {
      this.trailId = null;
      this.name.hidden = true;
      q('.drawing').hidden = false;
      q('.drawing').innerHTML = state.lift
        ? '<b>New lift</b>'
        : `<b>New trail</b> · ${state.points} point${state.points === 1 ? '' : 's'}`;
      for (const s of ['.stats', '.bar', '.breakdown', '.uphill', '.point']) q(s).hidden = true;
      q('.hint').textContent =
        state.lift ? 'Click to place the other end'
        : state.routing ? 'Finding a route…'
        : state.mode ? `Click where it should go: ${/^[aeiou]/.test(state.mode) ? 'an' : 'a'} ${state.mode} route is found · double-click to finish`
        : 'Click to add points · double-click to finish';
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
    q('.stats').hidden = !st;
    // Lifts have no difficulty of their own: they show their size and the
    // difficulties of the runs off their top, like a lift sign.
    q('.bar').hidden = !st || state.lift;
    q('.breakdown').hidden = !st || (state.lift && !state.serves?.length);
    if (st && state.lift) {
      q('.stats').textContent = `${st.length.toFixed(0)} m long · ${st.vertical.toFixed(0)} m vertical · lift`;
      q('.breakdown').innerHTML = 'Serves ' + (state.serves ?? [])
        .map((i) => `<span class="serves">${ratingIcon(i)} ${ratingLabel(i).toLowerCase()}</span>`)
        .join('');
    } else if (st) {
      q('.stats').innerHTML =
        `${st.length.toFixed(0)} m long · ${st.vertical.toFixed(0)} m vertical · ` +
        `${ratingIcon(st.rating.index)} <span class="rating" style="color:${st.rating.color}">${st.rating.name}</span>`;
      q('.bar').innerHTML = st.shares
        .map((f, i) => (f > 0 ? `<span style="flex:${f};background:${RATINGS[i].color}"></span>` : ''))
        .join('');
      q('.breakdown').textContent = st.shares
        .map((f, i) => [f, RATINGS[i].name])
        .filter(([f]) => f >= 0.005)
        .map(([f, name]) => `${Math.round(f * 100)}% ${name}`)
        .join(' · ');
    }

    // Where a run climbs (marked in pink on the map, see TrailView).
    const up = state.uphill ?? [];
    q('.uphill').hidden = !up.length;
    if (up.length) {
      const most = Math.round(Math.max(...up.map((u) => u.rise)));
      q('.uphill').innerHTML = '<i></i>' + (up.length === 1
        ? `Goes uphill: climbs ${most} m over ${Math.round(up[0].length)} m`
        : `Goes uphill in ${up.length} places, climbing up to ${most} m`);
    }

    const p = state.point;
    q('.point').hidden = !p;
    const several = p?.selected > 1;
    if (several) {
      const w = (x) => x.toFixed(0);
      const range = w(p.minWidth) === w(p.maxWidth) ? w(p.minWidth) : `${w(p.minWidth)}–${w(p.maxWidth)}`;
      q('.point').textContent = `${p.selected} points selected · width ${range} m`;
    } else if (p) {
      q('.point').textContent =
        `Point ${p.index + 1}/${p.count}${p.junction ? ' (junction)' : ''} · width ${p.width.toFixed(0)} m`;
    }
    // Gestures only: the action bar has the buttons and keys.
    q('.hint').textContent =
      several ? 'Drag any selected point to move them together · Shift-click to add or remove points'
      : p ? 'Drag the side handles to change the width · Shift-click to select more points'
      : state.lift ? 'Drag either end to move it'
      : 'Double-click the trail to add a point · drag points to reshape';
  }
}
