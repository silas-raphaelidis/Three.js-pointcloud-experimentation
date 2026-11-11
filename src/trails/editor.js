import * as THREE from 'three';
import { trailStats, uphillStretches } from './stats.js';
import { ContextMenu } from './menu.js';
import { sampleSpline } from './spline.js';
import { pickRunName, pickLiftName } from './names.js';
import { RATINGS, ratingLabel, ratingIcon, getThresholds } from '../difficulty.js';
import { showToast } from '../toast.js';

const PICK_PX = 11;         // screen radius for grabbing points and handles
const HANDLE_MIN_GAP_PX = 20; // width handles closer than this to their point (on screen) can't be grabbed
const HANDLE_MARGIN_PX = 4;   // a handle must be this much closer than any point to win
const MERGE_PX = 14;        // a point let go this close to its neighbor (on screen) merges with it
const CLICK_PX = 5;         // movement allowed before a press counts as a drag
const DOUBLE_CLICK_MS = 350;
const MIN_WIDTH = 6;
const WIDTH_STEP = 4;       // meters per - / = press
const MAX_WIDTH = 120;
const UNDO_LIMIT = 60;
const LIFT_WIDTH = 20;      // default width of the cut for a lift line, meters
const WARNING_MS = 5000;    // how long generation warnings stay on screen
const ATTACH_SNAP = 12;     // meters: a generated trail ending this close to a stop joins it
const MIN_GENERATE = 30;    // meters: a routed stretch shorter than this is refused

/**
 * Mouse/keyboard editing of the trail network. Always on (there is no
 * separate view mode); editing only happens through deliberate actions, so
 * casual clicking and dragging just looks around.
 *
 *   drag anywhere             orbit (also when starting on a trail line)
 *   click a trail             select it
 *   double-click a trail      insert a point there
 *   drag a point              move it (junctions move every trail through them);
 *                             let go on its neighbor and the two merge
 *   drag a side handle        change the selected point's width
 *   Shift-click points        select several on one trail, to drag, widen or
 *                             delete together
 *   B (or right-click)        start a new trail from the selected point
 *   right-click               options for a point / trail / spot
 *                             ("Start new trail / lift here" on open terrain)
 *   drawing a lift: the second click places the other end and finishes it
 *   lifts stay at two points: no inserting points or branching mid-line
 *   generating a mountain: Esc cancels and puts the old trails back
 *   while drawing: click adds a point, double-click / Enter finishes, Ctrl+Z
 *                             removes the last point (or stretch), Esc cancels
 *   while drawing a trail, 1-4 picks a difficulty: each click then routes a
 *                             stretch from the last point to there at that
 *                             difficulty (ending on a point or a trail's line
 *                             joins it); H goes back to drawing by hand. The
 *                             right-click menu's difficulties start a trail
 *                             that way, so generating a trail is: pick a
 *                             difficulty, click its end, finish.
 *   - / =                     narrower / wider (selected points, or new trails)
 *   Delete                    delete the selected points, or the selected trail
 *   Ctrl+Z · Ctrl+Shift+Z · Esc   undo · redo · deselect
 *   The same actions show as buttons for whatever is going on (see actions).
 *   Alt + drag                always orbits/pans, even over points (trackpads)
 *
 * When locked, trails can't be hovered, selected or edited; any attempt
 * calls onLocked() so the app can say so. The same holds while trails are
 * hidden from view (View > Trails and lifts), since they can't be seen.
 */
