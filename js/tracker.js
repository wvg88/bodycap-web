// Camera + herkenning. Stuurt camerabeelden naar de MediaPipe-motor (in een worker
// als dat kan), filtert de punten en geeft per beeld één 'capture' door.

import { MEDIAPIPE, MODELS, CAMERA } from "./config.js";
import { Engine } from "./engine.js";
import { OneEuroFilter, smoothingToCutoff } from "./filters.js";

const L_WRIST = 15, R_WRIST = 16, L_HIP = 23, R_HIP = 24;

export class Tracker {
  /**
   * video: het <video>-element voor het camerabeeld.
   * on: { result(capture), status(state, detail), stats(stats) }
   */
  constructor(video, on = {}) {
    this.video = video;
    this.on = on;
    this.cfg = { engine: "holistic", quality: "full", hands: true, face: false, delegate: "GPU", useWorker: true };
    this.stream = null;
    this.worker = null;
    this.engine = null;
    this.mode = null;            // "worker" of "main"
    this.ready = false;
    this.busy = false;
    this.busySince = 0;
    this.paused = false;
    this.lastTs = 0;
    this.stallLimit = { first: 45000, next: 15000 };   // ms zonder antwoord voordat we ingrijpen
    this.smoothing = 5;
    this.filters = { pose: new OneEuroFilter(), L: new OneEuroFilter(), R: new OneEuroFilter() };
    this.setSmoothing(5);
    this.stats = { camera: 0, tracking: 0, ms: 0, mode: "", delegate: "" };
    this._count = { camera: 0, tracking: 0, since: performance.now() };
    this._frameLoop = this._frameLoop.bind(this);
  }

  get cameraOn() { return !!this.stream; }

  setSmoothing(level) {
    this.smoothing = level;
    const c = smoothingToCutoff(level);
    for (const f of Object.values(this.filters)) f.minCutoff = c;
  }

  // --- camera --------------------------------------------------------------

