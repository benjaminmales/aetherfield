/**
 * Demo Server — the on-site show brain.
 *
 * Sits between the gateways (wired, local) and the cloud (internet).
 *   gateways --TCP :9000--> [ this ] --HTTPS--> cloud
 *                              |
 *                              +--HTTP :3000--> operator console (local)
 *
 * Deployment target is a Beelink ME Mini on Windows 11 with two NICs: bind the
 * gateway listener to the gateway-subnet NIC and leave the other for internet.
 * No native dependencies — swapping serial for TCP removed the only one — so
 * `npm install && node server.js` is the whole install story on Windows.
 *
 * Design rule: this box must keep working with the internet unplugged. Presence,
 * the roster and the console are all local; the cloud is a queued, retried
 * side-effect and never sits in the path of anything the venue can see.
 */

const path = require("node:path");
const express = require("express");
const { createGatewayLink } = require("./lib/gateway-link");
const { createRoster } = require("./lib/device-roster");
const { parseV2Line, buildCmd, buildOp, buildIdentify, ANIM_NAMES, OP_NAMES } =
  require("./lib/aura-v2");
const { toRosterRow, toAnnotation, strongestGateway } = require("./lib/v2-adapter");
const { createCloud } = require("./lib/cloud");
const { createNames } = require("./lib/names");
const { attachLiveApi, toLiveDevice, SCHEMA } = require("./lib/live-api");
const { createRestV1, createEventLog } = require("./lib/rest-v1");
const { createWebhooks } = require("./lib/webhooks");
const { createHookStore } = require("./lib/hook-store");
const v2 = require("./lib/aura-v2");
const { createBehaviours } = require("./lib/behaviours");
const { createSiteSettings } = require("./lib/site-settings");
const { parseColor } = require("./lib/rest-v1");

require("dotenv").config();

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const HTTP_HOST = process.env.HTTP_HOST || "0.0.0.0";
const GW_PORT = Number(process.env.GATEWAY_PORT || 9000);
const GW_HOST = process.env.GATEWAY_HOST || "0.0.0.0";
const SERVER_ID = process.env.SERVER_ID || "srv-1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LOCATE_S = 10;

// The aura-registration deployment: names, phone numbers, Twilio. Leave it
// empty and everything below still works minus messaging — see lib/cloud.js.
const CLOUD_URL = process.env.CLOUD_URL || "";
// Must match CLOUD_API_TOKEN on that deployment.
const CLOUD_TOKEN = process.env.CLOUD_TOKEN || "";

const startedAt = Date.now();
// Devices beacon every 5 s (AURA_BEACON_DEFAULT_MS). Offline after four
// missed beacons, not two: one lost frame in a busy room must not make a
// device flap offline and back, which would also fire presence behaviours.
const ONLINE_MS = Number(process.env.ONLINE_MS || 20_000);
const roster = createRoster({ onlineMs: ONLINE_MS });
const cloud = createCloud({ baseUrl: CLOUD_URL, apiToken: CLOUD_TOKEN });
const names = createNames(path.join(DATA_DIR, "names.json"));
const site = createSiteSettings(path.join(DATA_DIR, "settings.json"));

/** Set once the HTTP server is up. Until then there is nobody to tell. */
let live = null;

const events = createEventLog();
const hookStore = createHookStore(path.join(DATA_DIR, "hooks.json"));
const hooks = createWebhooks({ hooks: hookStore.list, gatewayId: SERVER_ID });
const behaviours = createBehaviours({
  file: path.join(DATA_DIR, "behaviours.json"),
  // `link` is created further down (it needs emit()); resolve it at call time.
  link: { send: (id, line) => link.send(id, line), broadcast: (line) => link.broadcast(line) },
  buildCmd: v2.buildCmd,
  parseColor,
  anims: v2.ANIM_NAMES,
  device: liveDevice,
  cloud,
  log,
});

/**
 * One place every fleet event goes: the REST event log (cursor-paged), the
 * /ws feed, and any configured webhooks. Webhook payloads carry `device`
 * (the address) because that is the field lib/webhooks.js keys cooldowns on.
 */
function emit(kind, e) {
  const item = events.push({ kind, ...e });
  live?.event(item);
  hooks.dispatch({ kind, device: e.id, ...e, seq: item.seq });
  behaviours.handle(item);
}

