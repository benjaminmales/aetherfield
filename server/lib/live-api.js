/**
 * live-api.js — the client-facing live feed: one JSON object per device.
 *
 * WebSocket at /ws. On connect a client gets `hello`, then a `snapshot` of
 * every known device, then:
 *   - `device` whenever a device's state changes (checked once a second)
 *   - `event`  immediately, for motion / gesture events and zone/presence changes
 *   - `gateway` when a Link connects, drops or is renamed
 *
 * Schema is versioned (`aura.live/1`) and documented in
 * docs/LIVE-API.md. The rule it follows: **every field the client asked for is
 * present, and a field we cannot yet measure is null, never a guess.**
 * Position is the honest example. Today the system knows which Link hears a
 * device loudest, so `zone` is filled, `position.source` says "zone", and
 * absolute/relative coordinates and speed are null. When markers or ranging
 * land, those fields fill in and no client code changes.
 *
 * `proximity` is a coarse band from smoothed RSSI to the zone's Link. The
 * thresholds are uncalibrated defaults, which is why the raw RSSI ships
 * alongside it.
 */

const { WebSocketServer } = require("ws");

const SCHEMA = "aura.live/1";

/* Defaults only — each site calibrates these in the console (site-settings.js). */
const NEAR_DBM = -60;
const MID_DBM = -75;

/** Caps byte -> product. Exact matches against the builds we ship. */
const PRODUCTS = {
  0x09: "Aura Tag",                // AURA_CAPS_HOLYIOT: light + accelerometer
  0x97: "Aura band (XIAO dev)",
  0x01: "Aura Pixel (XIAO dev)",
  0x03: "Aura Pixel (Holyiot)",
};

const CAP_BITS = [
  [0x01, "rgb_led"], [0x02, "hp_led"], [0x04, "imu"], [0x08, "accel"],
  [0x10, "mic"], [0x20, "button"], [0x40, "nfc"], [0x80, "multi_led"],
];

const FLAG_BITS = [
  [0x01, "charging"], [0x02, "lowBattery"], [0x04, "handRaised"],
  [0x08, "clap"], [0x10, "buttonHeld"], [0x20, "moving"],
];

function capsList(caps) {
  if (typeof caps !== "number") return [];
  return CAP_BITS.filter(([b]) => caps & b).map(([, n]) => n);
}

function flagsObj(flags) {
  const out = {};
  for (const [b, n] of FLAG_BITS) out[n] = typeof flags === "number" ? Boolean(flags & b) : null;
  return out;
}

function proximityBand(rssi, prox = {}) {
  if (typeof rssi !== "number") return null;
  if (rssi >= (prox.nearDbm ?? NEAR_DBM)) return "near";
  if (rssi >= (prox.midDbm ?? MID_DBM)) return "mid";
  return "far";
}

/**
 * Roster record (+ annotations) -> aura.live/1 device object.
 * Pure. `zone` is the strongest gateway heard within the window.
 */
function toLiveDevice(d, { names, strongest, prox }) {
  const zoneGw = strongest ? strongest.id : null;
  const rssi = strongest?.rssi ?? d.rssiAvg ?? d.rssi ?? null;

  return {
    id: d.uuid,
    niceName: names.device(d.uuid),
    product: PRODUCTS[d.caps] ?? (typeof d.caps === "number" ? "Aura device" : null),
    caps: capsList(d.caps),
    online: Boolean(d.online),
    lastSeen: new Date(d.lastSeen).toISOString(),
    zone: zoneGw ? { id: zoneGw, name: names.gateway(zoneGw) } : null,
    rssi,
    proximity: proximityBand(rssi, prox),
    position: {
      source: zoneGw ? "zone" : null,   // zone | marker | ranging (future)
      absolute: null,                   // { x, y, z } metres in venue frame — ⚠ not yet measurable
      relative: null,                   // { marker, distance_m } — ⚠ needs Aura Marker
      accuracy_m: null,
    },
    speed: null,                        // m/s — ⚠ derived from position, so null until position is
    battery: d.battery ?? null,         // % or null if the device can't measure it
    flags: flagsObj(d.flags),
    lastCmdSeq: d.lastCmdSeq ?? null,
    heardBy: Object.fromEntries(
      Object.entries(d.gateways || {}).map(([id, g]) => [id, { rssi: g.rssi, t: new Date(g.t).toISOString() }]),
    ),
  };
}

/**
 * Attach the live feed to an existing http.Server.
 * @param {object} o
 * @param {import('http').Server} o.server
 * @param {() => object[]} o.devices   returns live device objects
 * @param {() => object[]} o.gateways  returns gateway objects
 * @param {string} o.serverId
 */
function attachLiveApi({ server, devices, gateways, serverId, intervalMs = 1000 }) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  let last = new Map(); // id -> JSON string, for change detection

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
  function broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(s);
  }

  wss.on("connection", (ws) => {
    send(ws, { type: "hello", schema: SCHEMA, server: serverId, t: new Date().toISOString() });
    send(ws, { type: "snapshot", t: new Date().toISOString(), gateways: gateways(), devices: devices() });
  });

  // Diff on a timer rather than on every radio line: at thousands of devices
  // per second a per-line push would be a firehose of near-identical objects.
  // `lastSeen` and `heardBy.t` are excluded from the comparison — they change
  // on every beacon and would defeat the diff entirely.
  const timer = setInterval(() => {
    if (!wss.clients.size) return;
    const next = new Map();
    for (const d of devices()) {
      const { lastSeen, heardBy, ...cmp } = d;
      const key = JSON.stringify({ ...cmp, heardBy: Object.keys(heardBy) });
      next.set(d.id, key);
      if (last.get(d.id) !== key) broadcast({ type: "device", t: new Date().toISOString(), device: d });
    }
    last = next;
  }, intervalMs);
  timer.unref();

  return {
    event: (e) => broadcast({ type: "event", t: new Date().toISOString(), ...e }),
    gateway: (g) => broadcast({ type: "gateway", t: new Date().toISOString(), gateway: g }),
    clients: () => wss.clients.size,
    close: () => { clearInterval(timer); wss.close(); },
  };
}

module.exports = { attachLiveApi, toLiveDevice, proximityBand, capsList, SCHEMA, PRODUCTS };
