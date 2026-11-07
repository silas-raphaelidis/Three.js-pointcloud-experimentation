import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Copc } from 'copc';
import { createLazPerf } from 'laz-perf';
import lazPerfWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import { Terrain, terrainGLSL } from './terrain.js';
import { TrailMask, trailGLSL } from './trails/mask.js';
import { TrailNetwork } from './trails/network.js';
import { TrailGeometry } from './trails/spline.js';
import { TrailRasterizer } from './trails/rasterize.js';
import { TrailView } from './trails/view.js';
import { TrailEditor } from './trails/editor.js';
import { difficulty } from './trails/stats.js';
import { GroundMesh } from './ground.js';
import { withRetry } from './retry.js';
import { LoadingScreen } from './loading.js';
import { MenuBar } from './menubar.js';
import { TrailLock } from './traillock.js';
import {
  difficultyGLSL,
  difficultyUniforms,
  bindUniforms as bindDifficultyUniforms,
  onThresholdsChange,
  getSmoothing,
  onSmoothingChange,
  DifficultyLegend,
} from './difficulty.js';

// Which file to load: ?file=ascutney-1.4m.copc.laz to compare thinning levels.
const params = new URLSearchParams(location.search);
const FILE = `${import.meta.env.BASE_URL}data/${params.get('file') ?? 'ascutney.copc.laz'}`;
const FILE_URL = new URL(FILE, location.href).href;

// ---------- Renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);

// LiDAR is Z-up; keep it that way rather than rotating the data.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 20000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
// No damping: the camera follows the mouse exactly and stops on release
// (damping made it trail behind the hand, worse at lower frame rates).
controls.enableDamping = false;
controls.screenSpacePanning = false;

// ---------- Point material ----------
// Points are sized in world meters so density reads correctly at any zoom.
const uniforms = {
  uSize: { value: 1.6 },
  uProjScale: { value: 1 },
  uShowVeg: { value: 1 },
  uColorMode: { value: 0 }, // 0 = natural, 1 = height above ground, 2 = slope difficulty
  // Height map (filled in once it loads).
  uHeight: { value: null },
  uHeightOrigin: { value: new THREE.Vector2() },
  uHeightRes: { value: 1 },
  uHasHeight: { value: 0 },
  // Trail clearing (filled in once the height map loads).
  uTrail: { value: null },
  uHasTrail: { value: 0 },
  uTime: { value: 0 },
  uFallDuration: { value: 0.9 }, // seconds for a point to settle
  uFallStagger: { value: 0.6 },  // extra delay for the tallest trees
  uSnow: { value: new THREE.Color(0xf4f7fb) },
  // Ground color ramp, shared by ground points (CPU) and the ground mesh (GPU).
  uRamp0: { value: new THREE.Color(0x3b4a3f) },
  uRamp1: { value: new THREE.Color(0x6b7a5a) },
  uRamp2: { value: new THREE.Color(0xa89f86) },
  uRamp3: { value: new THREE.Color(0xf2efe6) },
  uZRange: { value: 1 },
  // Slope difficulty view: smoothed slope map + shared thresholds/colors.
  uSlope: { value: null },
  ...difficultyUniforms(),
};
bindDifficultyUniforms(uniforms);
const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */ `
    attribute float cls;
    uniform float uSize;
    uniform float uProjScale;
    uniform float uShowVeg;
    uniform float uColorMode;
    uniform float uTime;
    uniform float uFallDuration;
    uniform float uFallStagger;
    uniform vec3 uSnow;
    varying vec3 vColor;
    varying float vSize;
    ${terrainGLSL}
    ${trailGLSL}
    ${difficultyGLSL}

    // Height above ground -> color: blue at ground level, green at shrub
    // height, yellow/red for tall trees.
    vec3 hagColor(float h) {
      if (h < 0.3) return vec3(0.15, 0.35, 0.9);
      if (h < 2.0) return mix(vec3(0.2, 0.75, 0.3), vec3(0.6, 0.85, 0.2), (h - 0.3) / 1.7);
      return mix(vec3(0.95, 0.85, 0.2), vec3(0.9, 0.2, 0.15), clamp((h - 2.0) / 20.0, 0.0, 1.0));
    }

    void main() {
      bool isVeg = cls > 2.5 && cls < 5.5;
      bool isGround = cls > 1.5 && cls < 2.5;
      vec3 pos = position;
      vColor = color;

      bool difficultyMode = uColorMode > 1.5;
      float ground = 0.0;
      float hag = 0.0;
      vec3 rated = vec3(0.0);
      if (uHasHeight > 0.5) {
        ground = terrainHeight(pos.xy);
        hag = pos.z - ground;
        if (difficultyMode) {
          // Color by the slope of the ground under the point; trees a shade
          // darker so canopy still reads as canopy.
          rated = difficultyColor(slopeAt(pos.xy));
          vColor = rated * (isGround ? 1.0 : 0.72);
        } else if (uColorMode > 0.5) {
          vColor = hagColor(hag);
        }
      }

      // ---- Trail clearing ----
      // Inside a trail, everything that isn't ground falls onto the height
      // map once the cut reaches it. Taller trees start a little later so the
      // canopy settles from the top down; everything in the trail turns to snow.
      bool cleared = false;
      if (uHasTrail > 0.5) {
        vec2 trail = trailAt(pos.xy);
        float strength = trail.x;
        if (strength > 0.001) {
          float tall = clamp(hag / 25.0, 0.0, 1.0);
          float start = trail.y + (isGround ? 0.0 : uFallStagger * tall);
          float t = clamp((uTime - start) / (uFallDuration * (0.6 + 0.4 * tall)), 0.0, 1.0);
          float fall = t * t;               // accelerate like gravity
          if (!isGround) {
            pos.z = mix(pos.z, ground + 0.05, strength * fall);
            // Points pressed fully flat count as ground for the V toggle.
            cleared = strength * fall > 0.98;
          }
          float snow = strength * smoothstep(0.0, 1.0, t);
          // Difficulty view: trails are a lightened version of the rating
          // underneath (so you can see what a trail crosses), not snow.
          vec3 trailColor = difficultyMode ? mix(rated, vec3(1.0), 0.38) : uSnow;
          vColor = mix(vColor, trailColor, snow);
        }
      }

      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mv;
      if (isVeg && !cleared && uShowVeg < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
      // At least 2 px: smaller points flicker and leave holes at mid zoom.
      gl_PointSize = clamp(uSize * uProjScale / -mv.z, 2.0, 24.0);
      vSize = gl_PointSize;
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    varying float vSize;
    void main() {
      // Round points only when big enough to look round; trimming the
      // corners off a 2 px point just removes most of it.
      if (vSize >= 3.0) {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        if (dot(c, c) > 1.0) discard;
      }
      gl_FragColor = vec4(vColor, 1.0);
      #include <colorspace_fragment>
    }`,
  vertexColors: true,
});

