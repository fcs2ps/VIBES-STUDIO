import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import * as fflate from 'three/examples/jsm/libs/fflate.module.js';

/* ==========================================================================
   CLIENT CONFIG

   Prices are NOT set here. Filament rate, surcharges and the job minimum all
   live in server/src/pricing.js, and every quoted total comes back from the
   quoting service after a real Bambu Studio slice. Keeping one copy of the
   pricing rules means the displayed price and the billed price cannot drift
   apart, and a customer editing values in devtools changes nothing.

   What lives here is only what the viewer itself needs.
   ========================================================================== */
const CONFIG = {
  // Where the quoting service is reachable. Same-origin by default; point it
  // at the service's host if you deploy the front end separately (e.g.
  // 'https://quotes.vibes3dstudio.com').
  apiBase: window.VIBES_API_BASE || '',

  // Bambu Lab P2S build volume (mm) — https://bambulab.com/en-us/p2s
  // The server enforces this too; this copy only drives the viewer's
  // scale limits and the bed drawn on screen.
  bed: { width: 256, depth: 256, height: 256 },

  // A small safety margin so a model never touches the walls exactly.
  fitMargin: 0.98,
};

/* ==========================================================================
   PAYMENT / CHECKOUT PLACEHOLDER

   The quote passed in here is the server's own response, including its
   requestId. When you wire up payment, POST that requestId to /api/orders
   and let the server re-verify the price rather than trusting a total that
   travelled through the browser.
   ========================================================================== */
async function submitOrder(payload) {
  console.log('[placeholder] order submitted:', payload);
  alert(
    'Payment processing isn\u2019t connected yet \u2014 this is a placeholder.\n\n' +
    'Your quote total right now is $' + payload.quote.total.toFixed(2) + '.'
  );
}

// Holds the most recent server quote so checkout submits exactly what was
// shown, rather than recomputing anything client-side.
let lastQuote = null;

/* ==========================================================================
   DOM
   ========================================================================== */
const dropzone     = document.getElementById('dropzone');
const dropError     = document.getElementById('dropError');
const dropProgress  = document.getElementById('dropProgress');
const dropProgressTrack = document.getElementById('dropProgressTrack');
const dropProgressFill  = document.getElementById('dropProgressFill');
const dropStatus    = document.getElementById('dropStatus');
const fileInput     = document.getElementById('fileInput');
const uploadBtn     = document.getElementById('uploadBtn');
const workspace     = document.getElementById('workspace');
const viewerCanvas  = document.getElementById('viewerCanvas');
const viewerFilename= document.getElementById('viewerFilename');
const swapBtn       = document.getElementById('swapBtn');

// Material selection is removed from the UI for now — PLA only. Kept as a
// config-driven lookup (not a hardcoded value below) so re-enabling other
// materials later is a UI change, not a pricing-logic change.
const materialSelect = document.getElementById('materialSelect');
const colorReadout = document.getElementById('colorReadout');
const colorNote = document.getElementById('colorNote');

const sizeSlider = document.getElementById('sizeSlider');
const sizeReadout = document.getElementById('sizeReadout');
const sizeMinLabel = document.getElementById('sizeMinLabel');
const sizeMaxLabel = document.getElementById('sizeMaxLabel');
const sizeResetBtn = document.getElementById('sizeResetBtn');

const quoteIdle = document.getElementById('quoteIdle');
const quoteLoading = document.getElementById('quoteLoading');
const quoteLoadingText = document.getElementById('quoteLoadingText');
const quoteLoadingHint = document.getElementById('quoteLoadingHint');
const quoteProgress = document.getElementById('quoteProgress');
const quoteProgressFill = document.getElementById('quoteProgressFill');
const quoteResult = document.getElementById('quoteResult');
const quoteError = document.getElementById('quoteError');
const quoteErrorText = document.getElementById('quoteErrorText');
const sliceBtn = document.getElementById('sliceBtn');
const resliceBtn = document.getElementById('resliceBtn');
const retrySliceBtn = document.getElementById('retrySliceBtn');
const quoteLinesEl = document.getElementById('quoteLines');
const quoteTotalEl = document.getElementById('quoteTotal');
const quoteMinNoteEl = document.getElementById('quoteMinNote');
const checkoutBtn = document.getElementById('checkoutBtn');

const menuBtn = document.getElementById('menuBtn');
const drawer = document.getElementById('drawer');
const howBtn = document.getElementById('howBtn');
const howDialog = document.getElementById('howDialog');
const closeDialogBtn = document.getElementById('closeDialogBtn');

/* ==========================================================================
   NAV / MODAL
   ========================================================================== */
menuBtn.addEventListener('click', () => {
  const open = drawer.classList.toggle('is-open');
  menuBtn.classList.toggle('is-open', open);
  drawer.setAttribute('aria-hidden', String(!open));
});
document.querySelectorAll('.drawer a').forEach((a) => a.addEventListener('click', () => {
  drawer.classList.remove('is-open');
  menuBtn.classList.remove('is-open');
}));

howBtn.addEventListener('click', () => howDialog.showModal());
closeDialogBtn.addEventListener('click', () => howDialog.close());

/* ==========================================================================
   THREE.JS SCENE
   ========================================================================== */
let renderer, scene, camera, controls;
let modelRoot, offsetGroup, correctionGroup, userRotateGroup, rawObject = null;
let baseSize = new THREE.Vector3(1, 1, 1);   // size after axis-correction + user rotation, unscaled, mm
let currentScale = 1;
let maxScale = 1;
let minScale = 1;      // the floor — set to the scale the file loaded at
let defaultScale = 1;  // same value, kept separately as the reference point for the % display
let rotationDeg = { x: 0, y: 0, z: 0 };
let currentExt = null;
let quoteStale = true; // true whenever size or material changed since the last real slice
let originalUpload = null;   // bytes of an uploaded .3mf, kept verbatim
let detectedColors = 1;  // how many distinct colors the uploaded file actually uses

function initScene() {
  scene = new THREE.Scene();

  const w = viewerCanvas.clientWidth, h = viewerCanvas.clientHeight;
  camera = new THREE.PerspectiveCamera(40, w / h, 1, 5000);
  camera.position.set(340, 300, 420);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w, h);
  viewerCanvas.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, CONFIG.bed.height * 0.15, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 40;
  controls.maxDistance = 1400;
  // OrbitControls defaults already match: LEFT = rotate, RIGHT = pan, WHEEL = zoom.

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(260, 420, 260);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x39ff6a, 0.25);
  fill.position.set(-260, 120, -180);
  scene.add(fill);

  buildBed();

  modelRoot = new THREE.Group();
  offsetGroup = new THREE.Group();
  // STL/OBJ/3MF files meant for printing are almost always authored
  // Z-up (matching the printer's own coordinate system: XY is the bed,
  // Z is height). This scene is Y-up, so every loaded model gets this
  // fixed -90° X rotation applied underneath any user-chosen rotation,
  // converting "height in the file" into "height in the viewer" instead
  // of leaving models lying on their side/face.
  correctionGroup = new THREE.Group();
  correctionGroup.rotation.x = -Math.PI / 2;
  offsetGroup.add(correctionGroup);
  // Everything the user can freely spin (the ±90° buttons and the degree
  // inputs) lives one level further in, on top of the fixed axis correction.
  userRotateGroup = new THREE.Group();
  correctionGroup.add(userRotateGroup);
  modelRoot.add(offsetGroup);
  scene.add(modelRoot);

  animate();
  window.addEventListener('resize', onResize);
}

