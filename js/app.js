// Bodycap Web: bestuur een 3D-skelet met je lichaam voor de webcam.
// Dit bestand verbindt de onderdelen: de 3D-scène (three.js), de camera en herkenning
// (tracker.js), de vertaling naar botstanden (solver.js) en de bediening.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { DEFAULT_MODEL } from "./config.js";
import { Rig, ROLES, DEFAULT_SOLVER_SETTINGS, normName } from "./solver.js";
import { Tracker } from "./tracker.js";
import { Recorder } from "./recorder.js";

const $ = (id) => document.getElementById(id);
const nl = (v, digits = 1) => v.toFixed(digits).replace(".", ",");

// ---------------------------------------------------------------------------
// Instellingen (onthouden in deze browser)
// ---------------------------------------------------------------------------

const STORE_KEY = "bodycap-web";
const settings = {
  ...DEFAULT_SOLVER_SETTINGS,
  face: false, showCamera: true, showOverlay: true, showFaceMesh: true, cameraSize: "small", cameraId: "",
  smoothing: 5, engine: "holistic", quality: "full", delegate: "GPU", useWorker: true,
  shadows: true, showBones: false, showFloor: true, renderQuality: "auto",
};
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); } catch { /* geen opslag: standaardwaarden */ }
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* geen opslag beschikbaar */ }
}

// ---------------------------------------------------------------------------
// Scène
// ---------------------------------------------------------------------------

const canvas = $("scene");
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
} catch (err) {
  setStatus("error", "Deze browser kan geen 3D tonen (WebGL ontbreekt).");
  throw err;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.53;

const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
const key = new THREE.DirectionalLight(0xfff2df, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
const rim = new THREE.DirectionalLight(0xbfd4ff, 1.1);
scene.add(hemi, key, key.target, rim);

const floor = new THREE.Mesh(new THREE.CircleGeometry(7, 72), new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
const grid = new THREE.GridHelper(14, 28);
grid.material.transparent = true;
grid.material.opacity = 0.35;
grid.position.y = 0.002;
scene.add(floor, grid);

const modelGroup = new THREE.Group();
scene.add(modelGroup);

/** De scène neemt de kleuren van het thema (licht of donker) over. */
function applyTheme() {
  const css = getComputedStyle(document.documentElement);
  const color = (name) => new THREE.Color(css.getPropertyValue(name).trim() || "#222");
  const bg = color("--scene-top");
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 7, 17);
  floor.material.color.copy(color("--scene-floor"));
  grid.material.color.copy(color("--scene-grid"));
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  hemi.intensity = dark ? 0.9 : 1.5;
  hemi.groundColor.set(dark ? 0x2a3038 : 0x8c96a3);
}
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

// ---------------------------------------------------------------------------
// Model laden
// ---------------------------------------------------------------------------

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.setDRACOLoader(new DRACOLoader().setDecoderPath(new URL("../vendor/three/examples/jsm/libs/draco/gltf/", import.meta.url).href));

let rig = null;
let modelRoot = null;
let skeletonHelper = null;
let faceMeshes = [];
let modelHeight = 1.75;
const recorder = new Recorder();

const ARKIT_SAMPLE = ["jawopen", "eyeblinkleft", "eyeblinkl", "mouthsmileleft", "mouthsmilel", "browinnerup"];

async function loadModel(url, label) {
  setStatus("loading", "Model laden");
  let gltf;
  try {
    gltf = await loader.loadAsync(url);
  } catch (err) {
    setStatus("error", "Het model kon niet worden geladen.");
    toast(`Model laden mislukt: ${err.message || err}`, "error");
    return false;
  }
  const root = gltf.scene;
  const skinned = [];
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) {
    toast("Dit model heeft geen skelet (geen armature), dus het kan niet worden bestuurd.", "error");
    setStatus(tracker.cameraOn ? "tracking" : "idle", tracker.cameraOn ? "Volgt je lichaam" : "Camera uit");
    return false;
  }

  // Oud model opruimen
  if (modelRoot) {
    rig?.release();
    modelGroup.remove(modelRoot);
    modelRoot.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        for (const m of [].concat(o.material)) m.dispose();
      }
    });
    if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper.dispose?.(); }
  }
  recorder.clear();
  updateRecordUI();

  // Op de vloer zetten, in het midden, op mensmaat
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  let size = box.getSize(new THREE.Vector3());
  if (size.y > 0 && (size.y < 0.5 || size.y > 3)) {
    root.scale.multiplyScalar(1.75 / size.y);
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  }
  const centre = box.getCenter(new THREE.Vector3());
  root.position.x -= centre.x;
  root.position.z -= centre.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
  modelHeight = size.y || 1.75;

  const bones = [];
  faceMeshes = [];
  for (const mesh of skinned) {
    mesh.frustumCulled = false;     // de botten bewegen de mesh buiten zijn rustvorm
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (const b of mesh.skeleton.bones) if (!bones.includes(b)) bones.push(b);
  }
  root.traverse((o) => {
    if (o.isMesh && o.morphTargetDictionary) {
      const dict = {};
      for (const [name, index] of Object.entries(o.morphTargetDictionary)) dict[normName(name)] = index;
      if (ARKIT_SAMPLE.some((n) => n in dict)) faceMeshes.push({ mesh: o, dict });
    }
  });

  modelGroup.add(root);
  modelRoot = root;
  rig = new Rig(bones);
  rig.write();

  skeletonHelper = new THREE.SkeletonHelper(root);
  skeletonHelper.visible = settings.showBones;
  scene.add(skeletonHelper);

  frameView();
  updateModelUI(label);
  setStatus(tracker.cameraOn ? "searching" : "idle", tracker.cameraOn ? "Zoekt je lichaam" : "Camera uit");
  window.bodycap.rig = rig;
  return true;
}

