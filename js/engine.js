// De MediaPipe-motor. Draait bij voorkeur in een web worker (zie tracker-worker.js),
// en anders op de hoofdthread. Levert per camerabeeld kale getallenreeksen op.
//
//   pose.world  Float32Array(99)  33 x (x, y, z) in meters, oorsprong tussen de heupen
//   pose.norm   Float32Array(99)  33 x (x, y, zichtbaarheid) in beeldcoördinaten 0..1
//   hands[]     { world: Float32Array(63), norm: Float32Array(42), label }
//   face        { naam: score } met de 52 ARKit-uitdrukkingen (alleen Holistic)
//   faceNorm    Float32Array(956) 478 x (x, y) in beeldcoördinaten (alleen Holistic)

export class Engine {
  constructor() {
    this.pose = null;
    this.hand = null;
    this.holistic = null;
    this.info = {};
  }

  /**
   * cfg: { bundle, wasm, models, useModule, engine: "pose" | "holistic",
   *        quality: "lite" | "full" | "heavy", hands: bool, face: bool, delegate: "GPU" | "CPU" }
   */
  async init(cfg) {
    this.mp = await import(cfg.bundle);
    // MediaPipe heeft twee varianten van zijn WebAssembly-lader. Op de hoofdthread laadt
    // het de klassieke variant zelf, met een <script>. In een module-worker (useModule) is
    // de module-variant nodig. Die laadt MediaPipe met import() en wist hem na elk model
    // weer; een tweede import() komt uit de cache en zet hem niet terug. Daarom bewaren we
    // de lader in dat geval zelf en zetten we hem vóór elk nieuw model klaar.
    this.fileset = await this.mp.FilesetResolver.forVisionTasks(cfg.wasm, !!cfg.useModule);
    this.factory = cfg.useModule ? (await import(this.fileset.wasmLoaderPath)).default : null;
    await this.configure(cfg);
  }

  async configure(cfg) {
    this.close();
    this.cfg = cfg;
    const mp = this.mp;
    if (cfg.engine === "holistic") {
      this.holistic = await this._create(mp.HolisticLandmarker, cfg.models.holistic, cfg.delegate,
        { outputFaceBlendshapes: !!cfg.face });
    } else {
      this.pose = await this._create(mp.PoseLandmarker, cfg.models[`pose_${cfg.quality}`] || cfg.models.pose_full,
        cfg.delegate, { numPoses: 1 });
      if (cfg.hands) {
        this.hand = await this._create(mp.HandLandmarker, cfg.models.hand, cfg.delegate, { numHands: 2 });
      }
    }
    this.info = { engine: cfg.engine, quality: cfg.quality, hands: !!(this.hand || this.holistic),
                  face: !!(this.holistic && cfg.face), delegate: this.delegateUsed,
                  faceLines: this.holistic ? faceLines(mp) : null };
    return this.info;
  }

  /** Maakt een landmarker; lukt de GPU niet, dan op de processor. */
  async _create(Cls, modelAssetPath, delegate, extra) {
    const make = (d) => {
      if (this.factory) globalThis.ModuleFactory = this.factory;
      return Cls.createFromOptions(this.fileset, { baseOptions: { modelAssetPath, delegate: d }, runningMode: "VIDEO", ...extra });
    };
    try {
      const lm = await make(delegate || "GPU");
      this.delegateUsed = delegate || "GPU";
      return lm;
    } catch (err) {
      if ((delegate || "GPU") === "CPU") throw err;
      const lm = await make("CPU");
      this.delegateUsed = "CPU";
      return lm;
    }
  }

  close() {
    for (const k of ["pose", "hand", "holistic"]) {
      try { this[k]?.close(); } catch { /* al gesloten */ }
      this[k] = null;
    }
  }

