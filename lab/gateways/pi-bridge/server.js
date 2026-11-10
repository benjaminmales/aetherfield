"use strict";

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const { writeLocalFile, readLocalFile, loadMergedConfig, maskKey } = require("./lib/config-store");
const { loadQueue, persistQueue } = require("./lib/telemetry-queue");
const net = require("./lib/network");
const { startArtNet } = require("./lib/artnet");
const dmxMap = require("./lib/dmx-map");
const { createRoster } = require("./lib/device-roster");
const votes = require("./lib/votes");
const auraV2 = require("./lib/aura-v2");
const { createWebhooks } = require("./lib/webhooks");

require("dotenv").config({ path: path.join(__dirname, ".env") });

function findSerialPort() {
  const candidates = [
    "/dev/ttyACM0",          // USB CDC (dev/bench)
    "/dev/ttyACM1",
    "/dev/ttyUSB0",
    "/dev/tty.usbmodem7E2605BA3",
    "/dev/serial0",          // Pi GPIO UART (HAT) — symlink to the primary UART
    "/dev/ttyAMA0",          // Pi 5 PL011 on GPIO14/15
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* continue */
    }
  }
  return "/dev/ttyACM0";
}

/** @type {ReturnType<loadMergedConfig>} */
let config = loadMergedConfig(findSerialPort);

// Pin the resolved gateway serial into config.local.json the first time we see a
// valid one. Makes it explicit, visible in /health, and stable even if .env is
// removed. A freshly-imaged Pi re-derives the same value from its CPU serial.
try {
  if (
    config.gatewayHardwareId &&
    config.gatewayHardwareId !== "gw-unknown" &&
    !readLocalFile().gatewayHardwareId
  ) {
    writeLocalFile({ gatewayHardwareId: config.gatewayHardwareId });
  }
} catch {
  /* non-fatal */
}

let supabase = null;
let flushTimer = null;

function rebuildSupabase() {
  if (config.supabaseUrl && config.supabaseServiceRoleKey) {
    supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } else {
    supabase = null;
  }
}

rebuildSupabase();
scheduleFlush(1500);

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

const recentLines = [];
const MAX_RECENT = 40;
let lastRxAt = null;
let serialPort = null;
let parser = null;
let cloudInsertOkAt = null;
let cloudInsertError = "";
let serverPostOkAt = null;
let serverPostError = "";
let telemetryQueue = loadQueue();
let resolvingProject = null;
// Local roster of bands we can hear. Independent of the uplink so the
// console still works with no internet (presence otherwise lives only in
// the cloud tier - see insertTelemetry).
const roster = createRoster();

// Outbound triggers to machines on the venue LAN (TouchDesigner, media
// servers, lighting controllers). See WHITEPAPER 7.3: this fires from the
// gateway, not the cloud, because the receiving machine is behind the venue's
// NAT and the gateway is already on the same wire.
const webhooks = createWebhooks({
  hooks: () => (Array.isArray(config.webhooks) ? config.webhooks : []),
  gatewayId: config.gatewayHardwareId,
});

// directDMX state
let artnetHandle = null;
let dmxMapper = null;
let dmxListening = false;
let dmxLastFrame = null;      // last patched-channel raw values (for the live monitor)
let dmxLastDecoded = null;    // last decoded {mode,rate,r,g,b}
let dmxPackets = 0;
let dmxLastPacketAt = null;
let dmxError = "";
const MAX_QUEUE_ITEMS = 2000;
const PROJECT_LOOKUP_TTL_MS = 60_000;
let projectLookupCache = { at: 0, projectId: null };

function pushRecent(line) {
  lastRxAt = new Date().toISOString();
  recentLines.push({ t: lastRxAt, line });
  while (recentLines.length > MAX_RECENT) recentLines.shift();
}