function updateProjScale() {
  const h = renderer.domElement.height;
  uniforms.uProjScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

// ---------- Eye-Dome Lighting ----------
// Screen-space shading for point clouds (the technique Potree uses): each pixel
// is darkened by how much nearer its neighbours are in log-depth, which outlines
// tree crowns and ridges without needing normals.
const drawSize = new THREE.Vector2();
renderer.getDrawingBufferSize(drawSize);
const sceneTarget = new THREE.WebGLRenderTarget(drawSize.x, drawSize.y, {
  depthTexture: new THREE.DepthTexture(drawSize.x, drawSize.y, THREE.UnsignedIntType),
});
const edlUniforms = {
  tColor: { value: sceneTarget.texture },
  tDepth: { value: sceneTarget.depthTexture },
  uTexel: { value: new THREE.Vector2(1 / drawSize.x, 1 / drawSize.y) },
  uNear: { value: camera.near },
  uFar: { value: camera.far },
  uStrength: { value: 1.0 },
  uRadius: { value: 1.4 },
  uCap: { value: 0.03 }, // max darkening any one neighbour can contribute
};
const edlScene = new THREE.Scene();
const edlCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
edlScene.add(
  new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: edlUniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 uTexel;
        uniform float uNear, uFar, uStrength, uRadius, uCap;
        varying vec2 vUv;
        float logDepth(vec2 uv) {
          float d = texture2D(tDepth, uv).r;
          if (d >= 1.0) return 0.0;               // background
          float z = 2.0 * d - 1.0;
          float viewZ = 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
          return log2(viewZ);
        }
        void main() {
          vec4 color = texture2D(tColor, vUv);
          float d = logDepth(vUv);
          if (d == 0.0) { gl_FragColor = color; return; }
          float sum = 0.0;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.78539816;
            vec2 off = vec2(cos(a), sin(a)) * uRadius * uTexel;
            float n = logDepth(vUv + off);
            // Background neighbours don't count (they used to turn every gap
            // into a black-rimmed hole), and no single neighbour can darken a
            // pixel by more than uCap.
            if (n > 0.0) sum += min(uCap, max(0.0, d - n));
          }
          float shade = exp(-sum / 8.0 * 300.0 * uStrength);
          gl_FragColor = vec4(color.rgb * shade, 1.0);
          #include <colorspace_fragment>
        }`,
    })
  )
);

function resizeTargets() {
  renderer.getDrawingBufferSize(drawSize);
  sceneTarget.setSize(drawSize.x, drawSize.y);
  edlUniforms.uTexel.value.set(1 / drawSize.x, 1 / drawSize.y);
}

// ---------- Colors ----------
// One ramp for ground points (here, on the CPU) and the ground mesh (GLSL
// below), both reading the same uniform colors so they always match.
const ramp = [
  [0.0, uniforms.uRamp0.value],
  [0.35, uniforms.uRamp1.value],
  [0.7, uniforms.uRamp2.value],
  [1.0, uniforms.uRamp3.value],
];
const groundRampGLSL = /* glsl */ `
  uniform vec3 uRamp0, uRamp1, uRamp2, uRamp3;
  uniform float uZRange;
  vec3 groundRamp(float z) {
    float t = clamp(z / uZRange, 0.0, 1.0);
    if (t <= 0.35) return mix(uRamp0, uRamp1, t / 0.35);
    if (t <= 0.7) return mix(uRamp1, uRamp2, (t - 0.35) / 0.35);
    return mix(uRamp2, uRamp3, (t - 0.7) / 0.3);
  }
`;
function groundColor(t, out) {
  for (let i = 1; i < ramp.length; i++) {
    if (t <= ramp[i][0]) {
      const [t0, c0] = ramp[i - 1];
      const [t1, c1] = ramp[i];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(ramp[ramp.length - 1][1]);
}
const vegLow = new THREE.Color(0x1f4d2b);
const vegHigh = new THREE.Color(0x7fbf5a);
const other = new THREE.Color(0x8a8f99);

// ---------- HUD ----------
const hud = document.createElement('div');
hud.id = 'hud';
document.body.appendChild(hud);
let loadedPoints = 0;
let totalPoints = 0;
let loadStatus = '';
let cursorInfo = '';
let editorStatus = '';
function updateHud(extra) {
  if (extra !== undefined) loadStatus = extra;
  hud.innerHTML = `
    <strong>${decodeURIComponent(FILE.split('/').pop())}</strong><br>
    ${(loadedPoints / 1e6).toFixed(1)}M / ${(totalPoints / 1e6).toFixed(1)}M points ${loadStatus}<br>
    ${cursorInfo ? `<span class="cursor">${cursorInfo}</span><br>` : ''}
    ${editorStatus ? `<div class="editor">${editorStatus}</div>` : ''}
    <span class="keys">Drag to orbit · Shift-drag to pan · wheel to zoom · right-click for trail options</span>`;
}

// ---------- Terrain + cursor ----------
let terrain = null;
let sceneOffsetZ = 0; // UTM elevation of the scene origin, for readouts
const clock = new THREE.Clock();

// Things drawn on top of the point cloud (after the EDL pass), so markers
// stay crisp and visible: the cursor, trail lines, points and handles.
const overlay = new THREE.Scene();

const cursor = new THREE.Mesh(
  new THREE.RingGeometry(0.7, 1.0, 48),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false })
);
cursor.visible = false;
overlay.add(cursor);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hit = new THREE.Vector3();
const normal = new THREE.Vector3();
let pointerDirty = false;

renderer.domElement.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pointerDirty = true;
});
renderer.domElement.addEventListener('pointerleave', () => {
  cursor.visible = false;
  cursorInfo = '';
  updateHud();
});

function updateCursor() {
  if (!terrain || !pointerDirty) return;
  pointerDirty = false;
  raycaster.setFromCamera(pointer, camera);
  if (!terrain.raycast(raycaster.ray, hit)) {
    cursor.visible = false;
    cursorInfo = '';
    updateHud();
    return;
  }
  terrain.normalAt(hit.x, hit.y, normal);
  cursor.position.copy(hit).addScaledVector(normal, 0.2);
  cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  cursor.visible = true;

  // Same smoothed slope and thresholds as the difficulty view, so the
  // readout always matches the color under the cursor.
  const slope = terrain.smoothSlopeAt(hit.x, hit.y);
  const rating = difficulty(slope);
  const elev = hit.z + sceneOffsetZ;
  cursorInfo =
    `${elev.toFixed(0)} m (${(elev * 3.28084).toFixed(0)} ft) · ` +
    `slope ${(slope * 100).toFixed(0)}% (${THREE.MathUtils.radToDeg(Math.atan(slope)).toFixed(0)}°) · ` +
    `<span style="color:${rating.color}">${rating.name}</span>`;
  updateHud();
}

// Keep the ring the same size on screen regardless of distance.
function scaleCursor() {
  if (!cursor.visible) return;
  const dist = camera.position.distanceTo(cursor.position);
  // Yellow and a touch larger over anything you can select or drag.
  const selectable = !!editor?.hoveringSelectable;
  cursor.material.color.set(selectable ? 0xffd34d : 0xffffff);
  cursor.scale.setScalar(dist * (selectable ? 0.015 : 0.012));
}

// ---------- Trails ----------
// Data (network) -> sampled splines (geometry) -> forest mask (rasterizer)
// and overlay drawing (view). The editor is the only thing that edits.
const TRAIL_FEATHER = 8; // soft tree line on each side, meters
const SAVE_KEY = 'ascutney-trails-v1';
const network = new TrailNetwork();
let geometry = null;
let trailMask = null;
let rasterizer = null;
let trailView = null;
let editor = null;
const pendingTrails = new Set();
let saveTimer = 0;

network.addEventListener('change', (e) => {
  for (const id of e.detail.trails) pendingTrails.add(id);
});

function setupTrails(t) {
  geometry = new TrailGeometry(network, TRAIL_FEATHER);
  trailMask = new TrailMask(t);
  rasterizer = new TrailRasterizer(geometry, trailMask);
  trailView = new TrailView(network, geometry, t, overlay);
  trailView.setResolution(innerWidth, innerHeight);
  editor = new TrailEditor({
    network, geometry, terrain: t, camera, dom: renderer.domElement, controls, view: trailView,
    // Also keeps the menu bar's "Edit trails" button in sync with the T key.
    onStatus: (s) => { editorStatus = s; updateHud(); menuBar.refresh(); },
    onLocked: () => trailLock.nudge(),
  });
  uniforms.uTrail.value = trailMask.texture;
  uniforms.uHasTrail.value = 1;
  // Saved trails are loaded after the loading screen fades, so their
  // cut-into-the-forest animation is actually seen.
}

async function loadSavedTrails() {
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) { network.load(JSON.parse(saved)); return; }
  } catch { /* storage blocked or bad data: fall through to the preset */ }
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/preset-trails.json`);
    if (res.ok) network.load(await res.json());
  } catch { /* no preset: start empty */ }
}

function saveTrailsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(network.toJSON())); } catch { /* ignore */ }
  }, 400);
}

/** Apply network edits once per frame: resample, re-cut, redraw, save. */
function processTrails() {
  if (!pendingTrails.size || !geometry) return;
  const ids = [...pendingTrails];
  pendingTrails.clear();
  const box = geometry.update(ids);
  rasterizer.rebuild(box, clock.getElapsedTime());
  trailView.update(ids);
  editor.refresh();
  saveTrailsSoon();
}

// Debug/console access, e.g. copy(JSON.stringify(trails.network.toJSON()))
window.trails = { network, get editor() { return editor; } };


// ---------- Loading ----------
// Everything loads behind a loading screen; the scene is revealed only once
// the points, height map and ground mesh are ready. Every download retries
// (see retry.js) and failures are logged with what failed.
const loading = new LoadingScreen('Mount Ascutney');
let ready = false;

async function load() {
  loading.update(0.02, 'Preparing the LAZ decoder…');
  const lazPerf = await withRetry(() => createLazPerf({ locateFile: () => lazPerfWasmUrl }), 'LAZ decoder');

  loading.update(0.04, 'Reading the point cloud header…');
  const copc = await withRetry(() => Copc.create(FILE_URL), 'point cloud header');
  const { min, max } = copc.header;
  totalPoints = copc.header.pointCount;

  // Center the data at the origin: raw UTM coordinates (~700,000 m) are too
  // large for 32-bit floats on the GPU and would make points jitter.
  const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]);
  const zRange = max[2] - min[2];
  uniforms.uZRange.value = zRange;
  sceneOffsetZ = center.z;

  const size = Math.max(max[0] - min[0], max[1] - min[1]);
  camera.position.set(0, -size * 0.9, size * 0.6);
  controls.target.set(0, 0, zRange * 0.4);
  camera.far = size * 6;
  camera.updateProjectionMatrix();
  edlUniforms.uFar.value = camera.far;
  homeView = { position: camera.position.clone(), target: controls.target.clone() };

  // Progress: points are most of the work; the height map is the rest.
  let heightReady = false;
  const progress = () => {
    const pts = totalPoints ? loadedPoints / totalPoints : 0;
    loading.update(
      0.08 + 0.8 * pts + (heightReady ? 0.1 : 0),
      `Loading points · ${(loadedPoints / 1e6).toFixed(1)}M of ${(totalPoints / 1e6).toFixed(1)}M`,
      heightReady ? 'Height map ready' : 'Loading height map…'
    );
  };

  // Height map (and everything built on it) loads in parallel with the points.
  const heightLoad = Terrain.load(`${import.meta.env.BASE_URL}data/ascutney-height`, center, {
    slopeSmoothing: getSmoothing(),
  }).then((t) => {
    terrain = t;
    uniforms.uHeight.value = t.texture;
    uniforms.uHeightOrigin.value.copy(t.origin);
    uniforms.uHeightRes.value = t.res;
    uniforms.uHasHeight.value = 1;
    uniforms.uSlope.value = t.slopeTexture;
    ground = new GroundMesh(t, uniforms, { step: 2, sink: 0.5, colorGLSL: groundRampGLSL });
    scene.add(ground.mesh);
    occluderScene.add(ground.occluder);
    setupTrails(t);
    heightReady = true;
    progress();
  });

  // Walk every hierarchy page to collect all chunks (octree nodes).
  loading.update(0.06, 'Reading the point index…');
  const nodes = {};
  const pages = [copc.info.rootHierarchyPage];
  while (pages.length) {
    const page = pages.pop();
    const sub = await withRetry(() => Copc.loadHierarchyPage(FILE_URL, page), `index page @${page.pageOffset}`);
    Object.assign(nodes, sub.nodes);
    pages.push(...Object.values(sub.pages));
  }

  // Coarse levels first, then detail.
  const keys = Object.keys(nodes)
    .filter((k) => nodes[k].pointCount > 0)
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));

  const tmp = new THREE.Color();
  async function loadChunk(key) {
    const node = nodes[key];
    const view = await Copc.loadPointDataView(FILE_URL, copc, node, {
      lazPerf,
      include: ['X', 'Y', 'Z', 'Classification'],
    });
    const n = view.pointCount;
    const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
    const gc = view.getter('Classification');
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const cls = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const z = gz(i);
      pos[i * 3] = gx(i) - center.x;
      pos[i * 3 + 1] = gy(i) - center.y;
      pos[i * 3 + 2] = z - center.z;
      const c = gc(i);
      cls[i] = c;
      const t = (z - min[2]) / zRange;
      if (c === 2) groundColor(t, tmp);
      else if (c === 3 || c === 5) tmp.copy(vegLow).lerp(vegHigh, Math.min(1, t * 1.2));
      else tmp.copy(other);
      tmp.toArray(col, i * 3);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geom.setAttribute('cls', new THREE.BufferAttribute(cls, 1));
    scene.add(new THREE.Points(geom, material));
    loadedPoints += n;
    progress();
  }

  // Six chunks at a time. A chunk that still fails after its retries is
  // recorded and skipped; it doesn't stop the others.
  const failed = [];
  const queue = [...keys];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const key = queue.shift();
        try {
          await withRetry(() => loadChunk(key), `chunk ${key}`);
        } catch {
          failed.push(key);
        }
      }
    })
  );
  await heightLoad; // a height map failure is fatal: the scene depends on it

  if (failed.length) {
    const missing = failed.reduce((s, k) => s + nodes[k].pointCount, 0);
    console.error(`[load] ${failed.length} chunk(s) failed after retries (${missing} points missing):`, failed);
  }

  // Measured before the final frame wait, which can pause in a background tab.
  const seconds = ((performance.now() - t0) / 1000).toFixed(1);

  // Upload everything to the GPU and compile shaders behind the loading
  // screen, so the reveal doesn't stall.
  loading.update(0.98, 'Preparing the view…');
  renderer.setRenderTarget(sceneTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  await new Promise((r) => requestAnimationFrame(r));

  updateHud(
    failed.length
      ? `· loaded in ${seconds}s · <span style="color:#ffd34d">${failed.length} chunk${failed.length > 1 ? 's' : ''} failed (see console)</span>`
      : `· loaded in ${seconds}s`
  );
  ready = true;
  await loading.hide();
  loadSavedTrails();
}