function buildBed() {
  const { width, depth, height } = CONFIG.bed;

  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshStandardMaterial({ color: 0x030303, roughness: 0.95, metalness: 0.05 })
  );
  plate.rotation.x = -Math.PI / 2;
  scene.add(plate);

  const grid = new THREE.GridHelper(width, 16, 0x39ff6a, 0x1c3a26);
  grid.position.y = 0.05;
  scene.add(grid);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
    new THREE.LineBasicMaterial({ color: 0x39ff6a, transparent: true, opacity: 0.4 })
  );
  edges.position.set(0, height / 2, 0);
  scene.add(edges);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function onResize() {
  const w = viewerCanvas.clientWidth, h = viewerCanvas.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

/* ==========================================================================
   GEOMETRY MATH
   ========================================================================== */

// Walks the final, fully-transformed model (current scale, rotation, and
// centering all applied) and returns a flat Float32Array of triangle
// vertices in the SLICING engine's coordinate frame: Z-up, bed-centered.
// This is what actually gets sliced — it's the same geometry the viewer is
// showing, just converted back out of three.js's Y-up convention.
// Recomputes the current (axis-corrected, user-rotated, unscaled) bounding
// box and re-centers it inside offsetGroup so it always sits centered on
// X/Z and resting on the bed (Y = 0), at any scale.
function recomputeBoundsAndCenter() {
  offsetGroup.position.set(0, 0, 0);
  offsetGroup.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(correctionGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  offsetGroup.position.set(-center.x, -box.min.y, -center.z);
  return size;
}
function computeMaxScale(size) {
  const { width, depth, height } = CONFIG.bed;
  return Math.min(
    (width * CONFIG.fitMargin) / size.x,
    (height * CONFIG.fitMargin) / size.y,
    (depth * CONFIG.fitMargin) / size.z
  );
}

/* ==========================================================================
   FILE LOADING
   ========================================================================== */

function setError(msg) {
  dropError.textContent = msg || '';
}

// Reset the input's value before opening the picker so choosing the same
// file twice in a row still fires a 'change' event (browsers otherwise
// suppress it when the selection doesn't change).
uploadBtn.addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
swapBtn.addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

;['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); })
);
;['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('is-dragover'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

/**
 * Resolves once the browser has had a chance to paint.
 *
 * requestAnimationFrame and a timer are RACED, never chained. rAF alone never
 * fires in a background tab, so chaining anything behind it means a customer
 * who switches tabs mid-upload waits forever. The timer is the floor;
 * whichever arrives first wins.
 */
function nextPaint() {
  return new Promise((resolve) => {
    let settled = false;
    const go = () => { if (!settled) { settled = true; resolve(); } };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });
}

/**
 * Drives the dropzone's progress bar while a file is read and parsed.
 *
 * This whole stretch happens before the quote panel exists, and it is the
 * part that used to look like a hang: the page sat on the dropzone with no
 * indication that megabytes of geometry were being chewed through. Pass null
 * to clear it.
 */
function setDropProgress(fraction, label) {
  if (fraction === null) {
    dropzone.classList.remove('is-loading');
    dropProgress.hidden = true;
    dropStatus.textContent = '';
    return;
  }
  dropzone.classList.add('is-loading');
  dropProgress.hidden = false;
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  dropProgressFill.style.width = pct + '%';
  dropProgressTrack.setAttribute('aria-valuenow', String(pct));
  if (label !== undefined) dropStatus.textContent = label;
}


function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['stl', 'obj', '3mf'].includes(ext)) {
    setError('Unsupported file type. Please upload a .stl, .obj, or .3mf file.');
    return;
  }
  setError('');
  currentExt = ext;

  const sizeLabel = file.size >= 1048576
    ? (file.size / 1048576).toFixed(1) + ' MB'
    : Math.round(file.size / 1024) + ' KB';

  // Reading owns the first 25% of the bar, parsing the rest. Reading a local
  // file is quick; parsing a dense mesh is not, so giving parsing the larger
  // share keeps the bar moving in proportion to the actual wait.
  setDropProgress(0, 'Reading ' + file.name + ' \u2014 ' + sizeLabel);

  const reader = new FileReader();
  reader.onprogress = (e) => {
    if (e.lengthComputable) setDropProgress(0.25 * (e.loaded / e.total));
  };
  reader.onerror = () => {
    setDropProgress(null);
    setError('Couldn\u2019t read that file. Please try again.');
  };
  reader.onload = async () => {
    // Keep the original bytes of a sliced Bambu project. Its own numbers are
    // better than anything we can compute, but only while the customer has not
    // changed the size - the moment they do, the project's figures describe a
    // different print and we go back to slicing.
    originalUpload = (ext === '3mf') ? { bytes: reader.result, name: file.name } : null;
    setDropProgress(0.25, 'Preparing "' + file.name + '"');
    // Let that paint before any parsing work starts.
    await nextPaint();
    try {
      const loaded = await parseModel(ext, reader.result, (f, label) => {
        setDropProgress(0.25 + 0.75 * f, label ? label + ' \u2014 ' + sizeLabel : undefined);
      });
      setDropProgress(null);
      onModelLoaded(loaded, file.name);
    } catch (err) {
      setDropProgress(null);
      console.error(err);
      const hint = ext === '3mf'
        ? 'Couldn\u2019t read the geometry in this .3mf file. If it\u2019s a multi-plate project file, try exporting just the part as .stl or .obj instead.'
        : 'Couldn\u2019t parse that file. Make sure it\u2019s a valid ' + ext.toUpperCase() + ' export.';
      setError(hint);
    }
  };

  if (ext === 'obj') reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}

async function parseModel(ext, data, onProgress) {
  if (ext === 'stl') {
    onProgress(0.3, 'Reading geometry');
    await nextPaint();
    const geometry = new STLLoader().parse(data);
    onProgress(0.9, 'Building preview');
    await nextPaint();
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, claymaterial());
    // STL carries no color information at all, so it is always one color.
    mesh.userData.colorCount = 1;
    mesh.userData.colorSignals = { filaments: 1, basis: 'single', raw: 1 };
    return mesh;
  }
  if (ext === 'obj') {
    onProgress(0.3, 'Reading geometry');
    await nextPaint();
    const group = new OBJLoader().parse(data);
    onProgress(0.9, 'Building preview');
    await nextPaint();
    group.traverse((c) => { if (c.isMesh) { c.material = claymaterial(); c.geometry.computeVertexNormals(); } });
    // OBJ splits by material: each distinct `usemtl` becomes its own group.
    const names = new Set();
    for (const m of String(data).matchAll(/^\s*usemtl\s+(.+)$/gim)) names.add(m[1].trim());
    const n = Math.max(1, names.size);
    group.userData.colorCount = Math.min(n, MAX_FILAMENTS);
    group.userData.colorSignals = { filaments: group.userData.colorCount, basis: n > 1 ? 'palette' : 'single', raw: n };
    return group;
  }
  if (ext === '3mf') {
    return parse3mf(data, onProgress);
  }
  throw new Error('Unhandled extension: ' + ext);
}


