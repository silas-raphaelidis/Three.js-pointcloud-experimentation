import * as THREE from 'three';
import { trailStats } from './stats.js';
import { ContextMenu } from './menu.js';

const PICK_PX = 11;         // screen radius for grabbing points and handles
const CLICK_PX = 5;         // movement allowed before a press counts as a drag
const DOUBLE_CLICK_MS = 350;
const MIN_WIDTH = 6;
const MAX_WIDTH = 120;
const UNDO_LIMIT = 60;

/**
 * Mouse/keyboard editing of the trail network. The only part of the app
 * that changes the network in response to input; the view just draws.
 *
 * Edit mode (T):
 *   click open terrain        start a trail; keep clicking to add points;
 *                             double-click or Enter to finish, Esc to cancel
 *   click a trail             select it
 *   click a selected trail    insert a point there (and drag it)
 *   drag a point              move it (junctions move every trail through them)
 *   drag a side handle        change the selected point's width
 *   Shift-click a trail/point branch a new trail from there (or select a point + B)
 *   - / =                     narrower / wider (selected point, or new trails)
 *   Delete                    remove the selected point
 *   Ctrl+Z                    undo
 *   right-click               options for a point / trail / spot (any mode)
 *   Alt + drag                always orbits, even over trails (trackpads)
 */
export class TrailEditor {
  constructor({ network, geometry, terrain, camera, dom, controls, view, onStatus }) {
    Object.assign(this, { network, geometry, terrain, camera, dom, controls, view, onStatus });
    this.enabled = false;
    this.defaultWidth = 36;
    this.drawing = null;       // trail id being created
    this.selection = null;     // { trailId, index|null }
    this.drag = null;          // { type: 'node'|'width', ... }
    this.press = null;         // pending click on open terrain
    this.lastClick = null;
    this.hover = null;
    this.cursorWorld = null;   // terrain point under the mouse
    this.history = [];
    this.grabbed = false;      // we took this press away from OrbitControls
    this.rightPress = null;    // pending right-click
    this.menu = new ContextMenu();

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.hit = new THREE.Vector3();

    dom.addEventListener('pointerdown', (e) => this.#onDown(e), { capture: true });
    dom.addEventListener('pointermove', (e) => this.#onMove(e));
    dom.addEventListener('pointerup', (e) => this.#onUp(e));
    addEventListener('keydown', (e) => this.#onKey(e));
  }

  // ---------- Public ----------

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.#finishDrawing();
      this.selection = null;
      this.hover = null;
    }
    this.refresh();
  }

  /** Re-draw editor state (call after the network changes). */
  refresh() {
    // Drop a selection that no longer exists (deleted / undone).
    if (this.selection) {
      const t = this.network.trail(this.selection.trailId);
      if (!t || (this.selection.index !== null && this.selection.index >= t.points.length)) this.selection = null;
    }
    if (this.drawing && !this.network.trail(this.drawing)) this.drawing = null;

    const sel = this.selection;
    let highlightNode = null;
    let handles = null;
    if (sel && sel.index !== null) {
      const node = this.#stopNode(sel.trailId, sel.index);
      highlightNode = node;
      handles = this.#handlePositions(sel.trailId, sel.index);
    } else if (this.hover?.type === 'node') {
      highlightNode = this.network.node(this.hover.nodeId);
    }

    let preview = null;
    if (this.drawing && this.cursorWorld) {
      const t = this.network.trail(this.drawing);
      const last = this.network.node(t.points[t.points.length - 1].node);
      preview = { from: last, to: this.cursorWorld };
    }

    this.view.setState({
      selectedTrail: this.enabled ? (this.drawing ?? sel?.trailId ?? null) : null,
      highlightNode: this.enabled ? highlightNode : null,
      handles: this.enabled ? handles : null,
      preview: this.enabled ? preview : null,
    });
    this.onStatus?.(this.status());
  }

  /** One-line description for the HUD. */
  status() {
    if (!this.enabled) return '';
    if (this.drawing) {
      const n = this.network.trail(this.drawing)?.points.length ?? 0;
      return `Drawing · ${n} point${n === 1 ? '' : 's'} · click to add · double-click/Enter to finish · Esc to cancel`;
    }
    const sel = this.selection;
    if (sel) {
      const t = this.network.trail(sel.trailId);
      const geo = this.geometry.get(sel.trailId);
      const st = geo && trailStats(geo.samples, this.terrain);
      let line = `<b>${t.name}</b>`;
      if (st) {
        line +=
          ` · ${st.length.toFixed(0)} m long · ${st.vertical.toFixed(0)} m vertical` +
          ` · steepest ${(st.maxSustained * 100).toFixed(0)}% · <span style="color:${st.rating.color}">${st.rating.name}</span>`;
      }
      if (sel.index !== null) {
        const p = t.points[sel.index];
        const shared = this.network.isJunction(p.node) ? ' (junction)' : '';
        line += `<br>Point ${sel.index + 1}/${t.points.length}${shared} · width ${p.width.toFixed(0)} m · drag handles or − = · Del removes · B branches`;
      } else {
        line += '<br>Click the trail to add a point · drag points to reshape';
      }
      return line;
    }
    return `Click terrain to start a trail (${this.defaultWidth} m) · Shift-click a trail to branch`;
  }

  // ---------- Geometry helpers ----------

  #stopNode(trailId, index) {
    return this.network.node(this.network.trail(trailId).points[index].node);
  }

  /** Two handle positions across the trail at a control point. */
  #handlePositions(trailId, index) {
    const t = this.network.trail(trailId);
    const P = (i) => this.network.node(t.points[Math.min(t.points.length - 1, Math.max(0, i))].node);
    const p = P(index);
    if (t.points.length < 2) return null;
    const a = P(index - 1), b = P(index + 1);
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const h = t.points[index].width / 2;
    return [
      { x: p.x - dy * h, y: p.y + dx * h },
      { x: p.x + dy * h, y: p.y - dx * h },
    ];
  }