/** Strip Zephyr shell / VT100 CSI sequences so NODE: lines parse reliably. */
function stripAnsi(str) {
  return String(str).replace(/\x1b\[[\d;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Gateway uses one UART for both shell (uart:~$) and printk (NODE:...). Lines often
 * arrive as "prompt + escapes + NODE:...". Parse/log only from NODE: onward.
 */
function extractNodeLine(cleaned) {
  const idx = cleaned.search(/\bNODE:\s*id=/i);
  if (idx < 0) return null;
  return cleaned.slice(idx).trim();
}

const UUID_DASHED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function telemetryProjectIdForInsert() {
  const v = config.telemetryProjectId;
  if (!v || typeof v !== "string") return null;
  const t = v.trim();
  return UUID_DASHED.test(t) ? t : null;
}

async function resolveBoundProjectId() {
  const now = Date.now();
  if (now - projectLookupCache.at < PROJECT_LOOKUP_TTL_MS) {
    return projectLookupCache.projectId;
  }
  if (!supabase || !config.gatewayHardwareId) return null;
  if (resolvingProject) return resolvingProject;

  resolvingProject = (async () => {
    const { data, error } = await supabase
      .from("device_bindings")
      .select("project_id")
      .eq("kind", "gateway")
      .eq("hardware_id", config.gatewayHardwareId)
      .order("bound_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[bindings]", error.message);
      projectLookupCache = { at: now, projectId: null };
      return null;
    }
    const projectId = data?.project_id || null;
    projectLookupCache = { at: now, projectId };
    return projectId;
  })();

  try {
    return await resolvingProject;
  } finally {
    resolvingProject = null;
  }
}

async function telemetryProjectIdForInsertAsync() {
  const bound = await resolveBoundProjectId();
  if (bound) return bound;
  return telemetryProjectIdForInsert();
}

function parseTelemetryLine(trimmedLine) {
  const nodeMatch = trimmedLine.match(/NODE:\s*id=(\d+)/i);
  const nodeId = nodeMatch ? parseInt(nodeMatch[1], 10) : null;
  const uuidMatch = trimmedLine.match(/UUID:\s*(0x[0-9A-Fa-f]+|\d+)/i);
  const rssiMatch = trimmedLine.match(/RSSI:\s*(-?\d+)/i);
  const gestureMatch = trimmedLine.match(/Gesture:\s*(\w+)\s*\((\d+)\)/i);
  // v2 gateways append these to the legacy line; v0/v1 gateways do not.
  const capsMatch = trimmedLine.match(/Caps:\s*(0x[0-9A-Fa-f]+|\d+)/i);
  const battMatch = trimmedLine.match(/Batt:\s*(\d+)/i);
  if (!uuidMatch && !rssiMatch && !gestureMatch) return null;
  const uuid = uuidMatch ? uuidMatch[1] : null;
  const rssi = rssiMatch ? parseInt(rssiMatch[1], 10) : null;
  const gesture = gestureMatch ? gestureMatch[1] : null;
  const gestureCode = gestureMatch ? parseInt(gestureMatch[2], 10) : null;
  let bandId = null;
  if (uuid) {
    try {
      const hexStr = String(uuid).replace(/^0x/i, "");
      const hexValue = parseInt(hexStr, 16);
      const lastByte = hexValue & 0xff;
      if (lastByte >= 1 && lastByte <= 10) {
        bandId = String(lastByte);
      } else {
        bandId = String((hexValue % 10) + 1);
      }
    } catch {
      bandId = null;
    }
  }
  const capsRaw = capsMatch ? capsMatch[1] : null;
  const caps = capsRaw
    ? parseInt(String(capsRaw).replace(/^0x/i, ""), /^0x/i.test(capsRaw) ? 16 : 10)
    : null;
  // 0xFF is the protocol's "battery unknown" sentinel, not 255 percent.
  const battRaw = battMatch ? parseInt(battMatch[1], 10) : null;
  const battery = battRaw === null || battRaw === 0xff ? null : battRaw;
  return {
    node_id: nodeId,
    band_id: bandId,
    uuid,
    rssi,
    gesture,
    gesture_code: gestureCode,
    caps: Number.isFinite(caps) ? caps : null,
    battery,
    raw_line: trimmedLine,
  };
}

async function insertTelemetryNow(row, projectId) {
  if (!supabase) return;
  const payload = {
    project_id: projectId,
    gateway_hardware_id: config.gatewayHardwareId,
    node_id: row.node_id,
    band_id: row.band_id,
    rssi: row.rssi,
    gesture: row.gesture,
    gesture_code: row.gesture_code,
    raw_line: row.raw_line,
  };
  const { error } = await supabase.from("gateway_telemetry").insert(payload);
  if (error) throw error;
}

/**
 * Physical mode: POST one telemetry row to the local Server.
 * Contract (the Server implements this): POST {serverUrl}/api/telemetry
 *   body: { gateway_hardware_id, node_id, band_id, rssi, gesture, gesture_code, raw_line, ... }
 */
async function postTelemetryToServer(row) {
  if (!config.serverUrl) throw new Error("No Server URL configured (server uplink)");
  if (typeof fetch !== "function") throw new Error("fetch unavailable — Node 18+ required");
  const res = await fetch(config.serverUrl + "/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gateway_hardware_id: config.gatewayHardwareId, ...row }),
  });
  if (!res.ok) throw new Error(`Server HTTP ${res.status}`);
}

/** Deliver one row to whichever destination the current uplink dictates. */
async function deliverTelemetry(row) {
  if (config.uplink === "server") {
    await postTelemetryToServer(row);
    return;
  }
  const projectId = await telemetryProjectIdForInsertAsync();
  await insertTelemetryNow(row, projectId);
}

function markDeliverOk() {
  if (config.uplink === "server") { serverPostOkAt = new Date().toISOString(); serverPostError = ""; }
  else { cloudInsertOkAt = new Date().toISOString(); cloudInsertError = ""; }
}
function markDeliverErr(e) {
  const msg = (e && e.message) || "Telemetry delivery failed";
  if (config.uplink === "server") serverPostError = msg; else cloudInsertError = msg;
}

function queueTelemetry(row) {
  if (!row) return;
  telemetryQueue.push({
    ...row,
    queued_at: new Date().toISOString(),
  });
  if (telemetryQueue.length > MAX_QUEUE_ITEMS) {
    telemetryQueue = telemetryQueue.slice(telemetryQueue.length - MAX_QUEUE_ITEMS);
  }
  persistQueue(telemetryQueue);
}

async function flushTelemetryQueue() {
  if (telemetryQueue.length === 0) return;
  if (config.uplink === "none") return;
  if (config.uplink === "cloud" && !supabase) return;
  if (config.uplink === "server" && !config.serverUrl) return;
  while (telemetryQueue.length > 0) {
    const next = telemetryQueue[0];
    try {
      await deliverTelemetry(next);
      telemetryQueue.shift();
      markDeliverOk();
      persistQueue(telemetryQueue);
    } catch (e) {
      markDeliverErr(e);
      break;
    }
  }
}

function scheduleFlush(delayMs = 3000) {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      await flushTelemetryQueue();
    } catch (e) {
      cloudInsertError = e.message || "Queue flush failed";
    }
    if (telemetryQueue.length > 0) scheduleFlush(5000);
  }, delayMs);
}

