import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const LIFT = 1.5; // draw overlays slightly above the ground, meters

const COLORS = {
  selected: 0xffd34d,
  edge: 0xffffff,
  node: 0xffffff,
  junction: 0xff9a3c,
  handle: 0x9fd3ff,
  preview: 0x9fd3ff,
};

/** Round sprite so overlay points aren't squares. Used once by the TrailView constructor. */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(32, 32, 26, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,0.65)';
  g.stroke();
  return new THREE.CanvasTexture(c);
}

/**
 * Draws the trail network on the overlay: centerlines, cut edges, control
 * points (junctions in orange), the selection with its width handles, and a
 * preview line while drawing. Read-only: it never edits the network.
 */
export class TrailView {
  /**
   * Created once in setupTrails (main.js).
   * @param {(trailId: string) => string} ratingColor  line color for a trail's difficulty
   */
  constructor(network, geometry, terrain, overlay, ratingColor) {
    this.network = network;
    this.geometry = geometry;
    this.terrain = terrain;
    this.ratingColor = ratingColor;
    this.group = new THREE.Group();
    overlay.add(this.group);

    this.resolution = new THREE.Vector2(innerWidth, innerHeight);
    this.trailObjects = new Map(); // trailId -> { line, edges, color }
    this.selectedTrail = null;
    this.hoverTrails = new Set();
    this.hoverKey = '';

    const dot = dotTexture();
    // Material for a set of round dots; no color means per-point vertex colors.
    const pointsMaterial = (size, color) =>
      new THREE.PointsMaterial({
        size, color, map: dot, sizeAttenuation: false, transparent: true,
        alphaTest: 0.4, depthTest: false, vertexColors: color === undefined,
      });

    this.nodes = new THREE.Points(new THREE.BufferGeometry(), pointsMaterial(11));
    this.nodes.renderOrder = 3;
    this.group.add(this.nodes);

    this.highlight = new THREE.Points(new THREE.BufferGeometry(), pointsMaterial(17, COLORS.selected));
    this.highlight.renderOrder = 4;
    this.group.add(this.highlight);

    this.handles = new THREE.Points(new THREE.BufferGeometry(), pointsMaterial(13, COLORS.handle));
    this.handles.renderOrder = 5;
    this.group.add(this.handles);

    this.widthBar = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COLORS.handle, depthTest: false, transparent: true, opacity: 0.8 })
    );
    this.widthBar.renderOrder = 4;
    this.group.add(this.widthBar);

    this.preview = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: COLORS.preview, dashSize: 6, gapSize: 4, depthTest: false })
    );
    this.preview.renderOrder = 2;
    this.group.add(this.preview);
  }

  /** Tell the fat lines the screen size. Used by setupTrails and the resize handler in main.js. */
  setResolution(w, h) {
    this.resolution.set(w, h);
    for (const { line } of this.trailObjects.values()) line.material.resolution.copy(this.resolution);
  }

  /** Height to draw overlays at: the ground plus LIFT. Used by everything drawn here. */
  #ground(x, y) {
    return this.terrain.heightAt(x, y) + LIFT;
  }

  /**
   * Rebuild drawings for trails that changed, then refresh the node dots.
   * Called by processTrails in main.js.
   */
  update(trailIds) {
    for (const id of trailIds) {
      const old = this.trailObjects.get(id);
      if (old) {
        this.group.remove(old.line, old.edges);
        old.line.geometry.dispose();
        old.line.material.dispose();
        old.edges.geometry.dispose();
        old.edges.material.dispose();
        this.trailObjects.delete(id);
      }
      const entry = this.geometry.get(id);
      if (!entry || entry.samples.length < 2) continue;
      this.trailObjects.set(id, this.#buildTrail(id, entry.samples));
    }
    this.#rebuildNodes();
    this.#applySelectionColor();
  }

  /** Create a trail's center line and cut edges. Used by update. */
  #buildTrail(id, samples) {
    const center = [];
    const left = [];
    const right = [];
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      center.push(p.x, p.y, this.#ground(p.x, p.y));
      // Perpendicular from the local direction, to place the cut edges.
      const a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
      let dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const h = p.w / 2;
      const lx = p.x - dy * h, ly = p.y + dx * h;
      const rx = p.x + dy * h, ry = p.y - dx * h;
      left.push(lx, ly, this.#ground(lx, ly));
      right.push(rx, ry, this.#ground(rx, ry));
    }

    const geom = new LineGeometry();
    geom.setPositions(center);
    // Color and width are set by #applySelectionColor, which update() runs next.
    const line = new Line2(
      geom,
      new LineMaterial({ transparent: true, opacity: 0.9, depthTest: false })
    );
    line.material.resolution.copy(this.resolution);
    line.renderOrder = 2;
    line.userData.trailId = id;

    // Both edges in one LineSegments object.
    const seg = [];
    for (const side of [left, right]) {
      for (let i = 0; i + 3 < side.length; i += 3) seg.push(...side.slice(i, i + 6));
    }
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    const edges = new THREE.LineSegments(
      edgeGeom,
      new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.3, depthTest: false })
    );
    edges.renderOrder = 1;

    this.group.add(line, edges);
    return { line, edges, color: this.ratingColor(id) };
  }

  /** Rebuild every node dot, with junctions in orange. Used by update. */
  #rebuildNodes() {
    const pos = [];
    const col = [];
    const c = new THREE.Color();
    for (const n of this.network.nodes.values()) {
      pos.push(n.x, n.y, this.#ground(n.x, n.y));
      c.set(this.network.isJunction(n.id) ? COLORS.junction : COLORS.node);
      col.push(c.r, c.g, c.b);
    }
    const g = this.nodes.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
  }

  /** Re-read every trail's difficulty color. Called from main.js when thresholds change. */
  recolor() {
    for (const [id, obj] of this.trailObjects) obj.color = this.ratingColor(id);
    this.#applySelectionColor();
  }

  /**
   * Set each line's color and width: difficulty color normally; yellow when selected
   * or hovered, with selected drawn thickest. Used by update, recolor and setState.
   */
  #applySelectionColor() {
    for (const [id, obj] of this.trailObjects) {
      const selected = id === this.selectedTrail;
      const hovered = this.hoverTrails.has(id);
      obj.line.material.color.set(selected || hovered ? COLORS.selected : obj.color);
      obj.line.material.linewidth = selected ? 4 : hovered ? 3.5 : 3;
    }
  }

  /**
   * Show the current editor state. Called by TrailEditor.refresh.
   * @param {object} s
   * @param {string|null} s.selectedTrail
   * @param {string[]} s.hoverTrails  trails to highlight
   * @param {{x:number,y:number}|null} s.highlightNode  node to ring
   * @param {Array<{x:number,y:number}>|null} s.handles  width handles
   * @param {{from:{x,y}, to:{x,y}}|null} s.preview      drawing preview
   */
  setState({ selectedTrail = null, hoverTrails = [], highlightNode = null, handles = null, preview = null }) {
    const hoverKey = hoverTrails.join(',');
    if (selectedTrail !== this.selectedTrail || hoverKey !== this.hoverKey) {
      this.selectedTrail = selectedTrail;
      this.hoverTrails = new Set(hoverTrails);
      this.hoverKey = hoverKey;
      this.#applySelectionColor();
    }
    this.#setPoints(this.highlight, highlightNode ? [highlightNode] : []);
    this.#setPoints(this.handles, handles ?? []);
    this.#setPoints(this.widthBar, handles ?? []);
    this.#setPoints(this.preview, preview ? [preview.from, preview.to] : []);
    if (preview) this.preview.computeLineDistances();
  }

  /**
   * Set a Points or Line object's vertices, placed on the ground, and hide it if empty.
   * Used by setState for the highlight, handles, width bar and preview.
   */
  #setPoints(obj, pts) {
    const pos = pts.flatMap((p) => [p.x, p.y, this.#ground(p.x, p.y)]);
    obj.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    obj.geometry.computeBoundingSphere();
    obj.visible = pts.length > 0;
  }
}