function gatewayView(g) {
  return { ...g, name: names.gateway(g.id) };
}

function liveDevices(now = Date.now()) {
  return roster.list().map((d) =>
    toLiveDevice(d, { names, strongest: strongestGateway(d, 30_000, now), prox: site.get().proximity }));
}

function liveDevice(id) {
  return liveDevices().find((d) => d.id === id) || null;
}

// Ring buffer of recent raw lines — the first thing you want when a gateway is
// misbehaving and you are standing in a venue with no debugger.
const recent = [];
const RECENT_MAX = 200;
function pushRecent(entry) {
  recent.push(entry);
  while (recent.length > RECENT_MAX) recent.shift();
}

const counters = { lines: 0, parsed: 0, mirrored: 0, unparsed: 0, beacons: 0, events: 0, contacts: 0 };

/**
 * Lines the gateway is EXPECTED to send that are not telemetry.
 *
 * gw_emit() mirrors the gateway's whole console to the link, so alongside each
 * '<BCN' comes its legacy 'NODE:' twin, and every command it transmits is
 * echoed as '>CMD' / '>SYNC' / '>HOP' / '>READY'. All of that is normal
 * traffic. Counting it as "unparsed" makes that counter climb forever in
 * healthy operation, which is worse than not having it: a number that is
 * always large is a number nobody reads, and the one line that genuinely is
 * malformed disappears into it.
 */
const MIRRORED_RE = /^(NODE:|>)/;

/** Devices keyed by uuid -> our own annotation shadow (gateway attribution). */
const annotations = new Map();

const link = createGatewayLink({
  port: GW_PORT,
  host: GW_HOST,
  onConnect: (gw) => {
    log("gateway_connect", { conn: gw.connKey, remote: gw.remote });
    live?.gateway({ id: gw.id ?? null, remote: gw.remote, connected: true });
  },
  onDisconnect: (gw, reason) => {
    log("gateway_disconnect", { gw: gw.id, remote: gw.remote, reason });
    live?.gateway({ id: gw.id ?? null, name: names.gateway(gw.id), remote: gw.remote, connected: false, reason });
  },
  onLine: (line, gw) => {
    counters.lines += 1;
    const t = Date.now();
    const v2 = parseV2Line(line);

    if (!v2) {
      const mirrored = MIRRORED_RE.test(line);
      if (mirrored) counters.mirrored += 1;
      else counters.unparsed += 1;
      pushRecent({ t, gw: gw.id, line, parsed: false, mirrored });
      return;
    }

    counters.parsed += 1;
    if (v2.kind === "beacon") counters.beacons += 1;
    else if (v2.kind === "event") counters.events += 1;
    else if (v2.kind === "contact") counters.contacts += 1;

    const row = toRosterRow(v2);
    if (row) roster.ingest(row);

    const prev = annotations.get(v2.uuid) || {};
    const ann = toAnnotation(v2, gw.id, t, prev);
    annotations.set(v2.uuid, { ...prev, ...ann });
    roster.annotate(v2.uuid, ann);

    if (v2.kind === "event") {
      emit("event", {
        id: v2.uuid,
        niceName: names.device(v2.uuid),
        event: v2.event,          // motion | gesture (| button/nfc from lab devices)
        value: v2.value,          // motion: 1 started moving, 0 came to rest
        strength: v2.strength,
        rssi: v2.rssi,
        zone: gw.id ? { id: gw.id, name: names.gateway(gw.id) } : null,
      });
    }

    pushRecent({ t, gw: gw.id, line, parsed: true, kind: v2.kind, uuid: v2.uuid });
  },
});

function log(type, obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), type, ...obj }));
}

/* ------------------------------------------------------------------ HTTP -- */
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// The wiki's "Open Demo Server" button probes this from aetherfield.ai to see
// whether the server is running on this machine, so it must be readable
// cross-origin (and from a public page to a local address).
app.options("/health", (_req, res) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Private-Network": "true" }).sendStatus(204);
});
app.get("/health", (_req, res) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Private-Network": "true" });
  res.json({
    ok: true,
    serverId: SERVER_ID,
    uptimeMs: Date.now() - startedAt,
    gatewayPort: GW_PORT,
    gateways: link.list().length,
    ...roster.stats(),
    counters,
    cloud: cloud.stats(),
  });
});

