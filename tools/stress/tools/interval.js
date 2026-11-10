#!/usr/bin/env node
/**
 * interval.js — what beacon interval should the fleet use?
 *
 * There is a real optimum, and it is not "as often as possible".
 *
 * Two effects pull against each other. Beaconing more often gives more
 * chances to be heard inside a presence window. It also puts more frames on
 * air, and since the fleet transmits with IEEE802154_TX_MODE_DIRECT — no
 * carrier sense — the uplink is unslotted ALOHA, whose per-frame success
 * falls as e^(-2G) with offered load. Past a point, beaconing more often
 * means being detected LESS.
 *
 *     offered load G  = N * airtime / T
 *     per-beacon      p = e^(-2G)          (e^(-0.8G) with CSMA, indicative)
 *     detection       = 1 - (1 - p)^(W/T)
 *
 * The model is a starting point, not an answer. Measure p on the rig at a
 * couple of intervals and pass --calibrate to refit it; a venue full of
 * people and Wi-Fi will not match the textbook.
 *
 *   node tools/interval.js --devices 3000 --window 30
 *   node tools/interval.js --devices 3000 --window 60 --csma
 *   node tools/interval.js --devices 3000 --window 30 --calibrate 10,0.71
 *
 * Calibrating on a smaller rig than you will deploy — which is the normal
 * case — needs the rig's size too, or the fit is meaningless:
 *
 *   node tools/interval.js --devices 3000 --window 10 \
 *        --calibrate 3,0.924 --calibrate-devices 150
 */

const TAU = 736e-6; // one beacon on air: 6 B PHY + 9 B MHR + 6 B payload + 2 B FCS

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
const flag = (n) => process.argv.includes(`--${n}`);

const N = Number(arg("devices", 3000));
const W = Number(arg("window", 30));
const csma = flag("csma");
const calibrate = arg("calibrate", null);
/*
 * You calibrate at the scale you can actually build and predict at the scale
 * you have to deliver — 20 boards pretending to be 150 each is how you reach
 * 3,000, and the calibration run is usually ONE board. Without this the
 * measurement gets attributed to the full fleet's offered load and k comes
 * out ~20x too small, which turns a sober 58% into a reassuring 100%.
 */
const calDevices = Number(arg("calibrate-devices", N));

/*
 * k is the collision coefficient in p = e^(-k*G). Theory says 2 for unslotted
 * ALOHA and something nearer 0.8 once carrier sense is in play. If the rig has
 * measured a real (interval, delivery) pair, solve for k instead — that folds
 * in the venue, the Wi-Fi, the bodies and the antennas, none of which the
 * textbook knows about.
 */
let k = csma ? 0.8 : 2;
let source = csma ? "modelled (CSMA)" : "modelled (ALOHA)";

if (calibrate) {
  const [tStr, pStr] = calibrate.split(",");
  const t = Number(tStr), pMeas = Number(pStr);
  if (!(t > 0) || !(pMeas > 0 && pMeas < 1)) {
    console.error("--calibrate wants interval_seconds,delivery_fraction e.g. 10,0.71");
    process.exit(1);
  }
  k = -Math.log(pMeas) / ((calDevices * TAU) / t);
  source = `calibrated from ${calDevices} devices `
    + `(T=${t}s, delivery=${(pMeas * 100).toFixed(1)}%) -> k=${k.toFixed(2)}`
    + (calDevices !== N ? `, extrapolated to ${N}` : "");
}

const INTERVALS = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 60];

const rows = INTERVALS.map((T) => {
  const G = (N * TAU) / T;
  const p = Math.min(1, Math.exp(-k * G));
  const n = W / T;
  return {
    T, G, p, n,
    offered: N / T,
    detect: 1 - Math.pow(1 - p, n),
    txPerHour: 3600 / T,
  };
});

const best = rows.reduce((a, b) => (b.detect > a.detect ? b : a));
// Battery and airtime both favour a longer interval, so among intervals that
// are statistically indistinguishable from the peak, take the longest.
const within = rows.filter((r) => r.detect >= best.detect - 0.005);
const pick = within[within.length - 1];

console.log(`\n${N} devices · ${W}s presence window · ${source}\n`);
console.log("  T(s)   offered/s   channel   per-beacon   per window   DETECTION    tx/hr");
for (const r of rows) {
  const mark = r === pick ? "  <-- best value" : r === best ? "  <-- peak" : "";
  console.log(
    `  ${String(r.T).padStart(4)}   ${r.offered.toFixed(0).padStart(9)}`
    + `   ${(r.G * 100).toFixed(0).padStart(6)}%   ${(r.p * 100).toFixed(1).padStart(9)}%`
    + `   ${r.n.toFixed(1).padStart(10)}   ${(r.detect * 100).toFixed(2).padStart(8)}%`
    + `   ${r.txPerHour.toFixed(0).padStart(6)}${mark}`);
}

console.log(`\n  peak detection   ${(best.detect * 100).toFixed(2)}% at T=${best.T}s`);
console.log(`  best value       T=${pick.T}s -> ${(pick.detect * 100).toFixed(2)}%, `
  + `${pick.txPerHour.toFixed(0)} transmissions/hour/device`);
console.log(`  op 0 param       ${Math.round(pick.T * 10)}   (param x 100 ms)\n`);