load().catch((err) => {
  console.error('[load] fatal:', err);
  loading.fail(err?.message ?? String(err));
});


// ---------- Camera controls (Blender-style) ----------
//   left-drag / middle-drag  orbit        Alt+left-drag      orbit (trackpads)
//   Shift + either           pan          Shift+Alt+left     pan
//   Ctrl+middle-drag         zoom         wheel              zoom toward cursor
//   right-click              context menu (right-drag does nothing)
// OrbitControls already turns an orbit drag into a pan when Shift is held.
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null };
controls.zoomToCursor = true;
controls.minDistance = 2;

// Keep the orbit center on the terrain surface. It's moved along the current
// view line (so the view doesn't jump) to where that line meets the ground.
// Otherwise it can sit deep inside the mountain, and zooming toward it drives
// the camera straight through the terrain.
const _viewRay = new THREE.Ray();
const _surface = new THREE.Vector3();
function retargetToSurface() {
  if (!terrain || flight) return;
  _viewRay.origin.copy(camera.position);
  _viewRay.direction.copy(controls.target).sub(camera.position).normalize();
  if (terrain.raycast(_viewRay, _surface)) controls.target.copy(_surface);
}

renderer.domElement.addEventListener(
  'pointerdown',
  (e) => {
    retargetToSurface();
    if (e.button === 1) {
      controls.mouseButtons.MIDDLE = e.ctrlKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
    }
  },
  { capture: true }
);
renderer.domElement.addEventListener('wheel', retargetToSurface, { capture: true, passive: true });

