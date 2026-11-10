"use strict";

const fs = require("fs");
const path = require("path");
const { deriveHardwareId, deriveShortCode } = require("../scripts/gen-hardware-id");

const CONFIG_FILE = path.join(__dirname, "..", "config.local.json");

/** @returns {Record<string, unknown>} */
function readLocalFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} patch */
function writeLocalFile(patch) {
  const cur = readLocalFile();
  const next = { ...cur, ...patch };
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_FILE);
}

/**
 * Merge process.env (after dotenv) with config.local.json.
 * JSON keys: serialPort, gatewayHardwareId, telemetryProjectId, supabaseUrl, supabaseServiceRoleKey, httpPort, webhooks
 */
function loadMergedConfig(findSerialPortFn) {
  const file = readLocalFile();
  const g = (k, def) =>
    file[k] !== undefined && file[k] !== null && String(file[k]).length > 0 ? file[k] : def;

  const serialFromEnv = process.env.SERIAL_PORT || "";
  const serialPort = g("serialPort", serialFromEnv) || findSerialPortFn();

  let telNorm;
  if (Object.prototype.hasOwnProperty.call(file, "telemetryProjectId")) {
    const v = file.telemetryProjectId;
    telNorm = v === null || v === "" ? null : String(v);
  } else {
    const e = process.env.TELEMETRY_PROJECT_ID || "";
    telNorm = e ? String(e) : null;
  }

  // --- Two-axis capability model -------------------------------------------
  // uplink:  where detected-band presence is reported  (none | cloud | server)
  // control: what animates the bands (the downlink)     (none | dmx | cloud | server)
  // They are independent and coexist — e.g. control=dmx + uplink=cloud for a DJ
  // activation that animates bands AND registers presence. directDMX needs no
  // pairing (it never touches telemetryProjectId/Supabase).
  // Legacy single "mode" (cloud|physical) migrates into uplink.
  const legacyMode = String(g("mode", process.env.GATEWAY_MODE || "")).toLowerCase();
  const legacyUplink = legacyMode === "physical" ? "server" : legacyMode === "cloud" ? "cloud" : "";

  const uplink = normEnum(
    g("uplink", process.env.GATEWAY_UPLINK || legacyUplink || "cloud"),
    ["none", "cloud", "server"],
    "cloud"
  );
  const control = normEnum(
    g("control", process.env.GATEWAY_CONTROL || "none"),
    ["none", "dmx", "cloud", "server"],
    "none"
  );
  // Back-compat: keep `mode` for any caller still reading it.
  const mode = uplink === "server" ? "physical" : "cloud";

  // DMX (Art-Net) patch — the gateway behaves as ONE fixture consuming a block of
  // channels. Multi-zone = multiple gateways on different start channels.
  // layout "mrgb" = [mode, rate, R, G, B]; "rgb" = [R, G, B] with fixed mode/rate.
  const dmxFile = file.dmx && typeof file.dmx === "object" ? file.dmx : {};
  const dg = (k, def) =>
    dmxFile[k] !== undefined && dmxFile[k] !== null && String(dmxFile[k]).length > 0 ? dmxFile[k] : def;
  const dmx = {
    universe: clampInt(dg("universe", process.env.DMX_UNIVERSE || 0), 0, 32767, 0),
    startChannel: clampInt(dg("startChannel", process.env.DMX_START_CHANNEL || 1), 1, 512, 1),
    layout: normEnum(dg("layout", process.env.DMX_LAYOUT || "mrgb"), ["mrgb", "rgb"], "mrgb"),
    fixedMode: clampInt(dg("fixedMode", 1), 0, 7, 1),
    fixedRate: clampInt(dg("fixedRate", 128), 0, 255, 128),
    debounceMs: clampInt(dg("debounceMs", 60), 0, 1000, 60),
  };

  // Gateway serial: explicit config/env wins; otherwise derive deterministically
  // from the Pi's CPU serial so a freshly-imaged Pi self-provisions the same SN.
  let gatewayHardwareId = g("gatewayHardwareId", process.env.GATEWAY_HARDWARE_ID || "");
  if (!gatewayHardwareId || gatewayHardwareId === "gw-unknown") {
    gatewayHardwareId = deriveHardwareId() || "gw-unknown";
  }

  // Wi-Fi regulatory region for the setup AP (2-letter, e.g. GB/US/DE). NOT
  // hardcoded — field-settable per tour leg. The AP runs on 2.4GHz ch6 (legal
  // almost everywhere); the client link adopts the venue's country via 802.11d.
  const wifiRegion = String(g("wifiRegion", process.env.WIFI_REGION || "GB"))
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2) || "GB";

  // Short, human-typeable serial (e.g. GWD98M0CDR) — the code etched on the case
  // and accepted in the manual-pair field. Derived from the same CPU serial, so it
  // is automatic and persistent; explicit config/env override wins if ever needed.
  let gatewayShortCode = g("gatewayShortCode", process.env.GATEWAY_SHORT_CODE || "");
  if (!gatewayShortCode) {
    gatewayShortCode = deriveShortCode() || "";
  }

  // Per-unit mDNS name so a specific gateway is reachable by serial on a shared
  // LAN: http://aura-gw-<shortcode>.local:3000 (set as hostname by
  // scripts/set-gateway-hostname.sh; avahi then publishes it).
  const mdnsName = gatewayShortCode ? `aura-gw-${String(gatewayShortCode).toLowerCase()}` : "";

  return {
    httpPort: parseInt(String(g("httpPort", process.env.HTTP_PORT || "3000")), 10) || 3000,
    serialPort: String(serialPort),
    gatewayHardwareId: String(gatewayHardwareId),
    gatewayShortCode: String(gatewayShortCode),
    mdnsName,
    wifiRegion,
    uplink,
    control,
    dmx,
    mode,
    serverUrl: String(g("serverUrl", process.env.SERVER_URL || "")).replace(/\/+$/, ""),
    // Outbound triggers to machines on the venue LAN. Array of
    // { id, url, on?, match?, cooldownMs?, perDevice?, enabled? } - see
    // lib/webhooks.js. Config-file only: there is no env form, because a list
    // of rules does not belong in a shell variable.
    webhooks: Array.isArray(file.webhooks) ? file.webhooks : [],
    telemetryProjectId: telNorm,
    supabaseUrl: String(g("supabaseUrl", process.env.SUPABASE_URL || "")),
    supabaseServiceRoleKey: String(g("supabaseServiceRoleKey", process.env.SUPABASE_SERVICE_ROLE_KEY || "")),
  };
}

function normEnum(v, allowed, def) {
  const s = String(v == null ? "" : v).toLowerCase();
  return allowed.includes(s) ? s : def;
}

function clampInt(v, lo, hi, def) {
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

function maskKey(key) {
  if (!key || key.length < 8) return key ? "(set)" : "";
  return `(…${key.slice(-4)})`;
}

module.exports = {
  CONFIG_FILE,
  readLocalFile,
  writeLocalFile,
  loadMergedConfig,
  maskKey,
};