/** Zet het camerastandpunt recht voor het model en past licht en schaduw aan op de maat. */
function frameView() {
  const h = modelHeight;
  const fwd = rig?.geom.fwd.clone() || new THREE.Vector3(0, 0, 1);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
  fwd.normalize();
  controls.target.set(0, h * 0.52, 0);
  camera.position.copy(controls.target).addScaledVector(fwd, h * 2.5).add(new THREE.Vector3(0, h * 0.12, 0));
  controls.minDistance = h * 0.4;
  controls.maxDistance = h * 7;
  controls.update();

  const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd);
  key.position.set(0, h * 2.4, 0).addScaledVector(fwd, h * 1.5).addScaledVector(side, h * 1.2);
  key.target.position.set(0, h * 0.5, 0);
  rim.position.set(0, h * 1.6, 0).addScaledVector(fwd, -h * 2).addScaledVector(side, -h * 1.5);
  const s = key.shadow.camera;
  s.left = -h * 1.3; s.right = h * 1.3; s.top = h * 1.3; s.bottom = -h * 1.3;
  s.near = 0.1; s.far = h * 6;
  s.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Camera en herkenning
// ---------------------------------------------------------------------------

const video = $("video");
const overlay = $("overlay");
const overlayCtx = overlay.getContext("2d");

// Het kader krijgt de verhouding van het echte camerabeeld, zodat de overlay precies past
function syncVideoRatio() {
  if (video.videoWidth && video.videoHeight) $("camera").style.setProperty("--ar", (video.videoWidth / video.videoHeight).toFixed(4));
}
video.addEventListener("loadedmetadata", syncVideoRatio);
video.addEventListener("resize", syncVideoRatio);
let lastCapture = null;
let pendingCalibration = false;

const tracker = new Tracker(video, {
  result: onCapture,
  status: (state, detail) => {
    if (state === "loading") setStatus("loading", detail);
    else if (state === "ready") { setStatus("loading", "Herkenning start op (de eerste keer duurt dat even)"); updateEngineInfo(); }
    else if (state === "error") { setStatus("error", `Herkenning: ${detail}`); toast(`De herkenning geeft een fout: ${detail}`, "error"); }
  },
  fallback: () => {
    toast("De aparte thread reageerde niet. De herkenning draait nu op de hoofdthread.");
    $("use-worker").checked = false;
  },
  stats: (s) => {
    $("stat-track").textContent = tracker.ready && tracker.cameraOn ? `${s.tracking.toFixed(0)} fps` : "–";
    $("stat-camera").textContent = tracker.cameraOn ? `${s.camera.toFixed(0)} fps` : "–";
    updateEngineInfo();
  },
});

