/**
 * aura-v2.js — parse the Aetherfield v2 structured lines the gateway prints,
 * and build v2 shell commands to send back.
 *
 * The v2 gateway (GATEWAY/nrf54-firmware) prints TWO things for every beacon:
 * the structured line, and the legacy `NODE: id=...` line this bridge has
 * always parsed. That is deliberate — the Pi keeps working across the
 * migration. So this module is ENRICHMENT, not a replacement:
 *
 *   NODE:  -> telemetry + roster ingest   (unchanged, server.js owns it)
 *   <BCN   -> annotate only               (flags + cmd seq; no packet count)
 *   <EVT   -> button/nfc events, which have NO legacy line at all
 *   <CON   -> proximity contact, likewise
 *
 * Ingesting both would double every packet count and every cloud insert.
 *
 * Line formats (src/main.c print sites):
 *   <BCN a=1A2B n=3 r=-52 caps=97 batt=255 fl=02 cseq=7
 *   <EVT a=1A2B n=3 r=-52 t=gesture v=2 s=100
 *   <CON a=1A2B n=3 r=-52 peer=0C4D pr=-71 ev=open
 *   <V0  a=1A2B n=0 r=-52 fl=02
 *
 * Pure and side-effect free: no timers, no I/O, no serial.
 */

/** 0x1A2B | 1A2B | 6699 -> "0x1A2B" (4-digit, upper). null if unparseable. */
function hexAddr(raw) {
  if (raw === null || raw === undefined) return null;
  const n = parseInt(String(raw).replace(/^0x/i, ""), 16);
  if (!Number.isFinite(n)) return null;
  return "0x" + (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

const ANIM_NAMES = [
  "off", "steady", "flash", "pulse", "heartbeat", "ramp", "strobe", "rainbow",
];
const OP_NAMES = [
  "normal", "listen_only", "roll_call", "social", "low_power", "sleep", "identify",
];

const BCN_RE =
  /^<BCN\s+a=([0-9A-Fa-f]{1,4})\s+n=(\d+)\s+r=(-?\d+)\s+caps=([0-9A-Fa-f]{1,2})\s+batt=(\d+)\s+fl=([0-9A-Fa-f]{1,2})\s+cseq=(\d+)/;
const EVT_RE =
  /^<EVT\s+a=([0-9A-Fa-f]{1,4})\s+n=(\d+)\s+r=(-?\d+)\s+t=(\w+)\s+v=(\d+)\s+s=(\d+)/;
const CON_RE =
  /^<CON\s+a=([0-9A-Fa-f]{1,4})\s+n=(\d+)\s+r=(-?\d+)\s+peer=([0-9A-Fa-f]{1,4})\s+pr=(-?\d+)\s+ev=(\w+)/;
const V0_RE =
  /^<V0\s+a=([0-9A-Fa-f]{1,4})\s+n=(\d+)\s+r=(-?\d+)\s+fl=([0-9A-Fa-f]{1,2})/;

/**
 * Parse one cleaned serial line.
 * @returns {null | {kind:'beacon'|'event'|'contact'|'v0', uuid:string, ...}}
 *   null when the line is not a v2 structured line (the caller then falls
 *   through to its existing NODE:/other handling).
 */
function parseV2Line(line) {
  const s = String(line).trim();
  if (s[0] !== "<") return null; // cheap reject: nothing else starts with '<'

  let m = BCN_RE.exec(s);
  if (m) {
    const batt = parseInt(m[5], 10);
    return {
      kind: "beacon",
      uuid: hexAddr(m[1]),
      node_id: parseInt(m[2], 10),
      rssi: parseInt(m[3], 10),
      caps: parseInt(m[4], 16),
      // 0xFF is the "unknown" sentinel, not 255%.
      battery: batt === 0xff ? null : batt,
      flags: parseInt(m[6], 16),
      cmd_seq: parseInt(m[7], 10),
      raw_line: s,
    };
  }

  m = EVT_RE.exec(s);
  if (m) {
    return {
      kind: "event",
      uuid: hexAddr(m[1]),
      node_id: parseInt(m[2], 10),
      rssi: parseInt(m[3], 10),
      event: m[4], // gesture | button | nfc | ?
      value: parseInt(m[5], 10),
      strength: parseInt(m[6], 10),
      raw_line: s,
    };
  }

  m = CON_RE.exec(s);
  if (m) {
    return {
      kind: "contact",
      uuid: hexAddr(m[1]),
      node_id: parseInt(m[2], 10),
      rssi: parseInt(m[3], 10),
      peer: hexAddr(m[4]),
      peer_rssi: parseInt(m[5], 10),
      event: m[6], // open | close
      raw_line: s,
    };
  }

  m = V0_RE.exec(s);
  if (m) {
    return {
      kind: "v0",
      uuid: hexAddr(m[1]),
      node_id: parseInt(m[2], 10),
      rssi: parseInt(m[3], 10),
      flags: parseInt(m[4], 16),
      raw_line: s,
    };
  }

  return null;
}

/** Range check helper. Returns the integer, or throws with a useful message. */
function byte(name, v, max = 255) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max || Math.round(n) !== n) {
    throw new Error(`Invalid ${name} (0-${max})`);
  }
  return n;
}

/**
 * Full-state command. Mirrors `aura cmd` in the gateway shell:
 *   aura cmd <grp> <anim> <animp> <op> <opp> <r> <g> <b> <br> [df] [dst]
 * Field meanings are in include/aura_radio.h — that header is the source of
 * truth; this only formats the shell line.
 */
function buildCmd(o = {}) {
  const grp = byte("group", o.group ?? 0);
  const anim = byte("anim", o.anim ?? 1);
  const animp = byte("animParam", o.animParam ?? 0);
  const op = byte("op", o.op ?? 0, 6);
  const opp = byte("opParam", o.opParam ?? 0);
  const r = byte("r", o.r ?? 0);
  const g = byte("g", o.g ?? 0);
  const b = byte("b", o.b ?? 0);
  const br = byte("bright", o.bright ?? 255);
  let cmd = `aura cmd ${grp} ${anim} ${animp} ${op} ${opp} ${r} ${g} ${b} ${br}`;
  if (o.devFlags !== undefined) cmd += ` ${byte("devFlags", o.devFlags)}`;
  if (o.dst !== undefined) {
    const dst = hexAddr(o.dst);
    if (!dst) throw new Error("Invalid dst");
    if (o.devFlags === undefined) cmd += " 0";
    cmd += ` ${dst.slice(2)}`;
  }
  return cmd;
}

/** `aura op <mode> [param]` */
function buildOp(mode, param) {
  const m = byte("op", mode, 6);
  return param === undefined ? `aura op ${m}` : `aura op ${m} ${byte("opParam", param)}`;
}

/** `aura identify <addr hex>` — unicast locate, for "which one is this?" */
function buildIdentify(addr) {
  const a = hexAddr(addr);
  if (!a) throw new Error("Invalid address");
  return `aura identify ${a.slice(2)}`;
}

module.exports = {
  parseV2Line,
  buildCmd,
  buildOp,
  buildIdentify,
  hexAddr,
  ANIM_NAMES,
  OP_NAMES,
};
