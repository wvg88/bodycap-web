// One Euro-filter (Casiez e.a., 2012): weinig trillen bij stilstand, weinig vertraging
// bij snelle bewegingen. Werkt op een Float32Array van willekeurige lengte.

/** Smoothing 1 (snel, onrustig) .. 9 (rustig, iets trager) -> afsnijfrequentie in Hz. */
export function smoothingToCutoff(level) {
  const l = Math.max(1, Math.min(9, Math.round(level)));
  return 0.25 * Math.pow(1.5, 9 - l);
}

export class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.8, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() { this.x = null; this.dx = null; this.t = 0; }

  /** Filtert 'values' ter plekke. t in seconden. */
  apply(values, t) {
    const n = values.length;
    if (!this.x || this.x.length !== n) {
      this.x = Float32Array.from(values);
      this.dx = new Float32Array(n);
      this.t = t;
      return values;
    }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const aD = alpha(dt, this.dCutoff);
    for (let i = 0; i < n; i++) {
      const d = (values[i] - this.x[i]) / dt;
      const dHat = this.dx[i] + aD * (d - this.dx[i]);
      const a = alpha(dt, this.minCutoff + this.beta * Math.abs(dHat));
      const xHat = this.x[i] + a * (values[i] - this.x[i]);
      this.dx[i] = dHat;
      this.x[i] = xHat;
      values[i] = xHat;
    }
    return values;
  }
}

function alpha(dt, cutoff) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
