import { sampleHeightGrid } from '../trails/generator.js';
import { sampleSpline } from '../trails/spline.js';
import { getThresholds } from '../difficulty.js';
import { createRandom } from './random.js';

/** Wait for the frame loop to re-sample changed trails (one frame, plus one to be sure). */
const nextFrames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

/**
 * Generates a whole mountain: the worker places bases and lifts and plans
 * runs one at a time; each run is routed by the ordinary trail generator
 * (so it's rated and steered around existing trails exactly like a hand-
 * generated one) and added as it's found, so the mountain fills in on screen.
 *
 * Everything goes through an editor "build": the old network is cleared and
 * the whole generation is one undo step. Undoing (or any other edit) part
 * way through stops the generation.
 */
export class MountainGenerator {
  /** Created once in setupTrails (main.js). */
  constructor({ terrain, network, editor, trailGenerator }) {
    Object.assign(this, { terrain, network, editor, trailGenerator });
    this.worker = null;
    this.nextId = 1;
    this.waiting = new Map(); // request id -> resolve
  }

  /**
   * Replace the mountain with a generated one. The same seed and settings give
   * the same mountain. Resolves to { bases, lifts, runs, served (m²), ms,
   * connected, stopped } with counts of what was built (connected: every lift
   * can reach every other; stopped: an edit, undo or Esc ended it
   * early), or null if the worker failed (whatever was built so far stays,
   * and is still one undo step).
   * @param {{ bases:number, lifts:number, runs:number, seed:number }} settings
   * @param {(progress: { runs:number, pass:string }) => void} [onProgress]
   *   called before each run is routed
   */
  async generate({ bases, lifts, runs, seed }, onProgress = () => {}) {
    this.#startWorker();
    const t0 = performance.now();
    const placed = await this.#request({ type: 'generate', bases, lifts, runs, seed, thresholds: getThresholds() });
    if (!placed) return null;

    // Names come from the seed too (offset so they don't follow the worker's sequence).
    const names = createRandom(seed + 7919);
    const { token, trails: liftTrails } = this.editor.startBuild(placed.lifts.map((l) => ({
      kind: 'lift', source: 'generated', meta: { seed }, points: [l.bottom, l.top],
    })), names.next);
    // The router steers around existing trails, so let the cleared network be re-sampled first.
    await nextFrames();
    const runIds = []; // trail ids of the runs kept, in order (the planner refers to them by index)
    // A planned end as the trail generator takes it: a lift's top or bottom node,
    // or a spot on a kept run ({ run, x, y }), which the editor joins when the run is added.
    const terminal = (end) => (end.lift != null
      ? { node: liftTrails[end.lift].points[end.end === 'top' ? 1 : 0].node }
      : { trail: runIds[end.run], x: end.x, y: end.y });

    let built = 0, failed = false;
    for (;;) {
      const run = await this.#request({ type: 'next' });
      if (!run || !this.editor.isBuilding(token)) break;
      onProgress({ runs: built, pass: run.pass });
      // Coarser than a hand-generated trail: a whole mountain of points is a lot to look at.
      const route = await this.trailGenerator.generate(
        terminal(run.from), terminal(run.to), run.target, run.width, { coarseness: 2 });
      if (!this.editor.isBuilding(token)) break;
      const answer = await this.#request({
        type: 'tried', run, rating: route?.rating,
        samples: route && this.#samples(route.points),
        ctrl: route && this.#positions(route.points).map(({ x, y }) => ({ x, y })),
      });
      if (answer == null) { failed = true; break; } // the worker crashed
      if (!answer.widths || !this.editor.isBuilding(token)) continue;
      // The planner varies the width along the run.
      const points = route.points.map((p, i) => ({ ...p, width: answer.widths[i] }));
      const added = this.editor.addToBuild(token, {
        kind: 'run', source: 'generated', meta: { seed, target: run.target }, points,
      });
      runIds.push(added.id);
      built++;
      // Let the frame loop re-sample the new run, so the next route steers around it.
      await nextFrames();
    }
    const stopped = !this.editor.isBuilding(token);
    this.editor.endBuild(token);
    if (failed) return null;
    const connected = await this.#request({ type: 'connected' });
    return {
      bases: placed.bases.length, lifts: placed.lifts.length, runs: built,
      served: placed.served, ms: performance.now() - t0, connected, stopped,
    };
  }

  /** Route stops as { x, y, width }, with nodes resolved ({trail, x, y} ends are positions already). */
  #positions(points) {
    return points.map((p) => {
      const at = p.node ? this.network.node(p.node) : p;
      return { x: at.x, y: at.y, width: p.width };
    });
  }

  /** Spline samples every 10 m, as plain { x, y, s }, for the worker's overlap check. */
  #samples(points) {
    return sampleSpline(this.#positions(points), 10).map(({ x, y, s }) => ({ x, y, s }));
  }

  /** Send one message to the worker and wait for its answer. */
  #request(message) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ ...message, id });
    });
  }

  /** Start the worker and send it the height grid, the first time it's needed. */
  #startWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./mountain.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      this.waiting.get(data.id)?.(data.result);
      this.waiting.delete(data.id);
    };
    // A crash counts as a failed generation, so nothing waits forever.
    this.worker.onerror = (e) => {
      console.error('[mountain] generation failed:', e.message);
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
    };
    this.worker.postMessage({ type: 'grid', grid: sampleHeightGrid(this.terrain) });
  }
}
