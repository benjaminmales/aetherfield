/**
 * v2-adapter.js — map parsed v2 gateway lines onto roster calls.
 *
 * The roster (shared with the Pi bridge) was written for the legacy
 * `NODE: id=...` shape. The pixel server speaks v2 only, so this is the single
 * place that translates. Keeping it separate means the roster stays byte-identical
 * with the Pi's copy and can be updated from one source.
 *
 * It also adds what the roster has no concept of: WHICH GATEWAY heard the device.
 * With up to four gateways per server that attribution is the whole point — it is
 * what turns "device 1A2B is alive" into "device 1A2B is at the north checkpoint".
 * Gateway state is merged through roster.annotate(), so the roster lib is untouched.
 */

/** Roster row from a v2 beacon/event. Returns null for kinds that only annotate. */
function toRosterRow(v2) {
  if (!v2 || !v2.uuid) return null;
  if (v2.kind === "beacon" || v2.kind === "v0") {
    return {
      uuid: v2.uuid,
      node_id: v2.node_id ?? null,
      band_id: null,
      rssi: v2.rssi ?? null,
      gesture: null,
      gesture_code: null,
      battery: v2.battery ?? undefined,
      caps: v2.caps ?? undefined,
      raw_line: v2.raw_line,
    };
  }
  if (v2.kind === "event") {
    return {
      uuid: v2.uuid,
      node_id: v2.node_id ?? null,
      band_id: null,
      rssi: v2.rssi ?? null,
      gesture: v2.event ?? null,
      gesture_code: v2.value ?? null,
      raw_line: v2.raw_line,
    };
  }
  return null; // contact: annotate only, never counts as a packet
}

/**
 * Fields to merge via roster.annotate() for this line.
 * @param {object} v2   parsed line
 * @param {string} gwId gateway id from HELLO (or null if it never identified)
 * @param {number} t    timestamp
 * @param {object} prev the device's existing annotation, for merging gateway history
 */
function toAnnotation(v2, gwId, t, prev = {}) {
  const ann = {};

  if (gwId) {
    // Per-gateway last-heard map: { "gw-01": { t, rssi }, ... }
    const gateways = { ...(prev.gateways || {}) };
    gateways[gwId] = { t, rssi: v2.rssi ?? null };
    ann.gateways = gateways;
    ann.lastGateway = gwId;
    ann.lastGatewayAt = t;
  }

  if (v2.kind === "beacon") {
    if (v2.flags !== undefined) ann.flags = v2.flags;
    if (v2.cmd_seq !== undefined) ann.lastCmdSeq = v2.cmd_seq;
    if (v2.caps !== undefined) ann.caps = v2.caps;
    if (v2.battery !== undefined) ann.battery = v2.battery;
  }

  if (v2.kind === "v0" && v2.flags !== undefined) ann.flags = v2.flags;

  if (v2.kind === "contact") {
    ann.lastContact = {
      peer: v2.peer,
      rssi: v2.peer_rssi,
      event: v2.event,
      t,
    };
  }

  return ann;
}

/** Which gateway currently hears this device loudest, from the annotation map. */
function strongestGateway(device, withinMs = 30_000, nowMs = Date.now()) {
  const gws = device?.gateways;
  if (!gws) return null;
  let best = null;
  for (const [id, g] of Object.entries(gws)) {
    if (nowMs - g.t > withinMs) continue;
    if (!best || (g.rssi ?? -999) > (best.rssi ?? -999)) best = { id, ...g };
  }
  return best;
}

module.exports = { toRosterRow, toAnnotation, strongestGateway };
