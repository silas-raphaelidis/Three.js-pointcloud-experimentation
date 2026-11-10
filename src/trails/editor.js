import * as THREE from 'three';
import { trailStats } from './stats.js';
import { ContextMenu } from './menu.js';
import { sampleSpline } from './spline.js';
import { pickRunName, pickLiftName } from './names.js';
import { RATINGS } from '../difficulty.js';
import { showToast } from '../toast.js';

const PICK_PX = 11;         // screen radius for grabbing points and handles
const CLICK_PX = 5;         // movement allowed before a press counts as a drag
const DOUBLE_CLICK_MS = 350;
const MIN_WIDTH = 6;
const MAX_WIDTH = 120;
const UNDO_LIMIT = 60;
const LIFT_WIDTH = 20;      // default width of the cut for a lift line, meters
const WARNING_MS = 5000;    // how long generation warnings stay on screen
const ATTACH_SNAP = 12;     // meters: a generated trail ending this close to a stop joins it
const MIN_GENERATE = 30;    // meters: ends closer than this are too close to generate between

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
 *                             ("Start new trail / lift here" on open terrain)
 *   drawing a lift: the second click places the other end and finishes it
 *   lifts stay at two points: no inserting points or branching mid-line
 *   generating a trail: pick a difficulty from the right-click menu (on
 *                             terrain, a point or a trail), then click where it
 *                             should end: terrain, a point, or a trail's line,
 *                             which joins it there (Esc cancels)
 *   generating a mountain: Esc cancels and puts the old trails back
 *   while drawing: click adds a point, double-click / Enter finishes, Esc cancels
 *   - / =                     narrower / wider (selected point, or new trails)
 *   Delete · Ctrl+Z · Ctrl+Shift+Z · Esc   remove point · undo · redo · deselect
 *   Alt + drag                always orbits/pans, even over points (trackpads)
 *
 * When locked, trails can't be hovered, selected or edited; any attempt
 * calls onLocked() so the app can say so. The same holds while trails are
 * hidden from view (View > Trails and lifts), since they can't be seen.
 */
export class TrailEditor {
  /** Attaches the mouse and keyboard listeners. Created once in setupTrails (main.js). */
  constructor({ network, geometry, terrain, camera, dom, controls, view, generator, onStatus, onLocked }) {
    Object.assign(this, { network, geometry, terrain, camera, dom, controls, view, generator, onStatus, onLocked });
    this.lockedByUser = false; // the lock button / L
    this.trailsHidden = false; // trails and lifts turned off in the View menu
    this.pendingGenerate = null; // { from, target } waiting for the click that picks the end
    this.generation = null;      // { target } while a route search is running
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
    this.redoStack = [];       // states undone, newest last; cleared by any new edit
    this.build = null;         // { token } while mountain generation is adding trails
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
    this.lockedByUser = on;
    this.#applyLock();
  }

  /**
   * Treat trails as locked while they're hidden from view, so nothing can be
   * picked or edited blind. Used by the View menu's Trails and lifts option (main.js).
   */
  setTrailsHidden(on) {
    this.trailsHidden = on;
    this.#applyLock();
  }

  /** True while trails can't be selected or edited: locked, or hidden from view. */
  get locked() {
    return this.lockedByUser || this.trailsHidden;
  }