export class TrailEditor {
  /** Attaches the mouse and keyboard listeners. Created once in setupTrails (main.js). */
  constructor({ network, geometry, terrain, camera, dom, controls, view, generator, onStatus, onLocked, onFrame }) {
    Object.assign(this, { network, geometry, terrain, camera, dom, controls, view, generator, onStatus, onLocked, onFrame });
    this.lockedByUser = false; // the lock button / L
    this.trailsHidden = false; // trails and lifts turned off in the View menu
    this.drawMode = null;      // while drawing a trail: null by hand, or a rating index to route stretches at
    this.routing = null;       // { target, to, finish } while a stretch's route search runs
    this.stretches = [];       // per click on the trail being drawn: { count, joined }, for undo (see #undo)
    this.defaultWidth = 36;
    this.pickHidden = false;   // true while hidden trails are ghosted (G)
    this.drawing = null;       // trail id being created
    // { trailId, index|null, indexes? }: a trail, or points on it. `index` is
    // the main point (width handles, B); `indexes` lists every selected point
    // when Shift-click has added more.
    this.selection = null;
    this.drag = null;          // { type: 'node'|'group'|'width', ... }
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
    this.ratings = new WeakMap(); // sampled trail -> { thresholds, index }, see #ratingOf

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
      if (!t || this.#selectedIndexes().some((i) => i >= t.points.length)) this.selection = null;
    }
    if (this.drawing && !this.network.trail(this.drawing)) this.drawing = null;

    const sel = this.selection;
    let highlightNodes = [];
    let handles = null;
    if (sel && sel.index !== null) {
      highlightNodes = this.#selectedIndexes().map((i) => this.#stopNode(sel.trailId, i));
      handles = this.#handlePositions(sel.trailId, sel.index);
    } else if (this.hover?.type === 'node' && !this.locked) {
      // The hovered point may have just been removed (Ctrl+Z, Delete) under the mouse.
      highlightNodes = [this.network.node(this.hover.nodeId)].filter(Boolean);
    }

    let preview = null;
    const to = this.routing?.to ?? this.cursorWorld;
    if (this.drawing && to) {
      const t = this.network.trail(this.drawing);
      const last = this.network.node(t.points[t.points.length - 1].node);
      preview = { from: last, to };
    }

    // Hovering a trail, or a point on it (a junction: every trail through it).
    const h = this.locked ? null : this.hover;
    const hoverTrails = h?.type === 'line' ? [h.trailId]
      : h?.type === 'node' ? this.network.trailsUsingNode(h.nodeId)
      : [];
    this.view.setState({
      selectedTrail: this.drawing ?? sel?.trailId ?? null,
      hoverTrails,
      highlightNodes,
      handles,
      preview,
    });
    this.onStatus?.(this.panelState(), this.actions());
  }

