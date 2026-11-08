/**
 * The trail network: plain data, no Three.js.
 *
 * - A NODE is a physical point on the mountain (local x, y). Nothing else.
 * - A TRAIL is an ordered list of { node, width } stops. Width belongs to the
 *   trail's use of the node, so two trails sharing a junction can be
 *   different widths there (a skinny branch off a wide run).
 * - A BRANCH is a trail whose first node already belongs to another trail.
 *
 * Both the editor and (later) the pathfinder build trails only through this
 * API. Every edit fires a 'change' event naming the trails it affected.
 */
export class TrailNetwork extends EventTarget {
  constructor() {
    super();
    this.nodes = new Map(); // id -> { id, x, y }
    this.trails = new Map(); // id -> { id, name, source, meta, points: [{ node, width }] }
    this.nextId = 1;
  }

  // ---------- Queries ----------

  node(id) { return this.nodes.get(id); }
  trail(id) { return this.trails.get(id); }

  /** Trails that pass through a node. */
  trailsUsingNode(nodeId) {
    const out = [];
    for (const t of this.trails.values()) {
      if (t.points.some((p) => p.node === nodeId)) out.push(t.id);
    }
    return out;
  }

  isJunction(nodeId) { return this.trailsUsingNode(nodeId).length > 1; }

  // ---------- Edits ----------

  addNode(x, y) {
    const id = `n${this.nextId++}`;
    this.nodes.set(id, { id, x, y });
    return id;
  }

  /**
   * Create a trail. Each point is either { x, y, width } (a new node) or
   * { node, width } (an existing node, e.g. a branch start).
   */
  addTrail({ points = [], name, source = 'manual', meta = {} } = {}) {
    const id = `t${this.nextId++}`;
    const trail = {
      id,
      name: name ?? `Trail ${this.trails.size + 1}`,
      source,
      meta,
      points: points.map((p) => ({ node: p.node ?? this.addNode(p.x, p.y), width: p.width })),
    };
    this.trails.set(id, trail);
    this.#changed([id]);
    return trail;
  }

  /** Insert a stop at `index` (defaults to the end). */
  insertPoint(trailId, point, index) {
    const t = this.trails.get(trailId);
    const stop = { node: point.node ?? this.addNode(point.x, point.y), width: point.width };
    t.points.splice(index ?? t.points.length, 0, stop);
    this.#changed([trailId]);
    return stop.node;
  }

  moveNode(nodeId, x, y) {
    const n = this.nodes.get(nodeId);
    n.x = x;
    n.y = y;
    this.#changed(this.trailsUsingNode(nodeId));
  }

  rename(trailId, name) {
    this.trails.get(trailId).name = name;
    this.#changed([trailId]);
  }

  setWidth(trailId, index, width) {
    this.trails.get(trailId).points[index].width = width;
    this.#changed([trailId]);
  }

  /** Remove one stop. Trails left with fewer than 2 stops are removed. */
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

  removeTrail(trailId) {
    const t = this.trails.get(trailId);
    if (!t) return;
    this.trails.delete(trailId);
    for (const p of t.points) this.#dropIfUnused(p.node);
    this.#changed([trailId]);
  }

  clear() {
    const ids = [...this.trails.keys()];
    this.trails.clear();
    this.nodes.clear();
    this.#changed(ids);
  }

  // ---------- Saving ----------

  toJSON() {
    return {
      version: 1,
      nextId: this.nextId,
      nodes: [...this.nodes.values()],
      trails: [...this.trails.values()],
    };
  }

  /** Replace everything with saved data. */
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

  #dropIfUnused(nodeId) {
    if (this.trailsUsingNode(nodeId).length === 0) this.nodes.delete(nodeId);
  }

  #changed(trailIds) {
    this.dispatchEvent(new CustomEvent('change', { detail: { trails: new Set(trailIds) } }));
  }
}
