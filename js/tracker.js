// Camera + herkenning. Stuurt camerabeelden naar de MediaPipe-motor, filtert de punten
// en geeft per herkend beeld één 'capture' door.
//
// De herkenning draait bij voorkeur in een pool van web workers (aparte threads). Elk
// camerabeeld gaat naar een vrije thread. Eén beeld herkennen duurt even lang, maar met
// meerdere threads komen er meer resultaten per seconde uit: op de processor (CPU) werken
// ze op verschillende rekenkernen. Lukt een worker niet, dan draait alles op de hoofdthread.

import { MEDIAPIPE, MODELS, CAMERA } from "./config.js";
import { Engine } from "./engine.js";
import { OneEuroFilter, smoothingToCutoff } from "./filters.js";

const L_WRIST = 15, R_WRIST = 16, L_HIP = 23, R_HIP = 24;

/** Hoeveel threads bij 'automatisch'. Op de processor: alle kernen op twee na (max. 4). */
export function autoThreads(delegate) {
  const cores = navigator.hardwareConcurrency || 4;
  return delegate === "CPU" ? Math.max(1, Math.min(4, cores - 2)) : 2;
}

export class Tracker {
  /**
   * video: het <video>-element voor het camerabeeld.
   * on: { result(capture), status(state, detail), stats(stats), fallback(mode) }
   */
  constructor(video, on = {}) {
    this.video = video;
    this.on = on;
    this.cfg = { engine: "holistic", quality: "full", hands: true, face: false, delegate: "GPU",
                 useWorker: true, threads: "auto" };
    this.stream = null;
    this.pool = [];              // [{ worker, ready, busy, busySince, gotResult, pending }]
    this.engine = null;          // motor op de hoofdthread (als er geen workers zijn)
    this.mode = null;            // "worker" of "main"
    this.ready = false;
    this.paused = false;
    this.lastTs = 0;             // tijdstempel van het laatst verstuurde beeld
    this.lastApplied = 0;        // tijdstempel van het laatst verwerkte resultaat
    this.lastDispatch = 0;
    this.stallLimit = { first: 45000, next: 15000 };   // ms zonder antwoord voordat we ingrijpen
    this.smoothing = 5;
    this.filters = { pose: new OneEuroFilter(), L: new OneEuroFilter(), R: new OneEuroFilter() };
    this.setSmoothing(5);
    this.stats = { camera: 0, tracking: 0, ms: 0, mode: "", delegate: "", threads: 0, wantedThreads: 0, dropped: 0 };
    this._count = { camera: 0, tracking: 0, since: performance.now() };
    this._buffers = new Map();   // modeladres -> Promise<ArrayBuffer>
    this._generation = 0;        // telt elke herstart; threads van een oude start doen niet meer mee
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
    for (const w of this.pool) w.busy = false;
    for (const f of Object.values(this.filters)) f.reset();
  }

  // --- motor -----------------------------------------------------------------

  _engineConfig() {
    return { bundle: MEDIAPIPE.bundle, wasm: MEDIAPIPE.wasm, models: MODELS, engine: this.cfg.engine,
             quality: this.cfg.quality, hands: this.cfg.hands, face: this.cfg.face, delegate: this.cfg.delegate };
  }

  /** Het aantal threads dat we willen (0 = hoofdthread). */
  _wantedThreads() {
    if (!this.cfg.useWorker || this._workerFailed) return 0;
    const n = this.cfg.threads === "auto" ? autoThreads(this.cfg.delegate) : parseInt(this.cfg.threads, 10);
    return Math.max(1, Math.min(8, n || 1));
  }

  /** Welke modellen er nodig zijn: sleutels uit MODELS. */
  _modelKeys() {
    if (this.cfg.engine === "holistic") return ["holistic"];
    const pose = MODELS[`pose_${this.cfg.quality}`] ? `pose_${this.cfg.quality}` : "pose_full";
    return this.cfg.hands ? [pose, "hand"] : [pose];
  }

  /** Download de modellen één keer, in plaats van één keer per thread. */
  async _modelBuffers() {
    const out = {};
    for (const key of this._modelKeys()) {
      const url = MODELS[key];
      if (!this._buffers.has(url)) {
        this._buffers.set(url, fetch(url).then((r) => {
          if (!r.ok) throw new Error(`model niet gevonden (${r.status})`);
          return r.arrayBuffer();
        }));
      }
      try { out[key] = await this._buffers.get(url); } catch (err) {
        this._buffers.delete(url);   // MediaPipe haalt het dan zelf op, via het adres
        console.warn("Bodycap: model vooraf downloaden lukte niet", err);
      }
    }
    return out;
  }

