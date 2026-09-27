/* ============================================================================
 * app.js — Voxel Architect Phase 1 UI + Three.js viewport.
 *
 * Layout: left = prompt + parameter controls, center = 3D viewport +
 * candidate strip, right = structure library.
 *
 * Flow: prompt -> (keyword stub) params -> sliders -> generate 4
 * candidates -> click a candidate to inspect -> save to library.
 * Phase 2 will replace promptToParams and scoreCandidates with Jev calls;
 * those seams live in wfc.js and this file needs no changes for that.
 * ========================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  BLOCK, BLOCK_INFO, TILESET_VERSION,
  generate, generateCandidates, promptToParams, scoreCandidates,
} from './wfc.js';
import { Library } from './library.js';

const $ = (id) => document.getElementById(id);

const state = {
  candidates: [],   // generated result objects (+ thumbnail dataURLs)
  selected: 0,
  params: null,     // params used for the current batch
  lastPrompt: '',
};

const library = new Library();

let renderer, scene, camera, controls;
let voxelGroup = null;
let groundMesh = null;
const materials = {};
const boxGeom = new THREE.BoxGeometry(1, 1, 1);
const dummy = new THREE.Object3D();

/* ------------------------------------------------------------------ */
/* Three.js setup                                                      */
/* ------------------------------------------------------------------ */