let lastGatewayPresenceAtMs = 0;
async function touchGatewayPresence() {
  if (config.uplink !== "cloud") return; // presence lives in the cloud tier only
  if (!supabase || !config.gatewayHardwareId) return;
  const now = Date.now();
  if (now - lastGatewayPresenceAtMs < 30_000) return;
  lastGatewayPresenceAtMs = now;
  const { error } = await supabase.from("physical_devices").upsert(
    {
      hardware_id: config.gatewayHardwareId,
      kind: "gateway",
      label: config.gatewayHardwareId,
      last_seen: new Date().toISOString(),
    },
    { onConflict: "hardware_id" }
  );
  if (error) {
    console.error("[gateway_presence]", error.message);
  }
}

async function insertTelemetry(row) {
  // uplink=none: directDMX-only activation, no presence reporting — drop silently.
  if (config.uplink === "none") return;
  // Cloud uplink needs Supabase; server uplink needs a Server URL. If the destination
  // isn't configured yet, queue so nothing is lost and it replays once it is.
  if (config.uplink === "cloud" && !supabase) { queueTelemetry(row); return; }
  if (config.uplink === "server" && !config.serverUrl) { queueTelemetry(row); return; }
  try {
    await deliverTelemetry(row);
    markDeliverOk();
  } catch (e) {
    markDeliverErr(e);
    queueTelemetry(row);
    scheduleFlush(2000);
  }
  await touchGatewayPresence();
}