/*
 * .3mf parsing.
 *
 * WHY THIS DOESN'T USE DOMParser OR ThreeMFLoader
 *   A .3mf stores geometry as XML: one <vertex> element per point and one
 *   <triangle> element per face. Handing that to DOMParser builds a DOM node
 *   for every one of them — on a 320k-triangle model that is 777ms to parse
 *   plus 471ms to walk, and DOMParser is a single atomic call that cannot be
 *   broken up, so the tab is frozen for all of it. A model a few times larger
 *   is what put "Page Unresponsive" on screen.
 *
 *   Scanning the same text with a regex instead measures 427ms for the whole
 *   job — about 3.4x faster — and, far more importantly, it is a loop we
 *   control, so it can hand the thread back every few milliseconds and report
 *   real progress while it works.
 *
 *   That also removes the old two-pass behavior: this handles both plain
 *   core-spec files and the 3MF Production Extension (which splits geometry
 *   across several *.model parts and links them with p:path component
 *   references), so nothing has to be parsed twice to find out which it is.
 */

// One <vertex .../> or <triangle .../> element, captured as its attribute text.
const RE_VERTEX = /<vertex\s+([^>]*?)\/?>/g;
const RE_TRIANGLE = /<triangle\s+([^>]*?)\/?>/g;
const RE_XYZ = /([xyz])\s*=\s*"([^"]*)"/g;
const RE_V123 = /v([123])\s*=\s*"([^"]*)"/g;
const RE_OBJECT = /<object\s+([^>]*?)>/g;
const RE_COMPONENT = /<component\s+([^>]*?)\/?>/g;
const RE_ITEM = /<item\s+([^>]*?)\/?>/g;

/*
 * Color in 3MF lives in property groups: <basematerials> from the core spec,
 * <m:colorgroup> from the materials extension. Geometry points into one via a
 * `pid` (which group) plus an index - `pindex` on an <object>, or p1/p2/p3 on
 * an individual <triangle> when a single mesh is painted in several colors.
 *
 * So counting <base> entries is not enough: a file can define a palette of
 * eight and use one. What matters for pricing is how many distinct colors the
 * geometry actually references, which is what these collect.
 */
const RE_TRI_PID = /\bpid\s*=\s*"([^"]*)"/;
const RE_TRI_P1 = /\bp1\s*=\s*"([^"]*)"/;
// Bambu and Orca record color *painted* onto a mesh as a per-triangle
// `paint_color`, which is outside the 3MF spec and invisible to pid/p1.
const RE_TRI_PAINT = /\bpaint_color\s*=\s*"([^"]*)"/;

function attr(attrText, name) {
  // Matches both `name="…"` and a namespaced `ns:name="…"`, which is how the
  // production extension writes its cross-part `p:path` references.
  const m = new RegExp('(?:^|\\s)(?:[\\w.-]+:)?' + name + '\\s*=\\s*"([^"]*)"').exec(attrText);
  return m ? m[1] : null;
}

/**
 * Splits one *.model document into its <object> blocks.
 *
 * Objects don't nest in 3MF, so finding each object's extent is a matter of
 * pairing an opening tag with the next `</object>` — no parser needed.
 */
function indexObjects(text) {
  const objects = new Map();
  RE_OBJECT.lastIndex = 0;
  let m;
  while ((m = RE_OBJECT.exec(text)) !== null) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    const bodyStart = m.index + m[0].length;
    // A self-closing <object .../> has no body at all.
    const end = m[0].endsWith('/>') ? bodyStart : text.indexOf('</object>', bodyStart);
    objects.set(id, { start: bodyStart, end: end === -1 ? text.length : end, attrs: m[1] });
    RE_OBJECT.lastIndex = end === -1 ? text.length : end;
  }
  return objects;
}

/** Row-major 4x4 multiply, so the parser needs no THREE types of its own. */
function multiply(a, b) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] +
        a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 3MF writes transforms as 12 numbers in column-major order. */
function parseTransform(str) {
  const t = str.trim().split(/\s+/).map(Number);
  if (t.length < 12 || t.some((n) => !Number.isFinite(n))) return IDENTITY.slice();
  return [
    t[0], t[3], t[6], t[9],
    t[1], t[4], t[7], t[10],
    t[2], t[5], t[8], t[11],
    0, 0, 0, 1,
  ];
}

/**
 * Reads one object's <mesh>, appending world-space triangles to `out`.
 *
 * Yields to the browser whenever a slice has run long enough, so no single
 * task blocks the page however large the mesh is.
 */
async function readMesh(text, range, matrix, out, budget, colors) {
  const meshStart = text.indexOf('<mesh', range.start);
  if (meshStart === -1 || meshStart >= range.end) return false;

  const vertsStart = text.indexOf('<vertices', meshStart);
  const vertsEnd = text.indexOf('</vertices>', vertsStart);
  const trisStart = text.indexOf('<triangles', meshStart);
  const trisEnd = text.indexOf('</triangles>', trisStart);
  // Every marker must sit inside this object, or we would be reading the
  // next object's mesh into this one's transform.
  if (vertsStart === -1 || vertsEnd === -1 || trisStart === -1 || trisEnd === -1) return false;
  if (vertsEnd > range.end || trisEnd > range.end) return false;

  // Vertices first, into flat arrays — no per-point object allocation.
  const vx = [], vy = [], vz = [];
  RE_VERTEX.lastIndex = vertsStart;
  let m;
  let sliceStart = performance.now();
  while ((m = RE_VERTEX.exec(text)) !== null && m.index < vertsEnd) {
    let x = 0, y = 0, z = 0, a;
    RE_XYZ.lastIndex = 0;
    while ((a = RE_XYZ.exec(m[1])) !== null) {
      const v = parseFloat(a[2]);
      if (a[1] === 'x') x = v; else if (a[1] === 'y') y = v; else z = v;
    }
    vx.push(x); vy.push(y); vz.push(z);
    if ((vx.length & 2047) === 0 && performance.now() - sliceStart > 8) {
      await budget.yield();
      sliceStart = performance.now();
    }
  }

  // Then triangles, transformed into place as they're read.
  RE_TRIANGLE.lastIndex = trisStart;
  let count = 0;
  sliceStart = performance.now();
  while ((m = RE_TRIANGLE.exec(text)) !== null && m.index < trisEnd) {
    const abc = [-1, -1, -1];
    let a;
    RE_V123.lastIndex = 0;
    while ((a = RE_V123.exec(m[1])) !== null) abc[+a[1] - 1] = parseInt(a[2], 10);

    if (colors) {
      const p1 = RE_TRI_P1.exec(m[1]);
      if (p1) {
        const pid = RE_TRI_PID.exec(m[1]);
        colors.add((pid ? pid[1] : colors.objectPid || '') + ':' + p1[1]);
      }
      const paint = RE_TRI_PAINT.exec(m[1]);
      if (paint && paint[1]) colors.add('paint:' + paint[1]);
    }

    for (const idx of abc) {
      if (idx < 0 || idx >= vx.length) continue;
      const x = vx[idx], y = vy[idx], z = vz[idx];
      out.push(
        matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
        matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
        matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11]
      );
    }
    count++;
    if ((count & 1023) === 0 && performance.now() - sliceStart > 8) {
      await budget.yield();
      sliceStart = performance.now();
    }
  }
  return true;
}

