# Ascutney LiDAR Ski Designer

A browser app built on a real LiDAR scan of Mount Ascutney, Vermont: 10.8 million
laser points showing every tree and the bare ground beneath them. Draw ski trails
and the forest is cleared along them, each rated by how steep it actually skis, or
generate a whole ski area (bases, lifts and runs) from a seed in a few seconds.

**Live demo:** https://silasraphaelidis.dev/Three.js-pointcloud-experimentation/

Built with [Three.js](https://threejs.org), [copc.js](https://github.com/connormanning/copc.js)
(which brings laz-perf for decompression) and [Vite](https://vite.dev); everything
else is written from scratch.

## What you can do

- **Explore the scan.** Orbit, pan and zoom around the point cloud. Color it
  naturally, by height above ground, or by slope difficulty, with an editable legend.
- **Draw trails and lifts.** Right-click to start one. As a trail is drawn the trees
  inside it fall and the cut turns to snow. Drag points to reshape it, change its
  width along its length, or branch new trails off it.
- **Generate a trail.** Pick a difficulty and two ends; a route search finds a line
  down the mountain at that difficulty, steering around existing trails.
- **Generate a ski resort.** Choose how many bases, lifts and runs, and a seed. The same
  seed always gives the same resort.

## How it works

**Point cloud.** The scan is a single [COPC](https://copc.io) file (cloud-optimized
LAZ) read with copc.js and decompressed with laz-perf in WebAssembly. Points are
drawn with a custom shader sized in meters, then shaded with Eye-Dome Lighting, a
screen-space technique that outlines tree crowns and ridges without normals.
Coordinates are shifted to a local origin so float32 precision holds.

**Terrain.** A 2 m bare-earth height map (packed as 16-bit values in a PNG) gives
the ground height and slope everywhere, on the CPU for picking and stats and on
the GPU for the shaders.

**Trails.** Trails are Catmull-Rom splines through their points. Each one is
stamped into a trail mask texture, which the point shader reads to flatten the
trees inside it and fade them to snow. Editing only re-stamps the stretches that
changed, so dragging a busy junction stays at 60 fps.

**Rating.** A trail is rated by its crux, like a real one: the hardest band it holds
for at least 40 m, measured as the pitch along the trail itself (so traversing a
steep face rates easier than dropping straight down it).

**Trail generation.** An A* search runs in a Web Worker over a 10 m grid. Its state
includes the direction of travel so turns have a cost, and the cost of each step
encodes what makes a good ski run: staying in the target pitch band, no climbing,
limited side slope, and keeping away from cliffs, existing trails and the edge of
the scan.

**Mountain generation**, also in a worker, seeded so it repeats exactly:

1. Find base areas: gentle ground that a lot of the mountain drains down into.
2. Place lifts one at a time, each chosen for the new terrain it opens up times the
   vertical it climbs. Tops must be summits or ridges, and every lift must connect
   both ways to the lifts already placed.
3. Plan runs: a home run on every lift, connectors until every lift can reach every
   other, fill runs routed through the biggest uncovered gaps, then crosscuts
   (steep shots through the steepest patches, and easier bail-outs off the hardest
   runs). Each run is routed with the same trail generator and rated like any other.

## Project layout

| Path | What's there |
|---|---|
| `src/main.js` | Scene, point loading, shaders, frame loop, menus and view options |
| `src/terrain.js` | Height map loading, sampling, slope and ray casting |
| `src/difficulty.js` | Difficulty levels, thresholds and the slope legend |
| `src/trails/` | Trail network data, splines, the trail mask, drawing, editing, rating, and single-trail generation (`pathfind.js` is the A* search) |
| `src/mountain/` | Mountain generation: terrain analysis, lift placement, run planning, the worker and the dialog |
| `src/help.js`, `src/intro.js` | The Controls panel and the first-visit welcome |
| `public/data/` | The point cloud, height map, and the preset mountain shown on a first visit |
| `data-prep/` | Scripts that turn the public USGS LiDAR into those files (see its README) |

## Run locally

```bash
npm install
npm run dev
```

Then open the address Vite prints. `npm run build` makes a production build in `dist/`.

## Data

The scan is public-domain USGS 3D Elevation Program LiDAR
(`USGS_LPC_VT_Connecticut_River_2016_LAS_2018`). `data-prep/README.md` covers how
it's cropped, classified, thinned to COPC and turned into the height map.

## Deploy

Every push to `main` builds the site and publishes it to GitHub Pages
(see `.github/workflows/deploy.yml`).
