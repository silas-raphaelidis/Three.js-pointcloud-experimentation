/**
 * Runs mountain generation's planning off the main thread. Started by
 * MountainGenerator. Holds one generation at a time: lifts are placed first,
 * then runs are planned one by one while the main thread routes them.
 *
 * Messages in (each with an id, answered with { id, result }):
 *   { type: 'grid', grid }                       once, no answer
 *   { type: 'generate', bases, lifts, runs, seed, thresholds }
 *       -> { bases, lifts, served, ms }          places lifts, starts run planning
 *   { type: 'next' }        -> a planned run, or null when the mountain is done
 *   { type: 'tried', run, samples } -> true if the routed run should be kept
 *   { type: 'connected' }   -> true if every lift can reach every other by the runs kept
 */
import { gridSlopes } from '../trails/pathfind.js';
import { analyzeTerrain } from './analysis.js';
import { placeLifts } from './lifts.js';
import { RunPlanner } from './runs.js';
import { createRandom } from './random.js';

let grid = null;
let analysis = null;
let planner = null; // the current generation's run planner

self.onmessage = ({ data }) => {
  if (data.type === 'grid') {
    grid = { ...data.grid, slope: gridSlopes(data.grid) };
    analysis = analyzeTerrain(grid); // the terrain never changes, so once is enough
    return;
  }
  const answer = (result) => self.postMessage({ id: data.id, result });

  if (data.type === 'generate') {
    const t0 = performance.now();
    const random = createRandom(data.seed);
    const { plan, ...placed } = placeLifts(grid, analysis, { bases: data.bases, lifts: data.lifts, random });
    planner = new RunPlanner(grid, plan, { runs: data.runs, thresholds: data.thresholds, random });
    answer({ ...placed, ms: performance.now() - t0 });
  } else if (data.type === 'next') {
    answer(planner ? planner.next() : null);
  } else if (data.type === 'tried') {
    answer(planner ? planner.tried(data.run, data.samples) : false);
  } else if (data.type === 'connected') {
    answer(planner ? planner.connected() : false);
  }
};