/**
 * Resolves one object: its own mesh, or the components it is assembled from.
 * `p:path` lets a component point into a different *.model part, which is what
 * the production extension adds and what the stock loader can't follow.
 */
async function resolveObject(parts, path, id, matrix, out, budget, depth, colors) {
  if (depth > 12) return;                 // malformed circular reference guard
  const part = parts[path];
  if (!part) return;
  const range = part.objects.get(id);
  if (!range) return;

  // An object painted a single color carries pid/pindex on the <object> tag
  // itself rather than on every triangle.
  if (colors && range.attrs) {
    const pid = attr(range.attrs, 'pid');
    const pindex = attr(range.attrs, 'pindex');
    if (pid !== null && pindex !== null) colors.add(pid + ':' + pindex);
    colors.objectPid = pid === null ? colors.objectPid : pid;
  }

  if (await readMesh(part.text, range, matrix, out, budget, colors)) return;

  const body = part.text.slice(range.start, range.end);
  RE_COMPONENT.lastIndex = 0;
  const components = [];
  let m;
  while ((m = RE_COMPONENT.exec(body)) !== null) {
    components.push({
      id: attr(m[1], 'objectid'),
      path: attr(m[1], 'path'),
      transform: attr(m[1], 'transform'),
    });
  }
  for (const c of components) {
    if (!c.id) continue;
    const childMatrix = c.transform ? multiply(matrix, parseTransform(c.transform)) : matrix;
    await resolveObject(parts, c.path ? normalizePath(c.path) : path, c.id,
      childMatrix, out, budget, depth + 1, colors);
  }
}

/**
 * Parses a .3mf into a three.js group without ever blocking the page.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {(fraction:number, label:string)=>void} onProgress
 */
async function parse3mf(arrayBuffer, onProgress) {
  onProgress(0.05, 'Unpacking');
  await nextPaint();

  const zip = fflate.unzipSync(new Uint8Array(arrayBuffer));
  const decoder = new TextDecoder();

  const parts = {};
  for (const p in zip) {
    if (/\.model$/i.test(p)) {
      const text = decoder.decode(zip[p]);
      parts[normalizePath(p)] = { text, objects: indexObjects(text) };
    }
  }
  if (Object.keys(parts).length === 0) {
    throw new Error('No 3D model data found inside the .3mf package.');
  }

  // The package relationships name the root part; fall back to the
  // conventional path, then to whatever part we found.
  let rootPath = null;
  if (zip['_rels/.rels']) {
    const rels = decoder.decode(zip['_rels/.rels']);
    const m = /<Relationship\s+([^>]*?)\/?>/g;
    let r;
    while ((r = m.exec(rels)) !== null) {
      if (/3dmodel/i.test(attr(r[1], 'Type') || '')) {
        rootPath = normalizePath(attr(r[1], 'Target') || '');
        break;
      }
    }
  }
  if (!rootPath || !parts[rootPath]) {
    rootPath = parts['3d/3dmodel.model'] ? '3d/3dmodel.model' : Object.keys(parts)[0];
  }

  // Progress is reported against total <triangle> occurrences, counted up
  // front with a cheap scan — an honest denominator beats a guessed one.
  let totalTriangles = 0;
  for (const p in parts) {
    const t = parts[p].text;
    let i = 0;
    while ((i = t.indexOf('<triangle', i)) !== -1) { totalTriangles++; i += 9; }
  }

  const out = [];
  const colors = new Set();
  const budget = {
    // Called from inside the scan loops: hand the thread back, then report
    // where we are against the triangle count found above.
    yield: async () => {
      await yieldToBrowser();
      if (totalTriangles > 0) {
        onProgress(0.1 + 0.85 * Math.min(1, out.length / 9 / totalTriangles), 'Reading geometry');
      }
    },
  };

  onProgress(0.1, 'Reading geometry');

  const rootText = parts[rootPath].text;
  const buildStart = rootText.indexOf('<build');
  const buildEnd = rootText.indexOf('</build>');
  const items = [];
  if (buildStart !== -1) {
    const body = buildEnd === -1 ? rootText.slice(buildStart) : rootText.slice(buildStart, buildEnd);
    RE_ITEM.lastIndex = 0;
    let m;
    while ((m = RE_ITEM.exec(body)) !== null) {
      const id = attr(m[1], 'objectid');
      if (id) items.push({ id, path: attr(m[1], 'path'), transform: attr(m[1], 'transform') });
    }
  }

  if (items.length > 0) {
    for (const item of items) {
      const matrix = item.transform ? parseTransform(item.transform) : IDENTITY.slice();
      await resolveObject(parts, item.path ? normalizePath(item.path) : rootPath,
        item.id, matrix, out, budget, 0, colors);
    }
  } else {
    // No <build> section (unusual for a print-ready file) — take every object
    // we can find, across every part, as a last resort.
    for (const p in parts) {
      for (const id of parts[p].objects.keys()) {
        await resolveObject(parts, p, id, IDENTITY.slice(), out, budget, 0, colors);
      }
    }
  }

  if (out.length === 0) {
    throw new Error('Couldn’t find any printable geometry inside this .3mf file.');
  }

  /*
   * A Bambu or Orca project assigns filaments per part in
   * Metadata/model_settings.config, not in the 3MF geometry:
   *
   *     <object id="2">
   *       <metadata key="extruder" value="1"/>
   *       <part id="1" ...><metadata key="extruder" value="3"/></part>
   *
   * None of that is visible to pid/p1, so a four-color project sliced in
   * Bambu Studio would otherwise be read as single-color and quoted without
   * any purge at all. Count the distinct extruders it asks for.
   */
  const settings = zip['metadata/model_settings.config'] || zip['Metadata/model_settings.config'];
  if (settings) {
    const cfg = decoder.decode(settings);
    const extruders = new Set();
    for (const m of cfg.matchAll(/key="extruder"\s+value="([^"]*)"/g)) {
      if (m[1]) extruders.add(m[1]);
    }
    for (const e of extruders) colors.add('extruder:' + e);
  }

  onProgress(0.96, 'Building preview');
  await nextPaint();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geometry.computeVertexNormals();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, claymaterial()));
  group.userData.colorSignals = summarizeColors(colors);
  group.userData.colorCount = group.userData.colorSignals.filaments;
  return group;
}