function initSerial() {
  if (serialPort) {
    try {
      parser?.destroy();
      if (serialPort.isOpen) serialPort.close();
    } catch {
      /* ignore */
    }
    serialPort.removeAllListeners();
    serialPort = null;
    parser = null;
  }

  const pathSerial = config.serialPort;
  console.log(`Opening serial ${pathSerial} @ 115200`);
  serialPort = new SerialPort({
    path: pathSerial,
    baudRate: 115200,
    autoOpen: false,
  });
  parser = serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));

  serialPort.on("open", () => console.log("Serial open"));
  serialPort.on("error", (err) => console.error("Serial error:", err.message));
  parser.on("data", (data) => {
    const cleaned = stripAnsi(data.toString()).replace(/\r$/, "").trim();
    if (!cleaned) return;

    // Live vote state (EVENT: button lines + BEACON gesture re-sync).
    // Feeds the /votes visualiser over SSE; NODE: lines continue below
    // into the normal telemetry path.
    const vote = votes.ingestLine(cleaned);
    if (vote) {
      console.log(JSON.stringify({ type: "vote", ...vote }));
      if (!/\bNODE:\s*id=/i.test(cleaned)) pushRecent(cleaned);
    }

    // v2 structured lines. The gateway prints <BCN *and* its legacy NODE:
    // twin for the same beacon, so this branch must never ingest telemetry -
    // that would double every packet count and every cloud insert. It
    // annotates only. <EVT button/nfc and <CON have no legacy twin at all,
    // which is the whole reason this branch exists.
    const v2 = auraV2.parseV2Line(cleaned);
    if (v2) {
      console.log(JSON.stringify({ type: "serial_rx", line: cleaned }));
      if (!vote) pushRecent(cleaned); // the vote path above already pushed it
      if (v2.kind === "beacon") {
        const seen = roster.annotate(v2.uuid, {
          flags: v2.flags,
          lastCmdSeq: v2.cmd_seq,
          caps: v2.caps,
          battery: v2.battery,
        });
        // First time we have ever heard this device: someone walked in.
        if (seen && seen.packets === 1) {
          webhooks.dispatch({ kind: "presence", device: v2.uuid, event: "enter", rssi: v2.rssi });
        }
      } else if (v2.kind === "contact") {
        roster.annotate(v2.uuid, {
          lastContact: {
            peer: v2.peer,
            rssi: v2.peer_rssi,
            event: v2.event,
            at: new Date().toISOString(),
          },
        });
        webhooks.dispatch({
          kind: "contact",
          device: v2.uuid,
          peer: v2.peer,
          event: v2.event,
          rssi: v2.peer_rssi,
        });
      } else if (v2.kind === "event") {
        webhooks.dispatch({
          kind: "event",
          device: v2.uuid,
          event: v2.event,
          value: v2.value,
          strength: v2.strength,
          rssi: v2.rssi,
        });
      }
      return;
    }

    const nodeLine = extractNodeLine(cleaned);
    if (nodeLine) {
      console.log(JSON.stringify({ type: "serial_rx", line: nodeLine }));
      pushRecent(nodeLine);
      const parsed = parseTelemetryLine(nodeLine);
      if (parsed) roster.ingest(parsed);
      if (parsed && (parsed.uuid || parsed.rssi !== null)) {
        void insertTelemetry(parsed);
      }
      return;
    }

    if (!/\buart:~\$/i.test(cleaned)) {
      console.log(JSON.stringify({ type: "serial_rx", line: cleaned }));
      pushRecent(cleaned);
    }
  });

  serialPort.open((err) => {
    if (err) console.error("Serial open failed:", err.message);
  });
}

async function sendAuraCommand(mode, rate, r, g, b) {
  if (!serialPort?.isOpen) throw new Error("Serial not open");
  const command = `aura ${mode} ${rate} ${r} ${g} ${b}\r`;
  await new Promise((resolve, reject) => {
    serialPort.write(Buffer.from(command, "ascii"), (e) => (e ? reject(e) : resolve()));
  });
  await new Promise((resolve, reject) => {
    serialPort.drain((e) => (e ? reject(e) : resolve()));
  });
  return true;
}

/**
 * Write one already-built gateway shell line. sendAuraCommand() above is the
 * v0 compat path (`aura <mode> <rate> <r> <g> <b>`) and stays exactly as it
 * was - directDMX and /api/led depend on it. This is the v2 path; command
 * strings are built by lib/aura-v2.js, never interpolated at the call site.
 */
async function sendShellLine(line) {
  if (!serialPort?.isOpen) throw new Error("Serial not open");
  if (/[\r\n]/.test(line)) throw new Error("Illegal newline in command");
  await new Promise((resolve, reject) => {
    serialPort.write(Buffer.from(line + "\r", "ascii"), (e) => (e ? reject(e) : resolve()));
  });
  await new Promise((resolve, reject) => {
    serialPort.drain((e) => (e ? reject(e) : resolve()));
  });
  return line;
}