// Safety net: never let the camera go below the ground.
const CAMERA_CLEARANCE = 2; // meters above the terrain
function keepCameraAboveGround() {
  if (!terrain) return;
  const floor = terrain.heightAt(camera.position.x, camera.position.y) + CAMERA_CLEARANCE;
  if (camera.position.z < floor) {
    camera.position.z = floor;
    camera.lookAt(controls.target);
  }
}
// No browser menu or middle-click autoscroll on the 3D view.
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

// Smooth camera moves for F / Home.
let homeView = null;
let flight = null; // { from: {position, target}, to: {position, target}, t0 }
const FLIGHT_S = 0.45;

function flyTo(position, target) {
  flight = {
    from: { position: camera.position.clone(), target: controls.target.clone() },
    to: { position: position.clone(), target: target.clone() },
    t0: clock.getElapsedTime(),
  };
}

function updateFlight() {
  if (!flight) return;
  const u = Math.min(1, (clock.getElapsedTime() - flight.t0) / FLIGHT_S);
  const e = u * u * (3 - 2 * u);
  camera.position.lerpVectors(flight.from.position, flight.to.position, e);
  controls.target.lerpVectors(flight.from.target, flight.to.target, e);
  if (u >= 1) flight = null;
}

/** Frame a world-space box, keeping the current viewing direction. */
function frameBox(box) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 40);
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.1;
  const dir = camera.position.clone().sub(controls.target).normalize();
  flyTo(sphere.center.clone().addScaledVector(dir, dist), sphere.center);
}