  /** Drop anything in progress once trails become locked. Used by setLocked and setTrailsHidden. */
  #applyLock() {
    if (this.locked) {
      this.#finishDrawing();
      this.pendingGenerate = null;
      this.generation = null;
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
    } else if (this.pendingGenerate && this.cursorWorld) {
      const { from } = this.pendingGenerate;
      preview = { from: from.node ? this.network.node(from.node) : from, to: this.cursorWorld };
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
    if (this.pendingGenerate) return { kind: 'generate', busy: false, rating: RATINGS[this.pendingGenerate.target].name };
    if (this.generation) return { kind: 'generate', busy: true, rating: RATINGS[this.generation.target].name };
    if (this.drawing) {
      return {
        kind: 'drawing',
        lift: this.network.isLift(this.drawing),
        points: this.network.trail(this.drawing)?.points.length ?? 0,
      };
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
      lift: this.network.isLift(t.id),
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

  /**
   * Start replacing every trail and lift with generated ones. The old network
   * is cleared as a single undo step, so Ctrl+Z brings it back however many
   * trails the build adds. Cancels any drawing or trail generation in
   * progress. Returns { token, trails }: the token for addToBuild, and the
   * trails created from `trails` (see addToBuild for their shape). `random`
   * (numbers in [0, 1)) picks the build's names, so a seeded one repeats them.
   * Used by MountainGenerator.
   */
  startBuild(trails, random) {
    this.#cancelDrawing();
    this.generation = null; // a running trail generation drops its result
    this.#snapshot();
    this.#resetEditing();
    this.network.clear();
    this.build = { token: Symbol('build'), random };
    const created = trails.map((spec) => this.#addSpec(spec));
    this.refresh();
    return { token: this.build.token, trails: created };
  }

  /**
   * Is this build still going? Any other edit, undo or redo ends it.
   * Used by MountainGenerator before each step.
   */
  isBuilding(token) {
    return this.build?.token === token;
  }

  /**
   * Add a trail to a build without a separate undo step. `spec` is
   * { kind, source, meta, points: [{x, y} | {node} | {trail, x, y}, with optional width] },
   * where {trail, x, y} joins that trail at (about) x, y (see #resolveStops);
   * missing widths get the default for the kind, and the trail is named like a
   * hand-drawn one. Returns the trail, or null if the build has ended.
   * Used by MountainGenerator for each generated run.
   */
  addToBuild(token, spec) {
    if (!this.isBuilding(token)) return null;
    const t = this.#addSpec(spec);
    this.refresh();
    return t;
  }

  /**
   * Stop the running build and put back the network it replaced, leaving
   * nothing to redo, as if it never started. Used by Esc.
   */
  #cancelBuild() {
    this.build = null;
    const before = this.history.pop();
    if (!before) return;
    this.#resetEditing();
    this.network.load(before);
  }

  /** Finish a build (if it's still the current one). Used by MountainGenerator. */
  endBuild(token) {
    if (this.isBuilding(token)) this.build = null;
  }

  /** Add one generated trail and name it. Used by startBuild and addToBuild. */
  #addSpec({ kind = 'run', source, meta, points }) {
    const width = kind === 'lift' ? LIFT_WIDTH : this.defaultWidth;
    const t = this.network.addTrail({
      name: kind === 'lift' ? 'New lift' : 'New trail',
      kind, source, meta,
      points: this.#resolveStops(points.map((p) => ({ ...p, width: p.width ?? width }))),
    });
    this.#giveDefaultName(t, this.build?.random);
    return t;
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
    // Only points with a dot drawn count (hovering a trail reveals its points).
    const sel = this.selection;
    let best = null;
    for (const n of this.network.nodes.values()) {
      if (!this.view.isNodeShown(n.id)) continue;
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

  /** Add the network's current state to the undo history, keeping the last UNDO_LIMIT. */
  #remember() {
    this.history.push(structuredClone(this.network.toJSON()));
    if (this.history.length > UNDO_LIMIT) this.history.shift();
  }

  /**
   * Save the network for undo and forget anything that could be redone.
   * Called just before any undoable edit.
   */
  #snapshot() {
    this.#remember();
    this.redoStack.length = 0;
    this.build = null; // any other edit ends a mountain generation
  }

  /** Clear transient editing state before restoring a saved network. Used by #undo, #redo and startBuild. */
  #resetEditing() {
    this.build = null;
    this.drawing = null;
    this.pendingGenerate = null;
    this.selection = null;
    this.drag = null;
  }