  /** source: video-element of ImageBitmap; ts: oplopende tijd in milliseconden. */
  detect(source, ts) {
    const out = { pose: null, hands: [], face: null };
    if (this.holistic) {
      const r = this.holistic.detectForVideo(source, ts);
      if (r.poseLandmarks?.[0]?.length && r.poseWorldLandmarks?.[0]?.length) {
        out.pose = packPose(r.poseLandmarks[0], r.poseWorldLandmarks[0]);
      }
      for (const [label, n, w] of [["L", r.leftHandLandmarks, r.leftHandWorldLandmarks],
                                   ["R", r.rightHandLandmarks, r.rightHandWorldLandmarks]]) {
        if (n?.[0]?.length && w?.[0]?.length) out.hands.push(packHand(n[0], w[0], label));
      }
      const fl = r.faceLandmarks?.[0];
      if (fl?.length) {
        out.faceNorm = new Float32Array(fl.length * 2);
        for (let i = 0; i < fl.length; i++) { out.faceNorm[i * 2] = fl[i].x; out.faceNorm[i * 2 + 1] = fl[i].y; }
      }
      const cats = r.faceBlendshapes?.[0]?.categories;
      if (cats?.length) {
        out.face = {};
        for (const c of cats) if (c.categoryName !== "_neutral") out.face[c.categoryName] = c.score;
      }
      return out;
    }
    if (this.pose) {
      const r = this.pose.detectForVideo(source, ts);
      if (r.landmarks?.[0]?.length && r.worldLandmarks?.[0]?.length) out.pose = packPose(r.landmarks[0], r.worldLandmarks[0]);
    }
    if (this.hand) {
      const r = this.hand.detectForVideo(source, ts);
      for (let i = 0; i < (r.landmarks?.length || 0); i++) {
        if (r.worldLandmarks?.[i]?.length) out.hands.push(packHand(r.landmarks[i], r.worldLandmarks[i], null));
      }
    }
    return out;
  }
}

/** De lijnen van MediaPipe's gezichtsmesh: { mesh: alle driehoeksranden, contours: ogen, lippen, omtrek }. */
function faceLines(mp) {
  const flat = (list) => Uint16Array.from((list || []).flatMap((c) => [c.start, c.end]));
  const F = mp.FaceLandmarker;
  return F ? { mesh: flat(F.FACE_LANDMARKS_TESSELATION), contours: flat(F.FACE_LANDMARKS_CONTOURS) } : null;
}

function packPose(norm, world) {
  const n = new Float32Array(99), w = new Float32Array(99);
  for (let i = 0; i < 33; i++) {
    const a = norm[i], b = world[i];
    let vis = a.visibility ?? b.visibility ?? 1;
    // Buiten het beeld = niet zichtbaar (ook als het model er toch een gok voor geeft)
    if (a.x < -0.02 || a.x > 1.02 || a.y < -0.02 || a.y > 1.02) vis = Math.min(vis, 0.1);
    n[i * 3] = a.x; n[i * 3 + 1] = a.y; n[i * 3 + 2] = vis;
    w[i * 3] = b.x; w[i * 3 + 1] = b.y; w[i * 3 + 2] = b.z;
  }
  return { norm: n, world: w };
}

function packHand(norm, world, label) {
  const n = new Float32Array(42), w = new Float32Array(63);
  for (let i = 0; i < 21; i++) {
    n[i * 2] = norm[i].x; n[i * 2 + 1] = norm[i].y;
    w[i * 3] = world[i].x; w[i * 3 + 1] = world[i].y; w[i * 3 + 2] = world[i].z;
  }
  return { norm: n, world: w, label };
}

/** Alle buffers in een resultaat, om ze zonder kopiëren naar de hoofdthread te sturen. */
export function transferables(result) {
  const list = [];
  if (result.pose) list.push(result.pose.norm.buffer, result.pose.world.buffer);
  for (const h of result.hands) list.push(h.norm.buffer, h.world.buffer);
  if (result.faceNorm) list.push(result.faceNorm.buffer);
  return list;
}