function solverSettings() {
  return {
    torso: settings.torso, head: settings.head, arms: settings.arms, fingers: settings.fingers, legs: settings.legs,
    location: settings.location, locationScale: settings.locationScale, ground: settings.ground, ik: settings.ik,
    mirror: settings.mirror, visibility: settings.visibility,
  };
}

function engineConfig() {
  return {
    engine: settings.engine, quality: settings.quality, delegate: settings.delegate, useWorker: settings.useWorker,
    hands: settings.fingers,                       // geen vingers: het handmodel hoeft niet te draaien
    face: settings.face && faceMeshes.length > 0,
  };
}

async function applyEngineConfig() {
  if (!tracker.cameraOn) return;
  try { await tracker.configure(engineConfig()); } catch { /* de statusmelding staat al in beeld */ }
}

function onCapture(capture) {
  lastCapture = capture;
  const hasBody = !!capture.pose;
  const hasHands = !!(capture.hands.L || capture.hands.R);
  if (!tracker.paused) {
    if (hasBody) setStatus("tracking", "Volgt je lichaam");
    else if (hasHands) setStatus("tracking", "Volgt alleen je handen");
    else setStatus("searching", "Geen lichaam in beeld");
  }
  if (rig && !recorder.playing) {
    if (pendingCalibration && hasBody) {
      pendingCalibration = false;
      if (rig.calibrate(capture, solverSettings())) { toast("Gekalibreerd"); updateCalibrationUI(); }
      else toast("Kalibreren lukte niet: je schouders en heupen waren niet goed te zien.", "error");
    }
    rig.solve(capture, solverSettings());
    applyFace(capture.face);
  }
  if (settings.showCamera && (settings.showOverlay || settings.showFaceMesh)) drawOverlay(capture);
}

function applyFace(face) {
  if (!face || !settings.face || !faceMeshes.length) return;
  for (const { mesh, dict } of faceMeshes) {
    for (const name in face) {
      let n = normName(name);
      if (settings.mirror) n = n.endsWith("left") ? n.slice(0, -4) + "right" : n.endsWith("right") ? n.slice(0, -5) + "left" : n;
      let index = dict[n];
      if (index === undefined) index = dict[n.replace(/left$/, "l").replace(/right$/, "r")];
      if (index !== undefined) mesh.morphTargetInfluences[index] = Math.min(1, face[name] * 1.2);
    }
  }
}

const POSE_LINES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29],
  [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], [0, 7], [0, 8]];
const HAND_LINES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13],
  [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

function drawOverlay(capture) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return;
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  const ctx = overlayCtx;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = "round";
  const lines = tracker._info?.faceLines;
  if (settings.showFaceMesh && capture.faceNorm && lines) {
    const f = capture.faceNorm, count = f.length / 2;
    const path = (pairs) => {
      ctx.beginPath();
      for (let i = 0; i < pairs.length; i += 2) {
        const a = pairs[i], b = pairs[i + 1];
        if (a >= count || b >= count) continue;
        ctx.moveTo(f[a * 2] * w, f[a * 2 + 1] * h);
        ctx.lineTo(f[b * 2] * w, f[b * 2 + 1] * h);
      }
    };
    path(lines.mesh);
    ctx.strokeStyle = "rgba(190, 235, 255, 0.45)";
    ctx.lineWidth = Math.max(0.5, w / 1300);
    ctx.stroke();
    path(lines.contours);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = Math.max(1, w / 640);
    ctx.stroke();
  }
  if (!settings.showOverlay) return;
  if (capture.pose) {
    const n = capture.pose.norm, thr = settings.visibility;
    for (const pass of [false, true]) {          // eerst de onzekere lijnen, dan de zekere eroverheen
      ctx.beginPath();
      for (const [a, b] of POSE_LINES) {
        const ok = n[a * 3 + 2] >= thr && n[b * 3 + 2] >= thr;
        if (ok !== pass) continue;
        ctx.moveTo(n[a * 3] * w, n[a * 3 + 1] * h);
        ctx.lineTo(n[b * 3] * w, n[b * 3 + 1] * h);
      }
      ctx.strokeStyle = pass ? "#52d0b0" : "rgba(255,255,255,0.35)";
      ctx.lineWidth = pass ? Math.max(2, w / 220) : 1;
      ctx.stroke();
    }
  }
  for (const [s, colour] of [["L", "#f0b35e"], ["R", "#8fb8ff"]]) {
    const hand = capture.hands[s];
    if (!hand) continue;
    ctx.beginPath();
    for (const [a, b] of HAND_LINES) {
      ctx.moveTo(hand.norm[a * 2] * w, hand.norm[a * 2 + 1] * h);
      ctx.lineTo(hand.norm[b * 2] * w, hand.norm[b * 2 + 1] * h);
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1.5, w / 320);
    ctx.stroke();
  }
}

