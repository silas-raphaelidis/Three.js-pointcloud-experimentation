/**
 * Runs the route search off the main thread, so the page keeps rendering
 * while a trail is being generated. Started by TrailGenerator.
 *
 * Messages in:  { type: 'grid', grid }  once, then { type: 'route', id, ...request }
 * Messages out: { id, route }           route is { path, expansions } or null
 */
import { prepareGrid, findRoute } from './pathfind.js';

let grid = null;

self.onmessage = ({ data }) => {
  if (data.type === 'grid') {
    grid = prepareGrid(data.grid);
    return;
  }
  const { id, ...request } = data;
  self.postMessage({ id, route: findRoute(grid, request) });
};
