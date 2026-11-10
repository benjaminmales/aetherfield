/**
 * position.js — rough position from the RSSI several gateways report for the
 * same device.
 *
 * ---------------------------------------------------------------------------
 * Read this before showing anyone a dot on a map
 * ---------------------------------------------------------------------------
 *
 * RSSI is a bad ruler. The model below assumes signal falls off smoothly with
 * distance; in a real venue it is mangled by bodies (a human is mostly water
 * and eats 2.4 GHz), by metal, by the device's orientation, and by multipath
 * that can make a nearer gateway report a weaker signal than a further one.
 *
 * Realistic expectations, with good gateway geometry:
 *   3+ gateways, clear space   ~2-5 m
 *   3+ gateways, crowded room  ~5-15 m
 *   2 gateways                 a region, not a point
 *   1 gateway                  a circle around that gateway, nothing more
 *
 * So: this is zone-level. "North bar area" is defensible; "table 14" is not.
 * Every estimate carries a radius for exactly this reason, and the UI draws
 * the radius rather than a pinpoint, because a dot on a map is a promise of
 * precision this cannot keep.
 *
 * The honest use is aggregate: where is the crowd, which zones are filling,
 * is the north side dark. Those are robust to per-device error in a way that
 * "where is Alex" is not.
 */

/** Free-ish-space defaults for 802.15.4 at 2.4 GHz and AURA_TX_POWER_DBM = 8. */
const DEFAULT_MODEL = {
  // RSSI a gateway reports for a device one metre away. Theory says about
  // -32 dBm; chip antennas, enclosures and bodies make -40 to -45 typical.
  // CALIBRATE THIS: put one device exactly 1 m from a gateway, read the RSSI,
  // put the number here. It shifts every distance estimate, so it is the
  // single highest-value measurement you can make before a test.
  refRssi: -42,
  // Path loss exponent. 2.0 free space, ~2.7 a room with people in it, 3.5+
  // obstructed. The second most valuable thing to calibrate: put a device at
  // 1 m and at 10 m and solve for n.
  pathLossExp: 2.7,
  // Distances beyond this are treated as "far" rather than trusted.
  maxDistance: 120,
};

/** Log-distance path loss, inverted. Returns metres. */
function rssiToDistance(rssi, model = {}) {
  const m = { ...DEFAULT_MODEL, ...model };
  if (!Number.isFinite(rssi)) return null;
  const d = Math.pow(10, (m.refRssi - rssi) / (10 * m.pathLossExp));
  return Math.min(Math.max(d, 0.1), m.maxDistance);
}