  /** De motorinstellingen met een eigen kopie van de modelbytes. */
  _withBuffers(buffers) {
    const copy = {};
    for (const [k, b] of Object.entries(buffers)) copy[k] = new Uint8Array(b.slice(0));
    return { ...this._engineConfig(), buffers: copy };
  }

  /** Start de motor, of stelt hem opnieuw in als er iets verandert. */
  async configure(partial = {}) {
    const engineBefore = JSON.stringify(this._engineConfig());
    Object.assign(this.cfg, partial);
    const engineChanged = JSON.stringify(this._engineConfig()) !== engineBefore;
    const wanted = this._wantedThreads();
    const wantMode = wanted > 0 ? "worker" : "main";
    const sameMode = this.mode === wantMode;
    if (sameMode && !engineChanged && (wantMode === "main" || this.pool.length === wanted)) return;

    this.ready = false;
    this.on.status?.("loading", "Herkenning laden (de eerste keer wordt het model gedownload)");
    try {
      const buffers = await this._modelBuffers();
      if (!sameMode || engineChanged) {
        this._disposeEngine();
        if (wantMode === "worker") {
          try {
            await this._startPool(wanted, buffers);
          } catch (err) {
            console.warn("Bodycap: de herkenningsthread start niet, ik gebruik de hoofdthread.", err);
            this._workerFailed = true;
            this._disposeEngine();
            await this._startMain(buffers);
          }
        } else {
          await this._startMain(buffers);
        }
      } else {
        this._resizePool(wanted, buffers);   // alleen het aantal threads is veranderd
      }
      this.ready = true;
      this.lastApplied = 0;
      this._updateModeStats();
      this.on.status?.("ready", this._info);
    } catch (err) {
      this.on.status?.("error", String(err?.message || err));
      throw err;
    }
  }

  async _startMain(buffers) {
    this.engine = new Engine();
    await this.engine.init({ ...this._withBuffers(buffers), useModule: false });
    this._info = this.engine.info;
    this.mode = "main";
  }

  /** Eerste thread starten en daarop wachten; de rest sluit aan zodra ze klaar zijn. */
  async _startPool(n, buffers) {
    if (typeof Worker === "undefined" || typeof createImageBitmap === "undefined") throw new Error("geen worker-ondersteuning");
    this.mode = "worker";
    const gen = this._generation;
    await this._initWorker(this._addWorker(), buffers);
    if (gen === this._generation) this._resizePool(n, buffers);
  }

  /** Threads toevoegen of weghalen tot er n zijn. Nieuwe threads starten op de achtergrond. */
  _resizePool(n, buffers) {
    while (this.pool.length > n) this.pool.pop().worker.terminate();
    const gen = this._generation;
    while (this.pool.length < n) {
      const w = this._addWorker();
      this._initWorker(w, buffers).then(
        () => { if (gen === this._generation) this._updateModeStats(); },
        (err) => {
          if (gen !== this._generation) return;
          console.warn("Bodycap: een extra herkenningsthread start niet", err);
          this._removeWorker(w);
        });
    }
    this._updateModeStats();
  }

  _addWorker() {
    const w = { worker: new Worker(new URL("./tracker-worker.js", import.meta.url), { type: "module" }),
                ready: false, busy: false, busySince: 0, gotResult: false, pending: null };
    w.worker.onmessage = (e) => this._onWorkerMessage(w, e.data);
    w.worker.onerror = (e) => {
      if (w.pending) { w.pending.reject(new Error(e.message || "worker-fout")); w.pending = null; }
      else this._removeWorker(w);
    };
    this.pool.push(w);
    return w;
  }

  async _initWorker(w, buffers) {
    const cfg = this._withBuffers(buffers);
    const transfer = Object.values(cfg.buffers).map((b) => b.buffer);
    await new Promise((resolve, reject) => {
      w.pending = { resolve, reject };
      w.worker.postMessage({ type: "init", cfg }, transfer);
    });
    w.ready = true;
  }

  _removeWorker(w) {
    try { w.worker.terminate(); } catch { /* al gestopt */ }
    this.pool = this.pool.filter((x) => x !== w);
    this._updateModeStats();
  }

