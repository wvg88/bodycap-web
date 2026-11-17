// Instellingen die je als docent of ontwikkelaar kunt aanpassen.

/** Het model dat bij het openen wordt geladen. */
export const DEFAULT_MODEL = "models/human-skeleton.glb";

/**
 * false: MediaPipe en de herkenningsmodellen komen van internet (jsDelivr en Google).
 *        De browser bewaart ze daarna zelf.
 * true:  alles komt uit deze map, zodat de app zonder internet werkt. Het script
 *        tools/maak_offline.py downloadt de bestanden en zet deze regel op true.
 */
export const OFFLINE = false;

const local = (path) => new URL(`../${path}`, import.meta.url).href;
const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3";
const GOOGLE = "https://storage.googleapis.com/mediapipe-models";

/** MediaPipe voor het web (bibliotheek + WebAssembly). */
export const MEDIAPIPE = OFFLINE
  ? { bundle: local("vendor/mediapipe/vision_bundle.mjs"), wasm: local("vendor/mediapipe/wasm") }
  : { bundle: `${CDN}/vision_bundle.mjs`, wasm: `${CDN}/wasm` };

/** De herkenningsmodellen van Google: [bestandsnaam in de map 'models', adres op internet]. */
const MODEL_FILES = {
  holistic: ["holistic_landmarker.task", `${GOOGLE}/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task`],
  pose_lite: ["pose_landmarker_lite.task", `${GOOGLE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`],
  pose_full: ["pose_landmarker_full.task", `${GOOGLE}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`],
  pose_heavy: ["pose_landmarker_heavy.task", `${GOOGLE}/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task`],
  hand: ["hand_landmarker.task", `${GOOGLE}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`],
};
export const MODELS = Object.fromEntries(
  Object.entries(MODEL_FILES).map(([key, [file, url]]) => [key, OFFLINE ? local(`models/${file}`) : url]));

/** Gevraagde camera-instelling. Lager is sneller; MediaPipe verkleint het beeld toch. */
export const CAMERA = { width: 640, height: 480, frameRate: 30 };
