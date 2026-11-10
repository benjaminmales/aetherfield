#!/usr/bin/env node
/**
 * sweep.js — drive the fleet through a series of beacon intervals and
 * record what actually arrives at each one.
 *
 * WHY THIS EXISTS
 *
 * k was fitted from a single (interval, delivery) pair. A one-point fit
 * cannot tell the difference between the two things that could be causing
 * the missing 7.6%:
 *
 *   collisions   loss rises with offered load      p = e^(-kG)
 *   a floor      loss is constant, load-independent  p = c
 *
 * At 150 devices on 3 s the channel is 4% occupied. A collision model and a
 * flat 7.6% loss floor predict almost identical numbers there, so the single
 * measurement cannot separate them — and the two extrapolate to wildly
 * different places at 3,000 devices. Sweeping the interval separates them in
 * about ten minutes: halve the interval and collisions roughly double the
 * loss, while a floor does not move.
 *
 * WHAT ONE BOARD CAN AND CANNOT MEASURE
 *
 * A single radio transmits serially, so one board never collides with
 * itself no matter how many virtual devices it claims. One board therefore
 * measures the RECEIVE path — how many beacons a gateway can take in,
 * format, queue and ship before it starts dropping — with collisions held
 * at zero. That is a real ceiling and worth knowing on its own, and it is
 * the cleanest way to see the loss floor.
 *
 * Collisions need many radios. That is tomorrow's run, with the same script.
 *
 *   node tools/sweep.js                       # 3 s down to 0.5 s, 150 devices
 *   node tools/sweep.js --devices 600         # push the receive path harder
 *   node tools/sweep.js --intervals 3,2,1     # pick your own points
 *   node tools/sweep.js --dwell 90            # longer settle per point
 */

const BASE = process.env.SWEEP_BASE || "http://localhost:3200";

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
}

const DEVICES = Number(arg("devices", 150));
const WINDOW_S = Number(arg("window", 10));
const DWELL_S = Number(arg("dwell", 60));
const INTERVALS = String(arg("intervals", "3,2,1.5,1,0.7,0.5"))
  .split(",")
  .map(Number)
  .filter((n) => n > 0);

