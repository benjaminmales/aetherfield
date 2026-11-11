#!/usr/bin/env node
/**
 * Try the Aetherfield Demo Server with no hardware.
 *
 *   npm run simulate                      8 simulated Aura Tags in one zone
 *   node simulate.js --tags 20 --zones 3  more of both
 *   node simulate.js --host 192.168.1.50  against a server on another machine
 *
 * Pretends to be one Aura Link per zone, each hearing some Aura Tags. The
 * tags beacon every 5 s, wander in signal strength, slowly drain their
 * battery, and now and then start and stop moving. It speaks exactly what a
 * real Link speaks, so behaviours, the API and the live feed all work.
 * Simulated tags have ids starting 0x5; stop this script and they go quiet.
 */
const net = require("node:net");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const HOST = arg("host", "127.0.0.1");
const PORT = Number(arg("port", 9000));
const TAGS = Math.max(1, Number(arg("tags", 8)));
const ZONES = Math.max(1, Math.min(8, Number(arg("zones", 1))));
const BEACON_MS = 5000;
const ZONE_NAMES = ["sim-entrance", "sim-bar", "sim-stage", "sim-lounge", "sim-terrace", "sim-foyer", "sim-vip", "sim-garden"];

const rnd = (a, b) => a + Math.random() * (b - a);
const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, "0");

const tags = Array.from({ length: TAGS }, (_, i) => ({
  addr: hex(0x5000 + i, 4), zone: i % ZONES, rssi: Math.round(rnd(-78, -45)),
  batt: Math.round(rnd(70, 100)), moving: false, peak: 0, cseq: 0,
}));

function link(zone) {
  const id = ZONE_NAMES[zone];
  let sock = null;
  let timers = [];
  const send = (line) => { if (sock && !sock.destroyed) sock.write(line + "\n"); };
  const mine = () => tags.filter((t) => t.zone === zone);
  const beacon = (t) => send(`<BCN a=${t.addr} n=0 r=${t.rssi} caps=09 batt=${t.batt} fl=${t.moving ? "20" : "00"} cseq=${t.cseq}`);

  function connect() {
    sock = net.connect(PORT, HOST, () => {
      console.log(`${id}: connected, ${mine().length} tags`);
      send(`HELLO gw=${id} fw=simulator proto=2`);
      for (const t of mine()) {
        setTimeout(() => beacon(t), rnd(0, 1500));
        timers.push(setInterval(() => {
          t.rssi = Math.max(-92, Math.min(-35, t.rssi + Math.round(rnd(-3, 3))));
          if (Math.random() < 0.01) t.batt = Math.max(1, t.batt - 1);
          beacon(t);
        }, BEACON_MS + rnd(-400, 400)));
      }
      // Every few seconds one tag starts or stops moving.
      timers.push(setInterval(() => {
        const list = mine();
        const t = list[Math.floor(Math.random() * list.length)];
        if (!t) return;
        t.moving = !t.moving;
        if (t.moving) { t.peak = Math.round(rnd(20, 100)); send(`<EVT a=${t.addr} n=0 r=${t.rssi} t=motion v=1 s=${Math.round(t.peak / 2)}`); }
        else send(`<EVT a=${t.addr} n=0 r=${t.rssi} t=motion v=0 s=${t.peak}`);
        beacon(t);
      }, 4000));
      timers.push(setInterval(() => send("PING"), 25000));
    });
    // Commands from the server: note the sequence number so the console's
    // "last command applied" matches, as a real tag would report it.
    let seq = 0;
    sock.on("data", (d) => {
      for (const line of String(d).split("\n")) {
        if (line.startsWith("aura cmd")) { seq = (seq + 1) & 0xff; mine().forEach((t) => { t.cseq = seq; }); console.log(`${id}: got "${line.trim()}"`); }
      }
    });
    const retry = () => { timers.forEach(clearInterval); timers = []; setTimeout(connect, 2000); };
    sock.on("error", (e) => { if (e.code === "ECONNREFUSED") console.log(`${id}: no server at ${HOST}:${PORT} yet (is the Demo Server running?). Retrying…`); });
    sock.on("close", retry);
  }
  connect();
}

console.log(`Simulating ${TAGS} Aura Tag${TAGS === 1 ? "" : "s"} across ${ZONES} zone${ZONES === 1 ? "" : "s"}. Ctrl+C to stop.`);
for (let z = 0; z < ZONES; z++) link(z);