async function toggleCamera() {
  const button = $("camera-start");
  if (tracker.cameraOn) {
    tracker.stopCamera();
    button.textContent = "Start camera";
    button.dataset.on = "false";
    $("camera").hidden = true;
    $("pause").disabled = true;
    $("calibrate").disabled = true;
    $("stat-track").textContent = "–";
    $("stat-camera").textContent = "–";
    setStatus("idle", "Camera uit");
    return;
  }
  button.disabled = true;
  try {
    setStatus("loading", "Camera starten");
    const info = await tracker.startCamera(settings.cameraId);
    $("camera-label").textContent = info.label;
    $("camera").hidden = false;
    updateCameraUI();
    button.textContent = "Stop camera";
    button.dataset.on = "true";
    $("pause").disabled = false;
    $("calibrate").disabled = false;
    await refreshCameraList();
    await tracker.configure(engineConfig());
  } catch (err) {
    const name = err?.name || "";
    const message = name === "NotAllowedError" ? "De browser kreeg geen toestemming voor de camera. Sta de camera toe en probeer het opnieuw."
      : name === "NotFoundError" || name === "OverconstrainedError" ? "Er is geen (passende) camera gevonden."
      : name === "NotReadableError" ? "De camera is in gebruik door een ander programma."
      : String(err?.message || err);
    if (!tracker.cameraOn) setStatus("error", message);
    toast(message, "error");
  } finally {
    button.disabled = false;
  }
}

async function refreshCameraList() {
  const select = $("camera-select");
  const cams = await tracker.listCameras();
  select.replaceChildren(new Option("Standaardcamera", ""));
  cams.forEach((c, i) => select.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  select.value = cams.some((c) => c.deviceId === settings.cameraId) ? settings.cameraId : "";
}

// ---------------------------------------------------------------------------
// Bediening
// ---------------------------------------------------------------------------

function setStatus(state, text) {
  const el = $("status");
  if (el.dataset.state === state && el.textContent === text) return;
  el.dataset.state = state;
  el.textContent = text;
}

let toastTimer = 0;
function toast(text, kind = "info") {
  const el = $("toast");
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === "error" ? 6000 : 2500);
}

function bindCheck(id, keyName, onChange) {
  const el = $(id);
  el.checked = !!settings[keyName];
  el.addEventListener("change", () => { settings[keyName] = el.checked; save(); onChange?.(el.checked); });
  return el;
}

function bindSelect(id, keyName, onChange) {
  const el = $(id);
  if ([...el.options].some((o) => o.value === settings[keyName])) el.value = settings[keyName];
  el.addEventListener("change", () => { settings[keyName] = el.value; save(); onChange?.(el.value); });
  return el;
}

function bindRange(id, keyName, format, onChange) {
  const el = $(id), out = $(`${id}-out`);
  el.value = settings[keyName];
  const show = () => { if (out) out.textContent = format(+el.value); };
  show();
  el.addEventListener("input", () => { settings[keyName] = +el.value; show(); save(); onChange?.(+el.value); });
  return el;
}

function updateCameraUI() {
  const box = $("camera");
  box.dataset.visible = settings.showCamera ? "true" : "false";
  box.dataset.size = settings.cameraSize;
  $("camera-size").textContent = settings.cameraSize === "large" ? "Kleiner" : "Groter";
  overlay.hidden = !settings.showOverlay && !settings.showFaceMesh;
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}

function updateCalibrationUI() {
  $("calibration-state").textContent = rig?.cal.done
    ? "Gekalibreerd. Kalibreer opnieuw als je de camera verplaatst."
    : "Niet gekalibreerd. Sta recht en klik op Kalibreer; je krijgt 3 seconden om klaar te staan.";
}

