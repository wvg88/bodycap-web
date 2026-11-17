// Opnemen, afspelen en exporteren. Een opname is een reeks momentopnames van de rig
// (zie Rig.snapshot). Exporteren maakt er een .glb met animatie van, die je in Blender
// of een andere 3D-app kunt importeren.

import * as THREE from "three";

export class Recorder {
  constructor() {
    this.clear();
    this.recording = false;
    this.playing = false;
    this.playTime = 0;
    this.fps = 30;
  }

  clear() {
    this.times = [];
    this.frames = [];
    this.playing = false;
  }

  get duration() { return this.times.length ? this.times[this.times.length - 1] : 0; }
  get hasData() { return this.frames.length > 1; }

  start() {
    this.clear();
    this.recording = true;
    this._t0 = performance.now();
    this._next = 0;
  }

  stop() { this.recording = false; }

  /** Aanroepen in de renderlus; neemt op met hooguit this.fps beelden per seconde. */
  capture(rig) {
    if (!this.recording) return;
    const t = (performance.now() - this._t0) / 1000;
    if (t < this._next) return;
    this._next = t + 1 / this.fps - 0.002;
    this.times.push(t);
    this.frames.push(rig.snapshot());
  }

  play() { if (this.hasData) { this.playing = true; this.playTime = 0; } }
  stopPlayback() { this.playing = false; }

  /** Speelt de opname af (in een lus). Geeft false terug als er niets speelt. */
  advance(rig, dt) {
    if (!this.playing || !this.hasData) return false;
    this.playTime = (this.playTime + dt) % this.duration;
    this.applyAt(rig, this.playTime);
    return true;
  }

  applyAt(rig, t) {
    const times = this.times;
    let lo = 0, hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    const span = times[hi] - times[lo];
    rig.applySnapshot(this.frames[lo], this.frames[hi], span > 0 ? (t - times[lo]) / span : 0);
  }

  /** Bouwt een AnimationClip met per bot de lokale rotatie (en positie waar die verandert). */
  buildClip(rig, name = "Bodycap-opname") {
    const n = this.frames.length;
    const times = Float32Array.from(this.times);
    let tracks = null;
    for (let i = 0; i < n; i++) {
      rig.applySnapshot(this.frames[i]);
      const locals = rig.localTransforms();
      if (!tracks) {
        tracks = locals.map((l) => ({ bone: l.bone, quat: new Float32Array(n * 4), pos: new Float32Array(n * 3), prev: null }));
      }
      locals.forEach((l, b) => {
        const tr = tracks[b];
        // dezelfde 'kant' van de quaternion aanhouden, anders maakt de interpolatie een omweg
        if (tr.prev && tr.prev.dot(l.quat) < 0) l.quat.set(-l.quat.x, -l.quat.y, -l.quat.z, -l.quat.w);
        tr.prev = l.quat;
        l.quat.toArray(tr.quat, i * 4);
        l.pos.toArray(tr.pos, i * 3);
      });
    }
    const out = [];
    for (const tr of tracks) {
      // Sporen verwijzen naar het bot via zijn uuid: botnamen met punten (DEF-upper_arm.01.L)
      // zouden anders als pad worden gelezen.
      out.push(new THREE.QuaternionKeyframeTrack(`${tr.bone.uuid}.quaternion`, times, tr.quat));
      let moves = false;
      for (let i = 3; i < tr.pos.length && !moves; i++) moves = Math.abs(tr.pos[i] - tr.pos[i % 3]) > 1e-5;
      if (moves) out.push(new THREE.VectorKeyframeTrack(`${tr.bone.uuid}.position`, times, tr.pos));
    }
    return new THREE.AnimationClip(name, this.duration, out);
  }

  /** Exporteert het model met de opname als .glb (ArrayBuffer). */
  async exportGLB(rig, modelRoot) {
    const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
    const keep = rig.snapshot();
    const clip = this.buildClip(rig);
    rig.applySnapshot(keep);
    // three.js haalt bij het laden de punten uit botnamen. Voor de export zetten we de
    // oorspronkelijke namen terug, zodat de animatie in Blender bij de rig past.
    const renamed = rig.bones.map((b) => [b, b.name]);
    for (const [b] of renamed) if (b.userData?.name) b.name = b.userData.name;
    try {
      return await new GLTFExporter().parseAsync(modelRoot, { binary: true, trs: true, animations: [clip], onlyVisible: false });
    } finally {
      for (const [b, name] of renamed) b.name = name;
    }
  }
}