  async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "videoinput");
  }

  async startCamera(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Deze browser geeft geen toegang tot de camera. Open de pagina via https of http://localhost.");
    }
    this.stopCamera();
    const video = { width: { ideal: CAMERA.width }, height: { ideal: CAMERA.height }, frameRate: { ideal: CAMERA.frameRate } };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = "user";
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    this._scheduleFrame();
    const track = this.stream.getVideoTracks()[0];
    return { label: track?.label || "camera", settings: track?.getSettings?.() || {} };
  }

  stopCamera() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.busy = false;
    for (const f of Object.values(this.filters)) f.reset();
  }

  // --- motor -----------------------------------------------------------------

  _engineConfig() {
    return { bundle: MEDIAPIPE.bundle, wasm: MEDIAPIPE.wasm, models: MODELS, engine: this.cfg.engine,
             quality: this.cfg.quality, hands: this.cfg.hands, face: this.cfg.face, delegate: this.cfg.delegate };
  }

  /** Start de motor, of stelt hem opnieuw in als er iets verandert. */
  async configure(partial = {}) {
    const before = JSON.stringify(this.cfg);
    Object.assign(this.cfg, partial);
    const changed = JSON.stringify(this.cfg) !== before;
    if (this.mode && !changed) return;
    // Lukte de worker eerder niet (oude browser), dan blijven we op de hoofdthread.
    const wantMode = this.cfg.useWorker && !this._workerFailed ? "worker" : "main";
    this.ready = false;
    this.on.status?.("loading", "Herkenning laden (de eerste keer worden de modellen gedownload)");
    try {
      if (this.mode !== wantMode) {
        this._disposeEngine();
        if (wantMode === "worker") {
          try { await this._startWorker(); } catch (err) {
            console.warn("Bodycap: de worker start niet, ik gebruik de hoofdthread.", err);
            this._workerFailed = true;
            this._disposeEngine();
            await this._startMain();
          }
        } else {
          await this._startMain();
        }
      } else if (this.mode === "worker") {
        await this._workerCall({ type: "configure", cfg: this._engineConfig() });
      } else {
        this._info = await this.engine.configure({ ...this._engineConfig(), useModule: false });
      }
      this.ready = true;
      this.busy = false;
      this._gotResult = false;
      this.stats.mode = this.mode === "worker" ? "aparte thread" : "hoofdthread";
      this.stats.delegate = this._info?.delegate || "";
      this.on.status?.("ready", this._info);
    } catch (err) {
      this.on.status?.("error", String(err?.message || err));
      throw err;
    }
  }

  async _startMain() {
    this.engine = new Engine();
    await this.engine.init({ ...this._engineConfig(), useModule: false });
    this._info = this.engine.info;
    this.mode = "main";
  }

  async _startWorker() {
    if (typeof Worker === "undefined" || typeof createImageBitmap === "undefined") throw new Error("geen worker-ondersteuning");
    this.worker = new Worker(new URL("./tracker-worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => this._onWorkerMessage(e.data);
    this.worker.onerror = (e) => { this._pending?.reject(new Error(e.message || "worker-fout")); this._pending = null; };
    await this._workerCall({ type: "init", cfg: this._engineConfig() });
    this.mode = "worker";
  }

  _workerCall(msg) {
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this.worker.postMessage(msg);
    });
  }

  _onWorkerMessage(msg) {
    if (msg.type === "ready") { this._info = msg.info; this._pending?.resolve(msg.info); this._pending = null; }
    else if (msg.type === "result") this._handle(msg.result);
    else if (msg.type === "skipped") this.busy = false;
    else if (msg.type === "error") {
      this.busy = false;
      if (this._pending) { this._pending.reject(new Error(msg.message)); this._pending = null; }
      else this.on.status?.("error", msg.message);
    }
  }

  _disposeEngine() {
    this.worker?.terminate();
    this.worker = null;
    this.engine?.close();
    this.engine = null;
    this.mode = null;
  }

  // --- beelden ---------------------------------------------------------------

  _scheduleFrame() {
    if (!this.stream) return;
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(this._frameLoop);
    else requestAnimationFrame(this._frameLoop);
  }

  _frameLoop() {
    if (!this.stream) return;
    this._scheduleFrame();
    // zonder requestVideoFrameCallback: alleen doorgaan bij een nieuw camerabeeld
    if (!this.video.requestVideoFrameCallback) {
      if (this.video.currentTime === this._lastVideoTime) return;
      this._lastVideoTime = this.video.currentTime;
    }
    this._count.camera++;
    this._updateStats();
    if (!this.ready || this.paused || this.video.readyState < 2 || document.hidden) return;
    const now = performance.now();
    if (this.busy) {
      // Herkenning is nog bezig: dit beeld overslaan. Blijft een antwoord te lang uit
      // (het eerste beeld mag langer duren: dan warmt het model op), dan grijpen we in.
      if (now - this.busySince > (this._gotResult ? this.stallLimit.next : this.stallLimit.first)) this._onStall();
      return;
    }
    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    if (this.mode === "worker") {
      this.busy = true;
      this.busySince = now;
      createImageBitmap(this.video).then(
        (bitmap) => this.worker?.postMessage({ type: "frame", bitmap, ts }, [bitmap]),
        () => { this.busy = false; });
    } else if (this.engine) {
      try {
        const t0 = performance.now();
        const result = this.engine.detect(this.video, ts);
        result.ms = performance.now() - t0;
        result.ts = ts;
        this._handle(result);
      } catch (err) {
        this.on.status?.("error", String(err?.message || err));
      }
    }
  }

  /** De herkenning geeft geen antwoord meer. In een worker: verder op de hoofdthread. */
  async _onStall() {
    if (this._recovering) return;
    this._recovering = true;
    try {
      if (this.mode === "worker") {
        console.warn("Bodycap: de worker antwoordt niet, ik ga verder op de hoofdthread.");
        this._workerFailed = true;
        this.ready = false;
        this._disposeEngine();
        this.on.status?.("loading", "De aparte thread reageert niet; herkenning opnieuw starten op de hoofdthread");
        await this._startMain();
        this.ready = true;
        this.stats.mode = "hoofdthread";
        this.stats.delegate = this._info?.delegate || "";
        this.on.status?.("ready", this._info);
        this.on.fallback?.("main");
      }
    } catch (err) {
      this.on.status?.("error", String(err?.message || err));
    } finally {
      this.busy = false;
      this._gotResult = false;
      this._recovering = false;
    }
  }

  _updateStats() {
    const now = performance.now(), dt = now - this._count.since;
    if (dt < 1000) return;
    this.stats.camera = (this._count.camera * 1000) / dt;
    this.stats.tracking = (this._count.tracking * 1000) / dt;
    this._count = { camera: 0, tracking: 0, since: now };
    this.on.stats?.(this.stats);
  }

  /** Ruwe motoruitvoer -> gefilterde capture met de handen aan de juiste kant. */
  _handle(result) {
    this.busy = false;
    this._gotResult = true;
    this._count.tracking++;
    this.stats.ms += (result.ms - this.stats.ms) * 0.2;
    const t = result.ts / 1000;
    const capture = { ts: result.ts, pose: null, hands: { L: null, R: null }, hip2d: null, face: result.face || null,
                      faceNorm: result.faceNorm || null };
    if (result.pose) {
      this.filters.pose.apply(result.pose.world, t);
      capture.pose = result.pose;
      const n = result.pose.norm;
      capture.hip2d = [(n[L_HIP * 3] + n[R_HIP * 3]) / 2, (n[L_HIP * 3 + 1] + n[R_HIP * 3 + 1]) / 2];
    } else {
      this.filters.pose.reset();
    }
    assignHands(capture, result.hands);
    for (const s of ["L", "R"]) {
      if (capture.hands[s]) this.filters[s].apply(capture.hands[s].world, t);
      else this.filters[s].reset();
    }
    this.on.result?.(capture);
  }

  dispose() {
    this.stopCamera();
    this._disposeEngine();
  }
}

/**
 * Koppelt elke gevonden hand aan de dichtstbijzijnde pols van het lichaam. Zo maakt
 * het niet uit of het model met 'links' de linkerhand van de persoon bedoelt of de
 * linkerkant van het beeld.
 */
export function assignHands(capture, hands) {
  if (!hands?.length) return;
  if (!capture.pose) {
    hands.slice(0, 2).forEach((h, i) => { capture.hands[h.label || (i === 0 ? "L" : "R")] = h; });
    return;
  }
  const n = capture.pose.norm;
  const wrist = { L: [n[L_WRIST * 3], n[L_WRIST * 3 + 1]], R: [n[R_WRIST * 3], n[R_WRIST * 3 + 1]] };
  const options = [];
  hands.forEach((h, i) => {
    for (const s of ["L", "R"]) options.push({ d: Math.hypot(h.norm[0] - wrist[s][0], h.norm[1] - wrist[s][1]), i, s });
  });
  options.sort((a, b) => a.d - b.d);
  const usedHand = new Set(), usedSide = new Set();
  for (const o of options) {
    if (usedHand.has(o.i) || usedSide.has(o.s)) continue;
    capture.hands[o.s] = hands[o.i];
    usedHand.add(o.i); usedSide.add(o.s);
  }
}