  #toScreen(x, y) {
    const v = new THREE.Vector3(x, y, this.terrain.heightAt(x, y) + 1.5).project(this.camera);
    if (v.z > 1) return null; // behind the camera
    return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight };
  }

  #terrainAt(clientX, clientY) {
    this.ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.terrain.raycast(this.raycaster.ray, this.hit) ? this.hit.clone() : null;
  }

  /** What's under the mouse: a width handle, a point, a trail, or terrain. */
  #pick(clientX, clientY) {
    const near = (p) => {
      const s = p && this.#toScreen(p.x, p.y);
      return s ? Math.hypot(s.x - clientX, s.y - clientY) : Infinity;
    };

    // Points and width handles compete on screen distance, so zoomed out
    // (where handles sit almost on top of their point) a press on the point
    // still moves the point. Points on the selected trail get a small bonus.
    const sel = this.selection;
    let best = null;
    for (const n of this.network.nodes.values()) {
      const d = near(n);
      if (d >= PICK_PX) continue;
      const onSelected = sel && this.network.trail(sel.trailId)?.points.some((p) => p.node === n.id);
      const score = d - (onSelected ? 3 : 0);
      if (!best || score < best.score) best = { score, type: 'node', nodeId: n.id };
    }
    if (sel && sel.index !== null) {
      for (const h of this.#handlePositions(sel.trailId, sel.index) ?? []) {
        const d = near(h);
        if (d < PICK_PX && (!best || d < best.score - 1)) best = { score: d, type: 'handle' };
      }
    }
    if (best) return best.type === 'node' ? { type: 'node', nodeId: best.nodeId } : { type: 'handle' };

    const world = this.#terrainAt(clientX, clientY);
    if (!world) return { type: 'none' };

    // A trail counts as hit anywhere inside its cut (or within a few pixels
    // of its centerline when zoomed far out).
    const metersPerPx =
      (this.camera.position.distanceTo(world) * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / innerHeight;
    const nearest = this.geometry.nearest(world.x, world.y);
    if (nearest && nearest.dist < Math.max(nearest.w / 2, 6 * metersPerPx)) {
      return { type: 'line', world, ...nearest };
    }
    return { type: 'terrain', world };
  }

  // ---------- Edits ----------

  #snapshot() {
    this.history.push(structuredClone(this.network.toJSON()));
    if (this.history.length > UNDO_LIMIT) this.history.shift();
  }

  #undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.drawing = null;
    this.selection = null;
    this.drag = null;
    this.network.load(prev);
  }

  #startTrail(first) {
    this.#snapshot();
    const t = this.network.addTrail({ points: [first] });
    this.drawing = t.id;
    this.selection = null;
  }

  #branchFromNode(nodeId) {
    this.#startTrail({ node: nodeId, width: Math.min(this.defaultWidth, 24) });
  }

  #branchFromLine(h) {
    this.#snapshot();
    const nodeId = this.network.insertPoint(h.trailId, { x: h.x, y: h.y, width: h.w }, h.seg + 1);
    const t = this.network.addTrail({ points: [{ node: nodeId, width: Math.min(this.defaultWidth, 24) }] });
    this.drawing = t.id;
    this.selection = null;
  }

  #addDrawingPoint(target) {
    const t = this.network.trail(this.drawing);
    const width = t.points[t.points.length - 1].width;
    if (target.type === 'node') {
      if (t.points.some((p) => p.node === target.nodeId)) return;
      this.network.insertPoint(this.drawing, { node: target.nodeId, width });
    } else if (target.world) {
      this.network.insertPoint(this.drawing, { x: target.world.x, y: target.world.y, width });
    }
  }

  #finishDrawing() {
    if (!this.drawing) return;
    const id = this.drawing;
    this.drawing = null;
    const t = this.network.trail(id);
    if (t && t.points.length < 2) {
      this.network.removeTrail(id);
    } else if (t) {
      this.selection = { trailId: id, index: null };
    }
  }

  #cancelDrawing() {
    if (!this.drawing) return;
    const id = this.drawing;
    this.drawing = null;
    this.network.removeTrail(id);
  }

  // ---------- Right-click menu ----------

  /** Build the menu for whatever is under the cursor. Works in any mode;
   *  trail actions switch edit mode on. */
  #openMenu(x, y) {
    const h = this.#pick(x, y);
    const edit = (fn) => () => { if (!this.enabled) this.setEnabled(true); fn(); this.refresh(); };
    // Width fields snapshot once per menu, so typing "45" is one undo step.
    let snapped = false;
    const snapOnce = () => { if (!snapped) { this.#snapshot(); snapped = true; } };
    const items = [];

    if (this.drawing) {
      items.push(
        { type: 'header', label: this.network.trail(this.drawing).name },
        { label: 'Finish trail', action: edit(() => this.#finishDrawing()) },
        { label: 'Cancel trail', danger: true, action: edit(() => this.#cancelDrawing()) },
      );
    } else if (h.type === 'node') {
      const trailIds = this.network.trailsUsingNode(h.nodeId);
      const junction = trailIds.length > 1;
      items.push(
        { type: 'header', label: junction ? `Junction · ${trailIds.length} trails` : 'Point' },
        { label: 'Start branch from here', action: edit(() => this.#branchFromNode(h.nodeId)) },
        { type: 'separator' },
      );
      for (const id of trailIds) {
        const t = this.network.trail(id);
        const index = t.points.findIndex((p) => p.node === h.nodeId);
        items.push({
          type: 'number',
          label: junction ? `Width on ${t.name}` : 'Width',
          value: Math.round(t.points[index].width),
          min: MIN_WIDTH, max: MAX_WIDTH, suffix: 'm',
          onChange: (w) => { snapOnce(); this.network.setWidth(id, index, w); this.refresh(); },
        });
      }
      items.push({ type: 'separator' });
      for (const id of trailIds) {
        const t = this.network.trail(id);
        const index = t.points.findIndex((p) => p.node === h.nodeId);
        items.push({
          label: junction ? `Remove from ${t.name}` : 'Delete point',
          danger: true,
          action: edit(() => { this.#snapshot(); this.network.removePoint(id, index); this.selection = null; }),
        });
      }
    } else if (h.type === 'line') {
      const t = this.network.trail(h.trailId);
      items.push(
        { type: 'header', label: t.name },
        { label: 'Branch from here', action: edit(() => this.#branchFromLine(h)) },
        {
          label: 'Insert point here',
          action: edit(() => {
            this.#snapshot();
            this.network.insertPoint(h.trailId, { x: h.x, y: h.y, width: h.w }, h.seg + 1);
            this.selection = { trailId: h.trailId, index: h.seg + 1 };
          }),
        },
        {
          type: 'text', label: 'Name', value: t.name,
          onSubmit: (name) => { if (name) { this.#snapshot(); this.network.rename(h.trailId, name); this.refresh(); } },
        },
        { type: 'separator' },
        {
          label: 'Delete trail', danger: true,
          action: edit(() => { this.#snapshot(); this.network.removeTrail(h.trailId); this.selection = null; }),
        },
      );
    } else if (h.world) {
      items.push(
        { label: 'Start new trail here', action: edit(() => this.#startTrail({ x: h.world.x, y: h.world.y, width: this.defaultWidth })) },
      );
    } else {
      return;
    }
    this.menu.open(x, y, items);
  }

  // ---------- Input ----------

  #onDown(e) {
    if (e.button === 2) {
      this.rightPress = { x: e.clientX, y: e.clientY };
      return;
    }
    // Alt + drag always orbits/pans, even over trails (Blender's emulate-3-button).
    if (!this.enabled || e.button !== 0 || e.altKey) return;
    const h = this.#pick(e.clientX, e.clientY);
    const grab = () => {
      e.stopImmediatePropagation(); // keep OrbitControls out of it
      e.preventDefault();
      try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.controls.enabled = false;
      this.grabbed = true;
    };

    if (this.drawing) {
      // Clicks while drawing are resolved on release, so dragging still orbits.
      this.press = { x: e.clientX, y: e.clientY, target: h };
      return;
    }

    if (h.type === 'handle') {
      grab();
      this.#snapshot();
      this.drag = { type: 'width', ...this.selection };
    } else if (h.type === 'node') {
      grab();
      if (e.shiftKey) {
        this.#branchFromNode(h.nodeId);
      } else {
        const sel = this.selection;
        const selTrail = sel && this.network.trail(sel.trailId);
        let idx = selTrail ? selTrail.points.findIndex((p) => p.node === h.nodeId) : -1;
        let trailId = sel?.trailId;
        if (idx < 0) {
          trailId = this.network.trailsUsingNode(h.nodeId)[0];
          idx = this.network.trail(trailId).points.findIndex((p) => p.node === h.nodeId);
        }
        this.selection = { trailId, index: idx };
        this.drag = { type: 'node', nodeId: h.nodeId, moved: false };
      }
    } else if (h.type === 'line') {
      grab();
      if (e.shiftKey) {
        this.#branchFromLine(h);
      } else if (this.selection?.trailId === h.trailId) {
        this.#snapshot();
        const nodeId = this.network.insertPoint(h.trailId, { x: h.x, y: h.y, width: h.w }, h.seg + 1);
        this.selection = { trailId: h.trailId, index: h.seg + 1 };
        this.drag = { type: 'node', nodeId, moved: true };
      } else {
        this.selection = { trailId: h.trailId, index: null };
      }
    } else {
      // Open terrain: wait for release to tell a click from an orbit drag.
      this.press = { x: e.clientX, y: e.clientY, target: h };
    }
    this.refresh();
  }

  #onMove(e) {
    if (!this.enabled) return;
    const world = this.#terrainAt(e.clientX, e.clientY);
    this.cursorWorld = world;

    if (this.drag?.type === 'node' && world) {
      if (!this.drag.moved) { this.#snapshot(); this.drag.moved = true; }
      this.network.moveNode(this.drag.nodeId, world.x, world.y);
    } else if (this.drag?.type === 'width' && world) {
      const n = this.#stopNode(this.drag.trailId, this.drag.index);
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, 2 * Math.hypot(world.x - n.x, world.y - n.y)));
      this.network.setWidth(this.drag.trailId, this.drag.index, w);
    } else if (!this.drag) {
      this.hover = this.#pick(e.clientX, e.clientY);
      this.dom.style.cursor = ['handle', 'node', 'line'].includes(this.hover.type) ? 'pointer' : '';
    }
    this.refresh();
  }

  #onUp(e) {
    if (e.button === 2) {
      const rp = this.rightPress;
      this.rightPress = null;
      // A right-click (not a drag) opens the menu; right-drag does nothing.
      if (rp && Math.hypot(e.clientX - rp.x, e.clientY - rp.y) <= CLICK_PX) this.#openMenu(e.clientX, e.clientY);
      return;
    }
    // Always hand the camera back after any press we took over (selecting a
    // trail by clicking used to leave orbiting switched off).
    if (this.grabbed) {
      this.grabbed = false;
      this.controls.enabled = true;
      try { this.dom.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    }
    if (!this.enabled) return;
    this.drag = null;

    const press = this.press;
    this.press = null;
    if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_PX) {
      this.refresh();
      return; // it was an orbit drag
    }

    const now = performance.now();
    const isDouble =
      this.lastClick && now - this.lastClick.time < DOUBLE_CLICK_MS &&
      Math.hypot(e.clientX - this.lastClick.x, e.clientY - this.lastClick.y) < CLICK_PX * 2;
    this.lastClick = { time: now, x: e.clientX, y: e.clientY };

    const target = press.target;
    if (this.drawing) {
      if (isDouble) this.#finishDrawing();
      else this.#addDrawingPoint(target);
    } else if (this.selection) {
      this.selection = null; // click on open terrain deselects first
    } else if (target.world) {
      this.#startTrail({ x: target.world.x, y: target.world.y, width: this.defaultWidth });
    }
    this.refresh();
  }

  #onKey(e) {
    // Don't treat typing in a menu field (width, rename) as shortcuts.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 't' || e.key === 'T') {
      this.setEnabled(!this.enabled);
      return;
    }
    if (!this.enabled) return;
    const sel = this.selection;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      this.#undo();
    } else if (e.key === 'Enter') {
      this.#finishDrawing();
    } else if (e.key === 'Escape') {
      if (this.drawing) this.#cancelDrawing();
      else this.selection = null;
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel?.index != null) {
      this.#snapshot();
      this.network.removePoint(sel.trailId, sel.index);
      this.selection = null;
    } else if (e.key === 'b' || e.key === 'B') {
      if (sel?.index != null) this.#branchFromNode(this.network.trail(sel.trailId).points[sel.index].node);
    } else if (e.key === '-' || e.key === '_' || e.key === '=' || e.key === '+') {
      const delta = e.key === '-' || e.key === '_' ? -4 : 4;
      if (sel?.index != null) {
        this.#snapshot();
        const w = this.network.trail(sel.trailId).points[sel.index].width;
        this.network.setWidth(sel.trailId, sel.index, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + delta)));
      } else {
        this.defaultWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, this.defaultWidth + delta));
      }
    } else {
      return;
    }
    this.refresh();
  }
}
