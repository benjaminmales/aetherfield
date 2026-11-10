#!/usr/bin/env node
/**
 * sim-gateway.js — pretend to be an Aetherfield gateway.
 *
 * Lets you exercise the whole server, console and cloud path before any
 * hardware exists, and later lets you load-test at event scale without 5000
 * physical devices. It speaks exactly what the real gateway speaks, so if the
 * server works against this it works against the metal.
 *
 *   node tools/sim-gateway.js --id gw-01 --devices 10
 *   node tools/sim-gateway.js --id gw-02 --devices 250 --interval 10000
 *   node tools/sim-gateway.js --host 192.168.1.50 --port 9000 --id gw-01
 *
 * Options:
 *   --host      server address           (default 127.0.0.1)
 *   --port      gateway TCP port         (default 9000)
 *   --id        gateway id sent in HELLO (default gw-sim)
 *   --devices   how many bands to fake   (default 10)
 *   --interval  beacon interval, ms      (default 10000 — the agreed value)
 *   --base      first device address     (default 0x1000)
 *   --events    events/min per device    (default 2)
 *   --contacts  contact events/min       (default 1, exercises proximity)
 *   --quiet     don't echo sent lines
 */

const net = require("node:net");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes("--" + name);

const HOST = arg("host", "127.0.0.1");
const PORT = Number(arg("port", 9000));
const ID = arg("id", "gw-sim");
const N = Number(arg("devices", 10));
const INTERVAL = Number(arg("interval", 10_000));
const BASE = parseInt(String(arg("base", "0x1000")).replace(/^0x/i, ""), 16);
const EVENTS_PER_MIN = Number(arg("events", 2));
const CONTACTS_PER_MIN = Number(arg("contacts", 1));
const QUIET = flag("quiet");

const hex4 = (n) => (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

// A fake fleet. Battery drains slowly so the console shows movement over a
// long run; RSSI wanders so the signal bars aren't suspiciously static.
const devices = Array.from({ length: N }, (_, i) => ({
  addr: hex4(BASE + i),
  caps: pick([0x01, 0x03, 0x1d, 0x97]), // LED-only … full band
  batt: Math.floor(rnd(60, 100)),
  rssi: Math.floor(rnd(-80, -35)),
  cseq: 0,
  flags: 0,
}));

let sock = null;
let connected = false;
let timers = [];
let backoff = 1000;

function send(line) {
  if (!connected || !sock) return;
  sock.write(line + "\n");
  if (!QUIET) console.log("->", line);
}

function beaconOnce(d) {
  // Random walk the signal, drain the battery very slowly.
  d.rssi = Math.max(-95, Math.min(-30, d.rssi + Math.round(rnd(-4, 4))));
  if (Math.random() < 0.02) d.batt = Math.max(0, d.batt - 1);
  send(
    `<BCN a=${d.addr} n=0 r=${d.rssi} caps=${d.caps.toString(16).toUpperCase()} ` +
      `batt=${d.batt} fl=${d.flags.toString(16).padStart(2, "0").toUpperCase()} cseq=${d.cseq}`
  );
}

function start() {
  stop();
  // Beacons: each device on its own phase so they don't all fire together —
  // exactly the jitter the real firmware needs to avoid CSMA pile-ups.
  devices.forEach((d) => {
    const jitter = Math.random() * INTERVAL;
    timers.push(
      setTimeout(() => {
        beaconOnce(d);
        timers.push(setInterval(() => beaconOnce(d), INTERVAL));
      }, jitter)
    );
  });

  if (EVENTS_PER_MIN > 0) {
    timers.push(
      setInterval(() => {
        const d = pick(devices);
        const t = pick(["button", "gesture", "nfc"]);
        send(`<EVT a=${d.addr} n=0 r=${d.rssi} t=${t} v=${Math.floor(rnd(1, 4))} s=${Math.floor(rnd(50, 100))}`);
      }, Math.max(1000, 60_000 / (EVENTS_PER_MIN * Math.max(1, N / 10))))
    );
  }

  if (CONTACTS_PER_MIN > 0 && N > 1) {
    timers.push(
      setInterval(() => {
        const a = pick(devices);
        let b = pick(devices);
        while (b === a) b = pick(devices);
        send(`<CON a=${a.addr} n=0 r=${a.rssi} peer=${b.addr} pr=${Math.floor(rnd(-85, -45))} ev=${pick(["open", "close"])}`);
      }, Math.max(1000, 60_000 / CONTACTS_PER_MIN))
    );
  }

  timers.push(setInterval(() => send("PING"), 25_000));
}

function stop() {
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  timers = [];
}

function connect() {
  sock = net.createConnection({ host: HOST, port: PORT }, () => {
    connected = true;
    backoff = 1000;
    console.log(`connected to ${HOST}:${PORT} as ${ID} — ${N} devices @ ${INTERVAL}ms`);
    send(`HELLO gw=${ID} fw=sim-1.0.0 proto=2`);
    start();
  });

  // Downlink: echo what the server sends so you can see commands land, and
  // reflect them into the fleet the way real firmware would.
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line === "PONG") continue;
      console.log("<-", line);
      if (/^aura cmd\b/.test(line)) devices.forEach((d) => (d.cseq = (d.cseq + 1) & 0xff));
      if (/^aura identify\b/.test(line)) {
        const m = /identify\s+([0-9A-Fa-f]{1,4})/.exec(line);
        if (m) {
          const d = devices.find((x) => x.addr === m[1].toUpperCase().padStart(4, "0"));
          if (d) { d.flags |= 0x80; setTimeout(() => (d.flags &= ~0x80), 5000); }
        }
      }
    }
  });

  const retry = () => {
    if (connected) console.log("disconnected");
    connected = false;
    stop();
    try { sock.destroy(); } catch { /* already gone */ }
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15_000); // same reconnect policy the gateway needs
  };
  sock.on("error", (e) => { console.log("socket error:", e.message); retry(); });
  sock.on("close", retry);
}

process.on("SIGINT", () => { stop(); try { sock?.destroy(); } catch {} process.exit(0); });
connect();
