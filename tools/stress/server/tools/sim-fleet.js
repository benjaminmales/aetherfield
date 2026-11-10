#!/usr/bin/env node
/**
 * sim-fleet.js — a whole venue, in software.
 *
 * Opens one TCP connection per simulated gateway, scatters N devices across
 * the venue, and emits exactly the `<BCN` lines a real gateway would, with
 * RSSI computed from each device's true distance plus noise. Devices near
 * several gateways are reported by several gateways, which is what exercises
 * the dedupe path.
 *
 * Two jobs:
 *
 *   1. End-to-end test with no hardware. Because it knows each device's TRUE
 *      position, `--verify` scores the estimator against ground truth, which
 *      no amount of staring at a map can do.
 *   2. Showing the client the console at 3,000 devices and 30 gateways before
 *      either exists.
 *
 * It does NOT simulate radio contention — every beacon it generates arrives.
 * Collision behaviour is exactly the part only the real boards can answer, so
 * a 100% delivery rate here means the software is correct, not that the air
 * will cope. Do not show this to anyone as evidence that 3,000 works.
 *
 *   node tools/sim-fleet.js --devices 3000 --gateways 30 --interval 10000
 *   node tools/sim-fleet.js --devices 500 --verify
 */

const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const { distanceToRssi } = require("../lib/position");

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

const HOST = arg("host", "127.0.0.1");
const PORT = Number(arg("port", 9000));
const N_DEV = Number(arg("devices", 3000));
const N_GW = Number(arg("gateways", 30));
const INTERVAL = Number(arg("interval", 10000));
const NOISE = Number(arg("noise", 6));
const RANGE = Number(arg("range", 45));   // metres a gateway can hear
const BASE = Number(arg("base", 0x1000));
const CONFIG = arg("config", path.join(__dirname, "..", "config.json"));

const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const venue = cfg.venue;

/* Gateways on a grid across the venue, which is roughly how a real rig is
 * hung and gives every device several in range. */
function layout(n) {
  const cols = Math.ceil(Math.sqrt((n * venue.width) / venue.height));
  const rows = Math.ceil(n / cols);
  const out = {};
  let k = 0;
  for (let r = 0; r < rows && k < n; r++) {
    for (let c = 0; c < cols && k < n; c++, k++) {
      out[`gw-${String(k + 1).padStart(2, "0")}`] = {
        x: Math.round(((c + 0.5) * venue.width / cols) * 10) / 10,
        y: Math.round(((r + 0.5) * venue.height / rows) * 10) / 10,
      };
    }
  }
  return out;
}

const gateways = N_GW === Object.keys(cfg.gateways).length && !flag("grid")
  ? cfg.gateways
  : layout(N_GW);

const devices = [];
for (let i = 0; i < N_DEV; i++) {
  devices.push({
    uuid: (BASE + i).toString(16).toUpperCase().padStart(4, "0"),
    x: Math.random() * venue.width,
    y: Math.random() * venue.height,
    batt: 60 + Math.floor(Math.random() * 41),
    cseq: 0,
  });
}

const socks = new Map();
let connected = 0;
let emitted = 0;

for (const [id, pos] of Object.entries(gateways)) {
  const s = net.connect(PORT, HOST, () => {
    s.write(`HELLO gw=${id} fw=sim proto=2\n`);
    connected += 1;
    if (connected === Object.keys(gateways).length) start();
  });
  s.on("error", (e) => console.error(`${id}: ${e.message}`));
  s.on("data", (d) => {
    // The server may send commands; answer PING so the link stays up and
    // adopt the CMD seq so downlink adoption reads as ~100% here.
    const text = d.toString();
    if (/^PING/m.test(text)) s.write("PONG\n");
    const m = /aura cmd\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+/.exec(text);
    if (m) for (const dev of devices) dev.cseq = (dev.cseq + 1) & 0xff;
  });
  socks.set(id, { sock: s, pos });
}

function emit(dev) {
  for (const [id, g] of socks) {
    const d = Math.hypot(dev.x - g.pos.x, dev.y - g.pos.y);
    if (d > RANGE) continue;                    // out of earshot entirely
    const rssi = Math.round(distanceToRssi(d, cfg.model) + (Math.random() * 2 - 1) * NOISE);
    if (rssi < -100) continue;                  // below the noise floor
    g.sock.write(
      `<BCN a=${dev.uuid} n=0 r=${rssi} caps=01 batt=${dev.batt} fl=00 cseq=${dev.cseq}\n`);
    emitted += 1;
  }
}

