import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Copc } from 'copc';
import { createLazPerf } from 'laz-perf';
import lazPerfWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';

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
};
const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */ `
    attribute float cls;
    uniform float uSize;
    uniform float uProjScale;
    uniform float uShowVeg;
    varying vec3 vColor;
    void main() {
      bool isVeg = cls > 2.5 && cls < 5.5;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      if (isVeg && uShowVeg < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
      gl_PointSize = clamp(uSize * uProjScale / -mv.z, 1.0, 24.0);
      vColor = color;
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
function updateHud(extra = '') {
  hud.innerHTML = `
    <strong>${decodeURIComponent(FILE.split('/').pop())}</strong><br>
    ${(loadedPoints / 1e6).toFixed(1)}M / ${(totalPoints / 1e6).toFixed(1)}M points ${extra}<br>
    <span class="keys">V vegetation · E shading · [ ] point size · drag orbit · right-drag pan</span>`;
}

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
  if (e.key === ']') uniforms.uSize.value *= 1.2;
  if (e.key === '[') uniforms.uSize.value /= 1.2;
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeTargets();
  updateProjScale();
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
  if (edlOn) {
    renderer.setRenderTarget(sceneTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(edlScene, edlCamera);
  } else {
    renderer.render(scene, camera);
  }
});