/*
 * Turns raw color signals into a printable filament count.
 *
 * WHY THIS IS NOT JUST colors.size
 *   A triangle's `p1` is an index into a property group, not a color. A model
 *   colored per-vertex or from a texture - which is what an AI generator
 *   exports - has a color group with thousands of entries, so the distinct
 *   index count is thousands too. That is where a four-color figure was read
 *   as 11,939 colors.
 *
 *   A printer cannot load 11,939 filaments. Past the AMS's capacity the count
 *   stops being a filament assignment and becomes artwork, and how it maps onto
 *   actual filaments is a decision someone makes in the slicer - it is not in
 *   the file. So beyond that limit we say "this has rich color data, assume a
 *   normal AMS load" and let the customer set the real number.
 */
const MAX_FILAMENTS = 16;        // AMS capacity, 4 slots x 4 units
const ASSUMED_FILAMENTS = 4;     // one AMS, the common case

function summarizeColors(colors) {
  // An explicit per-part filament assignment is authoritative: it is literally
  // "use filament N", not a color that has to be mapped onto one.
  const extruders = [...colors].filter((c) => c.startsWith('extruder:'));
  if (extruders.length > 0) {
    return { filaments: Math.min(extruders.length, MAX_FILAMENTS), basis: 'assigned', raw: extruders.length };
  }

  const raw = colors.size;
  if (raw <= 1) return { filaments: 1, basis: 'single', raw };
  if (raw <= MAX_FILAMENTS) return { filaments: raw, basis: 'palette', raw };
  return { filaments: ASSUMED_FILAMENTS, basis: 'artwork', raw };
}

function normalizePath(p) {
  return p.replace(/^\/+/, '').toLowerCase();
}

function claymaterial() {
  // Neutral gray so the model reads like an actual print preview rather
  // than being tinted by the site's brand color.
  return new THREE.MeshStandardMaterial({ color: 0xcfcfcf, roughness: 0.5, metalness: 0.06 });
}

function onModelLoaded(object, filename) {
  // Clear any previous model.
  if (rawObject) userRotateGroup.remove(rawObject);

  rawObject = object;
  rawObject.rotation.set(0, 0, 0);
  userRotateGroup.add(rawObject);

  // Orientation is chosen for the customer now, so nothing carries over.
  rotationDeg = { x: 0, y: 0, z: 0 };
  userRotateGroup.rotation.set(0, 0, 0);

  setDetectedColors(object.userData && object.userData.colorSignals);

  autoStandUpright();

  baseSize = recomputeBoundsAndCenter();
  maxScale = computeMaxScale(baseSize);

  // The floor is wherever the file actually loaded at: full size if it
  // already fits the bed, or the auto-fit size if it didn't. Either way,
  // the customer can only scale up from here, never down past it.
  defaultScale = Math.min(1, maxScale);
  minScale = defaultScale;
  currentScale = defaultScale;
  applyScale(currentScale);

  frameCamera();
  resetQuotePanel();

  viewerFilename.textContent = filename;
  dropzone.hidden = true;
  workspace.hidden = false;
  onResize();

  // Uploading a model is a request for its price — that is the whole point of
  // the page — so quote it straight away rather than making the customer find
  // a second button. Only on load: re-slicing on every scale or rotation tweak
  // would queue a slice per keystroke and make the shop feel broken. Those
  // still mark the quote stale and wait for "Get exact price".
  runSlice();
}

/**
 * Stands an elongated model up on the plate.
 *
 * Files arrive in whatever orientation they were authored in, and a figure
 * exported lying on its back reads as broken next to a plate. The fixed Z-up
 * correction handles the common case; this catches the rest.
 *
 * The rule is deliberately narrow: only rotate when one axis is clearly longer
 * than the other two (1.5x), and only to move that axis vertical. A blocky or
 * flat part is left exactly as it came, because standing a wide thin panel on
 * its edge would be worse than leaving it down - taller, tippier and needing
 * far more support. Nothing here changes size, only which way up.
 *
 * WHICH FRAME THIS WORKS IN
 *   userRotateGroup sits *inside* correctionGroup, whose fixed -90 deg X
 *   rotation is what turns a file's Z-up into the viewer's Y-up. So a rotation
 *   applied here lands in the file's own frame, not the viewer's: the axis that
 *   ends up vertical on the plate is the model's local Z, not its local Y.
 *   Measuring the box in world space and then rotating as if it were local is
 *   how a lying bar ended up lying the other way instead of standing.
 */
function autoStandUpright() {
  userRotateGroup.rotation.set(0, 0, 0);

  // Box3.setFromObject reports WORLD extents, and every ancestor here rotates:
  // measuring through the Z-up correction and then rotating as if the numbers
  // were local is what stood a lying bar on a different side and knocked over
  // one that was already upright. Neutralize the correction for the
  // measurement, so the numbers are in the same frame as the rotation we are
  // about to apply. Translation is irrelevant - a box's size does not move.
  const corrected = correctionGroup.rotation.x;
  correctionGroup.rotation.x = 0;
  correctionGroup.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(rawObject);
  const size = box.isEmpty() ? null : box.getSize(new THREE.Vector3());

  correctionGroup.rotation.x = corrected;
  correctionGroup.updateMatrixWorld(true);
  if (!size) return;

  const axes = [
    { name: 'x', len: size.x },
    { name: 'y', len: size.y },
    { name: 'z', len: size.z },   // local Z is what the correction makes vertical
  ].sort((a, b) => b.len - a.len);

  const longest = axes[0];
  if (longest.name === 'z') return;                    // already stands up
  if (longest.len < axes[1].len * 1.5) return;         // not clearly elongated

  // Quarter turns that bring the long local axis onto local Z:
  //   about Y maps local X -> local Z, about X maps local Y -> local Z.
  if (longest.name === 'x') userRotateGroup.rotation.y = Math.PI / 2;
  else userRotateGroup.rotation.x = Math.PI / 2;

  userRotateGroup.updateMatrixWorld(true);
}

function frameCamera() {
  const dims = getScaledSize();
  const dist = Math.max(dims.x, dims.y, dims.z, 60) * 2.1;
  camera.position.set(dist * 0.62, dist * 0.55, dist * 0.75);
  controls.target.set(0, dims.y * 0.3, 0);
  controls.update();
}

/* ==========================================================================
   SCALE + DIMENSION CONTROLS
   ========================================================================== */

function getScaledSize() {
  return new THREE.Vector3(baseSize.x * currentScale, baseSize.y * currentScale, baseSize.z * currentScale);
}

function applyScale(scale) {
  currentScale = Math.min(Math.max(scale, minScale), maxScale);
  modelRoot.scale.setScalar(currentScale);
  syncControlsFromScale();
  markQuoteStale();
}

/*
 * The slider's 0..1000 positions map onto minScale..maxScale.
 *
 * A fixed integer range rather than the scale values themselves, because the
 * usable range depends on the model: a small part might scale 6x before it
 * hits the plate, a big one barely at all. Mapping keeps the travel of the
 * knob the same either way, and keeps the two ends meaningful -- hard left is
 * always the size the file arrived at, hard right is always as large as the
 * plate allows.
 */
