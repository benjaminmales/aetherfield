/**
 * In-memory roster of bands this gateway can currently hear.
 *
 * The Pi has never kept one — presence is upserted straight to Supabase and
 * only when uplink === "cloud". That makes the local console blind whenever
 * there's no internet, which is exactly when you most want to see whether the
 * radio is working. This module keeps a local view, fed from the same parsed
 * telemetry lines that go to the cloud, so /api/devices works offline.
 *
 * Pure and side-effect free: no timers, no I/O. Staleness is derived from the
 * clock at read time, so a device silently goes offline without anything having
 * to fire. Inject `now` in tests.
 */

const DEFAULT_ONLINE_MS = 10_000; // heard within this → "online" (beacons are ~1/s)
const DEFAULT_PRUNE_MS = 10 * 60_000; // forgotten entirely after this
const RSSI_WINDOW = 10; // samples in the rolling average

/** `0x1A2B` | `6699` | `1a2b` → `0x1A2B`. Returns null if unparseable. */
function normaliseUuid(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hex = /^0x/i.test(s) ? s.slice(2) : s;
  const n = parseInt(hex, /^0x/i.test(s) ? 16 : 10);
  if (!Number.isFinite(n)) return null;
  return `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
}

function mean(xs) {
  if (!xs.length) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.onlineMs] ms since last packet before a device reads as stale
 * @param {number} [opts.pruneMs]  ms since last packet before it is dropped
 * @param {() => number} [opts.now] clock injection for tests
 */
function createRoster(opts = {}) {
  const onlineMs = opts.onlineMs ?? DEFAULT_ONLINE_MS;
  const pruneMs = opts.pruneMs ?? DEFAULT_PRUNE_MS;
  const now = opts.now ?? (() => Date.now());

  /** @type {Map<string, object>} */
  const devices = new Map();

  /**
   * Feed one parsed telemetry row (the return value of parseTelemetryLine).
   * Rows without a uuid can't be attributed to a device and are ignored here —
   * they still flow to the cloud through the normal path.
   * @returns {object|null} the updated record, or null if not attributable
   */
  function ingest(parsed) {
    if (!parsed) return null;
    const uuid = normaliseUuid(parsed.uuid);
    if (!uuid) return null;

    const t = now();
    let d = devices.get(uuid);
    if (!d) {
      d = {
        uuid,
        bandId: parsed.band_id ?? null,
        nodeIds: [],
        rssi: null,
        rssiAvg: null,
        _rssiSamples: [],
        firstSeen: t,
        lastSeen: t,
        packets: 0,
        lastGesture: null,
        lastGestureAt: null,
        gestureCount: 0,
        // v1 fields — the v0 uplink carries neither. Populated once the
        // BEACON caps/battery bytes land (see include/aura_radio.h).
        battery: null,
        caps: null,
        // v2 enrichment — set by annotate() from <BCN lines, which carry
        // state the legacy NODE: line has no room for.
        flags: null,
        lastCmdSeq: null,
        lastContact: null,
      };
      devices.set(uuid, d);
    }

    d.lastSeen = t;
    d.packets += 1;
    if (parsed.band_id != null) d.bandId = parsed.band_id;

    if (parsed.node_id != null && !d.nodeIds.includes(parsed.node_id)) {
      d.nodeIds.push(parsed.node_id);
      d.nodeIds.sort((a, b) => a - b);
    }

    if (typeof parsed.rssi === "number" && Number.isFinite(parsed.rssi)) {
      d.rssi = parsed.rssi;
      d._rssiSamples.push(parsed.rssi);
      while (d._rssiSamples.length > RSSI_WINDOW) d._rssiSamples.shift();
      d.rssiAvg = mean(d._rssiSamples);
    }

    // A v2 gateway prints a Gesture field on EVERY beacon, "none (0)" when
    // there was none. Counting that would make gestureCount a beacon counter
    // and pin lastGesture to "none" forever.
    const idle = !parsed.gesture ||
      parsed.gesture === "none" ||
      parsed.gesture_code === 0;
    if (!idle) {
      d.lastGesture = parsed.gesture;
      d.lastGestureAt = t;
      d.gestureCount += 1;
    }

    if (typeof parsed.battery === "number") d.battery = parsed.battery;
    if (typeof parsed.caps === "number") d.caps = parsed.caps;

    return d;
  }

  /**
   * Enrich an EXISTING record without counting a packet.
   *
   * The v2 gateway prints a structured <BCN line *and* the legacy NODE: line
   * for the same beacon. ingest() runs on NODE:; this runs on <BCN, so the
   * extra fields land without doubling `packets` or the RSSI window.
   *
   * A device unknown to the roster is a no-op rather than a create: <BCN is
   * printed just before its NODE: twin, so on a device's very first beacon
   * there is nothing to annotate yet and the next beacon fills it in.
   *
   * @returns {object|null} the updated record, or null if unknown/unattributable
   */
  function annotate(uuidRaw, fields = {}) {
    const uuid = normaliseUuid(uuidRaw);
    if (!uuid) return null;
    const d = devices.get(uuid);
    if (!d) return null;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) d[k] = v;
    }
    return d;
  }

  /** Drop anything unheard for longer than pruneMs. Returns the count removed. */
  function prune() {
    const cutoff = now() - pruneMs;
    let removed = 0;
    for (const [uuid, d] of devices) {
      if (d.lastSeen < cutoff) {
        devices.delete(uuid);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Snapshot for the API. Online devices first, then strongest signal.
   * `_rssiSamples` is internal and never serialised.
   */
  function list() {
    prune();
    const t = now();
    return [...devices.values()]
      .map(({ _rssiSamples, ...d }) => ({
        ...d,
        ageMs: t - d.lastSeen,
        online: t - d.lastSeen <= onlineMs,
      }))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (b.rssiAvg ?? -999) - (a.rssiAvg ?? -999);
      });
  }

  function stats() {
    const all = list();
    return {
      total: all.length,
      online: all.filter((d) => d.online).length,
      onlineMs,
      pruneMs,
    };
  }

  function clear() {
    devices.clear();
  }

  return { ingest, annotate, list, stats, prune, clear };
}

module.exports = { createRoster, normaliseUuid };