function updateEngineInfo() {
  if (!tracker.ready) { $("engine-info").textContent = ""; return; }
  const s = tracker.stats;
  const where = s.delegate === "CPU" ? "de processor" : "de grafische kaart";
  $("engine-info").textContent = `Draait op ${where}, in ${s.mode === "aparte thread" ? "een aparte thread" : "de hoofdthread"}. `
    + `Eén beeld herkennen kost ongeveer ${Math.max(1, s.ms).toFixed(0)} ms.`;
}

function updateModelUI(label) {
  const n = rig.mappedCount;
  $("model-info").textContent = `${label}: ${n} lichaamsdelen gekoppeld aan ${rig.boneInfo.filter((b) => b.role).length} van de ${rig.bones.length} botten. Naamgeving: ${rig.conventionLabel}.`;
  const list = $("model-warnings");
  list.replaceChildren(...rig.warnings.map((w) => Object.assign(document.createElement("li"), { textContent: w })));
  if (n < 8) list.append(Object.assign(document.createElement("li"), { textContent: "Er zijn weinig botten herkend. Kies ze zelf onder Botkoppeling." }));

  const hasFace = faceMeshes.length > 0;
  $("part-face").disabled = !hasFace;
  $("part-face").checked = hasFace && settings.face;
  $("face-hint").hidden = hasFace;
  updateCalibrationUI();
  buildMappingUI();
}

function buildMappingUI() {
  const box = $("mapping");
  const titles = { torso: "Romp", head: "Hoofd", arms: "Armen", fingers: "Vingers", legs: "Benen" };
  const names = rig.bones.map((b) => b.userData?.name || b.name);
  const nodes = [];
  let group = null;
  for (const role of ROLES) {
    if (role.group !== group) {
      group = role.group;
      nodes.push(Object.assign(document.createElement("h4"), { textContent: titles[group] }));
    }
    const label = document.createElement("label");
    label.textContent = role.label;
    const select = document.createElement("select");
    select.id = `map-${role.id}`;
    select.add(new Option("(geen)", ""));
    names.forEach((n, i) => select.add(new Option(n, String(i))));
    const current = rig.map[role.id]?.[0];
    select.value = current ? String(rig.bones.indexOf(current)) : "";
    select.addEventListener("change", () => {
      const map = { ...rig.map };
      if (select.value === "") delete map[role.id];
      else map[role.id] = [rig.bones[+select.value]];
      rig.restPose();
      rig.setMapping(map);
      $("model-info").textContent = `Aangepaste koppeling: ${rig.mappedCount} lichaamsdelen gekoppeld.`;
    });
    label.append(select);
    nodes.push(label);
  }
  box.replaceChildren(...nodes);
}

function updateRecordUI() {
  const rec = $("record"), play = $("play");
  rec.textContent = recorder.recording ? "Stop opnemen" : "Start opnemen";
  rec.dataset.on = recorder.recording ? "true" : "false";
  play.textContent = recorder.playing ? "Stop afspelen" : "Afspelen";
  play.disabled = recorder.recording || !recorder.hasData;
  $("download").disabled = recorder.recording || !recorder.hasData;
  $("record-info").textContent = recorder.recording ? "Bezig met opnemen…"
    : recorder.hasData ? `Opname van ${nl(recorder.duration)} seconden (${recorder.frames.length} beelden).`
    : "Nog geen opname.";
}

function startCalibration() {
  if (!tracker.cameraOn || !rig) { toast("Start eerst de camera."); return; }
  const box = $("countdown");
  let left = 3;
  const tick = () => {
    if (left === 0) { box.hidden = true; pendingCalibration = true; return; }
    box.innerHTML = `Sta recht en kijk naar de camera<strong>${left}</strong>`;
    box.hidden = false;
    left--;
    setTimeout(tick, 1000);
  };
  tick();
}

function togglePause() {
  if (!tracker.cameraOn) return;
  tracker.paused = !tracker.paused;
  $("pause").textContent = tracker.paused ? "Hervat herkenning" : "Pauzeer herkenning";
  if (tracker.paused) setStatus("paused", "Herkenning gepauzeerd");
}