  /**
   * The buttons for what can be done right now, each with its shortcut:
   * [{ label, key, run, danger?, primary?, disabled? }], empty when there's
   * nothing to offer. Passed to onStatus by refresh, for the action bar.
   */
  actions() {
    if (this.locked) return [];
    // Each button does what its key does, then refreshes.
    const act = (label, key, fn, opts = {}) => ({
      label, key, ...opts,
      run: () => { if (!this.locked) { fn(); this.refresh(); } },
    });
    const cancel = (label) => act(label, 'Esc', () => this.#escape(), { danger: true });
    if (this.build) return [cancel('Stop generating')];
    if (this.drawing) {
      const t = this.network.trail(this.drawing);
      if (this.network.isLift(this.drawing)) return [cancel('Cancel lift')];
      // How the next click adds to the trail: by hand, or routed at a difficulty.
      const modes = [
        act('By hand', 'H', () => this.#setDrawMode(null), { active: this.drawMode === null }),
        ...RATINGS.map((_, i) => act(`${ratingIcon(i)} ${ratingLabel(i)}`, String(i + 1),
          () => this.#setDrawMode(i), { active: this.drawMode === i })),
        { type: 'separator' },
      ];
      if (this.routing) {
        return [
          ...modes,
          act('Finish trail', 'Enter', () => this.#finishOrQueue(), { primary: true }),
          cancel('Stop routing'),
        ];
      }
      const enough = t.points.length >= 2;
      return [
        ...modes,
        act('Finish trail', 'Enter', () => this.#finishOrQueue(), { primary: true, disabled: !enough }),
        act(this.stretches.at(-1)?.routed ? 'Remove last stretch' : 'Remove last point', 'Ctrl+Z',
          () => this.#undo(), { disabled: !enough }),
        cancel('Cancel trail'),
      ];
    }
    const sel = this.selection;
    if (!sel) return [];
    const lift = this.network.isLift(sel.trailId);
    const indexes = this.#selectedIndexes();
    if (!indexes.length) {
      return [
        act('Frame', 'F', () => this.onFrame?.()),
        act(lift ? 'Delete lift' : 'Delete trail', 'Del', () => this.#deleteSelection(), { danger: true }),
      ];
    }
    const width = [
      act('Narrower', '−', () => this.#changeWidth(-WIDTH_STEP)),
      act('Wider', '=', () => this.#changeWidth(WIDTH_STEP)),
    ];
    if (indexes.length > 1) {
      return [...width, act(`Delete ${indexes.length} points`, 'Del', () => this.#deleteSelection(), { danger: true })];
    }
    return [
      act('Start trail from here', 'B', () => this.#branchFromSelection()),
      ...width,
      act(lift ? 'Delete lift' : 'Delete point', 'Del', () => this.#deleteSelection(), { danger: true }),
    ];
  }

  /**
   * What the trail panel should show, or null when nothing is selected or drawn.
   * Used by refresh, which passes it to onStatus.
   */
  panelState() {
    if (this.drawing) {
      return {
        kind: 'drawing',
        lift: this.network.isLift(this.drawing),
        points: this.network.trail(this.drawing)?.points.length ?? 0,
        mode: this.drawMode === null ? null : RATINGS[this.drawMode].name,
        routing: !!this.routing,
      };
    }
    const sel = this.selection;
    if (!sel) return null;
    const t = this.network.trail(sel.trailId);
    const geo = this.geometry.get(sel.trailId);
    const widths = this.#selectedIndexes().map((i) => t.points[i].width);
    const point = sel.index === null ? null : {
      index: sel.index,
      count: t.points.length,
      junction: this.network.isJunction(t.points[sel.index].node),
      width: t.points[sel.index].width,
      selected: widths.length,
      minWidth: Math.min(...widths),
      maxWidth: Math.max(...widths),
    };
    const lift = this.network.isLift(t.id);
    return {
      kind: 'trail',
      lift,
      trailId: t.id,
      name: t.name,
      stats: geo ? trailStats(geo.samples, this.terrain) : null,
      serves: lift ? this.#liftServes(t) : null,
      uphill: lift || !geo ? [] : uphillStretches(geo.samples, this.terrain),
      point,
    };
  }

  /**
   * Rating indexes (easiest first) of every run you can ski from a lift's
   * top without riding another lift: down each run through its top, then
   * on through any junction further down, as far as the runs go. Like the
   * "this lift serves" line on a real lift sign. Used by panelState.
   */
  #liftServes(lift) {
    const height = (nodeId) => {
      const n = this.network.node(nodeId);
      return this.terrain.trailHeightAt(n.x, n.y);
    };
    const ends = lift.points.map((p) => p.node);
    const top = height(ends[0]) >= height(ends[1]) ? ends[0] : ends[1];
    const seen = new Set([top]), skied = new Set(), queue = [top];
    while (queue.length) {
      const node = queue.shift();
      for (const id of this.network.trailsUsingNode(node)) {
        if (this.network.isLift(id)) continue;
        const stops = this.network.trail(id).points.map((p) => p.node);
        // Which way the run goes downhill, and the stops below this one.
        const forward = height(stops[0]) >= height(stops[stops.length - 1]);
        const i = stops.indexOf(node);
        const below = forward ? stops.slice(i + 1) : stops.slice(0, i).reverse();
        if (!below.length) continue;
        skied.add(id);
        for (const next of below) if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    const indexes = new Set([...skied].map((id) => this.#ratingOf(id)).filter((i) => i != null));
    return [...indexes].sort((a, b) => a - b);
  }

  /** A trail's rating index, cached until it changes or the thresholds do. Used by #liftServes. */
  #ratingOf(trailId) {
    const geo = this.geometry.get(trailId);
    if (!geo) return null;
    const thresholds = getThresholds().join();
    const cached = this.ratings.get(geo);
    if (cached?.thresholds === thresholds) return cached.index;
    const index = trailStats(geo.samples, this.terrain)?.rating.index ?? null;
    this.ratings.set(geo, { thresholds, index });
    return index;
  }

  /** Rename a trail (undoable). Used by the name field in the trail panel. */
  rename(trailId, name) {
    if (this.locked) { this.onLocked?.(); return; }
    this.#snapshot();
    this.network.rename(trailId, name);
    this.refresh();
  }

  /**
   * Remove every trail and lift as one undo step. Returns false (and changes
   * nothing) if trails are locked or hidden, or there's nothing to clear.
   * Used by the Clear mountain button (main.js).
   */
  clearAll() {
    if (this.locked) { this.onLocked?.(); return false; }
    if (!this.network.trails.size) return false;
    this.#cancelDrawing();
    this.#snapshot(); // also ends a mountain generation in progress
    this.#resetEditing();
    this.network.clear();
    this.refresh();
    return true;
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

    // Points come first. Width handles only count once they sit well apart
    // from their point on screen (zoomed in), and then only when the press is
    // clearly closer to a handle than to any point, so a press on a point
    // from a distance never grabs a handle by accident. Points on the selected
    // trail get a small bonus. Only points with a dot drawn count (hovering a
    // trail reveals its points).
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
      const stop = this.#stopNode(sel.trailId, sel.index);
      const point = this.#toScreen(stop.x, stop.y);
      for (const h of this.#handlePositions(sel.trailId, sel.index) ?? []) {
        const hs = this.#toScreen(h.x, h.y);
        if (!point || !hs || Math.hypot(hs.x - point.x, hs.y - point.y) < HANDLE_MIN_GAP_PX) continue;
        const d = near(h);
        if (d < PICK_PX && (!best || d < best.score - HANDLE_MARGIN_PX)) best = { score: d, type: 'handle' };
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
    this.routing = null;
    this.stretches = [];
    this.selection = null;
    this.drag = null;
  }

  /** Undo, as Ctrl+Z does (or say why not, if locked). Used by the Undo button. */
  undo() {
    if (this.locked) { this.onLocked?.(); return; }
    this.#undo();
    this.refresh();
  }

  /** Redo, as Ctrl+Shift+Z does (or say why not, if locked). Used by the Redo button. */
  redo() {
    if (this.locked) { this.onLocked?.(); return; }
    this.#redo();
    this.refresh();
  }

  /** Is there anything to undo? Used to grey out the Undo button. */
  get canUndo() { return !this.locked && this.history.length > 0; }

  /** Is there anything to redo? Used to grey out the Redo button. */
  get canRedo() { return !this.locked && !this.drawing && this.redoStack.length > 0; }

  /**
   * Restore the last snapshot and make the current state redoable. While
   * drawing a trail it takes back the last click instead: the point placed,
   * or the whole stretch routed (and the junction it made on another trail),
   * or stops a route search still running. Once only the first point is
   * left it cancels the trail (it can't come back half-drawn).
   * Used by Ctrl+Z, the Undo button and the action bar.
   */
  #undo() {
    if (this.drawing && this.routing) { this.routing = null; return; }
    const drawn = this.drawing && this.network.trail(this.drawing);
    if (drawn && drawn.points.length > 1) {
      const last = this.stretches.pop() ?? { count: drawn.points.length - 1, joined: null };
      while (drawn.points.length > Math.max(1, last.count)) {
        this.network.removePoint(this.drawing, drawn.points.length - 1, { keepShort: true });
      }
      const j = last.joined;
      const other = j && this.network.trail(j.trailId);
      const k = other ? other.points.findIndex((p) => p.node === j.nodeId) : -1;
      if (k > 0 && k < other.points.length - 1 && !this.network.isJunction(j.nodeId)) {
        this.network.removePoint(j.trailId, k);
      }
      return;
    }
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
  #startTrail(first, mode = null) {
    this.#snapshot();
    // Named for real when finished, once its difficulty is known.
    const t = this.network.addTrail({ name: 'New trail', points: [first] });
    this.#beginDrawing(t.id, mode);
  }

  /**
   * Make a just-added trail or lift the one being drawn, by hand or (`mode`,
   * a rating index) routing each stretch. Used by everything that starts one.
   */
  #beginDrawing(trailId, mode = null) {
    this.drawing = trailId;
    this.drawMode = this.network.isLift(trailId) ? null : mode;
    this.routing = null;
    this.stretches = [];
    this.selection = null;
  }

  /** Draw the next stretch by hand (null) or routed at a rating. Used by H, 1-4 and the action bar. */
  #setDrawMode(mode) {
    if (this.drawing && !this.network.isLift(this.drawing)) this.drawMode = mode;
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
    this.#beginDrawing(t.id);
  }

  /**
   * Begin drawing a branch from an existing point.
   * Used by #branchFromSelection and the right-click menu.
   */
  #branchFromNode(nodeId, mode = null) {
    this.#startTrail({ node: nodeId, width: Math.min(this.defaultWidth, 24) }, mode);
  }

  /**
   * Add a point on a trail at the picked spot and begin a branch from it.
   * Used by the right-click menu.
   */
  #branchFromLine(h, mode = null) {
    this.#snapshot();
    const nodeId = this.network.insertPoint(h.trailId, { x: h.x, y: h.y, width: h.w }, h.seg + 1);
    const t = this.network.addTrail({ name: 'New trail', points: [{ node: nodeId, width: Math.min(this.defaultWidth, 24) }] });
    this.#beginDrawing(t.id, mode);
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
   * Add a click to the trail being drawn: a point there by hand (snapping to
   * a node if one was clicked), or a routed stretch when a difficulty is
   * picked. A node already on this trail is ignored, and so are clicks while
   * a stretch is still being routed. A lift finishes at its second point.
   * Used by #onUp.
   */
  #addDrawingPoint(target) {
    if (this.routing) return;
    if (this.drawMode !== null) { this.#routeStretch(target); return; }
    const t = this.network.trail(this.drawing);
    const count = t.points.length;
    const width = t.points[count - 1].width;
    if (target.type === 'node') {
      if (t.points.some((p) => p.node === target.nodeId)) return;
      this.network.insertPoint(this.drawing, { node: target.nodeId, width });
    } else if (target.world) {
      this.network.insertPoint(this.drawing, { x: target.world.x, y: target.world.y, width });
    }
    if (t.points.length > count) this.stretches.push({ count, joined: null });
    if (this.network.isLift(this.drawing) && t.points.length >= 2) this.#finishDrawing();
  }

  /**
   * Route a stretch of the trail being drawn from its last point to the
   * clicked spot, point, or trail line (which it joins), at the picked
   * difficulty, using the same search as a generated trail. Warns with a
   * toast if there's no route or the terrain forced another difficulty.
   * Used by #addDrawingPoint.
   */
  async #routeStretch(clicked) {
    const id = this.drawing;
    const t = this.network.trail(id);
    const last = t.points[t.points.length - 1];
    let to = null;
    if (clicked.type === 'node') {
      if (t.points.some((p) => p.node === clicked.nodeId)) return;
      to = { node: clicked.nodeId };
    } else if (clicked.type === 'line' && clicked.trailId !== id && !this.network.isLift(clicked.trailId)) {
      to = { trail: clicked.trailId, x: clicked.x, y: clicked.y };
    } else if (clicked.world) {
      to = { x: clicked.world.x, y: clicked.world.y };
    }
    if (!to) return;
    const from = { node: last.node };
    const a = this.#endPosition(from), b = this.#endPosition(to);
    if (Math.hypot(a.x - b.x, a.y - b.y) < MIN_GENERATE) {
      showToast('Too close to route a stretch · click further away');
      return;
    }

    const run = { target: this.drawMode, to: { x: b.x, y: b.y }, finish: false };
    this.routing = run;
    this.refresh();
    const result = await this.generator.generate(from, to, run.target, last.width, { ignore: id });
    if (this.routing !== run) return; // stopped while searching
    this.routing = null;

    // The ends must still exist: nothing else should change while drawing, but be sure.
    const ok = result && this.drawing === id && t.points.at(-1)?.node === last.node &&
      result.points.every((p) => (!p.node || this.network.node(p.node)) && (!p.trail || this.network.trail(p.trail)));
    if (!ok) {
      showToast('No skiable route to there.', WARNING_MS);
    } else {
      // Routes run downhill; put the stops in drawing order, from the last point.
      const stops = result.points[0].node === last.node ? result.points : [...result.points].reverse();
      const rest = stops.slice(1);
      const count = t.points.length;
      // Joining a trail's line may add a point to it; undo takes that back too.
      const k = rest.findIndex((p) => p.trail);
      const other = k >= 0 ? this.network.trail(rest[k].trail) : null;
      const before = other?.points.length;
      const resolved = this.#resolveStops(rest);
      const joined = other && other.points.length > before ? { trailId: other.id, nodeId: resolved[k].node } : null;
      for (const p of resolved) this.network.insertPoint(id, p);
      this.stretches.push({ count, joined, routed: true });
      if (result.rating !== run.target) {
        const want = RATINGS[run.target].name, got = RATINGS[result.rating].name;
        showToast(`Couldn't make ${/^[aeiou]/.test(want) ? 'an' : 'a'} ${want} stretch here. It rates ${got}.`, WARNING_MS);
      }
    }
    if (run.finish) this.#finishDrawing();
    this.refresh();
  }

  /**
   * Finish the trail being drawn, or, while a stretch is still being routed,
   * as soon as it lands. Used by Enter, double-click and the action bar.
   */
  #finishOrQueue() {
    if (this.routing) this.routing.finish = true;
    else this.#finishDrawing();
  }

  /**
   * End the current drawing. Too short: removed. Otherwise named and selected.
   * Used by double-click, Enter, the right-click menu and locking.
   */
  #finishDrawing() {
    if (!this.drawing) return;
    const id = this.drawing;
    this.drawing = null;
    this.routing = null;
    this.stretches = [];
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
   * Used by #finishDrawing and #addSpec.
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
    this.routing = null;
    this.stretches = [];
    this.network.removeTrail(id);
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

  /** Indexes of the selected points (the main one last added), or [] for none. */
  #selectedIndexes() {
    const sel = this.selection;
    if (!sel || sel.index === null) return [];
    return sel.indexes ?? [sel.index];
  }

  /**
   * Shift-click: add a point on the selected trail to the selection, or take
   * it out again. A point on another trail starts a new selection.
   * Used by #onDown.
   */
  #toggleInSelection(nodeId) {
    const sel = this.selection;
    const t = sel && this.network.trail(sel.trailId);
    const i = t ? t.points.findIndex((p) => p.node === nodeId) : -1;
    if (i < 0) { this.#selectNode(nodeId); return; }
    const current = this.#selectedIndexes();
    const next = current.includes(i) ? current.filter((x) => x !== i) : [...current, i];
    this.selection = !next.length ? { trailId: t.id, index: null }
      : next.length === 1 ? { trailId: t.id, index: next[0] }
      : { trailId: t.id, index: next[next.length - 1], indexes: next };
  }

  /** Delete the selected points, or the selected trail. Used by Delete and the action bar. */
  #deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    this.#snapshot();
    const indexes = this.#selectedIndexes().sort((a, b) => b - a); // last first, so the rest keep their place
    if (!indexes.length) this.network.removeTrail(sel.trailId);
    for (const i of indexes) {
      if (!this.network.trail(sel.trailId)) break; // too few points left: the trail went with them
      this.network.removePoint(sel.trailId, i);
    }
    this.selection = null;
  }

  /**
   * Widen (or narrow) the selected points by `delta` meters, or the width new
   * trails start at when no point is selected. Used by - / = and the action bar.
   */
  #changeWidth(delta) {
    const indexes = this.#selectedIndexes();
    const clamp = (w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
    if (!indexes.length) { this.defaultWidth = clamp(this.defaultWidth + delta); return; }
    this.#snapshot();
    const t = this.network.trail(this.selection.trailId);
    for (const i of indexes) this.network.setWidth(t.id, i, clamp(t.points[i].width + delta));
  }

  /** Start a new trail from the main selected point. Used by B and the action bar. */
  #branchFromSelection() {
    const sel = this.selection;
    if (sel?.index != null) this.#branchFromNode(this.network.trail(sel.trailId).points[sel.index].node);
  }

  /**
   * Esc: stop whatever is going on, newest first (a mountain build, a
   * stretch being routed, a trail being drawn), or else deselect. Used by Esc and the action bar.
   */
  #escape() {
    if (this.build) this.#cancelBuild();
    else if (this.routing) this.routing = null;
    else if (this.drawing) this.#cancelDrawing();
    else this.selection = null;
  }

  /**
   * A dragged point let go on top of its neighbor along the selected trail
   * merges with it: the one in the middle of the trail goes, so ends and
   * junctions stay. Part of the drag's undo step. Used by #onUp.
   */
  #mergeIfOnNeighbor(nodeId) {
    const sel = this.selection;
    const t = sel && this.network.trail(sel.trailId);
    if (!t || t.points.length < 3) return;
    const i = t.points.findIndex((p) => p.node === nodeId);
    const me = i >= 0 && this.network.node(nodeId);
    const here = me && this.#toScreen(me.x, me.y);
    if (!here) return;
    const last = t.points.length - 1;
    const removable = (k) => k > 0 && k < last && !this.network.isJunction(t.points[k].node);
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j > last) continue;
      const n = this.network.node(t.points[j].node);
      const there = this.#toScreen(n.x, n.y);
      if (!there || Math.hypot(there.x - here.x, there.y - here.y) > MERGE_PX) continue;
      const drop = removable(i) ? i : removable(j) ? j : -1;
      if (drop < 0) return;
      const keep = drop === i ? j : i;
      this.network.removePoint(t.id, drop);
      this.selection = { trailId: t.id, index: keep > drop ? keep - 1 : keep };
      showToast('Points merged');
      return;
    }
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
    // Menu rows for generating a trail from this spot, one per difficulty:
    // `start(i)` starts drawing it with stretches routed at that difficulty.
    const generateItems = (start) => [
      { type: 'separator' },
      { type: 'header', label: 'Generate trail from here' },
      ...RATINGS.map((_, i) => ({
        label: ratingLabel(i),
        icon: ratingIcon(i),
        action: edit(() => start(i)),
      })),
    ];
    const items = [];

    if (this.drawing && this.network.isLift(this.drawing)) {
      items.push(
        { type: 'header', label: this.network.trail(this.drawing).name },
        { label: 'Cancel lift', danger: true, action: edit(() => this.#cancelDrawing()) },
      );
    } else if (this.drawing) {
      items.push(
        { type: 'header', label: this.network.trail(this.drawing).name },
        { label: 'Finish trail', action: edit(() => this.#finishOrQueue()) },
        { label: 'Cancel trail', danger: true, action: edit(() => this.#cancelDrawing()) },
      );
    } else if (h.type === 'node') {
      const trailIds = this.network.trailsUsingNode(h.nodeId);
      const junction = trailIds.length > 1;
      items.push(
        { type: 'header', label: junction ? `Junction · ${trailIds.length} trails` : 'Point' },
        { label: 'Start trail from here', action: edit(() => this.#branchFromNode(h.nodeId)) },
        { label: 'Start lift from here', action: edit(() => this.#startLift({ node: h.nodeId })) },
        ...generateItems((i) => this.#branchFromNode(h.nodeId, i)),
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
          { label: 'Start trail from here', action: edit(() => this.#branchFromLine(h)) },
          { label: 'Insert point here', action: edit(() => this.#insertPoint(h)) },
          ...generateItems((i) => this.#branchFromLine(h, i)),
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
        ...generateItems((i) => this.#startTrail({ x: h.world.x, y: h.world.y, width: this.defaultWidth }, i)),
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

    // Locked, drawing, trail lines and open terrain are all decided on release: a click acts, a drag orbits (or pans with Shift).
    if (this.locked || this.drawing || h.type === 'line' || h.type === 'terrain' || h.type === 'none') {
      this.press = { x: e.clientX, y: e.clientY, target: h };
      return;
    }

    // Points and width handles are small, deliberate targets: grab them now.
    e.stopImmediatePropagation(); // keep OrbitControls out of it
    e.preventDefault();
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    this.controls.enabled = false;
    this.grabbed = true;

    const sel = this.selection;
    const selectedNodes = this.#selectedIndexes().map((i) => this.network.trail(sel.trailId).points[i].node);
    const start = this.#terrainAt(e.clientX, e.clientY);
    if (h.type === 'handle') {
      // Every selected point changes width by the same amount as the main one.
      this.#snapshot();
      const t = this.network.trail(sel.trailId);
      this.drag = {
        type: 'width', trailId: sel.trailId, index: sel.index,
        widths: this.#selectedIndexes().map((i) => ({ i, width: t.points[i].width })),
      };
    } else if (e.shiftKey) {
      this.#toggleInSelection(h.nodeId);
    } else if (selectedNodes.length > 1 && selectedNodes.includes(h.nodeId) && start) {
      // Pressing one of several selected points drags them all; a click
      // without moving selects just that one (see #onUp).
      this.drag = {
        type: 'group', nodeId: h.nodeId, start, moved: false,
        nodes: selectedNodes.map((id) => ({ id, x: this.network.node(id).x, y: this.network.node(id).y })),
      };
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
    } else if (this.drag?.type === 'group' && world) {
      if (!this.drag.moved) { this.#snapshot(); this.drag.moved = true; }
      const dx = world.x - this.drag.start.x, dy = world.y - this.drag.start.y;
      for (const n of this.drag.nodes) this.network.moveNode(n.id, n.x + dx, n.y + dy);
    } else if (this.drag?.type === 'width' && world) {
      const { trailId, index, widths } = this.drag;
      const n = this.#stopNode(trailId, index);
      const clamp = (w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
      const w = clamp(2 * Math.hypot(world.x - n.x, world.y - n.y));
      const delta = w - widths.find((s) => s.i === index).width;
      for (const s of widths) this.network.setWidth(trailId, s.i, clamp(s.width + delta));
    } else if (!this.drag && !this.press) {
      this.hover = this.#pick(e.clientX, e.clientY);
      this.dom.style.cursor = this.hoveringSelectable ? 'pointer' : '';
    }
    this.refresh();
  }

  /**
   * Pointer release: returns the camera if it was taken and finishes a drag
   * (merging a point let go on its neighbor), then treats a short press as a
   * click (select, add a point). A right-click opens the menu.
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
    const drag = this.drag;
    this.drag = null;
    if (drag?.type === 'node' && drag.moved) this.#mergeIfOnNeighbor(drag.nodeId);
    if (drag?.type === 'group' && !drag.moved) this.#selectNode(drag.nodeId);

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
      if (isDouble) this.#finishOrQueue();
      else this.#addDrawingPoint(target);
    } else if (target.type === 'line') {
      const lift = this.network.isLift(target.trailId); // lifts stay at two points
      if (isDouble && !lift) this.#insertPoint(target);
      else this.selection = { trailId: target.trailId, index: null };
    } else {
      this.selection = null; // click on open terrain deselects
    }
    this.refresh();
  }

  /**
   * Editing shortcuts: undo, redo, Enter, Esc, Delete, B, - / =, and while
   * drawing, H and 1-4 for how the next stretch is drawn.
   * View shortcuts live in main.js.
   */
  #onKey(e) {
    // Don't treat typing in a menu field (width, rename) as shortcuts.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const sel = this.selection;
    // The action bar's buttons take focus when clicked; Enter or Space there
    // presses the button, so it isn't also a shortcut.
    if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (this.locked) this.onLocked?.();
      else if (e.shiftKey) this.#redo();
      else this.#undo();
    } else if (this.locked) {
      return; // nothing is selected while locked; other keys do nothing
    } else if (e.key === 'Enter') {
      this.#finishOrQueue();
    } else if (this.drawing && (e.key === 'h' || e.key === 'H')) {
      this.#setDrawMode(null);
    } else if (this.drawing && e.key >= '1' && e.key <= String(RATINGS.length)) {
      this.#setDrawMode(Number(e.key) - 1);
    } else if (e.key === 'Escape') {
      this.#escape();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !this.drawing) {
      this.#deleteSelection();
    } else if (e.key === 'b' || e.key === 'B') {
      this.#branchFromSelection();
    } else if (e.key === '-' || e.key === '_' || e.key === '=' || e.key === '+') {
      this.#changeWidth(e.key === '-' || e.key === '_' ? -WIDTH_STEP : WIDTH_STEP);
    } else {
      return;
    }
    this.refresh();
  }
}
