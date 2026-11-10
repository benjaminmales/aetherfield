const test = require("node:test");
const assert = require("node:assert");
const {
  rssiToDistance, distanceToRssi, estimate, weightedCentroid, DEFAULT_MODEL,
} = require("./position");

/* A square of gateways 40 m on a side, which is roughly how you would cover a
 * medium hall. Positions in metres. */
const SQUARE = {
  "gw-01": { x: 0, y: 0 },
  "gw-02": { x: 40, y: 0 },
  "gw-03": { x: 40, y: 40 },
  "gw-04": { x: 0, y: 40 },
};

/** Deterministic noise: a test that fails one run in twenty is not a test. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** What the gateways would report for a device truly at (x, y). */
function synth(truth, positions = SQUARE, noiseDb = 0, rand = null) {
  return Object.entries(positions).map(([gw, p]) => {
    const d = Math.hypot(truth.x - p.x, truth.y - p.y);
    const n = noiseDb && rand ? (rand() * 2 - 1) * noiseDb : 0;
    return { gw, rssiAvg: distanceToRssi(d) + n };
  });
}

const err = (est, truth) => Math.hypot(est.x - truth.x, est.y - truth.y);

test("position", async (t) => {
  await t.test("distance and rssi are inverses", () => {
    for (const d of [1, 2, 5, 10, 25, 50]) {
      const back = rssiToDistance(distanceToRssi(d));
      assert.ok(Math.abs(back - d) < 0.01, `${d} -> ${back}`);
    }
  });

  await t.test("1 m is the reference point", () => {
    assert.strictEqual(Math.round(distanceToRssi(1)), DEFAULT_MODEL.refRssi);
  });

  await t.test("further is weaker, monotonically", () => {
    let prev = Infinity;
    for (const d of [1, 2, 4, 8, 16, 32]) {
      const r = distanceToRssi(d);
      assert.ok(r < prev);
      prev = r;
    }
  });

  await t.test("noise-free centre of the square is found precisely", () => {
    const truth = { x: 20, y: 20 };
    const e = estimate(synth(truth), SQUARE);
    assert.strictEqual(e.method, "least-squares");
    assert.strictEqual(e.n, 4);
    assert.ok(err(e, truth) < 0.5, `error ${err(e, truth).toFixed(2)} m`);
  });

  await t.test("noise-free off-centre position is found", () => {
    for (const truth of [{ x: 10, y: 30 }, { x: 33, y: 12 }, { x: 5, y: 5 }]) {
      const e = estimate(synth(truth), SQUARE);
      assert.ok(err(e, truth) < 2.5,
        `truth ${JSON.stringify(truth)} -> ${JSON.stringify(e)}`);
    }
  });

  await t.test("beats the centroid it was seeded from", () => {
    // If refinement does not improve on the seed there is no reason to run it.
    const truth = { x: 8, y: 32 };
    const obs = synth(truth).map((o) => ({
      gw: SQUARE[o.gw], d: rssiToDistance(o.rssiAvg),
    }));
    const c = weightedCentroid(obs);
    const e = estimate(synth(truth), SQUARE);
    assert.ok(err(e, truth) < err(c, truth),
      `refined ${err(e, truth).toFixed(2)} vs centroid ${err(c, truth).toFixed(2)}`);
  });

  await t.test("degrades gracefully with 6 dB of noise", () => {
    const rand = lcg(42);
    const errors = [];
    for (let i = 0; i < 60; i++) {
      const truth = { x: 4 + rand() * 32, y: 4 + rand() * 32 };
      const e = estimate(synth(truth, SQUARE, 6, rand), SQUARE);
      errors.push(err(e, truth));
    }
    errors.sort((a, b) => a - b);
    const median = errors[Math.floor(errors.length / 2)];
    // 6 dB of noise on a 40 m hall. Single figures is the honest claim; this
    // asserts the model does not silently get much worse than advertised.
    assert.ok(median < 8, `median error ${median.toFixed(2)} m`);
  });

  await t.test("the stated radius actually contains the device", () => {
    // The radius is the whole honesty mechanism. If it is optimistic the map
    // lies to the operator, which is worse than having no map. Checked at
    // several noise levels because a radius that only works in easy
    // conditions is the one that fails in a full venue.
    for (const [noiseDb, minCoverage] of [[3, 0.85], [6, 0.75], [10, 0.7], [14, 0.7]]) {
      const rand = lcg(99);
      let covered = 0;
      const N = 300;
      for (let i = 0; i < N; i++) {
        const truth = { x: 2 + rand() * 36, y: 2 + rand() * 36 };
        const e = estimate(synth(truth, SQUARE, noiseDb, rand), SQUARE);
        if (err(e, truth) <= e.r) covered += 1;
      }
      assert.ok(covered / N >= minCoverage,
        `${noiseDb} dB: only ${covered}/${N} inside the stated radius`);
    }
  });

  await t.test("the radius grows as conditions get worse", () => {
    // A radius that stays small when the data gets bad is worse than useless:
    // it reports false confidence exactly when the operator needs the warning.
    const radii = [3, 6, 10, 14].map((noiseDb) => {
      const rand = lcg(5);
      const rs = [];
      for (let i = 0; i < 200; i++) {
        const truth = { x: 2 + rand() * 36, y: 2 + rand() * 36 };
        rs.push(estimate(synth(truth, SQUARE, noiseDb, rand), SQUARE).r);
      }
      rs.sort((a, b) => a - b);
      return rs[100];
    });
    for (let i = 1; i < radii.length; i++) {
      assert.ok(radii[i] > radii[i - 1],
        `median radius must increase with noise: ${radii.join(" -> ")}`);
    }
  });

  await t.test("one gateway reports a circle, not a point", () => {
    const e = estimate([{ gw: "gw-01", rssiAvg: distanceToRssi(12) }], SQUARE);
    assert.strictEqual(e.method, "single-gateway");
    assert.deepStrictEqual({ x: e.x, y: e.y }, SQUARE["gw-01"]);
    assert.ok(Math.abs(e.r - 12) < 0.5, `radius ${e.r} should be ~12 m`);
  });

  await t.test("two gateways carry a large floor radius", () => {
    const truth = { x: 20, y: 20 };
    const two = synth(truth).filter((o) => o.gw === "gw-01" || o.gw === "gw-02");
    const e = estimate(two, SQUARE);
    assert.strictEqual(e.method, "centroid");
    assert.ok(e.r >= 8, `radius ${e.r} must not imply precision it lacks`);
  });

  await t.test("collinear gateways do not blow up", () => {
    // Gateways hung along one wall. The geometry is degenerate; the answer
    // must still be finite and inside the venue.
    const line = {
      "gw-01": { x: 0, y: 0 }, "gw-02": { x: 20, y: 0 },
      "gw-03": { x: 40, y: 0 }, "gw-04": { x: 60, y: 0 },
    };
    const truth = { x: 30, y: 15 };
    const e = estimate(synth(truth, line), line, {
      bounds: { minX: -10, maxX: 70, minY: -10, maxY: 60 },
    });
    assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y));
    assert.ok(e.x > -10 && e.x < 70 && e.y > -10 && e.y < 60, JSON.stringify(e));
  });

  await t.test("ignores gateways with no known position", () => {
    const e = estimate(
      [...synth({ x: 20, y: 20 }), { gw: "gw-99", rssiAvg: -50 }], SQUARE);
    assert.strictEqual(e.n, 4);
    assert.ok(!e.gateways.includes("gw-99"));
  });

  await t.test("no positioned gateways means no guess", () => {
    assert.strictEqual(estimate([{ gw: "gw-99", rssiAvg: -50 }], SQUARE), null);
    assert.strictEqual(estimate([], SQUARE), null);
  });
});