/** F: frame the selected point or trail (Blender's "View Selected"). */
function frameSelected() {
  const sel = editor?.selection;
  if (!sel || !terrain) return;
  const box = new THREE.Box3();
  if (sel.index !== null) {
    const n = network.node(network.trail(sel.trailId).points[sel.index].node);
    const z = terrain.heightAt(n.x, n.y);
    box.setFromCenterAndSize(new THREE.Vector3(n.x, n.y, z), new THREE.Vector3(120, 120, 40));
  } else {
    for (const p of geometry.get(sel.trailId)?.samples ?? []) {
      box.expandByPoint(new THREE.Vector3(p.x, p.y, terrain.heightAt(p.x, p.y)));
    }
  }
  if (!box.isEmpty()) frameBox(box);
}

// ---------- Help panel ----------
const help = document.createElement('div');
help.id = 'help';
help.hidden = true;
help.innerHTML = `
  <h3>Controls</h3>
  <table>
    <tr><th colspan="2">Camera</th></tr>
    <tr><td>Left- or middle-drag</td><td>Orbit</td></tr>
    <tr><td>Shift + drag</td><td>Pan</td></tr>
    <tr><td>Ctrl + middle-drag</td><td>Zoom</td></tr>
    <tr><td>Wheel</td><td>Zoom toward cursor</td></tr>
    <tr><td>Alt + left-drag / Shift + Alt</td><td>Orbit / pan (trackpads)</td></tr>
    <tr><td>F</td><td>Frame selected trail or point</td></tr>
    <tr><td>Home</td><td>Frame the whole mountain</td></tr>
    <tr><th colspan="2">Trails</th></tr>
    <tr><td>Right-click terrain</td><td>Start a new trail</td></tr>
    <tr><td>Click terrain (drawing)</td><td>Add a point</td></tr>
    <tr><td>Double-click / Enter</td><td>Finish the trail</td></tr>
    <tr><td>Right-click</td><td>Options for a point, trail or spot</td></tr>
    <tr><td>Click / double-click a trail</td><td>Select it / add a point</td></tr>
    <tr><td>Drag a point / handle</td><td>Move it / change width</td></tr>
    <tr><td>Shift-click a trail or point</td><td>Branch from there</td></tr>
    <tr><td>&minus; / =</td><td>Narrower / wider</td></tr>
    <tr><td>Delete &middot; Ctrl+Z &middot; Esc</td><td>Remove point &middot; undo &middot; cancel</td></tr>
    <tr><td>L</td><td>Lock / unlock trail selection</td></tr>
    <tr><th colspan="2">View</th></tr>
    <tr><td>V &middot; E</td><td>Vegetation &middot; shading</td></tr>
    <tr><td>H &middot; D</td><td>Color by height above ground &middot; slope difficulty</td></tr>
    <tr><td>G &middot; M</td><td>Ghost hidden trails (and let them be picked) &middot; ground surface</td></tr>
    <tr><td>[ ]</td><td>Point size</td></tr>
    <tr><td>P</td><td>FPS counter</td></tr>
  </table>
  <p>Press ? to close</p>`;