const TAU = 736e-6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${j.error || res.status}`);
  return j;
}

/*
 * op mode 0's param IS the beacon interval, in units of 100 ms. That is the
 * only way to re-rate every virtual device on every board at the same
 * instant — over the air, in one frame. Setting boards one at a time over
 * RTT produces a smear, not a sweep.
 */
function paramFor(seconds) {
  const p = Math.round((seconds * 1000) / 100);
  if (p < 1 || p > 255) throw new Error(`interval ${seconds}s is outside op param range`);
  return p;
}

async function point(intervalS) {
  const param = paramFor(intervalS);
  const trueInterval = (param * 100) / 1000;

  await api("/api/op", { mode: 0, param });
  await api("/api/expected", {
    devices: DEVICES,
    beaconIntervalMs: trueInterval * 1000,
    presenceWindowMs: WINDOW_S * 1000,
  });

  // Let the old rate drain out of the rate estimators before measuring, then
  // reset so the sample is entirely from this interval.
  await sleep(5000);
  await api("/api/reset", {});   /* {} so this is a POST — the route is POST-only */
  await sleep(DWELL_S * 1000);

  const s = await api("/api/stats");
  const offered = DEVICES / trueInterval;

  return {
    T: trueInterval,
    offered,
    channel: offered * TAU,
    delivered: s.measured.sightingsPerSec,
    delivery: s.measured.deliveryRate,
    detected: s.presence?.rate ?? null,
    clean: s.presence?.sustained?.rate ?? null,
    gateways: s.gateways.length,
    gwPerBeacon: s.fleet?.duplicationFactor ?? null,
  };
}

(async () => {
  const meta = await api("/api/stats");
  if (!meta.gateways.length) {
    console.error("No gateway connected — nothing would be measured.");
    process.exit(1);
  }

  console.log(`\nSweep: ${DEVICES} devices, ${WINDOW_S}s window, `
    + `${DWELL_S}s per point, ${meta.gateways.length} gateway(s)`);
  console.log(`Total run time ~${Math.ceil((INTERVALS.length * (DWELL_S + 5)) / 60)} min\n`);
  console.log("   T(s)  offered/s  channel   delivered/s   DELIVERY   detected   clean");

  const rows = [];
  for (const iv of INTERVALS) {
    const r = await point(iv);
    rows.push(r);
    console.log(
      `  ${String(r.T).padStart(5)}  ${String(Math.round(r.offered)).padStart(9)}`
      + `  ${(r.channel * 100).toFixed(1).padStart(6)}%`
      + `  ${r.delivered.toFixed(1).padStart(12)}`
      + `  ${((r.delivery ?? 0) * 100).toFixed(1).padStart(8)}%`
      + `  ${((r.detected ?? 0) * 100).toFixed(1).padStart(8)}%`
      + `  ${((r.clean ?? 0) * 100).toFixed(1).padStart(6)}%`);
  }

  /*
   * The verdict. Fit both models and see which the data prefers.
   *
   *   floor      p = c               loss does not vary with load
   *   collision  p = e^(-kG)         loss rises with load
   *
   * Compared by residual against the measured points. With one board the
   * honest expectation is that FLOOR wins — there is nothing to collide
   * with — and that is the useful result: it says how much of the missing
   * percentage was never collisions at all, and must be subtracted before
   * fitting k to tomorrow's multi-board run.
   */
  const pts = rows.filter((r) => r.delivery > 0 && r.delivery <= 1.2);

  /*
   * Before fitting anything, check for a CEILING.
   *
   * If delivered/s stops rising while offered/s keeps climbing, something in
   * the chain is saturated — the gateway's receive thread, the txq, the
   * socket, or the load generator itself failing to hit its own target. The
   * delivery RATIO then falls purely because the denominator grew, and the
   * collision fit will happily read that as a large k and call it physics.
   *
   * A ceiling is a real and useful finding. It is just not a collision, and
   * the two want opposite responses: collisions want a longer interval,
   * a ceiling wants more gateways or less work per beacon.
   */
  if (pts.length >= 2) {
    const first = pts[0], last = pts[pts.length - 1];
    const offeredUp = last.offered / first.offered;
    const deliveredUp = last.delivered / (first.delivered || 1);
    if (offeredUp > 1.5 && deliveredUp < 1.15) {
      console.log(`\n  !! CEILING, not collisions.`);
      console.log(`     Offered rose ${offeredUp.toFixed(1)}x but delivered stayed flat `
        + `(${first.delivered.toFixed(1)} -> ${last.delivered.toFixed(1)} /s).`);
      console.log(`     Something is saturated at about ${last.delivered.toFixed(0)} `
        + `beacons/s. Find it before reading anything below as physics:`);
      console.log(`       - one board cannot collide with itself, so at a single`);
      console.log(`         transmitter this is almost certainly the receive path`);
      console.log(`       - check the gateway's own beacons/s in the dashboard`);
      console.log(`       - check the load generator is meeting its target ('sim stats')`);
    }
  }

  if (pts.length >= 2) {
    const c = pts.reduce((a, r) => a + r.delivery, 0) / pts.length;
    const floorErr = pts.reduce((a, r) => a + (r.delivery - c) ** 2, 0);

    const ks = pts.map((r) => -Math.log(Math.min(0.999, r.delivery)) / r.channel);
    const k = ks.reduce((a, b) => a + b, 0) / ks.length;
    const collErr = pts.reduce(
      (a, r) => a + (r.delivery - Math.exp(-k * r.channel)) ** 2, 0);

    console.log(`\n  flat loss floor   ${((1 - c) * 100).toFixed(1)}% loss at every `
      + `interval, residual ${floorErr.toFixed(5)}`);
    console.log(`  collision model   k=${k.toFixed(2)}, residual ${collErr.toFixed(5)}`);
    console.log(`\n  -> the data prefers ${floorErr < collErr ? "A LOSS FLOOR" : "COLLISIONS"}`);

    if (floorErr < collErr) {
      console.log(`     Loss is not load-dependent here, which is expected from a`);
      console.log(`     single transmitter. Subtract this ${((1 - c) * 100).toFixed(1)}% floor`);
      console.log(`     before fitting k to the multi-board run, or k absorbs it and`);
      console.log(`     the extrapolation to 3,000 is pessimistic.`);
    } else {
      console.log(`     Feed it forward:`);
      console.log(`       node tools/interval.js --devices 3000 --window ${WINDOW_S} \\`);
      console.log(`            --calibrate ${pts[0].T},${pts[0].delivery.toFixed(3)} `
        + `--calibrate-devices ${DEVICES}`);
    }
  }

  console.log("");
})().catch((e) => {
  const m = String(e.message || e);
  if (/fetch failed|ECONNREFUSED/.test(m)) {
    console.error(`Cannot reach the stress server at ${BASE}.`);
    console.error("Start it with 'npm start' in stress/server, or set SWEEP_BASE.");
  } else {
    console.error(m);
  }
  process.exit(1);
});