  _onWorkerMessage(w, msg) {
    if (msg.type === "ready") {
      if (!this._info || this.pool[0] === w) this._info = msg.info;
      w.pending?.resolve(msg.info);
      w.pending = null;
    } else if (msg.type === "result") {
      w.busy = false;
      w.gotResult = true;
      this._accept(msg.result);
    } else if (msg.type === "skipped") {
      w.busy = false;
    } else if (msg.type === "error") {
      w.busy = false;
      if (w.pending) { w.pending.reject(new Error(msg.message)); w.pending = null; }
      else this.on.status?.("error", msg.message);
    }
  }

  _disposeEngine() {
    this._generation++;
    for (const w of this.pool) {
      try { w.worker.terminate(); } catch { /* al gestopt */ }
      w.pending?.reject(new Error("gestopt"));
    }
    this.pool = [];
    this.engine?.close();
    this.engine = null;
    this.mode = null;
    this._info = null;
  }

  _updateModeStats() {
    this.stats.threads = this.mode === "worker" ? this.pool.filter((w) => w.ready).length : 0;
    this.stats.wantedThreads = this.mode === "worker" ? this.pool.length : 0;
    this.stats.mode = this.mode === "worker" ? "aparte thread" : "hoofdthread";
    this.stats.delegate = this._info?.delegate || "";
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

    if (this.mode === "worker") {
      // Threads die te lang niet antwoorden, vallen af (de eerste keer mag langer: dan warmt het model op).
      for (const w of [...this.pool]) {
        if (w.busy && now - w.busySince > (w.gotResult ? this.stallLimit.next : this.stallLimit.first)) this._onStall(w);
      }
      const free = this.pool.find((w) => w.ready && !w.busy);
      if (!free) return;
      // Beelden gelijkmatig over de tijd verdelen: niet twee threads vlak na elkaar laten beginnen.
      const active = this.pool.filter((w) => w.ready).length;
      if (active > 1 && this.stats.ms > 0 && now - this.lastDispatch < (this.stats.ms / active) * 0.85) return;
      const ts = Math.max(now, this.lastTs + 1);
      this.lastTs = ts;
      this.lastDispatch = now;
      free.busy = true;
      free.busySince = now;
      createImageBitmap(this.video).then(
        (bitmap) => free.worker.postMessage({ type: "frame", bitmap, ts }, [bitmap]),
        () => { free.busy = false; });
    } else if (this.engine) {
      const ts = Math.max(now, this.lastTs + 1);
      this.lastTs = ts;
      try {
        const t0 = performance.now();
        const result = this.engine.detect(this.video, ts);
        result.ms = performance.now() - t0;
        result.ts = ts;
        this._accept(result);
      } catch (err) {
        this.on.status?.("error", String(err?.message || err));
      }
    }
  }

  /** Een thread antwoordt niet meer: weghalen. Is er geen enkele over, dan verder op de hoofdthread. */
  async _onStall(w) {
    console.warn("Bodycap: een herkenningsthread antwoordt niet en wordt gestopt.");
    this._removeWorker(w);
    if (this.pool.length > 0 || this._recovering) return;
    this._recovering = true;
    try {
      this._workerFailed = true;
      this.ready = false;
      this._disposeEngine();
      this.on.status?.("loading", "De aparte thread reageert niet; herkenning opnieuw starten op de hoofdthread");
      await this._startMain(await this._modelBuffers());
      this.ready = true;
      this._updateModeStats();
      this.on.status?.("ready", this._info);
      this.on.fallback?.("main");
    } catch (err) {
      this.on.status?.("error", String(err?.message || err));
    } finally {
      this._recovering = false;
    }
  }

  _updateStats() {
    const now = performance.now(), dt = now - this._count.since;
    if (dt < 1000) return;
    this.stats.camera = (this._count.camera * 1000) / dt;
    this.stats.tracking = (this._count.tracking * 1000) / dt;
    this._count = { camera: 0, tracking: 0, since: now };
    this._updateModeStats();
    this.on.stats?.(this.stats);
  }

  /** Resultaten van verschillende threads kunnen door elkaar binnenkomen: alleen nieuwere gebruiken. */
  _accept(result) {
    this.stats.ms += (result.ms - this.stats.ms) * 0.2;
    if (result.ts <= this.lastApplied) { this.stats.dropped++; return; }
    this.lastApplied = result.ts;
    this._handle(result);
  }

  /** Ruwe motoruitvoer -> gefilterde capture met de handen aan de juiste kant. */
  _handle(result) {
    this._count.tracking++;
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