function fieldAdminToken(req) {
  const expected = process.env.FIELD_ADMIN_TOKEN || "";
  if (!expected) return null;
  const hdr = req.headers.authorization || "";
  const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  const q = String(req.query.token || "").trim();
  const bodyTok = req.body && typeof req.body.adminToken === "string" ? req.body.adminToken.trim() : "";
  return bearer || q || bodyTok;
}

function requireFieldAdmin(req, res, next) {
  const expected = process.env.FIELD_ADMIN_TOKEN || "";
  if (!expected) {
    return res.status(503).json({
      error: "FIELD_ADMIN_TOKEN is not set. Add it to .env on the Pi before using field setup.",
    });
  }
  const got = fieldAdminToken(req);
  if (got !== expected) {
    return res.status(401).json({ error: "Invalid or missing admin token" });
  }
  next();
}

const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
let listenPort = config.httpPort;

app.use(
  express.static(path.join(__dirname, "public"), {
    etag: false,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// --- Captive portal -------------------------------------------------------
// When a phone joins the setup AP, the OS probes these URLs to check for
// internet. The AP's dnsmasq resolves every hostname to this Pi and :80 is
// redirected to this port, so the probes land here — we answer by sending the
// device to the setup page, which makes the "Sign in to network" sheet open
// straight onto /field-setup.html. Harmless when not on the AP (nobody hits them).
const SETUP_PATH = "/field-setup.html";
app.get(["/generate_204", "/gen_204"], (_req, res) => res.redirect(302, SETUP_PATH)); // Android
app.get(["/ncsi.txt", "/connecttest.txt"], (_req, res) => res.redirect(302, SETUP_PATH)); // Windows
app.get(["/hotspot-detect.html", "/library/test/success.html"], (_req, res) =>
  res
    .type("html")
    .send(
      `<!doctype html><meta http-equiv="refresh" content="0;url=${SETUP_PATH}"><title>Gateway setup</title><a href="${SETUP_PATH}">Open gateway setup</a>`
    )
); // Apple

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    serialPath: config.serialPort,
    serialOpen: Boolean(serialPort?.isOpen),
    lastRxAt,
    gatewayHardwareId: config.gatewayHardwareId,
    gatewayShortCode: config.gatewayShortCode,
    mdnsName: config.mdnsName,
    uplink: config.uplink,
    control: config.control,
    dmxListening,
    mode: config.mode,
    serverUrl: config.serverUrl || null,
    telemetryProjectId: config.telemetryProjectId,
    supabaseConfigured: Boolean(supabase),
    cloudInsertOkAt,
    cloudInsertError: cloudInsertError || null,
    serverPostOkAt,
    serverPostError: serverPostError || null,
    queuedTelemetry: telemetryQueue.length,
    fieldSetupEnabled: Boolean(process.env.FIELD_ADMIN_TOKEN),
  });
});

// Bands heard by this gateway. Local-only: no Supabase, no internet needed.
app.get("/api/devices", (_req, res) => {
  const devices = roster.list();
  const stats = roster.stats();
  res.json({
    ...stats,
    serialOpen: Boolean(serialPort?.isOpen),
    lastRxAt,
    gatewayHardwareId: config.gatewayHardwareId,
    now: new Date().toISOString(),
    devices,
  });
});

// Outbound trigger state: what is configured, what fired, what failed.
app.get("/api/webhooks", (_req, res) => res.json(webhooks.stats()));

app.get("/api/status", (_req, res) => {
  res.json({
    connected: Boolean(serialPort?.isOpen),
    port: config.serialPort,
    lastRxAt,
    recent: recentLines.slice(-15),
  });
});

app.get("/api/field-config", requireFieldAdmin, (_req, res) => {
  res.json({
    serialPort: config.serialPort,
    gatewayHardwareId: config.gatewayHardwareId,
    gatewayShortCode: config.gatewayShortCode,
    mdnsName: config.mdnsName,
    wifiRegion: config.wifiRegion,
    uplink: config.uplink,
    control: config.control,
    dmx: config.dmx,
    mode: config.mode,
    serverUrl: config.serverUrl || "",
    telemetryProjectId: config.telemetryProjectId || "",
    supabaseUrl: config.supabaseUrl,
    supabaseServiceRoleKeyMasked: maskKey(config.supabaseServiceRoleKey),
    supabaseServiceRoleKeySet: Boolean(config.supabaseServiceRoleKey),
    httpPort: config.httpPort,
    listenPort,
    httpPortRestartRequired: config.httpPort !== listenPort,
  });
});

