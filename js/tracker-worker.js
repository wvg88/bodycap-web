// Web worker: draait MediaPipe los van de hoofdthread, zodat het skelet soepel blijft
// bewegen terwijl de herkenning rekent.

import { Engine, transferables } from "./engine.js";

const engine = new Engine();
let ready = false;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      await engine.init({ ...msg.cfg, useModule: true });
      ready = true;
      self.postMessage({ type: "ready", info: engine.info });
    } else if (msg.type === "configure") {
      ready = false;
      const info = await engine.configure({ ...msg.cfg, useModule: true });
      ready = true;
      self.postMessage({ type: "ready", info });
    } else if (msg.type === "frame") {
      if (!ready) { msg.bitmap.close(); self.postMessage({ type: "skipped" }); return; }
      const t0 = performance.now();
      const result = engine.detect(msg.bitmap, msg.ts);
      msg.bitmap.close();
      result.ms = performance.now() - t0;
      result.ts = msg.ts;
      self.postMessage({ type: "result", result }, transferables(result));
    }
  } catch (err) {
    if (msg.bitmap) { try { msg.bitmap.close(); } catch { /* al vrijgegeven */ } }
    self.postMessage({ type: "error", stage: msg.type, message: String(err?.message || err) });
  }
};
