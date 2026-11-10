/**
 * The trail network: plain data, no Three.js.
 *
 * - A NODE is a physical point on the mountain (local x, y). Nothing else.
 * - A TRAIL is an ordered list of { node, width } stops. Width belongs to the
 *   trail's use of the node, so two trails sharing a junction can be
 *   different widths there (a skinny branch off a wide run).
 * - A BRANCH is a trail whose first node already belongs to another trail.
 * - A LIFT is a trail with kind 'lift' and exactly two stops. It cuts the
 *   forest like any trail, but isn't rated. Saves from before lifts existed
 *   have no kind, and count as ordinary runs.
 *
 * Both the editor and (later) the pathfinder build trails only through this
 * API. Every edit fires a 'change' event naming the trails it affected.
 */
export class TrailNetwork extends EventTarget {
  /** Starts empty. main.js creates the one shared network, and saved trails are loaded into it. */
  constructor() {
    super();
    this.nodes = new Map(); // id -> { id, x, y }
    this.trails = new Map(); // id -> { id, name, kind, source, meta, points: [{ node, width }] }
    this.nextId = 1;
  }

  // ---------- Queries ----------

  /** Look up a node by id. Used throughout the editor, spline code and view. */
  node(id) { return this.nodes.get(id); }
  /** Look up a trail by id. Used throughout the editor, and by the spline cache. */
  trail(id) { return this.trails.get(id); }

  /** Is this trail a lift? Used by the editor and TrailView, which treat lifts differently. */
  isLift(id) { return this.trails.get(id)?.kind === 'lift'; }

  /**
   * Ids of every trail that passes through a node.
   * Used to find which trails a node move affects, to delete unused nodes, and by the editor for junctions.
   */
  trailsUsingNode(nodeId) {
    const out = [];
    for (const t of this.trails.values()) {
      if (t.points.some((p) => p.node === nodeId)) out.push(t.id);
    }
    return out;
  }

  /**
   * True if more than one trail uses this node.
   * Used by TrailView to color junction dots and by the editor for the trail panel.
   */
  isJunction(nodeId) { return this.trailsUsingNode(nodeId).length > 1; }

  // ---------- Edits ----------

  /**
   * Create a node at local x, y and return its id.
   * Used by addTrail and insertPoint whenever a stop is given as coordinates.
   */
  addNode(x, y) {
    const id = `n${this.nextId++}`;
    this.nodes.set(id, { id, x, y });
    return id;
  }

  /**
   * Create a trail and return it. Each point is either { x, y, width } (a new node)
   * or { node, width } (an existing node, e.g. a branch start).
   * source and meta are stored and saved but not read yet; they are reserved for generated trails.
   * kind is 'run' or 'lift'. Used by the editor when a trail, branch or lift is started.
   */
  addTrail({ points = [], name, kind = 'run', source = 'manual', meta = {} } = {}) {
    const id = `t${this.nextId++}`;
    const trail = {
      id,
      name: name ?? `Trail ${this.trails.size + 1}`,
      kind,
      source,
      meta,
      points: points.map((p) => ({ node: p.node ?? this.addNode(p.x, p.y), width: p.width })),
    };
    this.trails.set(id, trail);
    this.#changed([id]);
    return trail;
  }

  /**
   * Insert a stop at `index` (defaults to the end) and return its node id.
   * Used by the editor to extend a trail being drawn, insert a point, and split a line for a branch.
   */
  insertPoint(trailId, point, index) {
    const t = this.trails.get(trailId);
    const stop = { node: point.node ?? this.addNode(point.x, point.y), width: point.width };
    t.points.splice(index ?? t.points.length, 0, stop);
    this.#changed([trailId]);
    return stop.node;
  }

  /**
   * Move a node. Fires a change for every trail through it, so junctions stay connected.
   * Used by the editor while a point is dragged.
   */
  moveNode(nodeId, x, y) {
    const n = this.nodes.get(nodeId);
    n.x = x;
    n.y = y;
    this.#changed(this.trailsUsingNode(nodeId));
  }

  /** Set a trail's name. Used by the editor (panel, right-click menu, automatic naming). */
  rename(trailId, name) {
    this.trails.get(trailId).name = name;
    this.#changed([trailId]);
  }

  /**
   * Set a trail's width at one stop. Width belongs to the stop, not the node.
   * Used by the editor (width handles, - / = keys, right-click menu).
   */
  setWidth(trailId, index, width) {
    this.trails.get(trailId).points[index].width = width;
    this.#changed([trailId]);
  }

  /**
   * Remove one stop. A trail left with fewer than 2 stops is removed entirely.
   * Used by the editor (Delete key and right-click menu).
   */
  removePoint(trailId, index) {
    const t = this.trails.get(trailId);
    const [stop] = t.points.splice(index, 1);
    this.#dropIfUnused(stop.node);
    if (t.points.length < 2) {
      this.removeTrail(trailId);
    } else {
      this.#changed([trailId]);
    }
  }

  /**
   * Delete a trail and any nodes only it used.
   * Used by the editor (Delete trail, cancelled or too-short drawings) and by removePoint.
   */
  removeTrail(trailId) {
    const t = this.trails.get(trailId);
    if (!t) return;
    this.trails.delete(trailId);
    for (const p of t.points) this.#dropIfUnused(p.node);
    this.#changed([trailId]);
  }

  /** Remove every trail and node. Used by the editor when mountain generation replaces everything. */
  clear() {
    const ids = [...this.trails.keys()];
    this.trails.clear();
    this.nodes.clear();
    this.#changed(ids);
  }

  // ---------- Saving ----------

  /**
   * Plain-data copy of the network.
   * Used by main.js to save to localStorage and by the editor for undo snapshots.
   */
  toJSON() {
    return {
      version: 1,
      nextId: this.nextId,
      nodes: [...this.nodes.values()],
      trails: [...this.trails.values()],
    };
  }

  /**
   * Replace everything with saved data, from toJSON.
   * Used by main.js when restoring saved trails and by the editor for undo.
   */
  load(data) {
    const before = [...this.trails.keys()];
    this.nodes = new Map(data.nodes.map((n) => [n.id, { ...n }]));
    this.trails = new Map(
      data.trails.map((t) => [t.id, { ...t, points: t.points.map((p) => ({ ...p })) }])
    );
    this.nextId = data.nextId;
    // Older saves can contain stray points left behind by deleted trails.
    for (const id of this.nodes.keys()) this.#dropIfUnused(id);
    this.#changed([...before, ...this.trails.keys()]);
  }

  // ---------- Internals ----------

  /** Delete a node once no trail uses it. Used after every removal and on load. */
  #dropIfUnused(nodeId) {
    if (this.trailsUsingNode(nodeId).length === 0) this.nodes.delete(nodeId);
  }

  /**
   * Fire the change event naming the affected trails. Every edit ends here.
   * main.js is the only listener: it queues the ids for processTrails, once per frame.
   */
  #changed(trailIds) {
    this.dispatchEvent(new CustomEvent('change', { detail: { trails: new Set(trailIds) } }));
  }
}
