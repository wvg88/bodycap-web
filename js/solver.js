// Bodycap Web: van MediaPipe-punten naar botstanden.
//
// Opzet:
//   1. Rig.analyse: botten koppelen aan lichaamsdelen ("rollen") en de rustpose opmeten.
//   2. Rig.solve(capture): per rol een doelrotatie uitrekenen (in wereldruimte, als
//      draaiing ten opzichte van de rustpose). Armen en benen met inverse kinematics.
//   3. Rig.animate(dt): elke rendering soepel naar het doel toe bewegen en de
//      wereldmatrix van elk bot rechtstreeks schrijven.
//
// Omdat wereldmatrices rechtstreeks worden geschreven, maakt de bothiërarchie in het
// .glb-bestand niet uit: ook een Rigify-export waarin de vervormende botten aan
// hulpbotten hangen (waarvan de constraints in glTF niet bestaan) werkt.

import * as THREE from "three";

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Q = () => new THREE.Quaternion();

export const SIDES = ["L", "R"];
export const SIDE_NL = { L: "links", R: "rechts" };
export const FINGERS = ["thumb", "index", "middle", "ring", "pinky"];
const FINGER_NL = { thumb: "Duim", index: "Wijsvinger", middle: "Middelvinger", ring: "Ringvinger", pinky: "Pink" };
const FINGER_LM = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };

// MediaPipe-lichaamspunten
const P = {
  L: { sh: 11, el: 13, wr: 15, pinky: 17, index: 19, hip: 23, knee: 25, ankle: 27, toe: 31, ear: 7 },
  R: { sh: 12, el: 14, wr: 16, pinky: 18, index: 20, hip: 24, knee: 26, ankle: 28, toe: 32, ear: 8 },
};
const NOSE = 0;
const POSE_MIRROR = Array.from({ length: 33 }, (_, i) => i);
for (const [a, b] of [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]]) {
  POSE_MIRROR[a] = b; POSE_MIRROR[b] = a;
}

// ---------------------------------------------------------------------------
// Rollen
// ---------------------------------------------------------------------------

function buildRoles() {
  const roles = [
    { id: "hips", label: "Heupen", group: "torso", parent: null },
    { id: "spine", label: "Rug (midden)", group: "torso", parent: "hips" },
    { id: "chest", label: "Borst", group: "torso", parent: "spine" },
    { id: "neck", label: "Nek", group: "head", parent: "chest" },
    { id: "head", label: "Hoofd", group: "head", parent: "neck" },
  ];
  for (const s of SIDES) {
    const n = SIDE_NL[s];
    roles.push(
      { id: `shoulder_${s}`, label: `Schouder ${n}`, group: "arms", parent: "chest", passive: true },
      { id: `upper_arm_${s}`, label: `Bovenarm ${n}`, group: "arms", parent: `shoulder_${s}` },
      { id: `forearm_${s}`, label: `Onderarm ${n}`, group: "arms", parent: `upper_arm_${s}` },
      { id: `hand_${s}`, label: `Hand ${n}`, group: "arms", parent: `forearm_${s}` },
    );
    for (const f of FINGERS) {
      for (let k = 1; k <= 3; k++) {
        roles.push({ id: `${f}_${k}_${s}`, label: `${FINGER_NL[f]} ${k} ${n}`, group: "fingers", parent: k === 1 ? `hand_${s}` : `${f}_${k - 1}_${s}` });
      }
    }
    roles.push(
      { id: `thigh_${s}`, label: `Bovenbeen ${n}`, group: "legs", parent: "hips" },
      { id: `shin_${s}`, label: `Onderbeen ${n}`, group: "legs", parent: `thigh_${s}` },
      { id: `foot_${s}`, label: `Voet ${n}`, group: "legs", parent: `shin_${s}` },
      { id: `toe_${s}`, label: `Tenen ${n}`, group: "legs", parent: `foot_${s}`, passive: true },
    );
  }
  return roles;
}

