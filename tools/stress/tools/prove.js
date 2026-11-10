#!/usr/bin/env node
/**
 * prove.js — what does it take to show 100% detection?
 *
 * Detection is a function of two numbers you control, exactly as you'd expect:
 *
 *     chances per window = W / T
 *     per-beacon success = e^(-k G),   G = N_earshot * airtime / T
 *     detection          = 1 - (1 - p)^(W/T)
 *
 * T appears twice and pulls in opposite directions. A shorter period gives
 * more chances per window, and also puts more frames on air, which lowers p.
 * That is why there is an optimum rather than "as fast as possible".
 *
 * THE PART THAT CATCHES PEOPLE OUT
 *
 * "100% detection" means two very different things:
 *
 *   snapshot     every device seen right now. One sample, 3,000 dice.
 *   sustained    no device EVER missed a window across the whole run.
 *
 * Over 15 minutes each device faces 900/W windows, so with 3,000 devices you
 * are rolling 3000 x 900/W dice, not 3,000. Demanding zero failures from
 * ~50,000 trials is a far harder test than one clean sample, and it is the
 * honest one — a client watching a crowd for fifteen minutes is running the
 * sustained test whether or not anyone calls it that.
 *
 * This tool answers: for a given fleet, what (T, W) actually gets there?
 *
 *   node tools/prove.js
 *   node tools/prove.js --earshot 750        # a large venue, not one room
 *   node tools/prove.js --run 900 --target 0.05
 */

const TAU = 736e-6;

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
}

const FLEET    = Number(arg("fleet", 3000));      // devices in the fleet
const EARSHOT  = Number(arg("earshot", FLEET));   // devices ONE gateway hears
const RUN_S    = Number(arg("run", 900));         // demo length, seconds
const TARGET   = Number(arg("target", 0.05));     // acceptable P(any miss in the run)

/* k measured on the rig: 150 devices, 3 s, 92.4% delivery. */
const K_DIRECT = -Math.log(0.924) / ((150 * TAU) / 3);
const K_CSMA   = K_DIRECT * 0.4;

const WINDOWS = [5, 10, 15, 20, 30, 45, 60];
const PERIODS = [1, 2, 3, 5, 8];

function model(k, T, W) {
  const G = (EARSHOT * TAU) / T;
  const p = Math.min(1, Math.exp(-k * G));
  const chances = W / T;
  const missPerWindow = Math.pow(1 - p, chances);

  // Every device, every window of the run. This is the number that decides
  // whether a demo survives being watched rather than sampled.
  const trials = FLEET * (RUN_S / W);
  const pAnyMiss = 1 - Math.pow(1 - missPerWindow, trials);

  return { p, chances, missPerWindow, trials, pAnyMiss,
           detection: 1 - missPerWindow, channel: G };
}

function table(label, k) {
  console.log(`\n${label}`);
  console.log("        " + WINDOWS.map((w) => `${w}s`.padStart(9)).join(""));
  for (const T of PERIODS) {
    let row = `  T=${T}s`.padEnd(8);
    for (const W of WINDOWS) {
      const m = model(k, T, W);
      // Pass = the whole run completes with no device ever missing a window.
      const mark = m.pAnyMiss <= TARGET ? "*" : " ";
      row += (`${(m.detection * 100).toFixed(1)}%${mark}`).padStart(9);
    }
    console.log(row);
  }
}

console.log(`\nFleet ${FLEET}, ${EARSHOT} in earshot of one gateway, `
  + `${RUN_S / 60} min run`);
console.log(`Cells show SNAPSHOT detection. * = also survives the whole run `
  + `with no device ever missed (P(any miss) <= ${(TARGET * 100).toFixed(0)}%).`);
console.log(`k: direct ${K_DIRECT.toFixed(2)} (measured), csma ${K_CSMA.toFixed(2)}.`);

table("AS SHIPPED — direct transmit, no carrier sense", K_DIRECT);
table("WITH CARRIER SENSE", K_CSMA);

/* The shortest window that passes, which is the product-relevant answer. */
function best(k) {
  let out = null;
  for (const W of WINDOWS) {
    for (const T of PERIODS) {
      const m = model(k, T, W);
      if (m.pAnyMiss <= TARGET && (!out || W < out.W)) out = { W, T, ...m };
    }
  }
  return out;
}

console.log("\nShortest window that proves a clean run:");
for (const [label, k] of [["direct", K_DIRECT], ["csma", K_CSMA]]) {
  const b = best(k);
  console.log(b
    ? `  ${label.padEnd(7)} W=${b.W}s at T=${b.T}s  `
      + `(per-beacon ${(b.p * 100).toFixed(1)}%, ${b.chances.toFixed(1)} chances, `
      + `channel ${(b.channel * 100).toFixed(0)}%)`
    : `  ${label.padEnd(7)} nothing in range passes — widen the window, `
      + `add gateways, or reduce devices per gateway`);
}
console.log("");
