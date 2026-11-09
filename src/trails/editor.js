import * as THREE from 'three';
import { trailStats } from './stats.js';
import { ContextMenu } from './menu.js';
import { sampleSpline } from './spline.js';
import { pickRunName } from './names.js';

const PICK_PX = 11;         // screen radius for grabbing points and handles
const CLICK_PX = 5;         // movement allowed before a press counts as a drag
const DOUBLE_CLICK_MS = 350;
const MIN_WIDTH = 6;
const MAX_WIDTH = 120;
const UNDO_LIMIT = 60;

/**
 * Mouse/keyboard editing of the trail network. Always on (there is no
 * separate view mode); editing only happens through deliberate actions, so
 * casual clicking and dragging just looks around.
 *
 *   drag anywhere             orbit (also when starting on a trail line)
 *   click a trail             select it
 *   double-click a trail      insert a point there
 *   drag a point              move it (junctions move every trail through them)
 *   drag a side handle        change the selected point's width
 *   Shift-click a trail/point branch a new trail from there (or select a point + B)
 *   right-click               options for a point / trail / spot
 *                             ("Start new trail here" on open terrain)
 *   while drawing: click adds a point, double-click / Enter finishes, Esc cancels
 *   - / =                     narrower / wider (selected point, or new trails)
 *   Delete · Ctrl+Z · Esc     remove point · undo · deselect
 *   Alt + drag                always orbits/pans, even over points (trackpads)
 *
 * When locked, trails can't be hovered, selected or edited; any attempt
 * calls onLocked() so the app can say so.
 */
export class TrailEditor {
  /** Attaches the mouse and keyboard listeners. Created once in setupTrails (main.js). */
  constructor({ network, geometry, terrain, camera, dom, controls, view, onStatus, onLocked }) {
    Object.assign(this, { network, geometry, terrain, camera, dom, controls, view, onStatus, onLocked });
    this.locked = false;
    this.defaultWidth = 36;
    this.pickHidden = false;   // true while hidden trails are ghosted (G)
    this.drawing = null;       // trail id being created
    this.selection = null;     // { trailId, index|null }
    this.drag = null;          // { type: 'node'|'width', ... }
    this.press = null;         // left press waiting to become a click or a drag
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

  /**
   * Lock or unlock trail selection. Locking finishes any drawing and deselects.
   * Used by the lock button (TrailLock, through main.js).
   */
  setLocked(on) {
    this.locked = on;
    if (on) {
      this.#finishDrawing();
      this.selection = null;
      this.hover = null;
      this.drag = null;
      this.dom.style.cursor = '';
    }
    this.refresh();
  }

  /**
   * Is something selectable under the mouse right now?
   * Used by #onMove for the pointer cursor and by scaleCursor in main.js for the yellow ring.
   */
  get hoveringSelectable() {
    return !this.locked && ['node', 'handle', 'line'].includes(this.hover?.type);
  }

  /**
   * Push the current selection, hover and drawing state to the view and trail panel.
   * Called after every input event, by processTrails in main.js, and when thresholds change.
   */
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
      highlightNode = this.#stopNode(sel.trailId, sel.index);
      handles = this.#handlePositions(sel.trailId, sel.index);
    } else if (this.hover?.type === 'node' && !this.locked) {
      highlightNode = this.network.node(this.hover.nodeId);
    }

    let preview = null;
    if (this.drawing && this.cursorWorld) {
      const t = this.network.trail(this.drawing);
      const last = this.network.node(t.points[t.points.length - 1].node);
      preview = { from: last, to: this.cursorWorld };
    }

