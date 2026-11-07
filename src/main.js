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
controls.enableDamping = true;
controls.screenSpacePanning = false;

// ---------- Point material ----------
// Points are sized in world meters so density reads correctly at any zoom.
const uniforms = {
  uSize: { value: 1.6 },
  uProjScale: { value: 1 },
  uShowVeg: { value: 1 },
  uColorMode: { value: 0 }, // 0 = class/elevation, 1 = height above ground
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
};
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
    ${terrainGLSL}
    ${trailGLSL}

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

      float ground = 0.0;
      float hag = 0.0;
      if (uHasHeight > 0.5) {
        ground = terrainHeight(pos.xy);
        hag = pos.z - ground;
        if (uColorMode > 0.5) vColor = hagColor(hag);
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
          vColor = mix(vColor, uSnow, snow);
        }
      }

      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mv;
      if (isVeg && !cleared && uShowVeg < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
      gl_PointSize = clamp(uSize * uProjScale / -mv.z, 1.0, 24.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    void main() {
      vec2 c = gl_PointCoord * 2.0 - 1.0;
      if (dot(c, c) > 1.0) discard;
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
        uniform float uNear, uFar, uStrength, uRadius;
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
            sum += max(0.0, d - logDepth(vUv + off));
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
const ramp = [
  [0.0, new THREE.Color(0x3b4a3f)],
  [0.35, new THREE.Color(0x6b7a5a)],
  [0.7, new THREE.Color(0xa89f86)],
  [1.0, new THREE.Color(0xf2efe6)],
];
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
  const editing = editor?.enabled;
  hud.innerHTML = `
    <strong>${decodeURIComponent(FILE.split('/').pop())}</strong><br>
    ${(loadedPoints / 1e6).toFixed(1)}M / ${(totalPoints / 1e6).toFixed(1)}M points ${loadStatus}<br>
    ${cursorInfo ? `<span class="cursor">${cursorInfo}</span><br>` : ''}
    ${editing ? `<div class="editor"><b style="color:#9fd3ff">Editing trails</b> · T to stop · Ctrl+Z undo<br>${editorStatus}</div>` : ''}
    <span class="keys">T edit trails · V vegetation · H height above ground · E shading · [ ] point size · drag orbit · right-drag pan</span>`;
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

  const slope = terrain.slopeAt(hit.x, hit.y);
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
  cursor.scale.setScalar(dist * 0.012);
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
    onStatus: (s) => { editorStatus = s; updateHud(); },
  });
  uniforms.uTrail.value = trailMask.texture;
  uniforms.uHasTrail.value = 1;
  loadSavedTrails();
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
async function load() {
  const lazPerf = await createLazPerf({ locateFile: () => lazPerfWasmUrl });
  const copc = await Copc.create(FILE_URL);
  const { min, max } = copc.header;
  totalPoints = copc.header.pointCount;
  updateHud('· reading hierarchy…');

  // Center the data at the origin: raw UTM coordinates (~700,000 m) are too
  // large for 32-bit floats on the GPU and would make points jitter.
  const center = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]);
  const zRange = max[2] - min[2];

  sceneOffsetZ = center.z;

  // Height map loads in parallel with the points.
  Terrain.load(`${import.meta.env.BASE_URL}data/ascutney-height`, center)
    .then((t) => {
      terrain = t;
      uniforms.uHeight.value = t.texture;
      uniforms.uHeightOrigin.value.copy(t.origin);
      uniforms.uHeightRes.value = t.res;
      uniforms.uHasHeight.value = 1;
      setupTrails(t);
    })
    .catch((err) => console.error('height map failed to load', err));

  const size = Math.max(max[0] - min[0], max[1] - min[1]);
  camera.position.set(0, -size * 0.9, size * 0.6);
  controls.target.set(0, 0, zRange * 0.4);
  camera.far = size * 6;
  camera.updateProjectionMatrix();
  edlUniforms.uFar.value = camera.far;

  // Walk every hierarchy page to collect all nodes.
  const nodes = {};
  const pending = [copc.info.rootHierarchyPage];
  while (pending.length) {
    const page = pending.pop();
    const sub = await Copc.loadHierarchyPage(FILE_URL, page);
    Object.assign(nodes, sub.nodes);
    pending.push(...Object.values(sub.pages));
  }

  // Coarse levels first so the mountain appears quickly, then detail fills in.
  const keys = Object.keys(nodes)
    .filter((k) => nodes[k].pointCount > 0)
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));

  const tmp = new THREE.Color();
  async function loadNode(key) {
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
    updateHud();
  }

  // Load a few nodes at a time.
  const queue = [...keys];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) await loadNode(queue.shift());
  });
  const t0 = performance.now();
  await Promise.all(workers);
  updateHud(`· loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

load().catch((err) => {
  console.error(err);
  updateHud(`· <span style="color:#f77">failed: ${err.message}</span>`);
});

// ---------- Input ----------
addEventListener('keydown', (e) => {
  if (e.key === 'v' || e.key === 'V') uniforms.uShowVeg.value = 1 - uniforms.uShowVeg.value;
  if (e.key === 'h' || e.key === 'H') uniforms.uColorMode.value = 1 - uniforms.uColorMode.value;
  if (e.key === ']') uniforms.uSize.value *= 1.2;
  if (e.key === '[') uniforms.uSize.value /= 1.2;
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

let edlOn = true;
addEventListener('keydown', (e) => {
  if (e.key === 'e' || e.key === 'E') edlOn = !edlOn;
});
renderer.domElement.tabIndex = 0; // let the canvas take keyboard focus
renderer.domElement.addEventListener('pointerdown', () => renderer.domElement.focus());

renderer.setAnimationLoop(() => {
  controls.update();
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
  // Overlay on top, without clearing what's already drawn.
  renderer.autoClear = false;
  renderer.render(overlay, camera);
  renderer.autoClear = true;
});

// Re-pick when the camera moves under a still mouse.
controls.addEventListener('change', () => { pointerDirty = true; });