app.post("/api/field-config", requireFieldAdmin, (req, res) => {
  const b = req.body || {};
  const patch = {};

  if (typeof b.serialPort === "string" && b.serialPort.trim()) {
    patch.serialPort = b.serialPort.trim();
  }
  if (typeof b.gatewayHardwareId === "string" && b.gatewayHardwareId.trim()) {
    patch.gatewayHardwareId = b.gatewayHardwareId.trim();
  }
  if (typeof b.uplink === "string") {
    const u = b.uplink.toLowerCase();
    patch.uplink = ["none", "cloud", "server"].includes(u) ? u : "cloud";
  } else if (typeof b.mode === "string") {
    // legacy: mode cloud|physical -> uplink cloud|server
    patch.uplink = b.mode.toLowerCase() === "physical" ? "server" : "cloud";
  }
  if (typeof b.control === "string") {
    const c = b.control.toLowerCase();
    patch.control = ["none", "dmx", "cloud", "server"].includes(c) ? c : "none";
  }
  if (b.dmx && typeof b.dmx === "object") {
    const d = b.dmx;
    const cur = config.dmx || {};
    const clampI = (v, lo, hi, def) => {
      const n = parseInt(String(v), 10);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    patch.dmx = {
      universe: clampI(d.universe, 0, 32767, cur.universe ?? 0),
      startChannel: clampI(d.startChannel, 1, 512, cur.startChannel ?? 1),
      layout: ["mrgb", "rgb"].includes(String(d.layout)) ? String(d.layout) : cur.layout || "mrgb",
      fixedMode: clampI(d.fixedMode, 0, 7, cur.fixedMode ?? 1),
      fixedRate: clampI(d.fixedRate, 0, 255, cur.fixedRate ?? 128),
      debounceMs: clampI(d.debounceMs, 0, 1000, cur.debounceMs ?? 60),
    };
  }
  if (typeof b.wifiRegion === "string" && b.wifiRegion.trim()) {
    patch.wifiRegion = b.wifiRegion.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  }
  if (typeof b.serverUrl === "string") {
    patch.serverUrl = b.serverUrl.trim().replace(/\/+$/, "");
  }
  if ("telemetryProjectId" in b) {
    patch.telemetryProjectId =
      typeof b.telemetryProjectId === "string" && b.telemetryProjectId.trim()
        ? b.telemetryProjectId.trim()
        : null;
  }
  if (typeof b.supabaseUrl === "string") {
    patch.supabaseUrl = b.supabaseUrl.trim();
  }
  if (typeof b.supabaseServiceRoleKey === "string" && b.supabaseServiceRoleKey.trim()) {
    patch.supabaseServiceRoleKey = b.supabaseServiceRoleKey.trim();
  }
  if (b.httpPort !== undefined && b.httpPort !== null && String(b.httpPort).length > 0) {
    const p = parseInt(String(b.httpPort), 10);
    if (p >= 1 && p <= 65535) patch.httpPort = p;
  }

  try {
    writeLocalFile(patch);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Failed to save config" });
  }

  config = loadMergedConfig(findSerialPort);
  rebuildSupabase();
  projectLookupCache = { at: 0, projectId: null };
  initSerial();
  initDmx();
  scheduleFlush(1000);

  const needsHttpRestart = config.httpPort !== listenPort;
  res.json({
    ok: true,
    applied: true,
    httpPortRestartRequired: needsHttpRestart,
    message: needsHttpRestart
      ? `HTTP port is now ${config.httpPort} in config. Restart the service (or reboot) so the server listens on the new port.`
      : "Settings saved. Serial and Supabase were reloaded.",
  });
});

app.get("/api/network", requireFieldAdmin, async (_req, res) => {
  try {
    const status = await net.getStatus();
    let wifi = [];
    let wifiError = null;
    try {
      wifi = await net.scanWifi();
    } catch (e) {
      wifiError = e.message || "scan failed";
    }
    res.json({ status, wifi, wifiError });
  } catch (e) {
    res.status(500).json({ error: e.message || "network status failed" });
  }
});

app.post("/api/network", requireFieldAdmin, async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || "").toLowerCase();
  try {
    if (kind === "wifi") {
      const status = await net.getStatus();
      const wifiDev = net.wifiDevice(status.devices);
      const apActive = status.devices.some(
        (d) => d.device === wifiDev && /hotspot/i.test(d.connection || "")
      );
      await net.connectWifi(String(b.ssid || ""), String(b.password || ""), b.iface);
      return res.json({
        ok: true,
        message: `Joining Wi-Fi “${b.ssid}”.`,
        warning: apActive
          ? "This gateway uses one Wi-Fi radio for both the setup AP and Wi-Fi internet, so the setup network will drop as it joins. Reconnect over the venue Wi-Fi, Ethernet, or by power-cycling to bring the AP back."
          : null,
      });
    }
    if (kind === "ethernet") {
      const ethMode = String(b.ethMode || "").toLowerCase();
      if (["shared", "static", "dhcp"].includes(ethMode)) {
        const r = await net.setEthernet(ethMode, { address: b.address, gateway: b.gateway });
        const where =
          ethMode === "shared"
            ? " Plug a laptop/console in (DHCP) → admin at http://10.42.0.1:3000, Art-Net to 10.42.0.1."
            : ethMode === "static"
            ? ` Static ${b.address}.`
            : " DHCP client on the LAN.";
        return res.json({ ok: true, message: `Ethernet ${ethMode} on ${r.device}.${where}` });
      }
      const r = await net.connectEthernet();
      return res.json({ ok: true, message: `Ethernet up on ${r.device}.` });
    }
    if (kind === "cellular") {
      const r = await net.connectCellular();
      return res.json({ ok: true, message: `Cellular up on ${r.device}.` });
    }
    return res.status(400).json({ error: "kind must be wifi, ethernet, or cellular" });
  } catch (e) {
    res.status(500).json({ error: `${e.message || "network change failed"}${e.stderr ? " — " + e.stderr : ""}` });
  }
});