document.body.appendChild(help);

// ---------- FPS counter ----------
// Frames per second, plus average and worst frame time, over half-second windows.
const fps = document.createElement('div');
fps.id = 'fps';
document.body.appendChild(fps);
const fpsStats = { last: performance.now(), windowStart: performance.now(), frames: 0, worst: 0 };

function tickFps() {
  const now = performance.now();
  const dt = now - fpsStats.last;
  fpsStats.last = now;
  fpsStats.frames++;
  if (dt > fpsStats.worst) fpsStats.worst = dt;
  const span = now - fpsStats.windowStart;
  if (span >= 500) {
    const rate = (fpsStats.frames * 1000) / span;
    const avg = span / fpsStats.frames;
    fps.textContent = `${rate.toFixed(0)} fps · ${avg.toFixed(1)} ms avg · ${fpsStats.worst.toFixed(1)} ms worst`;
    fps.className = rate >= 50 ? 'good' : rate >= 30 ? 'ok' : 'bad';
    fpsStats.windowStart = now;
    fpsStats.frames = 0;
    fpsStats.worst = 0;
  }
}

// ---------- View options ----------
// One place for every display toggle. The View menu and the keyboard
// shortcuts both go through these, so they always agree.
let edlOn = true;
let ghostTrails = false;

const view = {
  vegetation: {
    label: 'Vegetation', shortcut: 'V',
    get: () => uniforms.uShowVeg.value > 0.5,
    set: (on) => { uniforms.uShowVeg.value = on ? 1 : 0; },
  },
  ground: {
    label: 'Ground surface', shortcut: 'M',
    get: () => ground?.mesh.visible ?? true,
    set: (on) => { if (ground) ground.mesh.visible = on; },
  },
  shading: {
    label: 'Eye-Dome Lighting', shortcut: 'E',
    get: () => edlOn,
    set: (on) => { edlOn = on; },
  },
  ghost: {
    label: 'Ghost hidden trails', shortcut: 'G',
    get: () => ghostTrails,
    set: (on) => {
      ghostTrails = on;
      // Ghosted trails are visible, so they can be picked through terrain.
      if (editor) editor.pickHidden = on;
    },
  },
  fps: {
    label: 'FPS counter', shortcut: 'P',
    get: () => !fps.hidden,
    set: (on) => { fps.hidden = !on; },
  },
};
const toggle = (opt) => opt.set(!opt.get());

// "Color by" is one choice of three; the legend shows with the difficulty view.
const COLOR = { natural: 0, height: 1, difficulty: 2 };
const legend = new DifficultyLegend();
const colorMode = () => uniforms.uColorMode.value;
function setColorMode(mode) {
  uniforms.uColorMode.value = mode;
  legend.show(mode === COLOR.difficulty);
}
/** Keys H / D: switch to that mode, or back to natural if it's already on. */
const toggleColorMode = (mode) => setColorMode(colorMode() === mode ? COLOR.natural : mode);
const colorItem = (label, mode, shortcut) => ({
  type: 'radio', label, shortcut,
  get: () => colorMode() === mode,
  set: () => setColorMode(mode),
});

// Edited thresholds: refresh the cursor readout and the selected trail's rating.
onThresholdsChange(() => { pointerDirty = true; editor?.refresh(); });
// Smoothing slider: recompute the slope map (colors, readout and ratings follow).
onSmoothingChange((meters) => {
  if (!terrain) return;
  terrain.setSlopeSmoothing(meters);
  pointerDirty = true;
  editor?.refresh();
});