const SIZE_SLIDER_STEPS = 1000;

function scaleToSlider(scale) {
  if (maxScale <= minScale) return 0;
  const t = (scale - minScale) / (maxScale - minScale);
  return Math.round(Math.max(0, Math.min(1, t)) * SIZE_SLIDER_STEPS);
}

function sliderToScale(value) {
  if (maxScale <= minScale) return minScale;
  return minScale + (value / SIZE_SLIDER_STEPS) * (maxScale - minScale);
}

function syncSizer() {
  const pct = Math.round((currentScale / defaultScale) * 100);
  const dims = getScaledSize();
  const longest = Math.max(dims.x, dims.y, dims.z);
  sizeReadout.innerHTML = '<b>' + pct + '%</b> \u00b7 ' + longest.toFixed(1) + ' mm tallest side';

  sizeSlider.value = String(scaleToSlider(currentScale));
  // A model that already fills the plate can't grow: say so rather than
  // leaving a slider that looks broken because it won't move.
  const canGrow = maxScale > minScale * 1.001;
  sizeSlider.disabled = !canGrow;
  sizeMaxLabel.textContent = canGrow
    ? Math.round((maxScale / defaultScale) * 100) + '% (fits plate)'
    : 'already fills the plate';
  sizeResetBtn.disabled = Math.abs(currentScale - defaultScale) < 1e-6;
}

function syncControlsFromScale() {
  syncSizer();
}


/* ==========================================================================
   ROTATION CONTROLS
   ========================================================================== */


/* ==========================================================================
   PRICING
   ========================================================================== */

/* ==========================================================================
   QUOTE PANEL STATE MACHINE
   idle → (click "Get exact price") → loading → result (or error)
   Any change to size/rotation/multicolor after a result marks it stale and
   drops back to idle, so a customer never checks out against a price that
   no longer matches what's on the plate.
   ========================================================================== */

function showQuotePanel(state) {
  quoteIdle.hidden = state !== 'idle';
  quoteLoading.hidden = state !== 'loading';
  quoteResult.hidden = state !== 'result';
  quoteError.hidden = state !== 'error';
}

function resetQuotePanel() {
  quoteStale = true;
  showQuotePanel('idle');
}

function markQuoteStale() {
  if (!rawObject) return;
  if (!quoteStale) resetQuotePanel();
}

/*
 * We upload the *transformed* mesh rather than the original file plus a list
 * of transform parameters. That way the geometry the slicer measures is
 * byte-for-byte the geometry the customer approved on screen — there's no
 * second implementation of the transform math on the server that could drift
 * out of sync with the viewer.
 */

/**
 * Walks the mesh and writes a binary STL, a slice of triangles at a time.
 *
 * WHY THIS IS CHUNKED
 *   The straight-line version of this held the main thread for the whole job:
 *   about a second at 200k triangles and several at the 600k+ an AI-generated
 *   or scanned model routinely arrives with. During that the browser cannot
 *   paint, cannot scroll, and eventually offers to kill the page — which is
 *   what "the site stops responding" was. Yielding every few milliseconds costs
 *   a little total time and keeps the page alive throughout, which is the trade
 *   we want on the one machine the whole shop runs on.
 *
 *   It also means "Preparing" can show real progress instead of a sweep,
 *   because now there is something to report.
 *
 * Writes directly into the output buffer rather than accumulating triangles in
 * an array first: one pass, one allocation, and no 40 MB intermediate.
 */
async function buildStlInChunks(onProgress) {
  modelRoot.updateMatrixWorld(true);

  // Inverse of the -90° X import correction: rotates world-space (Y-up)
  // vertices back into the file/printer convention (Z-up). A rotation
  // preserves winding order and handedness, so no extra sign-flip is needed.
  const exportRotation = new THREE.Matrix4().makeRotationX(Math.PI / 2);

  // Pass 1: count triangles, so the buffer can be allocated exactly once.
  const meshes = [];
  let triCount = 0;
  rawObject.traverse((child) => {
    if (!child.isMesh) return;
    const pos = child.geometry.attributes.position;
    if (!pos) return;
    const index = child.geometry.index;
    const count = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    if (count > 0) {
      meshes.push({ mesh: child, pos, index, count });
      triCount += count;
    }
  });

  if (triCount === 0) return null;

  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triCount, true);   // 80-byte header stays zeroed

  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
  const m = new THREE.Matrix4();

  let offset = 84;
  let written = 0;
  let sliceStart = performance.now();

  for (const entry of meshes) {
    const { pos, index, count } = entry;
    m.multiplyMatrices(exportRotation, entry.mesh.matrixWorld);

    for (let i = 0; i < count; i++) {
      let a, b, c;
      if (index) {
        a = index.getX(i * 3); b = index.getX(i * 3 + 1); c = index.getX(i * 3 + 2);
      } else {
        a = i * 3; b = i * 3 + 1; c = i * 3 + 2;
      }
      vA.fromBufferAttribute(pos, a).applyMatrix4(m);
      vB.fromBufferAttribute(pos, b).applyMatrix4(m);
      vC.fromBufferAttribute(pos, c).applyMatrix4(m);

      ab.subVectors(vB, vA);
      ac.subVectors(vC, vA);
      normal.crossVectors(ab, ac);
      if (normal.lengthSq() > 0) normal.normalize();

      view.setFloat32(offset, normal.x, true); offset += 4;
      view.setFloat32(offset, normal.y, true); offset += 4;
      view.setFloat32(offset, normal.z, true); offset += 4;
      for (const v of [vA, vB, vC]) {
        view.setFloat32(offset, v.x, true); offset += 4;
        view.setFloat32(offset, v.y, true); offset += 4;
        view.setFloat32(offset, v.z, true); offset += 4;
      }
      offset += 2;   // attribute byte count, left zero
      written++;

      // Hand the browser the thread back roughly every frame. Checking the
      // clock rather than a fixed triangle count keeps the pause short on a
      // slow machine too, which is where the freeze actually hurt.
      if ((written & 1023) === 0 && performance.now() - sliceStart > 8) {
        onProgress(written / triCount);
        await yieldToBrowser();
        sliceStart = performance.now();
      }
    }
  }

  onProgress(1);
  return { blob: new Blob([buffer], { type: 'model/stl' }), triCount };
}

/**
 * Yields to the browser so it can paint, then resumes promptly.
 *
 * Neither obvious option survives a background tab: `requestAnimationFrame`
 * doesn't fire at all, and `setTimeout` is clamped to about once a second — so
 * a customer who starts a quote and switches tabs would be waiting a second per
 * chunk, which on a dense model is minutes. A MessageChannel message is a
 * macrotask the browser still lets the page paint around, and it is not
 * throttled, so the work continues at full speed either way.
 */
const yieldToBrowser = (() => {
  // Chrome's scheduler API says exactly what we mean, when it's available.
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return () => scheduler.yield();
  }
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    const waiting = [];
    channel.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
    return () => new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
  }
  return () => new Promise((resolve) => setTimeout(resolve, 0));
})();