// --- Voting POC (voteband-c6 -> gateway EVENT lines) ----------------------
app.get("/api/votes", (_req, res) => res.json(votes.snapshot()));

app.post("/api/votes/reset", (_req, res) => res.json(votes.reset()));

app.get("/api/votes/stream", (req, res) => votes.attachSse(req, res));

app.post("/api/led", async (req, res) => {
  const { mode, rate, r, g, b } = req.body || {};
  if (typeof mode !== "number" || mode < 0 || mode > 7) {
    return res.status(400).json({ error: "Invalid mode (0–7)" });
  }
  if (typeof rate !== "number" || rate < 0 || rate > 255) {
    return res.status(400).json({ error: "Invalid rate (0–255)" });
  }
  for (const k of ["r", "g", "b"]) {
    const v = req.body[k];
    if (typeof v !== "number" || v < 0 || v > 255) {
      return res.status(400).json({ error: `Invalid ${k}` });
    }
  }
  try {
    await sendAuraCommand(Math.round(mode), Math.round(rate), Math.round(r), Math.round(g), Math.round(b));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "LED failed" });
  }
});

// --- v2 control -----------------------------------------------------------
// /api/led above is the v0 shape the show controller and directDMX still use,
// and it keeps working: the gateway maps those five numbers onto v2 fields.
// These endpoints expose what v0 cannot say - group targeting, op mode,
// brightness, unicast. See include/aura_radio.h for field semantics.

app.post("/api/v2/cmd", async (req, res) => {
  try {
    const line = auraV2.buildCmd(req.body || {});
    await sendShellLine(line);
    res.json({ success: true, sent: line });
  } catch (e) {
    const bad = /^Invalid /.test(e.message || "");
    res.status(bad ? 400 : 500).json({ error: e.message || "Command failed" });
  }
});

app.post("/api/v2/op", async (req, res) => {
  try {
    const { mode, param } = req.body || {};
    const line = auraV2.buildOp(mode, param);
    await sendShellLine(line);
    res.json({ success: true, sent: line });
  } catch (e) {
    const bad = /^Invalid /.test(e.message || "");
    res.status(bad ? 400 : 500).json({ error: e.message || "Command failed" });
  }
});