function initThree() {
  const viewport = $('viewport');
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161c);
  scene.fog = new THREE.Fog(0x14161c, 60, 140);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;

  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2620, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
  sun.position.set(18, 26, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 80;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.userData.sun = sun;

  for (const [key, info] of Object.entries(BLOCK_INFO)) {
    materials[key] = new THREE.MeshLambertMaterial({
      color: info.color,
      emissive: info.emissive || 0x000000,
    });
  }

  const resize = () => {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(viewport);
  window.addEventListener('resize', resize);
  resize();

  const tick = () => {
    requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();
}

function buildVoxelGroup(result) {
  if (voxelGroup) {
    scene.remove(voxelGroup);
    voxelGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
  if (groundMesh) { scene.remove(groundMesh); groundMesh.geometry.dispose(); }

  const { grid, W, H, D } = result;
  const counts = new Map();
  const idx = (x, y, z) => (y * D + z) * W + x;
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const v = grid[idx(x, y, z)];
        if (v === BLOCK.AIR) continue;
        counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
  }

  const group = new THREE.Group();
  const placed = new Map();
  for (const [type, count] of counts) {
    const mesh = new THREE.InstancedMesh(boxGeom, materials[type], count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    group.add(mesh);
    placed.set(type, { mesh, i: 0 });
  }
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const v = grid[idx(x, y, z)];
        if (v === BLOCK.AIR) continue;
        const rec = placed.get(v);
        dummy.position.set(x - W / 2 + 0.5, y + 0.5, z - D / 2 + 0.5);
        dummy.updateMatrix();
        rec.mesh.setMatrixAt(rec.i++, dummy.matrix);
      }
    }
  }
  group.traverse((o) => { if (o.isInstancedMesh) o.instanceMatrix.needsUpdate = true; });

  // ground disc
  const r = Math.max(W, D) * 1.4;
  groundMesh = new THREE.Mesh(
    new THREE.CircleGeometry(r, 48),
    new THREE.MeshLambertMaterial({ color: 0x1e222c })
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  group.add(groundMesh);

  // fit shadow camera
  const sun = scene.userData.sun;
  const s = Math.max(W, H, D);
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
  sun.shadow.camera.updateProjectionMatrix();
  sun.position.set(s * 0.9, s * 1.3, s * 0.6);
  sun.target.position.set(0, H / 2, 0);
  sun.target.updateMatrixWorld();

  voxelGroup = group;
  scene.add(group);
  return group;
}

function frameCamera(result) {
  const { W, H, D } = result;
  const center = new THREE.Vector3(0, H * 0.45, 0);
  const maxDim = Math.max(W, H, D);
  const dist = maxDim * 2.1;
  const dir = new THREE.Vector3(1, 0.62, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  controls.target.copy(center);
  controls.update();
}

/** Render a candidate off-screen-in-place and capture a thumbnail. */
function renderThumbnail(result) {
  buildVoxelGroup(result);
  frameCamera(result);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/jpeg', 0.72);
}

/* ------------------------------------------------------------------ */
/* UI: params                                                          */
/* ------------------------------------------------------------------ */

const SLIDERS = [
  ['width', 'in-width', 'v-width', (v) => v],
  ['depth', 'in-depth', 'v-depth', (v) => v],
  ['stories', 'in-stories', 'v-stories', (v) => v],
  ['windowDensity', 'in-windows', 'v-windows', (v) => v + '%'],
];

function readSliders() {
  return {
    width: +$('in-width').value,
    depth: +$('in-depth').value,
    stories: +$('in-stories').value,
    roofStyle: $('in-roof').value,
    windowDensity: +$('in-windows').value / 100,
    chimney: $('in-chimney').checked,
    symmetry: $('in-symmetry').checked,
    crenellation: $('in-cren').checked,
    pillars: $('in-pillars').checked,
    door: true,
  };
}

function syncSliders(p) {
  $('in-width').value = p.width;
  $('in-depth').value = p.depth;
  $('in-stories').value = p.stories;
  $('in-roof').value = p.roofStyle;
  $('in-windows').value = Math.round(p.windowDensity * 100);
  $('in-chimney').checked = p.chimney;
  $('in-symmetry').checked = p.symmetry;
  $('in-cren').checked = p.crenellation;
  $('in-pillars').checked = p.pillars;
  refreshSliderLabels();
}

function refreshSliderLabels() {
  for (const [, inputId, labelId, fmt] of SLIDERS) {
    $(labelId).textContent = fmt($(inputId).value);
  }
}

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

/* ------------------------------------------------------------------ */
/* UI: generation flow                                                 */
/* ------------------------------------------------------------------ */

function generateFlow() {
  try {
    const t0 = performance.now();
    const prompt = $('prompt').value.trim();

    // New prompt text -> keyword stub seeds the sliders, then sliders win.
    if (prompt && prompt !== state.lastPrompt) {
      syncSliders({ ...readSliders(), ...promptToParams(prompt) });
      state.lastPrompt = prompt;
    }

    const params = { ...readSliders(), prompt };
    const candidates = generateCandidates(params, 4);
    const scored = scoreCandidates(candidates); // Phase 2: Jev curation

    // thumbnails (synchronous; no visible flash — selection restores after)
    for (const c of scored) c.thumbnail = renderThumbnail(c);

    state.candidates = scored;
    state.params = params;
    renderCandidateStrip();
    selectCandidate(0);

    const ms = Math.round(performance.now() - t0);
    const w = scored[0].stats.windows;
    setStatus(`Generated 4 variants in ${ms}ms · ${w} windows · seed ${scored[0].seed}`);
  } catch (err) {
    console.error(err);
    setStatus('Generation failed: ' + err.message, true);
  }
}

function renderCandidateStrip() {
  const strip = $('candidates');
  strip.innerHTML = '';
  state.candidates.forEach((c, i) => {
    const card = document.createElement('button');
    card.className = 'cand-card' + (i === state.selected ? ' selected' : '');
    const img = document.createElement('img');
    img.src = c.thumbnail;
    img.alt = 'variant ' + (i + 1);
    const label = document.createElement('span');
    label.textContent = 'Variant ' + (i + 1);
    card.appendChild(img);
    card.appendChild(label);
    card.addEventListener('click', () => selectCandidate(i));
    strip.appendChild(card);
  });
}

function selectCandidate(i) {
  state.selected = i;
  const c = state.candidates[i];
  if (!c) return;
  buildVoxelGroup(c);
  frameCamera(c);
  renderer.render(scene, camera);
  document.querySelectorAll('.cand-card').forEach((el, j) => {
    el.classList.toggle('selected', j === i);
  });
  $('sel-label').textContent =
    `Variant ${i + 1} · seed ${c.seed} · ${c.stats.windows} windows` +
    (c.stats.contradictions ? ` · ${c.stats.contradictions} fallbacks` : '');
  $('save').disabled = false;
}

/* ------------------------------------------------------------------ */
/* UI: library                                                         */
/* ------------------------------------------------------------------ */

function refreshLibrary() {
  library.renderList($('library'), (item) => {
    try {
      // Regenerate deterministically from stored params + seed.
      const result = generate({ ...item.params, seed: item.seed });
      result.thumbnail = item.thumbnail;
      state.candidates = [{ ...result, score: null }];
      state.params = { ...item.params };
      state.lastPrompt = item.prompt || '';
      $('prompt').value = item.prompt || '';
      syncSliders(item.params);
      renderCandidateStrip();
      selectCandidate(0);
      setStatus(`Loaded "${item.name}" from library.`);
    } catch (err) {
      console.error(err);
      setStatus('Failed to load: ' + err.message, true);
    }
  });
}

function saveCurrent() {
  const c = state.candidates[state.selected];
  if (!c || !state.params) return;
  const p = state.params;
  const fallbackName = p.prompt
    ? p.prompt.slice(0, 42)
    : `${p.roofStyle} ${p.width}x${p.depth} x${p.stories}`;
  const name = prompt('Name this structure:', fallbackName);
  if (!name || !name.trim()) return;
  library.add({
    name: name.trim(),
    prompt: p.prompt || '',
    params: { ...p },
    tilesetVersion: TILESET_VERSION,
    seed: c.seed,
    connectionPoints: c.connectionPoints || [],
    thumbnail: c.thumbnail,
  });
  refreshLibrary();
  setStatus(`Saved "${name.trim()}" to the library.`);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  initThree();

  for (const [, inputId] of SLIDERS) {
    $(inputId).addEventListener('input', refreshSliderLabels);
  }
  $('generate').addEventListener('click', generateFlow);
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generateFlow();
  });
  $('save').addEventListener('click', saveCurrent);

  refreshSliderLabels();
  refreshLibrary();

  // first paint: a friendly default
  $('prompt').value = 'cozy cottage with chimney';
  generateFlow();
});