function setupUI() {
  $("camera-start").addEventListener("click", toggleCamera);
  $("pause").addEventListener("click", togglePause);
  $("camera-select").addEventListener("change", async (e) => {
    settings.cameraId = e.target.value; save();
    if (tracker.cameraOn) {
      try { const info = await tracker.startCamera(settings.cameraId); $("camera-label").textContent = info.label; }
      catch (err) { toast(`Deze camera start niet: ${err.message || err}`, "error"); }
    }
  });
  bindCheck("show-camera", "showCamera", updateCameraUI);
  bindCheck("show-overlay", "showOverlay", updateCameraUI);
  bindCheck("show-face-mesh", "showFaceMesh", updateCameraUI);
  $("camera-size").addEventListener("click", () => { settings.cameraSize = settings.cameraSize === "large" ? "small" : "large"; save(); updateCameraUI(); });

  $("calibrate").addEventListener("click", startCalibration);
  $("clear-calibration").addEventListener("click", () => { rig?.clearCalibration(); updateCalibrationUI(); toast("Kalibratie gewist"); });
  $("rest-pose").addEventListener("click", () => rig?.restPose());

  for (const part of ["torso", "head", "arms", "legs"]) bindCheck(`part-${part}`, part);
  bindCheck("part-fingers", "fingers", applyEngineConfig);
  bindCheck("part-location", "location", (on) => { $("location-scale-field").hidden = !on; });
  $("location-scale-field").hidden = !settings.location;
  bindCheck("part-face", "face", applyEngineConfig);
  bindRange("location-scale", "locationScale", (v) => nl(v));
  bindCheck("ik", "ik");
  bindCheck("ground", "ground");
  bindCheck("mirror", "mirror");
  bindRange("visibility", "visibility", (v) => nl(v, 2));

  bindRange("smoothing", "smoothing", (v) => String(v), (v) => tracker.setSmoothing(v));
  tracker.setSmoothing(settings.smoothing);
  bindSelect("engine", "engine", () => { $("quality").disabled = settings.engine === "holistic"; applyEngineConfig(); });
  $("quality").disabled = settings.engine === "holistic";
  bindSelect("quality", "quality", applyEngineConfig);
  bindSelect("delegate", "delegate", applyEngineConfig);
  bindCheck("use-worker", "useWorker", applyEngineConfig);

  $("record").addEventListener("click", () => {
    if (recorder.recording) recorder.stop();
    else { recorder.stopPlayback(); recorder.start(); }
    updateRecordUI();
  });
  $("play").addEventListener("click", () => {
    if (recorder.playing) recorder.stopPlayback(); else recorder.play();
    updateRecordUI();
  });
  $("download").addEventListener("click", async () => {
    const button = $("download");
    button.disabled = true;
    try {
      const wasPlaying = recorder.playing;
      recorder.stopPlayback();
      const buffer = await recorder.exportGLB(rig, modelRoot);
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(new Blob([buffer], { type: "model/gltf-binary" })), download: "bodycap-opname.glb" });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      if (wasPlaying) recorder.play();
      toast("Opname gedownload als bodycap-opname.glb");
    } catch (err) {
      toast(`Exporteren mislukt: ${err.message || err}`, "error");
    }
    updateRecordUI();
  });

  bindCheck("shadows", "shadows", (on) => { renderer.shadowMap.enabled = on; key.castShadow = on; scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; }); });
  renderer.shadowMap.enabled = settings.shadows;
  key.castShadow = settings.shadows;
  bindCheck("show-bones", "showBones", (on) => { if (skeletonHelper) skeletonHelper.visible = on; });
  bindCheck("show-floor", "showFloor", (on) => { floor.visible = on; grid.visible = on; });
  floor.visible = grid.visible = settings.showFloor;
  bindSelect("render-quality", "renderQuality", setRenderQuality);
  $("reset-view").addEventListener("click", frameView);

  $("model-file").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; });

  $("panel-toggle").addEventListener("click", () => {
    const panel = $("panel");
    panel.hidden = !panel.hidden;
    $("panel-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  });

  // Slepen van een .glb op de pagina
  let dragDepth = 0;
  addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; $("dropzone").hidden = false; e.preventDefault(); } });
  addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropzone").hidden = true; });
  addEventListener("drop", (e) => {
    dragDepth = 0; $("dropzone").hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) { e.preventDefault(); loadFile(f); }
  });

  addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA|BUTTON|SUMMARY)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === "c") startCalibration();
    else if (k === "r") rig?.restPose();
    else if (k === "v") { $("show-camera").click(); }
    else if (k === "p") { $("show-overlay").click(); }
    else if (k === "m") { $("show-face-mesh").click(); }
    else if (k === "i") { $("ik").click(); toast(`Inverse kinematics ${$("ik").checked ? "aan" : "uit"}`); }
    else if (k === " ") { e.preventDefault(); togglePause(); }
    else if (k === "+" || k === "=" || k === "-" || k === "_") {
      const el = $("smoothing");
      el.value = Math.max(1, Math.min(9, +el.value + (k === "-" || k === "_" ? -1 : 1)));
      el.dispatchEvent(new Event("input"));
      toast(`Smoothing ${el.value} van 9`);
    }
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (tracker.cameraOn) refreshCameraList(); });
  updateCameraUI();
  updateRecordUI();
}