    // Hovering a trail, or a point on it (a junction: every trail through it).
    const h = this.locked ? null : this.hover;
    const hoverTrails = h?.type === 'line' ? [h.trailId]
      : h?.type === 'node' ? this.network.trailsUsingNode(h.nodeId)
      : [];
    this.view.setState({
      selectedTrail: this.drawing ?? sel?.trailId ?? null,
      hoverTrails,
      highlightNode,
      handles,
      preview,
    });
    this.onStatus?.(this.panelState());
  }

  /**
   * What the trail panel should show, or null when nothing is selected or drawn.
   * Used by refresh, which passes it to onStatus.
   */
  panelState() {
    if (this.drawing) {
      return { kind: 'drawing', points: this.network.trail(this.drawing)?.points.length ?? 0 };
    }
    const sel = this.selection;
    if (!sel) return null;
    const t = this.network.trail(sel.trailId);
    const geo = this.geometry.get(sel.trailId);
    const point = sel.index === null ? null : {
      index: sel.index,
      count: t.points.length,
      junction: this.network.isJunction(t.points[sel.index].node),
      width: t.points[sel.index].width,
    };
    return {
      kind: 'trail',
      trailId: t.id,
      name: t.name,
      stats: geo ? trailStats(geo.samples, this.terrain) : null,
      point,
    };
  }

  /** Rename a trail (undoable). Used by the name field in the trail panel. */
  rename(trailId, name) {
    if (this.locked) { this.onLocked?.(); return; }
    this.#snapshot();
    this.network.rename(trailId, name);
    this.refresh();
  }

  // ---------- Geometry helpers ----------

  /** The node at one stop of a trail. Used for the selected point and width dragging. */
  #stopNode(trailId, index) {
    return this.network.node(this.network.trail(trailId).points[index].node);
  }

  /**
   * Two handle positions across the trail at a control point.
   * Used by refresh to draw them and by #pick to grab them.
   */
  #handlePositions(trailId, index) {
    const t = this.network.trail(trailId);
    // Node at stop i, clamped to the ends of the trail.
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

  /**
   * Line of sight from the camera to a point on the ground (lifted like the overlay).
   * Used by #pick so things behind terrain can't be grabbed.
   */
  #visible(p) {
    const target = new THREE.Vector3(p.x, p.y, this.terrain.heightAt(p.x, p.y) + 1.5);
    const from = this.camera.position;
    const dist = from.distanceTo(target);
    const ray = new THREE.Ray(from.clone(), target.clone().sub(from).normalize());
    const hit = this.terrain.raycast(ray, new THREE.Vector3());
    // Blocked only if the terrain is hit clearly before reaching the point.
    return !hit || hit.distanceTo(from) > dist - 3;
  }

  /** Screen pixel for a ground position, or null if behind the camera. Used by #pick. */
  #toScreen(x, y) {
    const v = new THREE.Vector3(x, y, this.terrain.heightAt(x, y) + 1.5).project(this.camera);
    if (v.z > 1) return null; // behind the camera
    return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight };
  }

  /** Terrain point under a screen position, or null. Used by #pick and #onMove. */
  #terrainAt(clientX, clientY) {
    this.ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.terrain.raycast(this.raycaster.ray, this.hit) ? this.hit.clone() : null;
  }

  /**
   * What's under the mouse: a width handle, a point, a trail, or terrain.
   * Used by #onDown, #onMove and #openMenu.
   */
  #pick(clientX, clientY) {
    // Screen distance to a ground point, or Infinity if it's off screen or
    // hidden behind terrain (unless hidden trails are ghosted, i.e. visible).
    const near = (p) => {
      const s = p && this.#toScreen(p.x, p.y);
      if (!s) return Infinity;
      const d = Math.hypot(s.x - clientX, s.y - clientY);
      if (d >= PICK_PX || this.pickHidden) return d;
      return this.#visible(p) ? d : Infinity;
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

  /**
   * Save the network for undo, keeping the last UNDO_LIMIT states.
   * Called just before any undoable edit.
   */
  #snapshot() {
    this.history.push(structuredClone(this.network.toJSON()));
    if (this.history.length > UNDO_LIMIT) this.history.shift();
  }

  /** Restore the last snapshot and clear the current selection and drawing. Used by Ctrl+Z. */
  #undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.drawing = null;
    this.selection = null;
    this.drag = null;
    this.network.load(prev);
  }

  /**
   * Begin drawing a new trail from its first stop.
   * Used by the "Start new trail here" menu item and #branchFromNode.
   */
  #startTrail(first) {
    this.#snapshot();
    // Named for real when finished, once its difficulty is known.
    const t = this.network.addTrail({ name: 'New trail', points: [first] });
    this.drawing = t.id;
    this.selection = null;
  }

  /**
   * Begin drawing a branch from an existing point.
   * Used by Shift-click on a point, the B key and the right-click menu.
   */
  #branchFromNode(nodeId) {
    this.#startTrail({ node: nodeId, width: Math.min(this.defaultWidth, 24) });
  }

  /**
   * Add a point on a trail at the picked spot and begin a branch from it.
   * Used by Shift-click on a trail line and the right-click menu.
   */
  #branchFromLine(h) {
    this.#snapshot();
    const nodeId = this.network.insertPoint(h.trailId, { x: h.x, y: h.y, width: h.w }, h.seg + 1);
    const t = this.network.addTrail({ name: 'New trail', points: [{ node: nodeId, width: Math.min(this.defaultWidth, 24) }] });
    this.drawing = t.id;
    this.selection = null;
  }

  /**
   * Add a point to a trail at the picked spot and select it.
   * Used by double-clicking a trail and the right-click menu.
   */
  #insertPoint(h) {
    this.#snapshot();
    this.network.insertPoint(h.trailId, { x: h.x, y: h.y, width: h.w }, h.seg + 1);
    this.selection = { trailId: h.trailId, index: h.seg + 1 };
  }

  /**
   * Add a click to the trail being drawn, snapping to a node if one was clicked.
   * A node already on this trail is ignored. Used by #onUp.
   */
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

  /**
   * End the current drawing. Too short: removed. Otherwise named and selected.
   * Used by double-click, Enter, the right-click menu and locking.
   */
  #finishDrawing() {
    if (!this.drawing) return;
    const id = this.drawing;
    this.drawing = null;
    const t = this.network.trail(id);
    if (t && t.points.length < 2) {
      this.network.removeTrail(id);
    } else if (t) {
      this.#giveDefaultName(t);
      this.selection = { trailId: id, index: null };
    }
  }

  /** Name a finished trail from the run-name list for its difficulty. Used by #finishDrawing. */
  #giveDefaultName(t) {
    const samples = sampleSpline(this.geometry.controlPoints(t));
    const rating = trailStats(samples, this.terrain)?.rating.index ?? 0;
    const used = [...this.network.trails.values()].map((x) => x.name);
    this.network.rename(t.id, pickRunName(rating, used));
  }

  /** Throw away the trail being drawn. Used by Esc and the right-click menu. */
  #cancelDrawing() {
    if (!this.drawing) return;
    const id = this.drawing;
    this.drawing = null;
    this.network.removeTrail(id);
  }

  /**
   * Select a point, staying on the selected trail if it passes through that node.
   * Used by #onDown.
   */
  #selectNode(nodeId) {
    const sel = this.selection;
    const selTrail = sel && this.network.trail(sel.trailId);
    let index = selTrail ? selTrail.points.findIndex((p) => p.node === nodeId) : -1;
    let trailId = sel?.trailId;
    if (index < 0) {
      trailId = this.network.trailsUsingNode(nodeId)[0];
      index = this.network.trail(trailId).points.findIndex((p) => p.node === nodeId);
    }
    this.selection = { trailId, index };
  }

  // ---------- Right-click menu ----------

  /** Build the right-click menu for whatever is under the cursor. Used by #onUp. */
  #openMenu(x, y) {
    if (this.locked) {
      this.onLocked?.();
      return;
    }
    const h = this.#pick(x, y);
    // Wrap a menu action so the display refreshes after it.
    const edit = (fn) => () => { fn(); this.refresh(); };
    // Width fields snapshot once per menu, so typing "45" is one undo step.
    let snapped = false;
    // Take the undo snapshot the first time a width field changes.
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
        { label: 'Insert point here', action: edit(() => this.#insertPoint(h)) },
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

  /**
   * Pointer press. Grabs points and handles right away; anything else waits for release
   * so a drag can still orbit the camera. Runs before OrbitControls (capture phase).
   */
  #onDown(e) {
    if (e.button === 2) {
      this.rightPress = { x: e.clientX, y: e.clientY };
      return;
    }
    // Alt + drag always orbits/pans, even over points (Blender's emulate-3-button).
    if (e.button !== 0 || e.altKey) return;
    const h = this.#pick(e.clientX, e.clientY);

    // Locked, drawing, trail lines and open terrain are all decided on
    // release: a click acts, a drag orbits (or pans with Shift).
    if (this.locked || this.drawing || h.type === 'line' || h.type === 'terrain' || h.type === 'none') {
      this.press = { x: e.clientX, y: e.clientY, target: h, shift: e.shiftKey };
      return;
    }

    // Points and width handles are small, deliberate targets: grab them now.
    e.stopImmediatePropagation(); // keep OrbitControls out of it
    e.preventDefault();
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    this.controls.enabled = false;
    this.grabbed = true;

    if (h.type === 'handle') {
      this.#snapshot();
      this.drag = { type: 'width', ...this.selection };
    } else if (e.shiftKey) {
      this.#branchFromNode(h.nodeId);
    } else {
      this.#selectNode(h.nodeId);
      this.drag = { type: 'node', nodeId: h.nodeId, moved: false };
    }
    this.refresh();
  }

  /** Pointer move: track the cursor, then drag whatever is held or update the hover. */
  #onMove(e) {
    const world = this.#terrainAt(e.clientX, e.clientY);
    this.cursorWorld = world;
    if (this.locked) return;

    if (this.drag?.type === 'node' && world) {
      if (!this.drag.moved) { this.#snapshot(); this.drag.moved = true; }
      this.network.moveNode(this.drag.nodeId, world.x, world.y);
    } else if (this.drag?.type === 'width' && world) {
      const n = this.#stopNode(this.drag.trailId, this.drag.index);
      const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, 2 * Math.hypot(world.x - n.x, world.y - n.y)));
      this.network.setWidth(this.drag.trailId, this.drag.index, w);
    } else if (!this.drag && !this.press) {
      this.hover = this.#pick(e.clientX, e.clientY);
      this.dom.style.cursor = this.hoveringSelectable ? 'pointer' : '';
    }
    this.refresh();
  }

  /**
   * Pointer release: returns the camera if it was taken, then treats a short press
   * as a click (select, add a point, branch). A right-click opens the menu.
   */
  #onUp(e) {
    if (e.button === 2) {
      const rp = this.rightPress;
      this.rightPress = null;
      // A right-click (not a drag) opens the menu; right-drag does nothing.
      if (rp && Math.hypot(e.clientX - rp.x, e.clientY - rp.y) <= CLICK_PX) this.#openMenu(e.clientX, e.clientY);
      return;
    }
    // Always hand the camera back after any press we took over.
    if (this.grabbed) {
      this.grabbed = false;
      this.controls.enabled = true;
      try { this.dom.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    }
    this.drag = null;

    const press = this.press;
    this.press = null;
    if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_PX) {
      this.refresh();
      return; // it was an orbit / pan drag
    }

    const now = performance.now();
    const isDouble =
      this.lastClick && now - this.lastClick.time < DOUBLE_CLICK_MS &&
      Math.hypot(e.clientX - this.lastClick.x, e.clientY - this.lastClick.y) < CLICK_PX * 2;
    this.lastClick = isDouble ? null : { time: now, x: e.clientX, y: e.clientY };

    const target = press.target;
    if (this.locked) {
      // Clicking a trail while locked: say so (a drag just orbits).
      if (['node', 'handle', 'line'].includes(target.type)) this.onLocked?.();
    } else if (this.drawing) {
      if (isDouble) this.#finishDrawing();
      else this.#addDrawingPoint(target);
    } else if (target.type === 'line') {
      if (press.shift) this.#branchFromLine(target);
      else if (isDouble) this.#insertPoint(target);
      else this.selection = { trailId: target.trailId, index: null };
    } else {
      this.selection = null; // click on open terrain deselects
    }
    this.refresh();
  }

  /**
   * Editing shortcuts: undo, Enter, Esc, Delete, B, and - / =.
   * View shortcuts live in main.js.
   */
  #onKey(e) {
    // Don't treat typing in a menu field (width, rename) as shortcuts.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const sel = this.selection;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (this.locked) this.onLocked?.();
      else this.#undo();
    } else if (this.locked) {
      return; // nothing is selected while locked; other keys do nothing
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