// ---------- Menu bar ----------
const menuBar = new MenuBar();
menuBar.addMenu('View', [
  { type: 'toggle', ...view.vegetation },
  { type: 'toggle', ...view.ground },
  { type: 'separator' },
  { type: 'header', label: 'Color by' },
  colorItem('Natural', COLOR.natural),
  colorItem('Height above ground', COLOR.height, 'H'),
  colorItem('Slope difficulty', COLOR.difficulty, 'D'),
  { type: 'separator' },
  { type: 'toggle', ...view.shading },
  {
    type: 'range', label: 'Point size', min: 0.6, max: 4, step: 0.1,
    get: () => uniforms.uSize.value,
    set: (v) => { uniforms.uSize.value = v; },
    format: (v) => `${v.toFixed(1)} m`,
  },
  { type: 'separator' },
  { type: 'toggle', ...view.ghost },
  { type: 'toggle', ...view.fps },
  { type: 'separator' },
  { type: 'action', label: 'Frame selected', shortcut: 'F', action: () => frameSelected(), enabled: () => !!editor?.selection },
  { type: 'action', label: 'Frame whole mountain', shortcut: 'Home', action: () => homeView && flyTo(homeView.position, homeView.target) },
]);
menuBar.addButton({ label: 'Controls', shortcut: '?', action: () => { help.hidden = !help.hidden; } });

// Lock button on the left edge: blocks trail selection and editing.
const trailLock = new TrailLock({ onChange: (locked) => editor?.setLocked(locked) });

// ---------- Keys ----------
const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

addEventListener('keydown', (e) => {
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case 'v': case 'V': toggle(view.vegetation); break;
    case 'm': case 'M': toggle(view.ground); break;
    case 'h': case 'H': toggleColorMode(COLOR.height); break;
    case 'd': case 'D': toggleColorMode(COLOR.difficulty); break;
    case 'e': case 'E': toggle(view.shading); break;
    case 'g': case 'G': toggle(view.ghost); break;
    case 'p': case 'P': toggle(view.fps); break;
    case ']': uniforms.uSize.value = Math.min(4, uniforms.uSize.value * 1.2); break;
    case '[': uniforms.uSize.value = Math.max(0.6, uniforms.uSize.value / 1.2); break;
    case 'f': case 'F': frameSelected(); break;
    case 'l': case 'L': trailLock.toggle(); break;
    case 'Home': if (homeView) flyTo(homeView.position, homeView.target); break;
    case '?': help.hidden = !help.hidden; break;
    default: return;
  }
  menuBar.refresh();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeTargets();
  updateProjScale();
  trailView?.setResolution(innerWidth, innerHeight);
});
updateProjScale();
updateHud();

renderer.domElement.tabIndex = 0; // let the canvas take keyboard focus
renderer.domElement.addEventListener('pointerdown', () => renderer.domElement.focus());

// ---------- Overlay passes ----------
// The overlay is drawn after shading, tested against the ground mesh's depth
// (not the points', so trees don't chop lines up). With ghosting on, hidden
// parts are first drawn faintly with depth testing off.
const occluderScene = new THREE.Scene();
let ground = null;

function setOverlayGhost(ghost) {
  overlay.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (m.userData.baseOpacity === undefined) {
      m.userData.baseOpacity = m.opacity;
      m.userData.baseTransparent = m.transparent;
    }
    m.depthTest = !ghost;
    m.transparent = ghost || m.userData.baseTransparent;
    m.opacity = ghost ? m.userData.baseOpacity * 0.28 : m.userData.baseOpacity;
  });
}

function renderOverlay() {
  renderer.autoClear = false;
  renderer.clearDepth();
  if (ghostTrails) {
    setOverlayGhost(true);
    renderer.render(overlay, camera);
  }
  renderer.render(occluderScene, camera); // depth only
  setOverlayGhost(false);
  renderer.render(overlay, camera);
  renderer.autoClear = true;
}

renderer.setAnimationLoop(() => {
  tickFps();
  // Nothing is shown until loading finishes; the loading screen covers the page.
  if (!ready) return;
  updateFlight();
  controls.update();
  keepCameraAboveGround();
  uniforms.uTime.value = clock.getElapsedTime();
  updateCursor();
  scaleCursor();
  processTrails();
  trailMask?.flush();
  if (edlOn) {
    renderer.setRenderTarget(sceneTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(edlScene, edlCamera);
  } else {
    renderer.render(scene, camera);
  }
  renderOverlay();
});

// Re-pick when the camera moves under a still mouse.
controls.addEventListener('change', () => { pointerDirty = true; });