  /**
   * Restore the last snapshot and make the current state redoable. Undoing a
   * trail still being drawn just cancels it, so it can't come back half-drawn.
   * Used by Ctrl+Z.
   */
  #undo() {
    const prev = this.history.pop();
    if (!prev) return;
    if (!this.drawing) this.redoStack.push(structuredClone(this.network.toJSON()));
    this.#resetEditing();
    this.network.load(prev);
  }

  /** Put back the state most recently undone. Does nothing while drawing. Used by Ctrl+Shift+Z. */
  #redo() {
    if (this.drawing || !this.redoStack.length) return;
    this.#remember();
    const next = this.redoStack.pop();
    this.#resetEditing();
    this.network.load(next);
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
   * Begin drawing a lift from its first end; #addDrawingPoint finishes it at the second.
   * `first` is { x, y } on open terrain or { node } for an existing point.
   * Used by the right-click menu.
   */
  #startLift(first) {
    this.#snapshot();
    // Named for real when finished, like a trail.
    const t = this.network.addTrail({ name: 'New lift', kind: 'lift', points: [{ ...first, width: LIFT_WIDTH }] });
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
   * A node already on this trail is ignored. A lift finishes at its second point.
   * Used by #onUp.
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
    if (this.network.isLift(this.drawing) && t.points.length >= 2) this.#finishDrawing();
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

  /**
   * Name a finished lift from the lift list, or a trail from the run-name list
   * for its difficulty, using `random` if given (see pickFrom in names.js).
   * Used by #finishDrawing, #runGenerate and #addSpec.
   */
  #giveDefaultName(t, random) {
    const used = [...this.network.trails.values()].map((x) => x.name);
    if (this.network.isLift(t.id)) {
      this.network.rename(t.id, pickLiftName(used, random));
      return;
    }
    const samples = sampleSpline(this.geometry.controlPoints(t));
    const rating = trailStats(samples, this.terrain)?.rating.index ?? 0;
    this.network.rename(t.id, pickRunName(rating, used, random));
  }

  /** Throw away the trail being drawn. Used by Esc and the right-click menu. */
  #cancelDrawing() {
    if (!this.drawing) return;
    const id = this.drawing;
    this.drawing = null;
    this.network.removeTrail(id);
  }

  /**
   * Wait for a click choosing where a generated trail should end.
   * `from` is { x, y }, { node }, or { trail, x, y } (a spot on a trail's line).
   * Used by the right-click menu.
   */
  #beginGenerate(from, target) {
    this.pendingGenerate = { from, target };
    this.selection = null;
  }

  /**
   * Use a clicked point, trail line (not a lift) or spot as the generated
   * trail's other end. Clicks too close to the start are ignored. Used by #onUp.
   */
  #chooseGenerateEnd(clicked) {
    const { from, target } = this.pendingGenerate;
    let to = null;
    if (clicked.type === 'node') {
      if (clicked.nodeId === from.node) return;
      to = { node: clicked.nodeId };
    } else if (clicked.type === 'line' && !this.network.isLift(clicked.trailId)) {
      to = { trail: clicked.trailId, x: clicked.x, y: clicked.y };
    } else if (clicked.world) {
      to = { x: clicked.world.x, y: clicked.world.y };
    }
    if (!to) return;
    const a = this.#endPosition(from), b = this.#endPosition(to);
    if (Math.hypot(a.x - b.x, a.y - b.y) < MIN_GENERATE) return;
    this.pendingGenerate = null;
    this.#runGenerate(from, to, target);
  }

  /**
   * Search for a route, then add it as an undoable trail. Warns with a toast if
   * no route exists or the terrain forced a different difficulty.
   * Used by #chooseGenerateEnd.
   */
  async #runGenerate(from, to, target) {
    const run = { target };
    this.generation = run;
    this.refresh();
    const result = await this.generator.generate(from, to, target, this.defaultWidth);
    if (this.generation !== run) return; // cancelled while searching
    this.generation = null;

    // The ends must still exist: an edit while searching could have removed them.
    const endsExist = result?.points.every((p) =>
      (!p.node || this.network.node(p.node)) && (!p.trail || this.network.trail(p.trail)));
    if (!endsExist) {
      showToast('No skiable route between these points.', WARNING_MS);
      this.refresh();
      return;
    }
    this.#snapshot();
    const t = this.network.addTrail({
      name: 'New trail', source: 'generated', meta: { target }, points: this.#resolveStops(result.points),
    });
    this.#giveDefaultName(t);
    this.selection = { trailId: t.id, index: null };
    if (result.rating !== target) {
      showToast(`Couldn't make a ${RATINGS[target].name} here. This run rates ${RATINGS[result.rating].name}.`, WARNING_MS);
    }
    this.refresh();
  }

  /** Where an end given as { node }, { x, y } or { trail, x, y } is. */
  #endPosition(end) {
    return end.node ? this.network.node(end.node) : end;
  }

  /**
   * Turn stops given as { trail, x, y, width } into junctions on that trail:
   * an existing stop within ATTACH_SNAP is reused, otherwise a point is
   * inserted on the trail's line there. Other stops pass through unchanged.
   * Ends further along a trail are inserted first, so the insert positions of
   * earlier ones (from the same, not yet re-sampled, geometry) stay right.
   * Used whenever a generated trail is added.
   */
  #resolveStops(points) {
    const out = points.map((p) => ({ ...p }));
    const joins = points
      .map((p, i) => (p.trail && this.network.trail(p.trail) ? { i, near: this.geometry.nearest(p.x, p.y, p.trail) } : null))
      .filter((j) => j?.near)
      .sort((a, b) => b.near.seg - a.near.seg || b.near.t - a.near.t);
    for (const { i, near } of joins) {
      const { trail: trailId, width } = points[i];
      const stops = this.network.trail(trailId).points;
      const close = stops.find((s) => {
        const n = this.network.node(s.node);
        return Math.hypot(n.x - near.x, n.y - near.y) < ATTACH_SNAP;
      });
      const node = close?.node ?? this.network.insertPoint(trailId, { x: near.x, y: near.y, width: near.w }, near.seg + 1);
      out[i] = { node, width };
    }
    // A trail that vanished (or was never sampled) leaves a plain spot instead.
    return out.map(({ trail, ...p }) => p);
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
    // Menu rows for generating a trail from this spot, one per difficulty.
    const generateItems = (from) => (this.generation ? [] : [
      { type: 'separator' },
      { type: 'header', label: 'Generate trail from here' },
      ...RATINGS.map((r, i) => ({
        label: r.name[0].toUpperCase() + r.name.slice(1),
        action: edit(() => this.#beginGenerate(from, i)),
      })),
    ]);
    const items = [];

    if (this.pendingGenerate) {
      items.push(
        { type: 'header', label: 'Generate trail' },
        { label: 'Cancel', danger: true, action: edit(() => { this.pendingGenerate = null; }) },
      );
    } else if (this.drawing && this.network.isLift(this.drawing)) {
      items.push(
        { type: 'header', label: this.network.trail(this.drawing).name },
        { label: 'Cancel lift', danger: true, action: edit(() => this.#cancelDrawing()) },
      );
    } else if (this.drawing) {
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
        { label: 'Start lift from here', action: edit(() => this.#startLift({ node: h.nodeId })) },
        ...generateItems({ node: h.nodeId }),
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
        // A lift has only two points, so removing either one deletes it.
        const removeLabel = this.network.isLift(id)
          ? (junction ? `Delete ${t.name}` : 'Delete lift')
          : (junction ? `Remove from ${t.name}` : 'Delete point');
        items.push({
          label: removeLabel,
          danger: true,
          action: edit(() => { this.#snapshot(); this.network.removePoint(id, index); this.selection = null; }),
        });
      }
    } else if (h.type === 'line') {
      const t = this.network.trail(h.trailId);
      const lift = this.network.isLift(h.trailId);
      items.push({ type: 'header', label: t.name });
      if (!lift) {
        items.push(
          { label: 'Branch from here', action: edit(() => this.#branchFromLine(h)) },
          { label: 'Insert point here', action: edit(() => this.#insertPoint(h)) },
          ...generateItems({ trail: h.trailId, x: h.x, y: h.y }),
          { type: 'separator' },
        );
      }
      items.push(
        {
          type: 'text', label: 'Name', value: t.name,
          onSubmit: (name) => { if (name) { this.#snapshot(); this.network.rename(h.trailId, name); this.refresh(); } },
        },
        { type: 'separator' },
        {
          label: lift ? 'Delete lift' : 'Delete trail', danger: true,
          action: edit(() => { this.#snapshot(); this.network.removeTrail(h.trailId); this.selection = null; }),
        },
      );
    } else if (h.world) {
      items.push(
        { label: 'Start new trail here', action: edit(() => this.#startTrail({ x: h.world.x, y: h.world.y, width: this.defaultWidth })) },
        { label: 'Start new lift here', action: edit(() => this.#startLift({ x: h.world.x, y: h.world.y })) },
        ...generateItems({ x: h.world.x, y: h.world.y }),
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

    // Locked, drawing, picking a generated trail's end, trail lines and open
    // terrain are all decided on release: a click acts, a drag orbits (or pans with Shift).
    if (this.locked || this.drawing || this.pendingGenerate || h.type === 'line' || h.type === 'terrain' || h.type === 'none') {
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
    } else if (this.pendingGenerate) {
      this.#chooseGenerateEnd(target);
    } else if (this.drawing) {
      if (isDouble) this.#finishDrawing();
      else this.#addDrawingPoint(target);
    } else if (target.type === 'line') {
      const lift = this.network.isLift(target.trailId); // lifts stay at two points
      if (press.shift && !lift) this.#branchFromLine(target);
      else if (isDouble && !lift) this.#insertPoint(target);
      else this.selection = { trailId: target.trailId, index: null };
    } else {
      this.selection = null; // click on open terrain deselects
    }
    this.refresh();
  }

  /**
   * Editing shortcuts: undo, redo, Enter, Esc, Delete, B, and - / =.
   * View shortcuts live in main.js.
   */
  #onKey(e) {
    // Don't treat typing in a menu field (width, rename) as shortcuts.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const sel = this.selection;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (this.locked) this.onLocked?.();
      else if (e.shiftKey) this.#redo();
      else this.#undo();
    } else if (this.locked) {
      return; // nothing is selected while locked; other keys do nothing
    } else if (e.key === 'Enter') {
      this.#finishDrawing();
    } else if (e.key === 'Escape') {
      if (this.build) this.#cancelBuild();
      else if (this.pendingGenerate) this.pendingGenerate = null;
      else if (this.generation) this.generation = null;
      else if (this.drawing) this.#cancelDrawing();
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