async function loadFile(file) {
  if (!/\.(glb|gltf)$/i.test(file.name)) { toast("Kies een .glb-bestand.", "error"); return; }
  const url = URL.createObjectURL(file);
  await loadModel(url, file.name);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Tekenen
// ---------------------------------------------------------------------------

const maxRatio = Math.min(devicePixelRatio || 1, 2);
let pixelRatio = maxRatio;

function setRenderQuality(mode) {
  if (mode === "low") pixelRatio = Math.min(0.75, maxRatio);
  else if (mode === "medium") pixelRatio = Math.min(1, maxRatio);
  else pixelRatio = maxRatio;
  key.shadow.mapSize.setScalar(mode === "low" ? 1024 : 2048);
  key.shadow.map?.dispose();
  key.shadow.map = null;
  lastSize = "";
}

let lastSize = "";
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const id = `${w}x${h}@${pixelRatio}`;
  if (id === lastSize || !w || !h) return;
  lastSize = id;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const perf = { frames: 0, since: performance.now(), slow: 0, fast: 0 };

/** Houdt het beeld soepel: bij een te lage snelheid iets minder scherp tekenen, en andersom. */
function adaptQuality(fps) {
  if (settings.renderQuality !== "auto" || document.hidden) return;
  if (fps < 45) { perf.slow++; perf.fast = 0; } else if (fps > 57) { perf.fast++; perf.slow = 0; } else { perf.slow = perf.fast = 0; }
  if (perf.slow >= 2 && pixelRatio > 0.75) { pixelRatio = Math.max(0.75, pixelRatio - 0.25); perf.slow = 0; lastSize = ""; }
  else if (perf.fast >= 5 && pixelRatio < maxRatio) { pixelRatio = Math.min(maxRatio, pixelRatio + 0.25); perf.fast = 0; lastSize = ""; }
}

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (rig) {
    const wasPlaying = recorder.playing;
    if (!recorder.advance(rig, dt)) {
      // hoe hoger de smoothing, hoe rustiger het skelet naar zijn doel beweegt
      rig.animate(dt, 0.025 + 0.007 * (settings.smoothing - 1));
      if (wasPlaying) updateRecordUI();
    }
    recorder.capture(rig);
  }
  controls.update();
  resize();
  renderer.render(scene, camera);

  perf.frames++;
  if (now - perf.since >= 1000) {
    const fps = (perf.frames * 1000) / (now - perf.since);
    $("stat-render").textContent = `${fps.toFixed(0)} fps`;
    adaptQuality(fps);
    perf.frames = 0;
    perf.since = now;
    if (recorder.recording) $("record-info").textContent = `Bezig met opnemen… ${nl(recorder.duration)} s`;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Handig in de console: bodycap.rig, bodycap.tracker, bodycap.settings ...
window.bodycap = { THREE, rig: null, tracker, recorder, settings, scene, camera, renderer, loadModel, frameView };

setupUI();
setRenderQuality(settings.renderQuality);
resize();
requestAnimationFrame(frame);
loadModel(DEFAULT_MODEL, "Menselijk skelet").then((ok) => { window.bodycap.ready = true; window.bodycap.modelLoaded = ok; });