/* --------------------------------------------------------------- progress */

/**
 * Drives the progress bar.
 *
 * A null `fraction` means "we cannot measure this" and puts the bar into its
 * sweeping state. That is the honest rendering of slicing: the CLI reports
 * nothing at all until it finishes, so any percentage shown during it would be
 * invented — and an invented bar that parks at 90% is exactly what makes a
 * working app look hung.
 */
function setProgress(fraction, text, hint) {
  const measurable = typeof fraction === 'number';
  quoteProgress.classList.toggle('is-indeterminate', !measurable);

  if (measurable) {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    quoteProgressFill.style.width = pct + '%';
    quoteProgress.setAttribute('aria-valuenow', String(pct));
  } else {
    quoteProgressFill.style.width = '';
    quoteProgress.removeAttribute('aria-valuenow');
  }

  if (text !== undefined) quoteLoadingText.textContent = text;
  if (hint !== undefined) quoteLoadingHint.textContent = hint;
}

function formatElapsed(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's elapsed';
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's elapsed';
}

class NetworkError extends Error {
  constructor() {
    super('The quoting service could not be reached.');
    this.name = 'NetworkError';
  }
}

/**
 * Uploads the model and resolves with the parsed response.
 *
 * XMLHttpRequest rather than fetch on purpose: fetch still cannot report
 * upload progress, and the upload is the one part of a quote whose remaining
 * time the customer can actually watch shrink. A multi-megabyte mesh on a slow
 * connection is otherwise a silent wait with nothing moving on screen.
 *
 * The mesh goes up as the raw request body with its metadata in the query
 * string, rather than as multipart form data. That lets the server stream it
 * straight to disk instead of holding the whole thing (twice) in memory, which
 * is what capped uploads at 100MB and made a detailed model fail.
 */
function postQuote(blob, params, { onUploadProgress, onUploadComplete }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams(params).toString();
    xhr.open('POST', CONFIG.apiBase + '/api/quote?' + query);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onUploadProgress(e.loaded / e.total);
    });
    xhr.upload.addEventListener('load', () => onUploadComplete());

    xhr.addEventListener('load', () => {
      let payload = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* non-JSON body */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, payload });
    });
    xhr.addEventListener('error', () => reject(new NetworkError()));
    xhr.addEventListener('timeout', () => reject(new NetworkError()));
    xhr.addEventListener('abort', () => {
      const err = new Error('superseded');
      err.name = 'AbortError';
      reject(err);
    });

    // Generous, because a quote queued behind someone else's slice is
    // legitimately slow. The server's own request timeout is the real bound.
    xhr.timeout = 15 * 60 * 1000;
    xhr.send(blob);

    postQuote.current = xhr;
  });
}

async function runSlice() {
  if (!rawObject) return;

  // A second click while one is in flight should replace it, not race it.
  if (postQuote.current) {
    const superseded = postQuote.current;
    postQuote.current = null;
    superseded.abort();
  }

  showQuotePanel('loading');
  setProgress(0, 'Preparing your model…', '');

  let ticker = null;

  try {
    // The mesh walk and STL write happen in slices with the thread handed
    // back between them, so a dense model can't freeze the page. It reports
    // real progress, which is why this phase is a percentage and not a sweep.
    const built = await buildStlInChunks((f) => {
      // Preparing owns 0-35% of the bar, uploading 35-70%, slicing the rest.
      setProgress(f * 0.35);
    });
    if (!built) throw new Error('No geometry to slice.');

    let { blob } = built;
    const { triCount } = built;
    const dims = getScaledSize();
    const params = {
      name: 'model.stl',
      material: materialSelect.value || 'PLA',
      multicolor: String(detectedColors > 1),
      colors: String(detectedColors),
      // Printer-space dims: viewer Y (up) is the printer's Z.
      dims: JSON.stringify({
        x: Number(dims.x.toFixed(3)),
        y: Number(dims.z.toFixed(3)),
        z: Number(dims.y.toFixed(3)),
      }),
    };

    /*
     * An unmodified Bambu project goes up verbatim, so the server can read the
     * grams Bambu already worked out - purge and prime tower included. Once the
     * customer rescales, those figures describe a different print, so we fall
     * back to uploading the transformed mesh and slicing it.
     */
    const unmodified = Math.abs(currentScale - defaultScale) < 1e-6;
    if (originalUpload && unmodified) {
      blob = new Blob([originalUpload.bytes], { type: 'model/3mf' });
      params.name = 'model.3mf';
    }

    const mb = blob.size / (1024 * 1024);
    const sizeLabel = mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(blob.size / 1024) + ' KB';
    const triLabel = triCount.toLocaleString();

    setProgress(0.35, 'Uploading your model…', sizeLabel + ' · ' + triLabel + ' triangles');

    let slicingStartedAt = 0;

    const res = await postQuote(blob, params, {
      onUploadProgress: (f) => setProgress(0.35 + f * 0.35),
      onUploadComplete: () => {
        slicingStartedAt = Date.now();
        setProgress(null, 'Slicing on a Bambu Lab P2S…', 'Measuring real filament use');
        ticker = setInterval(() => {
          const ms = Date.now() - slicingStartedAt;
          quoteLoadingHint.textContent = ms > 25000
            ? formatElapsed(ms) + ' · detailed models take longer'
            : formatElapsed(ms);
        }, 1000);
      },
    });

    if (ticker) { clearInterval(ticker); ticker = null; }

    if (!res.ok) {
      const err = new Error(
        (res.payload && res.payload.error) ||
        'The quoting service couldn’t process this model.'
      );
      err.code = res.payload && res.payload.code;
      err.status = res.status;
      throw err;
    }

    setProgress(1, 'Done', '');

    lastQuote = res.payload;
    renderQuote(res.payload);
    quoteStale = false;
    showQuotePanel('result');
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by a newer request
    console.error(err);
    showQuotePanel('error');
    quoteErrorText.textContent = describeSliceError(err);
  } finally {
    if (ticker) clearInterval(ticker);
    postQuote.current = null;
  }
}

function describeSliceError(err) {
  // A request that fails outright rather than returning a status almost always
  // means the service isn't reachable — worth saying plainly instead of
  // showing a raw error object.
  if (err instanceof NetworkError) {
    return 'Couldn’t reach the quoting service. Check that the launcher ' +
      'window is still open, then try again.';
  }
  // The server is up and deliberately turning us away. That is a "try again in
  // a moment", not a "something is broken" — so pass its own wording through.
  if (err.code === 'BUSY' || err.code === 'BUSY_TIMEOUT') return err.message;

  return err.message && err.message.length < 240
    ? err.message
    : 'Something went wrong while slicing this model. Please try again.';
}

/*
 * Dragging fires a continuous stream of input events, and every one of them
 * marks the quote stale. That is correct -- the price no longer matches the
 * plate -- but re-slicing per event would be absurd, so applyScale only
 * invalidates and the customer asks for the new price when they've settled.
 */
sizeSlider.addEventListener('input', () => {
  applyScale(sliderToScale(Number(sizeSlider.value)));
});
sizeResetBtn.addEventListener('click', () => applyScale(defaultScale));