app.get("/api/gateways", (_req, res) => {
  res.json({ serverId: SERVER_ID, gateways: link.list().map(gatewayView) });
});

/** Flash a Link's status LED white so someone on a ladder can find it. */
app.post("/api/gateways/:id/locate", (req, res) => {
  const s = Math.min(Math.max(Number(req.body?.seconds) || LOCATE_S, 1), 300);
  const ok = link.send(req.params.id, `link locate ${s}`);
  if (!ok) return res.status(404).json({ error: `Link ${req.params.id} is not connected` });
  log("locate", { gw: req.params.id, seconds: s });
  res.json({ ok: true, seconds: s });
});

/* ---------------------------------------------------------------- live -- */

/** Same objects the /ws feed pushes, for clients that would rather poll. */
app.get("/api/live", (_req, res) => {
  res.json({
    schema: SCHEMA,
    server: SERVER_ID,
    t: new Date().toISOString(),
    gateways: link.list().map(gatewayView),
    devices: liveDevices(),
  });
});

app.get("/api/names", (_req, res) => res.json(names.all()));

app.put("/api/names/devices/:id", (req, res) => {
  try {
    res.json({ ok: true, id: req.params.id, name: names.setDevice(req.params.id, req.body?.name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/names/gateways/:id", (req, res) => {
  try {
    const name = names.setGateway(req.params.id, req.body?.name);
    live?.gateway({ id: req.params.id, name, renamed: true });
    res.json({ ok: true, id: req.params.id, name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/devices", (_req, res) => {
  const now = Date.now();
  // Fire-and-forget: serves whatever the cache already holds and warms it for
  // the next poll. The console must never wait on Vercel to draw the fleet.
  cloud.refresh();
  const devices = roster.list().map((d) => {
    const reg = cloud.lookup(d.uuid);
    return {
      ...d,
      strongestGateway: strongestGateway(d, 30_000, now),
      deviceId: cloud.deviceId(d.uuid),
      // Name only. The phone number stays in the cloud tier and is never
      // serialised here — same boundary lib/webhooks.js keeps.
      registeredName: reg?.name ?? null,
      registered: Boolean(reg),
    };
  });
  res.json({ ...roster.stats(), serverId: SERVER_ID, now: new Date().toISOString(), devices });
});

app.get("/api/recent", (req, res) => {
  const n = Math.min(Number(req.query.n) || 50, RECENT_MAX);
  res.json({ lines: recent.slice(-n) });
});

/**
 * Downlink. `gw` selects one gateway, omit it to hit them all.
 * `dst` makes it unicast to a single device; omit for the whole group.
 */
app.post("/api/cmd", (req, res) => {
  let line;
  try {
    line = buildCmd(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const sent = req.body.gw ? (link.send(req.body.gw, line) ? 1 : 0) : link.broadcast(line);
  if (!sent) return res.status(503).json({ error: "No gateway connected", line });
  log("cmd", { line, sent, gw: req.body.gw || "*" });
  res.json({ ok: true, line, gatewaysSent: sent });
});

app.post("/api/op", (req, res) => {
  let line;
  try {
    line = buildOp(req.body?.mode, req.body?.param);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const sent = req.body.gw ? (link.send(req.body.gw, line) ? 1 : 0) : link.broadcast(line);
  if (!sent) return res.status(503).json({ error: "No gateway connected", line });
  log("op", { line, sent });
  res.json({ ok: true, line, gatewaysSent: sent });
});

app.post("/api/identify", (req, res) => {
  let line;
  try {
    line = buildIdentify(req.body?.addr);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const sent = req.body.gw ? (link.send(req.body.gw, line) ? 1 : 0) : link.broadcast(line);
  if (!sent) return res.status(503).json({ error: "No gateway connected", line });
  log("identify", { line, sent });
  res.json({ ok: true, line, gatewaysSent: sent });
});

/* --------------------------------------------------------------- cloud -- */

/** Who has registered. Cached; `?force=1` goes to the app. */
app.get("/api/registrations", async (req, res) => {
  if (!cloud.configured()) {
    return res.status(503).json({ error: "CLOUD_URL is not set", registrations: [] });
  }
  await cloud.refresh(req.query.force === "1");
  // Numbers are deliberately not returned to the browser.
  const registrations = cloud
    .registrations()
    .map(({ deviceId, name, updatedAt }) => ({ deviceId, name, updatedAt }));
  res.json({ registrations, cloud: cloud.stats() });
});

/**
 * Text whoever registered this device.
 *
 * The local server never sees the number: it posts the ADDRESS and the text to
 * aura-registration, which resolves the contact and calls Twilio. With no
 * Twilio env set that app answers {dryRun:true, preview} — which is what you
 * want when rehearsing, so the reply is passed straight back rather than being
 * flattened into "sent".
 */
app.post("/api/message", async (req, res) => {
  const addr = req.body?.addr ?? req.body?.uuid ?? req.body?.device_id;
  try {
    const out = await cloud.send(addr, req.body?.message);
    log("message", { device: out.deviceId, dryRun: Boolean(out.dryRun) });
    res.json({ ok: true, ...out });
  } catch (e) {
    log("message_failed", { device: cloud.deviceId(addr), error: e.message });
    // e.status is the registration app's own code where it had one; 502 means
    // we could not reach it at all, which is a different problem on the night.
    res.status(e.status || 502).json({ error: e.message });
  }
});

/* ------------------------------------------------- client API, v1 -- */
app.use("/api/v1", createRestV1({
  devices: () => liveDevices(),
  zones: () => link.list().map(gatewayView),
  names,
  link,
  v2,
  events,
  hooks: { list: hookStore.list, add: hookStore.add, remove: hookStore.remove, stats: hooks.stats },
  behaviours,
  site,
  serverId: SERVER_ID,
  schema: SCHEMA,
  log,
}));

/*
 * Fleet transitions, once a second, independent of whether anyone is
 * watching: zone changes (strongest Link changed) and presence (a device came
 * online or went quiet). These are the events client software most often
 * wants pushed — "guest arrived at the bar" — so they go through emit().
 * A device's first sighting is presence/online only, not also a zone change.
 */
const fleetState = new Map(); // id -> { zone, online }
setInterval(() => {
  for (const d of liveDevices()) {
    const prev = fleetState.get(d.id);
    const zone = d.zone?.id ?? null;
    const base = { id: d.id, niceName: d.niceName, product: d.product };
    if (!prev) {
      if (d.online) emit("presence", { ...base, state: "online", zone: d.zone });
    } else {
      if (prev.online !== d.online) emit("presence", { ...base, state: d.online ? "online" : "offline", zone: d.zone });
      if (d.online && zone && prev.zone !== zone) {
        emit("zone", { ...base, from: prev.zone ? { id: prev.zone, name: names.gateway(prev.zone) } : null, to: d.zone, rssi: d.rssi });
      }
    }
    fleetState.set(d.id, { zone: d.online ? zone : prev?.zone ?? null, online: d.online });
  }
}, 1000).unref();

app.get("/api/meta", (_req, res) => {
  res.json({ anims: ANIM_NAMES, ops: OP_NAMES, serverId: SERVER_ID, cloud: cloud.configured() });
});

/* ------------------------------------------------------------------ boot -- */
async function main() {
  const { port, host } = await link.listen();
  log("gateway_listener", { host, port });

  setInterval(() => {
    const n = link.reapIdle();
    if (n) log("gateway_reaped", { count: n });
  }, 30_000).unref();

  if (cloud.configured()) {
    log("cloud", { url: CLOUD_URL, token: Boolean(CLOUD_TOKEN) });
    cloud.refresh(true);
  } else {
    log("cloud", { url: null, note: "CLOUD_URL unset - messaging disabled" });
  }

  const http = app.listen(HTTP_PORT, HTTP_HOST, () => {
    log("http_listener", { host: HTTP_HOST, port: HTTP_PORT });
    log("ready", { serverId: SERVER_ID, console: `http://localhost:${HTTP_PORT}/`, live: `ws://localhost:${HTTP_PORT}/ws` });
  });
  live = attachLiveApi({
    server: http,
    serverId: SERVER_ID,
    devices: () => liveDevices(),
    gateways: () => link.list().map(gatewayView),
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", e.message);
    process.exit(1);
  });
}

module.exports = { app, link, roster, cloud, names };
