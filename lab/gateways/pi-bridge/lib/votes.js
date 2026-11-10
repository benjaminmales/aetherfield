/**
 * votes.js — live vote state for the Aetherfield 4-option voting POC.
 *
 * Ingests gateway serial lines and keeps "latest vote per band":
 *
 *   EVENT: band=0x1A2B button action=3        <- v1 EVENT type=BUTTON (C6 voteband)
 *   NODE: id=0 UUID: 0x00001A2B ... Gesture: gesture_3 (3)
 *                                             <- v1 BEACON; the gesture byte
 *                                                mirrors the band's current vote,
 *                                                so beacons re-sync missed events
 *
 * Options are 1..4 (A..D). Latest vote wins; a band can change its mind
 * until the operator resets the round. SSE keeps the /votes visualiser live.
 */

const EVENT_RE = /EVENT:\s*band=0x([0-9A-Fa-f]{1,4})\s+button\s+action=(\d+)/;
// v2 (GATEWAY/nrf54-firmware, protocol v2): the same button press now arrives as
//   <EVT a=1A2B n=3 r=-52 t=button v=3 s=0
// Both forms are accepted so a mixed fleet during migration still votes.
const EVENT_V2_RE = /^<EVT\s+a=([0-9A-Fa-f]{1,4})\s+n=\d+\s+r=-?\d+\s+t=button\s+v=(\d+)/;
const BEACON_RE = /UUID:\s*(0x[0-9A-Fa-f]+|\d+).*?Gesture:\s*\w+\s*\((\d+)\)/;

const NUM_OPTIONS = 4;

/** band(hex string, "0x1A2B") -> { choice, at, via } */
const perBand = new Map();
let roundStartedAt = new Date().toISOString();
let lastEventAt = null;
let eventCount = 0;

/** @type {Set<import("http").ServerResponse>} */
const sseClients = new Set();

function normBand(raw) {
  const v = parseInt(String(raw).replace(/^0x/i, ""), 16);
  if (!Number.isFinite(v)) return null;
  return "0x" + (v & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

function record(band, choice, via) {
  const prev = perBand.get(band);
  if (prev && prev.choice === choice && via === "beacon") return null; // no change
  const entry = { choice, at: new Date().toISOString(), via };
  perBand.set(band, entry);
  lastEventAt = entry.at;
  if (via === "event") eventCount++;
  return { band, ...entry };
}

/**
 * Feed one cleaned serial line. Returns {band, choice, at, via} when the
 * line changed vote state, else null.
 */
function ingestLine(line) {
  let m = EVENT_RE.exec(line) || EVENT_V2_RE.exec(line);
  if (m) {
    const band = normBand(m[1]);
    const choice = parseInt(m[2], 10);
    if (!band || choice < 1 || choice > NUM_OPTIONS) return null;
    const changed = record(band, choice, "event");
    if (changed) broadcast();
    return changed;
  }

  m = BEACON_RE.exec(line);
  if (m) {
    const band = normBand(m[1]);
    const choice = parseInt(m[2], 10);
    // Beacon gesture 0 = idle (never clears an existing vote); 1..4 = vote.
    if (!band || choice < 1 || choice > NUM_OPTIONS) return null;
    const changed = record(band, choice, "beacon");
    if (changed) broadcast();
    return changed;
  }

  return null;
}

function snapshot() {
  const counts = {};
  for (let i = 1; i <= NUM_OPTIONS; i++) counts[i] = 0;
  const bands = [];
  for (const [band, e] of perBand) {
    counts[e.choice]++;
    bands.push({ band, choice: e.choice, at: e.at, via: e.via });
  }
  bands.sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    counts,
    total: bands.length,
    bands,
    eventCount,
    roundStartedAt,
    lastEventAt,
    updatedAt: new Date().toISOString(),
  };
}

function reset() {
  perBand.clear();
  eventCount = 0;
  lastEventAt = null;
  roundStartedAt = new Date().toISOString();
  broadcast();
  return snapshot();
}

/* --- SSE ---------------------------------------------------------------- */

function attachSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* dropped */
    }
  }, 15000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

function broadcast() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

module.exports = { ingestLine, snapshot, reset, attachSse, NUM_OPTIONS };