// Material changes the slice itself, not just the rate: ASA is 1.05 g/cm3
// against PLA's 1.26, so the same part weighs ~17% less. The quote has to be
// re-run, not rescaled.
materialSelect.addEventListener('change', markQuoteStale);

// Color count drives purge and prime tower, which is most of a multicolor
// price - so it is the customer's to set, the way they would in the slicer.

/**
 * Fills the material picker from /api/health.
 *
 * Built from the server's list rather than hardcoded here, so the rates and
 * the options can never disagree with what the quote is actually computed
 * from. Falls back to PLA alone if the service isn't reachable yet.
 */
function populateMaterials(pricing) {
  const materials = (pricing && pricing.materials) || [{ key: 'PLA', label: 'PLA' }];
  materialSelect.innerHTML = '';
  for (const m of materials) {
    const opt = document.createElement('option');
    opt.value = m.key;
    opt.textContent = Number.isFinite(m.costPerGram)
      ? `${m.label} \u2014 $${m.costPerGram.toFixed(2)}/g`
      : m.label;
    materialSelect.appendChild(opt);
  }
  if (pricing && pricing.defaultMaterial) materialSelect.value = pricing.defaultMaterial;
}

/**
 * Reports how many colors the uploaded file uses.
 *
 * Detected from the file rather than asked of the customer: a .3mf records its
 * colors as property groups the geometry points into, and an .obj splits by
 * material. An .stl carries no color at all, so it is always one.
 */
function setDetectedColors(signals) {
  const s = signals || { filaments: 1, basis: 'single', raw: 1 };
  detectedColors = Math.max(1, Math.min(MAX_FILAMENTS, s.filaments || 1));

  const multi = detectedColors > 1;
  colorReadout.textContent = multi ? `${detectedColors} colors` : '1 color';
  colorReadout.classList.toggle('is-multi', multi);

  /*
   * The note exists because of what a color count does and does not buy you.
   *
   * Purge and prime tower are real filament, and they are billed from the
   * actual G-code. But a plain mesh gives the slicer no instruction about which
   * filament goes where, so our slice runs single-color and has none - which
   * would quote a multicolor job without the waste that makes it expensive.
   * The only way to get those grams is a project already sliced in Bambu
   * Studio, so that is what this says.
   */
  colorNote.textContent =
    s.basis === 'single'
      ? 'No color data in this file, so it prints in one.'
      : s.basis === 'artwork'
        ? `This file carries ${s.raw.toLocaleString()} colors — artwork, not a filament assignment. `
          + 'Upload a .3mf you have sliced in Bambu Studio to be billed for the real purge and prime tower.'
        : 'Purge and prime tower are only counted for a .3mf you have already sliced in '
          + 'Bambu Studio — that is the only place the filament layout exists.';
}

sliceBtn.addEventListener('click', runSlice);
resliceBtn.addEventListener('click', runSlice);
retrySliceBtn.addEventListener('click', runSlice);

/* ==========================================================================
   BACKEND AVAILABILITY

   Checked once on load so the idle panel can tell the truth up front. Finding
   out the service is down only after waiting through a slice attempt is a bad
   way to learn it.
   ========================================================================== */

let backendStatus = { checked: false, reachable: false, ready: false, detail: '' };

async function checkBackend() {
  try {
    const res = await fetch(`${CONFIG.apiBase}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();

    const setup = data.setup || {};
    backendStatus = {
      checked: true,
      reachable: true,
      ready: data.slicer === 'ready' && setup.ready !== false,
      detail: '',
    };

    populateMaterials(data.pricing);

    if (!setup.slicerFound) {
      // A released copy carries its own slicer, so this means the folder is
      // damaged rather than unconfigured. Say what to do about it.
      backendStatus.detail =
        'The slicing engine is missing from this copy of the app. ' +
        'Re-unzip the folder, or run "node setup.js" in it.';
    } else if (setup.missingProfiles && setup.missingProfiles.length) {
      backendStatus.detail =
        `Printer profiles still need setting up (${setup.missingProfiles.join(', ')}).`;
    }
  } catch {
    backendStatus = {
      checked: true,
      reachable: false,
      ready: false,
      detail: 'The quoting service isn\u2019t running. Start it with "node start.js", then reload this page.',
    };
  }
  renderBackendNotice();
}

function renderBackendNotice() {
  const el = document.getElementById('backendNotice');
  if (!el) return;

  if (!backendStatus.checked || backendStatus.ready) {
    el.hidden = true;
    sliceBtn.disabled = false;
    return;
  }

  el.hidden = false;
  el.textContent = backendStatus.detail
    || 'Exact pricing is unavailable right now.';
  // Leave the button enabled when the service is merely misconfigured: the
  // resulting error names the real problem. Only a hard-unreachable service
  // makes clicking pointless.
  sliceBtn.disabled = !backendStatus.reachable;
}

checkBackend();

/* ==========================================================================
   PRICING
   ========================================================================== */

/*
 * Pricing lives on the server (server/src/pricing.js) and is computed from a
 * real slice. The browser deliberately does not calculate prices: a total the
 * client can compute is a total the client can edit, and there's no second
 * formula here to drift out of sync with the one that bills the customer.
 * This code only renders what the service returned.
 */


function renderQuote(payload) {
  const quote = payload.quote;

  quoteLinesEl.innerHTML = '';
  quote.lines.forEach((line) => {
    const row = document.createElement('div');
    row.className = 'quote-line'
      + (line.placeholder ? ' is-placeholder' : '')
      + (line.surcharge ? ' is-surcharge' : '');
    const dt = document.createElement('dt');
    dt.textContent = line.label;
    const dd = document.createElement('dd');
    dd.textContent = line.placeholder ? 'Added at checkout' : '$' + line.amount.toFixed(2);
    row.appendChild(dt);
    row.appendChild(dd);
    quoteLinesEl.appendChild(row);
  });

  quoteTotalEl.textContent = '$' + quote.total.toFixed(2);

  /*
   * The slice is the last word on how many filaments this print uses. A Bambu
   * project records one extruder per object but loads several, and the file
   * gives no way to tell which regions use which - only slicing does. So once a
   * quote comes back, the readout follows it rather than the guess made at load.
   */
  const filaments = (payload.slice && payload.slice.filaments) || null;
  if (filaments && filaments.length) {
    detectedColors = filaments.length;
    const multi = filaments.length > 1;
    colorReadout.textContent = multi ? filaments.length + ' colors' : '1 color';
    colorReadout.classList.toggle('is-multi', multi);
    colorNote.textContent = multi
      ? 'Sliced with the ' + filaments.length + ' filaments your project loads.'
      : 'Sliced with one filament.';
  }

  const notes = [];
  if (quote.belowMinimum) {
    notes.push(`Raised to the $${quote.total.toFixed(2)} job minimum.`);
  }
  quoteMinNoteEl.textContent = notes.join(' ');

  checkoutBtn.onclick = () => submitOrder(payload);
}

/* ==========================================================================
   INIT
   ========================================================================== */
initScene();