export const ROLES = buildRoles();
const ROLE_BY_ID = Object.fromEntries(ROLES.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
// Botnamen herkennen
// ---------------------------------------------------------------------------

/** "DEF-upper_arm.01.L" -> "defupperarm01l" (three.js haalt zelf ook al punten uit namen). */
export function normName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Elke naamgeving geeft per rol een lijst: eerste bot = het hoofdbot (draaipunt),
// de rest zijn segmenten of botten die star meebewegen (zoals handpalmbotten).
const CONVENTIONS = [
  {
    id: "rigify-oud", label: "Rigify (DEF-botten, oud type)",
    names(role, s) {
      const core = { hips: ["defhips"], spine: ["defspine"], chest: ["defchest"], neck: ["defneck"], head: ["defhead"] };
      if (core[role]) return core[role];
      const m = role.match(/^(thumb|index|middle|ring|pinky)_(\d)$/);
      if (m) {
        const f = m[1] === "thumb" ? "thumb" : `f${m[1]}`;
        return m[2] === "1" ? [`def${f}01${s}01`, `def${f}01${s}02`] : [`def${f}0${m[2]}${s}`];
      }
      return {
        shoulder: [`defshoulder${s}`], upper_arm: [`defupperarm01${s}`, `defupperarm02${s}`],
        forearm: [`defforearm01${s}`, `defforearm02${s}`],
        hand: [`defhand${s}`, `defpalm01${s}`, `defpalm02${s}`, `defpalm03${s}`, `defpalm04${s}`],
        thigh: [`defthigh01${s}`, `defthigh02${s}`], shin: [`defshin01${s}`, `defshin02${s}`],
        foot: [`deffoot${s}`], toe: [`deftoe${s}`],
      }[role] || [];
    },
  },
  ...["def", "", "org"].map((p) => ({
    id: `rigify${p ? "-" + p : "-meta"}`, label: p === "def" ? "Rigify (DEF-botten)" : p === "org" ? "Rigify (ORG-botten)" : "Metarig (spine.001 ...)",
    names(role, s) {
      const core = { hips: [`${p}spine`], spine: [`${p}spine001`, `${p}spine002`], chest: [`${p}spine003`], neck: [`${p}spine004`, `${p}spine005`], head: [`${p}spine006`] };
      if (core[role]) return core[role];
      const m = role.match(/^(thumb|index|middle|ring|pinky)_(\d)$/);
      if (m) return [`${p}${m[1] === "thumb" ? "thumb" : "f" + m[1]}0${m[2]}${s}`];
      return {
        shoulder: [`${p}shoulder${s}`], upper_arm: [`${p}upperarm${s}`, `${p}upperarm${s}001`],
        forearm: [`${p}forearm${s}`, `${p}forearm${s}001`],
        hand: [`${p}hand${s}`, `${p}palm01${s}`, `${p}palm02${s}`, `${p}palm03${s}`, `${p}palm04${s}`],
        thigh: [`${p}thigh${s}`, `${p}thigh${s}001`], shin: [`${p}shin${s}`, `${p}shin${s}001`],
        foot: [`${p}foot${s}`], toe: [`${p}toe${s}`],
      }[role] || [];
    },
  })),
  {
    id: "eenvoudig", label: "Eenvoudig skelet (hips, chest, upper_arm.L ...)",
    names(role, s) {
      const core = { hips: ["hips", "pelvis"], spine: ["spine"], chest: ["chest"], neck: ["neck"], head: ["head"] };
      if (core[role]) return core[role];
      const m = role.match(/^(thumb|index|middle|ring|pinky)_(\d)$/);
      if (m) return [`${m[1] === "thumb" ? "thumb" : "f" + m[1]}0${m[2]}${s}`];
      return {
        shoulder: [`shoulder${s}`], upper_arm: [`upperarm${s}`], forearm: [`forearm${s}`],
        hand: [`hand${s}`, `palm01${s}`, `palm02${s}`, `palm03${s}`, `palm04${s}`],
        thigh: [`thigh${s}`], shin: [`shin${s}`], foot: [`foot${s}`], toe: [`toe${s}`],
      }[role] || [];
    },
  },
  {
    id: "mixamo", label: "Mixamo", stripPrefix: /^mixamorig\d*/,
    names(role, s) {
      const S = s === "l" ? "left" : "right";
      const core = { hips: ["hips"], spine: ["spine", "spine1"], chest: ["spine2"], neck: ["neck"], head: ["head"] };
      if (core[role]) return core[role];
      const m = role.match(/^(thumb|index|middle|ring|pinky)_(\d)$/);
      if (m) return [`${S}hand${m[1]}${m[2]}`];
      return {
        shoulder: [`${S}shoulder`], upper_arm: [`${S}arm`], forearm: [`${S}forearm`], hand: [`${S}hand`],
        thigh: [`${S}upleg`], shin: [`${S}leg`], foot: [`${S}foot`], toe: [`${S}toebase`],
      }[role] || [];
    },
  },
];

/** Zoekt de naamgeving die de meeste rollen koppelt. Geeft { convention, map: {rol: [botten]} }. */
export function autoMap(bones) {
  let best = null;
  for (const conv of CONVENTIONS) {
    const lookup = new Map();
    for (const b of bones) {
      let n = normName(b.userData?.name || b.name);
      if (conv.stripPrefix) n = n.replace(conv.stripPrefix, "");
      if (!lookup.has(n)) lookup.set(n, b);
    }
    const map = {};
    let count = 0;
    for (const role of ROLES) {
      const m = role.id.match(/^(.*)_([LR])$/);
      const base = m ? m[1] : role.id;
      const s = m ? m[2].toLowerCase() : "";
      const found = conv.names(base, s).map((n) => lookup.get(n)).filter(Boolean);
      // het hoofdbot moet bestaan; alleen segmenten zonder hoofdbot tellen niet
      const primary = lookup.get(conv.names(base, s)[0]) || (base === "hips" ? found[0] : null);
      if (primary) { map[role.id] = [primary, ...found.filter((b) => b !== primary)]; count++; }
    }
    if (!best || count > best.count) best = { convention: conv, map, count };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Wiskunde
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();

/** Rotatie waarvan de kolommen (zijkant, boven, voor) zijn. */
function quatFromBasis(s, u, f) {
  return Q().setFromRotationMatrix(_m4.makeBasis(s, u, f));
}

/** Assenstelsel met 'boven' leidend. */
function frameFrom(side, up) {
  const u = up.clone();
  if (u.lengthSq() < 1e-12) return null;
  u.normalize();
  const s = side.clone().addScaledVector(u, -side.dot(u));
  if (s.lengthSq() < 1e-12) return null;
  s.normalize();
  return quatFromBasis(s, u, V().crossVectors(s, u));
}

/** Assenstelsel met 'zijkant' leidend (bekken: draaien en zijwaarts kantelen). */
function sideFrame(side, upHint) {
  const s = side.clone();
  if (s.lengthSq() < 1e-12) return null;
  s.normalize();
  const u = upHint.clone().addScaledVector(s, -upHint.dot(s));
  if (u.lengthSq() < 1e-12) return null;
  u.normalize();
  return quatFromBasis(s, u, V().crossVectors(s, u));
}

/** Hoofd: oren geven de zijkant, de neus de voorkant. */
function headFrame(side, forward) {
  const s = side.clone();
  if (s.lengthSq() < 1e-12) return null;
  s.normalize();
  const f = forward.clone().addScaledVector(s, -forward.dot(s));
  if (f.lengthSq() < 1e-12) return null;
  f.normalize();
  return quatFromBasis(s, V().crossVectors(f, s), f);
}

/** Kortste draai die de (met de ouder meegedraaide) rustrichting op het doel zet. */
function swing(parentQ, restDir, target) {
  if (target.lengthSq() < 1e-12) return null;
  const cur = restDir.clone().applyQuaternion(parentQ).normalize();
  return Q().setFromUnitVectors(cur, target.clone().normalize()).multiply(parentQ);
}

function bendWeight(u, f) {
  const deg = THREE.MathUtils.radToDeg(u.angleTo(f));
  return THREE.MathUtils.clamp((deg - 5) / 10, 0, 1);
}

/** Draait q om de eigen bot-as zodat elleboog of knie de goede kant op buigt. */
function hingeTwist(q, restNormal, u, f) {
  if (u.lengthSq() < 1e-12 || f.lengthSq() < 1e-12) return q;
  const w = bendWeight(u, f);
  if (w <= 0) return q;
  const axis = u.clone().normalize();
  const a = restNormal.clone().applyQuaternion(q);
  a.addScaledVector(axis, -a.dot(axis));
  const b = V().crossVectors(u, f);
  b.addScaledVector(axis, -b.dot(axis));
  if (a.lengthSq() < 1e-12 || b.lengthSq() < 1e-12) return q;
  const ang = Math.atan2(axis.dot(V().crossVectors(a, b)), a.dot(b));
  return Q().setFromAxisAngle(axis, ang * w).multiply(q);
}

/**
 * Inverse kinematics voor twee botten (bovenarm+onderarm of bovenbeen+onderbeen).
 * target: vector van het begin (schouder/heup) naar het einddoel (pols/enkel), al in modelmaat.
 * pole: richting waarin het scharnier (elleboog/knie) moet uitwijken.
 * Geeft { upper, lower }: de richtingen van de twee botten.
 */
export function twoBoneIK(target, pole, lenUpper, lenLower) {
  const maxReach = (lenUpper + lenLower) * 0.9995;
  const minReach = Math.abs(lenUpper - lenLower) * 1.0005 + 1e-6;
  let d = target.length();
  if (d < 1e-9) return null;
  const dir = target.clone().divideScalar(d);
  d = THREE.MathUtils.clamp(d, minReach, maxReach);
  // cosinusregel: hoek bij het begin
  const cosA = THREE.MathUtils.clamp((lenUpper * lenUpper + d * d - lenLower * lenLower) / (2 * lenUpper * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const perp = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-10) return null;
  perp.normalize();
  const joint = dir.clone().multiplyScalar(lenUpper * cosA).addScaledVector(perp, lenUpper * sinA);
  const end = dir.clone().multiplyScalar(d);
  return { upper: joint, lower: end.sub(joint) };
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

export const DEFAULT_SOLVER_SETTINGS = {
  torso: true, head: true, arms: true, fingers: true, legs: true,
  location: false, locationScale: 1.5, ground: true, ik: true, mirror: true, visibility: 0.5,
};

export class Rig {
  /** bones: alle botten van het model (skeleton.bones van alle SkinnedMeshes samen). */
  constructor(bones) {
    this.bones = bones;
    this.roles = new Map();        // id -> rolgegevens
    this.order = [];               // gekoppelde rollen in hiërarchievolgorde
    this.boneInfo = [];            // per bot: eigenaar-rol en rustmatrix
    this.warnings = [];
    this.cal = { G: Q(), head: null, hips: null, base2d: null, done: false };
    this.rootOffset = V();         // huidige verplaatsing van het hele lichaam
    this.rootOffsetT = V();        // doel
    this.scale = { torso: 1, armL: 1, armR: 1, legL: 1, legR: 1 };
    this._scaleInit = {};
    // Rustpose één keer vastleggen, vóórdat wij de botten gaan besturen
    this._rest = new Map();
    for (const b of bones) { b.updateWorldMatrix(true, false); this._rest.set(b, b.matrixWorld.clone()); }
    this.auto = autoMap(bones);
    this.setMapping(this.auto.map);
  }

  get conventionLabel() { return this.auto.convention.label; }
  get mappedCount() { return this.order.length; }

  /** map: {rol: [botten]} (eerste bot = hoofdbot). Meet daarna de rustpose op. */
  setMapping(map) {
    this.map = map;
    this.roles.clear();
    this.order = [];
    this.warnings = [];

    const rest = (b) => this._rest.get(b);

    const effParent = (id) => {
      let p = ROLE_BY_ID[id].parent;
      while (p && !map[p]) p = ROLE_BY_ID[p].parent;
      return p;
    };
    for (const def of ROLES) {
      const list = map[def.id];
      if (!list || !list.length) continue;
      const pivotRest = V().setFromMatrixPosition(rest(list[0]));
      const restQuat = Q().setFromRotationMatrix(_m4.extractRotation(rest(list[0])));
      this.roles.set(def.id, {
        id: def.id, def, bones: list, parent: effParent(def.id), pivotRest, restQuat,
        qc: Q(), qt: Q(), rel: Q(), pivotNow: pivotRest.clone(), driven: false,
        twist: 0, twistT: 0, twistAxis: V(0, 1, 0),
      });
      this.order.push(def.id);
    }

    // Elk bot krijgt een eigenaar: de rol waarmee het star meebeweegt
    const owner = new Map();
    for (const [id, r] of this.roles) r.bones.forEach((b, i) => owner.set(b, { role: r, seg: i }));
    this.boneInfo = this.bones.map((bone) => {
      let o = owner.get(bone);
      if (!o) {
        let p = bone.parent;
        while (p && !owner.has(p)) p = p.parent;
        o = p ? { role: owner.get(p).role, seg: 0, inherited: true } : { role: null, seg: 0 };
      }
      return { bone, role: o.role, seg: o.inherited ? 0 : o.seg, restWorld: rest(bone).clone() };
    });
    for (const info of this.boneInfo) {
      // Vanaf nu schrijven wij de wereldmatrix zelf; three.js moet er vanaf blijven.
      info.bone.matrixAutoUpdate = false;
      info.bone.matrixWorldAutoUpdate = false;
    }

    this._measure();
    return this;
  }

  _pivot(id) { const r = this.roles.get(id); return r ? r.pivotRest : null; }

  /** Rustposities van gewrichten en de rust-assenstelsels van het model. */
  _measure() {
    const g = (this.geom = { seg: {}, hinge: {}, len: {} });
    const piv = (id) => this._pivot(id);
    const sh = { L: piv("upper_arm_L"), R: piv("upper_arm_R") };
    const hip = { L: piv("thigh_L"), R: piv("thigh_R") };
    let side = sh.L && sh.R ? sh.L.clone().sub(sh.R) : hip.L && hip.R ? hip.L.clone().sub(hip.R) : null;
    if (!side) { side = V(1, 0, 0); this.warnings.push("Geen armen of benen gekoppeld; ik neem aan dat het model naar voren (+Z) kijkt."); }
    const shMid = sh.L && sh.R ? sh.L.clone().add(sh.R).multiplyScalar(0.5) : null;
    const hipMid = hip.L && hip.R ? hip.L.clone().add(hip.R).multiplyScalar(0.5) : piv("hips");
    let up = shMid && hipMid ? shMid.clone().sub(hipMid) : piv("head") && piv("hips") ? piv("head").clone().sub(piv("hips")) : V(0, 1, 0);
    if (up.lengthSq() < 1e-9) up = V(0, 1, 0);
    g.M = frameFrom(side, up) || Q();
    g.left = V(1, 0, 0).applyQuaternion(g.M);
    g.up = V(0, 1, 0).applyQuaternion(g.M);
    g.fwd = V(0, 0, 1).applyQuaternion(g.M);
    g.shMid = shMid; g.hipMid = hipMid;
    g.shoulderWidth = sh.L && sh.R ? sh.L.distanceTo(sh.R) : 0.36;
    g.height = up.length() * 3.2;

    g.restHips = hip.L && hip.R ? sideFrame(hip.L.clone().sub(hip.R), g.up) : g.M.clone();
    g.chestPivot = piv("chest") || piv("spine") || hipMid;
    g.restChest = sh.L && sh.R && g.chestPivot ? frameFrom(sh.L.clone().sub(sh.R), shMid.clone().sub(g.chestPivot)) || g.M.clone() : g.M.clone();

    const boneY = (id) => V(0, 1, 0).applyQuaternion(this.roles.get(id).restQuat);
    for (const s of SIDES) {
      const a = piv(`upper_arm_${s}`), e = piv(`forearm_${s}`), w = piv(`hand_${s}`);
      if (a && e) g.seg[`upper_arm_${s}`] = e.clone().sub(a);
      if (e && w) g.seg[`forearm_${s}`] = w.clone().sub(e);
      if (a && e && w) {
        g.hinge[`upper_arm_${s}`] = restHinge(g.seg[`upper_arm_${s}`], g.seg[`forearm_${s}`], g.fwd);
        g.len[`arm_${s}`] = [a.distanceTo(e), e.distanceTo(w)];
      }
      const h = piv(`thigh_${s}`), k = piv(`shin_${s}`), n = piv(`foot_${s}`), t = piv(`toe_${s}`);
      if (h && k) g.seg[`thigh_${s}`] = k.clone().sub(h);
      if (k && n) g.seg[`shin_${s}`] = n.clone().sub(k);
      if (h && k && n) {
        g.hinge[`thigh_${s}`] = restHinge(g.seg[`thigh_${s}`], g.seg[`shin_${s}`], g.fwd.clone().negate());
        g.len[`leg_${s}`] = [h.distanceTo(k), k.distanceTo(n)];
      }
      if (n) {
        // Voet: van enkel naar de teenpunt (MediaPipe's 'foot index' ligt bij de teenpunt)
        if (t) g.seg[`foot_${s}`] = t.clone().addScaledVector(boneY(`toe_${s}`), 0.45 * t.distanceTo(n)).sub(n);
        else g.seg[`foot_${s}`] = boneY(`foot_${s}`);
      }
      // Hand: pols -> middelvinger, en wijsvinger - pink
      const idx = piv(`index_1_${s}`), mid = piv(`middle_1_${s}`), pnk = piv(`pinky_1_${s}`);
      if (w && idx && pnk) {
        const centre = mid || idx.clone().add(pnk).multiplyScalar(0.5);
        g[`restHand_${s}`] = frameFrom(idx.clone().sub(pnk), centre.clone().sub(w));
        g[`restHandPose_${s}`] = frameFrom(idx.clone().sub(pnk), idx.clone().add(pnk).multiplyScalar(0.5).sub(w));
      }
      if (w) g.seg[`hand_${s}`] = mid ? mid.clone().sub(w) : boneY(`hand_${s}`);
      for (const f of FINGERS) {
        for (let k2 = 1; k2 <= 3; k2++) {
          const id = `${f}_${k2}_${s}`;
          if (!this.roles.has(id)) continue;
          const next = k2 < 3 ? piv(`${f}_${k2 + 1}_${s}`) : null;
          g.seg[id] = next ? next.clone().sub(piv(id)) : boneY(id);
        }
      }
    }
    g.restLowest = this._lowestFootHeight(() => IDENT);
  }

  /** De punten waarmee het model op de vloer staat (enkels, tenen, teenpunten), bij de gegeven rotaties. */
  _lowestFootHeight(quatOf) {
    const g = this.geom, pos = new Map();
    const pivot = (id) => {
      if (pos.has(id)) return pos.get(id);
      const r = this.roles.get(id);
      let p;
      if (r.parent) {
        const pr = this.roles.get(r.parent);
        p = r.pivotRest.clone().sub(pr.pivotRest).applyQuaternion(quatOf(pr)).add(pivot(r.parent));
      } else p = r.pivotRest.clone();
      pos.set(id, p);
      return p;
    };
    let lowest = Infinity;
    for (const s of SIDES) {
      for (const id of [`foot_${s}`, `toe_${s}`]) {
        if (this.roles.has(id)) lowest = Math.min(lowest, pivot(id).dot(g.up));
      }
      const foot = this.roles.get(`foot_${s}`);
      if (foot && g.seg[`foot_${s}`]) {
        lowest = Math.min(lowest, pivot(`foot_${s}`).clone().add(g.seg[`foot_${s}`].clone().applyQuaternion(quatOf(foot))).dot(g.up));
      }
    }
    return lowest;
  }

  // --- kalibratie ------------------------------------------------------

  clearCalibration() { this.cal = { G: Q(), head: null, hips: null, base2d: null, done: false }; }

  /** Leg vast hoe 'recht staan' eruitziet (corrigeert een scheve, hoge of lage camera). */
  calibrate(capture, settings) {
    const c = this._canonical(capture, settings.mirror);
    if (!c) return false;
    const T = frameFrom(c[P.L.sh].clone().sub(c[P.R.sh]),
      c[P.L.sh].clone().add(c[P.R.sh]).multiplyScalar(0.5).sub(c[P.L.hip].clone().add(c[P.R.hip]).multiplyScalar(0.5)));
    if (!T) return false;
    this.cal = { G: T.invert(), head: null, hips: null, base2d: null, done: true };
    const raw = this._frameTargets(this._points(capture, settings), false);
    this.cal.head = raw.head || null;
    this.cal.hips = raw.hips || null;
    this.cal.base2d = capture.hip2d ? [...capture.hip2d] : null;
    return true;
  }

  // --- punten omzetten --------------------------------------------------

  /** MediaPipe (x rechts, y omlaag, z van de camera af) -> (links, boven, voor) van de persoon. */
  _canonical(capture, mirror) {
    const w = capture.pose?.world;
    if (!w) return null;
    const out = new Array(33);
    for (let i = 0; i < 33; i++) {
      const j = (mirror ? POSE_MIRROR[i] : i) * 3;
      out[i] = V(mirror ? -w[j] : w[j], -w[j + 1], -w[j + 2]);
    }
    return out;
  }

  _points(capture, settings) {
    const A = this.geom.M.clone().multiply(this.cal.G);
    const mirror = settings.mirror;
    const pts = this._canonical(capture, mirror);
    let vis = null;
    if (pts) {
      for (const p of pts) p.applyQuaternion(A);
      vis = new Float32Array(33);
      const n = capture.pose.norm;
      for (let i = 0; i < 33; i++) vis[i] = n[(mirror ? POSE_MIRROR[i] : i) * 3 + 2];
    }
    const hands = {};
    for (const s of SIDES) {
      const src = capture.hands?.[mirror ? (s === "L" ? "R" : "L") : s]?.world;
      if (!src) continue;
      const h = new Array(21);
      for (let i = 0; i < 21; i++) h[i] = V(mirror ? -src[i * 3] : src[i * 3], -src[i * 3 + 1], -src[i * 3 + 2]).applyQuaternion(A);
      hands[s] = h;
    }
    const thr = settings.visibility;
    const ok = (...idx) => !!pts && idx.every((i) => vis[i] >= thr);
    return { pts, vis, hands, ok };
  }

  /** Absolute doelrotaties voor romp, hoofd en handen. */
  _frameTargets(pp, useCorrections = true) {
    const g = this.geom, { pts, hands, ok } = pp, out = {};
    if (pts) {
      const L = P.L, R = P.R;
      const hipMid = pts[L.hip].clone().add(pts[R.hip]).multiplyScalar(0.5);
      const shMid = pts[L.sh].clone().add(pts[R.sh]).multiplyScalar(0.5);
      if (ok(L.hip, R.hip)) {
        const T = sideFrame(pts[L.hip].clone().sub(pts[R.hip]), g.up);
        if (T) {
          const q = T.multiply(g.restHips.clone().invert());
          if (useCorrections && this.cal.hips) q.multiply(this.cal.hips.clone().invert());
          out.hips = q;
        }
      }
      if (ok(L.sh, R.sh) && g.shMid && g.hipMid) {
        // Maat van de persoon -> maat van het model (rustig bijgehouden). De schouderbreedte
        // is de maatstaf: die verandert niet als je buigt, de romplengte wel.
        const width = pts[L.sh].distanceTo(pts[R.sh]);
        if (width > 0.05) this._ema("torso", g.shoulderWidth / width);
        const qh = out.hips || this.roles.get("hips")?.qt || Q();
        // waar het draaipunt van de borst nu ligt, gezien vanaf het midden van de heupen
        let qc = qh;
        // (de rug buigt mee met de borst, dus dit wordt in een paar stappen benaderd)
        for (let pass = 0; pass < 5; pass++) {
          const spineP = this._pivot("spine");
          const offset = V();
          if (spineP && this.roles.has("chest")) {
            offset.copy(spineP).sub(g.hipMid).applyQuaternion(qh);
            offset.add(g.chestPivot.clone().sub(spineP).applyQuaternion(qh.clone().slerp(qc, 0.5)));
          } else {
            offset.copy(g.chestPivot).sub(g.hipMid).applyQuaternion(qh);
          }
          const upVec = shMid.clone().sub(hipMid).multiplyScalar(this.scale.torso).sub(offset);
          const T = frameFrom(pts[L.sh].clone().sub(pts[R.sh]), upVec);
          if (!T) break;
          qc = T.multiply(g.restChest.clone().invert());
        }
        out.chest = qc;
      }
      if (ok(L.ear, R.ear, NOSE)) {
        const earMid = pts[L.ear].clone().add(pts[R.ear]).multiplyScalar(0.5);
        const T = headFrame(pts[L.ear].clone().sub(pts[R.ear]), pts[NOSE].clone().sub(earMid));
        if (T) {
          const q = T.multiply(g.M.clone().invert());
          if (useCorrections && this.cal.head) q.multiply(this.cal.head.clone().invert());
          out.head = q;
        }
      }
      if (out.hips && out.chest) out.spine = out.hips.clone().slerp(out.chest, 0.5);
      else if (out.chest) out.spine = (this.roles.get("hips")?.qt || Q()).clone().slerp(out.chest, 0.5);
      if (out.chest && out.head) out.neck = out.chest.clone().slerp(out.head, 0.5);
    }
    for (const s of SIDES) {
      const p = P[s];
      if (hands[s] && g[`restHand_${s}`]) {
        const h = hands[s];
        const T = frameFrom(h[5].clone().sub(h[17]), h[9].clone().sub(h[0]));
        if (T) out[`hand_${s}`] = T.multiply(g[`restHand_${s}`].clone().invert());
      } else if (ok(p.wr, p.index, p.pinky) && g[`restHandPose_${s}`]) {
        const T = frameFrom(pts[p.index].clone().sub(pts[p.pinky]),
          pts[p.index].clone().add(pts[p.pinky]).multiplyScalar(0.5).sub(pts[p.wr]));
        if (T) out[`hand_${s}`] = T.multiply(g[`restHandPose_${s}`].clone().invert());
      }
    }
    return out;
  }

  _ema(key, value, alpha = 0.06) {
    if (!Number.isFinite(value) || value <= 0) return;
    if (!this._scaleInit[key]) { this.scale[key] = value; this._scaleInit[key] = true; }
    else this.scale[key] += (value - this.scale[key]) * alpha;
  }

  // --- oplossen ---------------------------------------------------------

  /** Rekent uit de meting de doelrotaties uit. */
  solve(capture, settings) {
    const g = this.geom;
    const pp = this._points(capture, settings);
    const targets = this._frameTargets(pp);
    const { pts, hands, ok } = pp;
    const limbs = {};

    // Armen en benen: richtingen van boven- en onderbot, via IK of rechtstreeks
    if (pts) {
      for (const s of SIDES) {
        const p = P[s];
        limbs[`arm_${s}`] = this._limb(settings.ik, g.len[`arm_${s}`], `arm${s}`, pts, ok, p.sh, p.el, p.wr);
        limbs[`leg_${s}`] = this._limb(settings.ik, g.len[`leg_${s}`], `leg${s}`, pts, ok, p.hip, p.knee, p.ankle);
      }
    }

    for (const id of this.order) {
      const r = this.roles.get(id);
      const pq = r.parent ? this.roles.get(r.parent).qt : IDENT;
      const enabled = settings[r.def.group] !== false;
      let q = null;
      if (enabled && !r.def.passive) q = this._solveRole(id, pq, targets, limbs, pts, hands, ok);
      if (q) { r.qt.copy(q); r.driven = true; }
      else r.qt.copy(pq).multiply(r.rel);      // geen data: stand ten opzichte van de ouder vasthouden
      r.rel.copy(pq).invert().multiply(r.qt);
    }

    // Onderarm: de helft van de polsdraaiing meegeven aan het tweede segment (spaakbeen/ellepijp)
    for (const s of SIDES) {
      const fore = this.roles.get(`forearm_${s}`), hand = this.roles.get(`hand_${s}`);
      if (!fore || !hand || fore.bones.length < 2 || !g.seg[`forearm_${s}`]) continue;
      const axis = g.seg[`forearm_${s}`].clone().applyQuaternion(fore.qt).normalize();
      const rel = hand.qt.clone().multiply(fore.qt.clone().invert());
      let ang = 2 * Math.atan2(rel.x * axis.x + rel.y * axis.y + rel.z * axis.z, rel.w);
      if (ang > Math.PI) ang -= 2 * Math.PI; else if (ang < -Math.PI) ang += 2 * Math.PI;
      fore.twistT = THREE.MathUtils.clamp(ang * 0.5, -1.2, 1.2);
      fore.twistAxis.copy(axis);
    }

    // Verplaatsing van het hele lichaam
    const legsSeen = SIDES.some((s) => ok(P[s].hip, P[s].knee, P[s].ankle));
    let sideways = this._sideways || 0, vertical = this._vertical || 0;
    if (settings.location && capture.hip2d && ok(P.L.hip, P.R.hip)) {
      if (!this.cal.base2d) this.cal.base2d = [...capture.hip2d];
      const k = settings.locationScale * (g.height / 1.75);
      const dx = capture.hip2d[0] - this.cal.base2d[0], dy = capture.hip2d[1] - this.cal.base2d[1];
      sideways = (settings.mirror ? -dx : dx) * k;
      vertical = -dy * k;
    } else if (!settings.location) {
      sideways = vertical = 0;
    }
    // Voeten op de vloer: het lichaam zakt of rijst zo dat de laagste voet de vloer raakt
    // (bijvoorbeeld bij spreiden of door de knieën gaan). Gaat boven de gemeten hoogte.
    if (settings.ground && settings.legs && Number.isFinite(g.restLowest)) {
      if (legsSeen) this._ground = g.restLowest - this._lowestFootHeight((r) => r.qt);
      vertical = this._ground || 0;
    } else {
      this._ground = 0;
    }
    this._sideways = sideways; this._vertical = vertical;
    this.rootOffsetT.set(0, 0, 0).addScaledVector(g.left, sideways).addScaledVector(g.up, vertical);
  }

  /** Richtingen (in modelruimte) voor een arm of been. */
  _limb(useIK, lengths, scaleKey, pts, ok, a, b, c) {
    if (!lengths || !ok(a, b)) return null;
    const u = pts[b].clone().sub(pts[a]);
    if (!ok(c)) return { upper: u, lower: null };
    const f = pts[c].clone().sub(pts[b]);
    const person = u.length() + f.length();
    if (person > 0.05) this._ema(scaleKey, (lengths[0] + lengths[1]) / person);
    if (!useIK) return { upper: u, lower: f };
    // IK: het uiteinde (pols/enkel) bepaalt de pose, de elleboog/knie alleen de buigrichting
    const target = pts[c].clone().sub(pts[a]).multiplyScalar(this.scale[scaleKey]);
    const solved = twoBoneIK(target, u, lengths[0], lengths[1]);
    return solved || { upper: u, lower: f };
  }

  _solveRole(id, pq, targets, limbs, pts, hands, ok) {
    if (targets[id]) return targets[id];
    const g = this.geom, seg = g.seg[id];
    const m = id.match(/^(.*)_([LR])$/);
    if (!m || !seg) return null;
    const [, name, s] = m;
    const p = P[s];
    if (name === "upper_arm" || name === "thigh") {
      const limb = limbs[(name === "upper_arm" ? "arm_" : "leg_") + s];
      if (!limb) return null;
      let q = swing(pq, seg, limb.upper);
      if (q && limb.lower && g.hinge[id]) q = hingeTwist(q, g.hinge[id], limb.upper, limb.lower);
      return q;
    }
    if (name === "forearm" || name === "shin") {
      const limb = limbs[(name === "forearm" ? "arm_" : "leg_") + s];
      return limb && limb.lower ? swing(pq, seg, limb.lower) : null;
    }
    if (name === "hand") return hands[s] ? swing(pq, seg, hands[s][9].clone().sub(hands[s][0])) : null;
    if (name === "foot") return ok(p.ankle, p.toe) ? swing(pq, seg, pts[p.toe].clone().sub(pts[p.ankle])) : null;
    const fm = name.match(/^(thumb|index|middle|ring|pinky)_(\d)$/);
    if (fm && hands[s]) {
      const lm = FINGER_LM[fm[1]], k = +fm[2], h = hands[s];
      return swing(pq, seg, h[lm[k]].clone().sub(h[lm[k - 1]]));
    }
    return null;
  }

  // --- animeren en schrijven ---------------------------------------------

  restPose() {
    for (const r of this.roles.values()) { r.qt.identity(); r.rel.identity(); r.twistT = 0; }
    this.rootOffsetT.set(0, 0, 0);
    this._ground = this._sideways = this._vertical = 0;
  }

  /** Beweegt soepel naar het doel en schrijft de botten. tau: tijdconstante in seconden (0 = direct). */
  animate(dt, tau = 0.045) {
    const a = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    for (const id of this.order) {
      const r = this.roles.get(id);
      r.qc.slerp(r.qt, a);
      r.twist += (r.twistT - r.twist) * a;
    }
    this.rootOffset.lerp(this.rootOffsetT, a);
    this.write();
  }

  /** Voorwaartse kinematica op de huidige rotaties, daarna wereldmatrices schrijven. */
  write() {
    for (const id of this.order) {
      const r = this.roles.get(id);
      if (r.parent) {
        const pr = this.roles.get(r.parent);
        r.pivotNow.copy(r.pivotRest).sub(pr.pivotRest).applyQuaternion(pr.qc).add(pr.pivotNow);
      } else {
        r.pivotNow.copy(r.pivotRest).add(this.rootOffset);
      }
    }
    for (const info of this.boneInfo) {
      const r = info.role, out = info.bone.matrixWorld;
      if (!r) {
        out.copy(info.restWorld);
        out.elements[12] += this.rootOffset.x; out.elements[13] += this.rootOffset.y; out.elements[14] += this.rootOffset.z;
        continue;
      }
      // wereld = T(draaipunt nu) · R(q) · T(-draaipunt rust) · rustmatrix
      if (info.seg > 0 && r.twist !== 0) _q.setFromAxisAngle(r.twistAxis, r.twist).multiply(r.qc);
      else _q.copy(r.qc);
      _v.copy(r.pivotRest).applyQuaternion(_q).negate().add(r.pivotNow);
      _mA.compose(_v, _q, ONE);
      out.multiplyMatrices(_mA, info.restWorld);
    }
  }

  /** Wereldpositie van het draaipunt van een rol (na write). */
  jointPosition(id) { return this.roles.get(id)?.pivotNow.clone() || null; }

  // --- momentopnames (voor opnemen en afspelen) -----------------------------

  get snapshotSize() { return 3 + this.order.length * 5; }

  snapshot(out = new Float32Array(this.snapshotSize)) {
    out[0] = this.rootOffset.x; out[1] = this.rootOffset.y; out[2] = this.rootOffset.z;
    let k = 3;
    for (const id of this.order) {
      const r = this.roles.get(id);
      out[k++] = r.qc.x; out[k++] = r.qc.y; out[k++] = r.qc.z; out[k++] = r.qc.w; out[k++] = r.twist;
    }
    return out;
  }

  /** Zet een momentopname (of een mengsel van twee) op het model. */
  applySnapshot(a, b = null, t = 0) {
    this.rootOffset.set(a[0], a[1], a[2]);
    if (b) this.rootOffset.lerp(_v.set(b[0], b[1], b[2]), t);
    let k = 3;
    for (const id of this.order) {
      const r = this.roles.get(id);
      r.qc.set(a[k], a[k + 1], a[k + 2], a[k + 3]);
      r.twist = a[k + 4];
      if (b) {
        r.qc.slerp(_q.set(b[k], b[k + 1], b[k + 2], b[k + 3]), t);
        r.twist += (b[k + 4] - r.twist) * t;
      }
      r.qt.copy(r.qc); r.twistT = r.twist;
      k += 5;
    }
    this.rootOffsetT.copy(this.rootOffset);
    this.write();
  }

  /** Lokale positie/rotatie van elk bot bij de huidige pose (voor export als animatie). */
  localTransforms() {
    return this.boneInfo.map((info) => {
      const parent = info.bone.parent;
      _mA.copy(parent ? parent.matrixWorld : IDENT_M).invert().multiply(info.bone.matrixWorld);
      const pos = V(), quat = Q(), scl = V();
      _mA.decompose(pos, quat, scl);
      return { bone: info.bone, pos, quat };
    });
  }

  /** Geeft three.js de regie over de botten terug (bij het wisselen van model). */
  release() {
    for (const info of this.boneInfo) {
      info.bone.matrixAutoUpdate = true;
      info.bone.matrixWorldAutoUpdate = true;
      info.bone.matrixWorldNeedsUpdate = true;
    }
  }
}

const IDENT = new THREE.Quaternion();
const IDENT_M = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _mA = new THREE.Matrix4();

/** Normaal van het buigvlak in rust; bij een gestrekte rustpose de natuurlijke buigrichting. */
function restHinge(u, f, natural) {
  if (u.lengthSq() > 1e-12 && f.lengthSq() > 1e-12 && THREE.MathUtils.radToDeg(u.angleTo(f)) > 8) {
    return V().crossVectors(u, f).normalize();
  }
  return V().crossVectors(u, natural).normalize();
}