// "Which physical band is 0x1A2B?" - unicast locate.
app.post("/api/v2/identify", async (req, res) => {
  try {
    const line = auraV2.buildIdentify((req.body || {}).addr);
    await sendShellLine(line);
    res.json({ success: true, sent: line });
  } catch (e) {
    const bad = /^Invalid /.test(e.message || "");
    res.status(bad ? 400 : 500).json({ error: e.message || "Command failed" });
  }
});

// Captive fallback: any other GET for an HTML page (a phone reaching out to an
// arbitrary site while joined to the setup AP) is redirected to the setup page.
// Static assets and the API are matched earlier, so this only catches strays.
app.use((req, res, next) => {
  if (req.method === "GET" && /text\/html/.test(req.headers.accept || "")) {
    return res.redirect(302, SETUP_PATH);
  }
  next();
});

// --- directDMX: Art-Net -> mapping engine -> sendAuraCommand --------------
// Runs only when control === "dmx". The band holds the animation; we send a
// command ONLY when the mapped {mode,rate,r,g,b} changes (no pixel streaming),
// debounced so a fader sweep coalesces to its final value. Needs no pairing.
function stopDmx() {
  if (artnetHandle) {
    artnetHandle.close();
    artnetHandle = null;
  }
  if (dmxMapper) {
    dmxMapper.reset();
    dmxMapper = null;
  }
  dmxListening = false;
}

function initDmx() {
  stopDmx();
  dmxError = "";
  if (config.control !== "dmx") return;

  const count = dmxMap.channelCount(config.dmx.layout);
  dmxMapper = dmxMap.createMapper(config.dmx, (mode, rate, r, g, b) => {
    sendAuraCommand(mode, rate, r, g, b).catch((e) => {
      dmxError = e.message || "send failed";
    });
  });

  artnetHandle = startArtNet({
    longName: `Aetherfield Gateway ${config.gatewayShortCode || ""}`.trim(),
    shortName: "Aetherfield",
    onListening: () => {
      dmxListening = true;
      console.log(`[dmx] Art-Net listening :6454 universe=${config.dmx.universe} start=${config.dmx.startChannel} layout=${config.dmx.layout}`);
    },
    onError: (e) => {
      dmxError = e.message || "artnet error";
      console.error("[dmx]", dmxError);
    },
    onDmx: (universe, data) => {
      if (universe !== config.dmx.universe) return; // only our patched universe
      dmxPackets++;
      dmxLastPacketAt = new Date().toISOString();
      // snapshot the patched channels for the live monitor
      const s = config.dmx.startChannel;
      dmxLastFrame = Array.from({ length: count }, (_, i) =>
        s - 1 + i < data.length ? data[s - 1 + i] & 0xff : 0
      );
      const res = dmxMapper.onFrame(data);
      dmxLastDecoded = res.decoded;
    },
  });
}

app.get("/api/dmx", (_req, res) => {
  res.json({
    control: config.control,
    enabled: config.control === "dmx",
    listening: dmxListening,
    universe: config.dmx.universe,
    startChannel: config.dmx.startChannel,
    layout: config.dmx.layout,
    channelCount: dmxMap.channelCount(config.dmx.layout),
    fixedMode: config.dmx.fixedMode,
    fixedRate: config.dmx.fixedRate,
    debounceMs: config.dmx.debounceMs,
    packets: dmxPackets,
    lastPacketAt: dmxLastPacketAt,
    patchedChannels: dmxLastFrame, // raw values of the patched block
    decoded: dmxLastDecoded,       // {mode,rate,r,g,b} the engine computed
    lastSent: dmxMapper ? dmxMapper.getState().lastSent : null,
    error: dmxError || null,
  });
});

initSerial();
initDmx();
void touchGatewayPresence();

app.listen(listenPort, LISTEN_HOST, () => {
  if (config.telemetryProjectId && !telemetryProjectIdForInsert()) {
    console.warn(
      "[telemetry] TELEMETRY_PROJECT_ID is set but is not a dashed UUID; inserts use project_id=null. Copy id from activation_projects in Supabase."
    );
  }
  console.log(
    JSON.stringify({
      type: "bridge_start",
      listenHost: LISTEN_HOST,
      httpPort: listenPort,
      serialPath: config.serialPort,
      gatewayHardwareId: config.gatewayHardwareId,
      fieldSetup: Boolean(process.env.FIELD_ADMIN_TOKEN),
    })
  );
});