/** The inverse, for tests and for generating synthetic fixtures. */
function distanceToRssi(d, model = {}) {
  const m = { ...DEFAULT_MODEL, ...model };
  return m.refRssi - 10 * m.pathLossExp * Math.log10(Math.max(d, 0.1));
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Weighted centroid: sum of gateway positions weighted by 1/d^p.
 *
 * Always lands inside the convex hull of the gateways that heard the device.
 * That is a real limitation — it cannot place anything outside the gateway
 * ring — and also a useful safety property: it has no failure mode, never
 * diverges, and degrades smoothly to "at the nearest gateway" as the geometry
 * gets worse. It is the seed for the refinement below and the fallback when
 * refinement is not justified.
 */
function weightedCentroid(obs, p = 1.5) {
  let sx = 0, sy = 0, sw = 0;
  for (const o of obs) {
    const w = 1 / Math.pow(Math.max(o.d, 0.1), p);
    sx += o.gw.x * w;
    sy += o.gw.y * w;
    sw += w;
  }
  if (sw === 0) return null;
  return { x: sx / sw, y: sy / sw };
}

/**
 * Gauss-Newton least squares on the distance residuals, seeded from the
 * centroid.
 *
 * Damped and iteration-capped on purpose. Trilateration on noisy RSSI is
 * happy to run away to infinity when the circles do not intersect — which,
 * with real RSSI, is most of the time. A bounded, damped solve that improves
 * the centroid a little and never diverges is worth more here than a
 * mathematically pure one that occasionally puts a guest in the car park.
 */
function refine(seed, obs, { iterations = 12, damping = 0.6, bounds = null } = {}) {
  let p = { ...seed };

  for (let it = 0; it < iterations; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;

    for (const o of obs) {
      const dx = p.x - o.gw.x;
      const dy = p.y - o.gw.y;
      const r = Math.hypot(dx, dy) || 1e-6;
      const res = r - o.d;
      const jx = dx / r;
      const jy = dy / r;
      const w = o.w ?? 1;

      g0 += w * jx * res;
      g1 += w * jy * res;
      h00 += w * jx * jx;
      h01 += w * jx * jy;
      h11 += w * jy * jy;
    }

    // Levenberg-style ridge keeps the 2x2 invertible when gateways are
    // collinear — which they will be, because event gateways get hung along
    // walls.
    const lambda = 1e-6 + 0.01 * (h00 + h11);
    const a = h00 + lambda, b = h01, c = h01, d = h11 + lambda;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;

    const stepX = (d * g0 - b * g1) / det;
    const stepY = (-c * g0 + a * g1) / det;
    if (!Number.isFinite(stepX) || !Number.isFinite(stepY)) break;

    p = { x: p.x - damping * stepX, y: p.y - damping * stepY };

    if (bounds) {
      p.x = Math.min(Math.max(p.x, bounds.minX), bounds.maxX);
      p.y = Math.min(Math.max(p.y, bounds.minY), bounds.maxY);
    }
    if (Math.hypot(stepX, stepY) < 0.01) break;
  }
  return p;
}

/**
 * Estimate a position.
 *
 * @param {Array} observations [{gw: 'gw-01', rssi: -62}, ...]
 * @param {object} gatewayPositions {'gw-01': {x, y}, ...} in metres
 * @param {object} [opts] {model, bounds}
 * @returns {null | {x, y, r, n, method, gateways}}
 *          r is a confidence RADIUS in metres, not an error bar on a point.
 */
function estimate(observations, gatewayPositions, opts = {}) {
  const model = { ...DEFAULT_MODEL, ...(opts.model || {}) };

  const obs = [];
  for (const o of observations || []) {
    const gw = gatewayPositions[o.gw];
    if (!gw || !Number.isFinite(gw.x) || !Number.isFinite(gw.y)) continue;
    const rssi = Number.isFinite(o.rssiAvg) ? o.rssiAvg : o.rssi;
    const d = rssiToDistance(rssi, model);
    if (d === null) continue;
    // Near gateways are far more trustworthy than distant ones: the same 3 dB
    // of noise is a metre at close range and twenty at the far end.
    obs.push({ gw, d, rssi, w: 1 / Math.max(d, 1), id: o.gw });
  }

  if (obs.length === 0) return null;
  const ids = obs.map((o) => o.id);

  if (obs.length === 1) {
    // One gateway gives a circle, and pretending otherwise is the single
    // easiest way to mislead someone with this feature. Report the gateway's
    // own position with the estimated distance as the radius, and let the map
    // draw something honestly enormous.
    return {
      x: obs[0].gw.x, y: obs[0].gw.y,
      r: Math.round(obs[0].d * 10) / 10,
      n: 1, method: "single-gateway", gateways: ids,
    };
  }

  const seed = weightedCentroid(obs);
  if (!seed) return null;

  const p = obs.length >= 3
    ? refine(seed, obs, { bounds: opts.bounds })
    : seed;

  /*
   * The confidence radius.
   *
   * Residual RMS alone is badly optimistic — measured against synthetic
   * geometry it contained the true position only ~40% of the time, because
   * it measures how well the distances agree with each other, not how far
   * the answer is from the truth. Four gateways can agree beautifully on the
   * wrong point.
   *
   * Two terms, because there are two sources of error:
   *   rms   - how much the measurements disagree, which tracks noise
   *   dmin  - distance to the NEAREST gateway, which bounds what is knowable.
   *           RSSI error is multiplicative: sigma dB becomes a distance
   *           factor of 10^(sigma/10n), so uncertainty scales with range. If
   *           the closest gateway is 30 m away, no amount of arithmetic
   *           locates anyone to 3 m.
   *
   * Coefficients calibrated against synthetic geometry across 3-14 dB of
   * noise; the stated radius then contains the true position 78-93% of the
   * time, and grows honestly as conditions worsen rather than staying
   * reassuringly small. See the coverage test.
   */
  let sq = 0;
  let dmin = Infinity;
  for (const o of obs) {
    const r = dist(p, o.gw) - o.d;
    sq += r * r;
    if (o.d < dmin) dmin = o.d;
  }
  const rms = Math.sqrt(sq / obs.length);
  const radius = 2 * rms + 0.3 * dmin;

  // Floor it. Even a perfect fit is not accurate to a metre with RSSI, and
  // two gateways cannot resolve which side of the line you are on.
  const floor = obs.length >= 3 ? 3 : 8;

  /*
   * Did this actually resolve, or did the clamp catch it?
   *
   * refine() pins the solution inside the venue. That is right for a solution
   * that wanders slightly outside during iteration, and badly wrong as a
   * silent behaviour: when the circles do not intersect inside the box at all,
   * every such device lands exactly ON a boundary and gets drawn as a
   * confident dot. A whole fleet pinned along two edges is the signature, and
   * it reads as "everyone is against the north wall" rather than "the geometry
   * did not solve".
   *
   * Two independent checks:
   *   pinned  - sitting on a bound, i.e. the clamp is what put it there
   *   rms     - the distances disagree by more than the nearest one, so no
   *             point in the plane fits them
   *
   * Either way the position is not evidence and the caller should say so
   * instead of drawing it.
   */
  const b = opts.bounds;
  const EPS = 0.05;
  const pinned = Boolean(b) && (
    Math.abs(p.x - b.minX) < EPS || Math.abs(p.x - b.maxX) < EPS ||
    Math.abs(p.y - b.minY) < EPS || Math.abs(p.y - b.maxY) < EPS);

  /*
   * Pinning alone is NOT failure. A device genuinely standing against a wall
   * clamps to that wall and is correctly placed — on clean synthetic geometry
   * ~12% of devices pin legitimately, and rejecting them would throw away the
   * edges of every venue.
   *
   * The residual is what separates the two. A real wall-hugger fits its
   * distances well; a solution shoved outside the box does not fit them at
   * all, because no point in the plane does. So rms decides, and `pinned` is
   * reported alongside as a hint rather than a verdict — a large number of
   * pinned devices with good residuals means a crowd at the edge, while
   * pinned with bad residuals means the geometry or the model is wrong.
   */
  const resolved = rms < Math.max(dmin * 0.5, 5);

  return {
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
    r: Math.round(Math.max(radius, floor) * 10) / 10,
    n: obs.length,
    method: obs.length >= 3 ? "least-squares" : "centroid",
    gateways: ids,
    resolved,
    pinned,
    rms: Math.round(rms * 10) / 10,
  };
}

module.exports = {
  DEFAULT_MODEL,
  rssiToDistance,
  distanceToRssi,
  weightedCentroid,
  refine,
  estimate,
};