async function start() {
  const api = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${arg("http", 3200)}`;
  const post = (p, body) => fetch(api + p, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    // What we are offering, so delivery rate is measured against THIS run
    // rather than whatever config.json last described.
    await post("/api/expected", {
      devices: N_DEV, base: BASE, beaconIntervalMs: INTERVAL,
    });

    // Where the gateways are. Without this the server can only position
    // against the handful in config.json and silently drops the rest — which
    // looks like the estimator being bad rather than the estimator being
    // starved, and cost an hour the first time it happened.
    for (const [id, g] of Object.entries(gateways)) {
      await post(`/api/gateways/${id}/position`, { x: g.x, y: g.y });
    }
  } catch { /* the sim is still useful against a server that is not up yet */ }

  let cursor = 0;
  let cycles = 0;

  const target = N_DEV / (INTERVAL / 1000);
  console.log(`${N_DEV} devices, ${Object.keys(gateways).length} gateways, `
    + `${INTERVAL} ms interval -> ${Math.round(target)} beacons/s offered`);
  console.log(`venue ${venue.width}x${venue.height} m, gateway range ${RANGE} m, noise +/-${NOISE} dB`);

  /*
   * A 20 ms tick emitting a batch, not a per-device timer.
   *
   * At 3,000 devices on a 10 s interval the per-device slot is 3.3 ms, and
   * Node will not hold a 3 ms setInterval while also writing to 30 sockets —
   * it drifts to roughly 5 ms and silently offers 40% less load than you
   * asked for. That shortfall then appears on the dashboard as packet loss
   * that the radio never caused, which is the single most misleading thing
   * this tool could do. A coarser tick with a batch is accurate; the extra
   * burstiness is irrelevant because there is no contention here anyway.
   */
  const TICK_MS = 20;
  const per = Math.max(1, Math.round((N_DEV * TICK_MS) / INTERVAL));

  setInterval(() => {
    for (let k = 0; k < per; k++) {
      emit(devices[cursor]);
      cursor = (cursor + 1) % N_DEV;
      cycles += 1;
    }
  }, TICK_MS);

  let last = Date.now();
  setInterval(() => {
    const secs = (Date.now() - last) / 1000;
    const achieved = cycles / secs;
    const pct = (100 * achieved) / target;
    console.log(`offered ${achieved.toFixed(0)}/s of ${target.toFixed(0)}/s target `
      + `(${pct.toFixed(0)}%) · ${emitted} gateway-reports`
      + (pct < 95 ? "  <-- SIMULATOR is short, not the network" : ""));
    emitted = 0; cycles = 0; last = Date.now();
  }, 10_000).unref();

  // The rate meter averages over a 20 s window, so scoring before it has
  // filled reports phantom packet loss from the ramp-up.
  if (flag("verify")) setTimeout(verify, Math.max(INTERVAL * 2, 25_000) + 3000);
}

/**
 * Score the estimator against ground truth.
 *
 * This is the only place the true positions are known, so it is the only
 * place the position feature can actually be checked rather than eyeballed.
 */
async function verify() {
  const base = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${arg("http", 3200)}`;
  let body;
  try {
    body = await fetch(`${base}/api/positions`).then((r) => r.json());
  } catch (e) {
    console.error(`verify: cannot reach ${base} (${e.message})`);
    process.exit(1);
  }

  const truth = new Map(devices.map((d) => [`0x${d.uuid}`, d]));
  const errs = [];
  let inside = 0;
  const byN = new Map();

  for (const p of body.devices) {
    const t = truth.get(p.uuid);
    if (!t) continue;
    const e = Math.hypot(p.x - t.x, p.y - t.y);
    errs.push(e);
    if (e <= p.r) inside += 1;
    const b = byN.get(p.n) || [];
    b.push(e);
    byN.set(p.n, b);
  }

  if (!errs.length) {
    console.error("verify: no positioned devices to score");
    process.exit(1);
  }
  errs.sort((a, b) => a - b);
  const q = (f) => errs[Math.floor(errs.length * f)].toFixed(1);

  console.log(`\n--- position accuracy vs ground truth (${errs.length} devices) ---`);
  console.log(`median ${q(0.5)} m   p75 ${q(0.75)} m   p90 ${q(0.9)} m   worst ${errs.at(-1).toFixed(1)} m`);
  console.log(`inside the stated radius: ${((100 * inside) / errs.length).toFixed(0)}%`);
  for (const n of [...byN.keys()].sort((a, b) => a - b)) {
    const b = byN.get(n).sort((x, y) => x - y);
    console.log(`  heard by ${n} gateway(s): ${b.length} devices, median ${b[Math.floor(b.length/2)].toFixed(1)} m`);
  }
  process.exit(0);
}
