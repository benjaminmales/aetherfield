/**
 * gateway-link.js — TCP listener for Aetherfield gateways.
 *
 * Replaces the Pi bridge's single serial port. A gateway (XIAO nRF54 + W5500)
 * opens a long-lived TCP connection and streams the same newline-delimited v2
 * lines it used to print to UART:
 *
 *   ->  HELLO gw=gw-01 fw=1.0.0 proto=2      (first line after connect)
 *   ->  <BCN a=1A2B n=3 r=-52 caps=97 batt=88 fl=02 cseq=7
 *   ->  <EVT ... / <CON ... / <V0 ...
 *   ->  PING                                  (idle keepalive)
 *   <-  aura cmd 0 2 0 0 0 255 180 40 255     (downlink, gateway shell syntax)
 *   <-  PONG
 *
 * Everything above the wire is unchanged: lines go to the same parseV2Line the
 * Pi already uses. That's the point — the migration is a transport swap, not a
 * protocol change.
 *
 * Robustness notes, because this runs for three days unattended:
 *  - Partial lines are buffered across TCP segments; TCP gives no framing.
 *  - A peer that never sends a newline would grow that buffer without bound,
 *    so it is capped and the connection dropped.
 *  - Gateways reconnect themselves; the server never dials out.
 *  - A gateway that goes quiet past `staleMs` is reported stale but the socket
 *    is left alone unless `idleTimeoutMs` elapses — a silent event is normal,
 *    a silent TCP connection is not.
 */

const net = require("node:net");

const MAX_LINE = 4096; // longest sane line; anything larger is a broken peer
const DEFAULT_PORT = 9000;
const DEFAULT_STALE_MS = 30_000; // no traffic → flagged stale in the UI
const DEFAULT_IDLE_TIMEOUT_MS = 120_000; // no traffic → socket destroyed

/**
 * @param {object} opts
 * @param {number}   [opts.port]
 * @param {string}   [opts.host]           bind address; default all interfaces
 * @param {(line: string, gw: object) => void} opts.onLine
 * @param {(gw: object) => void} [opts.onConnect]
 * @param {(gw: object, reason: string) => void} [opts.onDisconnect]
 * @param {() => number} [opts.now]
 */
function createGatewayLink(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "0.0.0.0";
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const onLine = opts.onLine ?? (() => {});
  const onConnect = opts.onConnect ?? (() => {});
  const onDisconnect = opts.onDisconnect ?? (() => {});

  /** @type {Map<string, object>} connKey -> gateway record */
  const conns = new Map();
  let seq = 0;
  let server = null;

  function handle(socket) {
    const connKey = `c${++seq}`;
    // Nagle off: commands are small and latency-sensitive (an operator pressing
    // "identify" should not wait for a full segment).
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);

    const gw = {
      connKey,
      id: null, // set by HELLO; null until then
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      fw: null,
      proto: null,
      connectedAt: now(),
      lastRxAt: now(),
      lines: 0,
      bytes: 0,
      sent: 0,
      _socket: socket,
      _buf: "",
    };
    conns.set(connKey, gw);
    onConnect(gw);

    socket.on("data", (chunk) => {
      gw.lastRxAt = now();
      gw.bytes += chunk.length;
      gw._buf += chunk.toString("utf8");

      if (gw._buf.length > MAX_LINE) {
        // No newline in a full buffer's worth of data — not a gateway.
        drop(connKey, "line too long");
        return;
      }

      let nl;
      while ((nl = gw._buf.indexOf("\n")) !== -1) {
        const line = gw._buf.slice(0, nl).replace(/\r$/, "").trim();
        gw._buf = gw._buf.slice(nl + 1);
        if (!line) continue;
        gw.lines += 1;

        // HELLO names the gateway. Accept it at any point, not just first line,
        // so a gateway that reboots mid-stream re-identifies cleanly.
        const hello = /^HELLO\s+(.*)$/i.exec(line);
        if (hello) {
          const kv = parseKv(hello[1]);
          if (kv.gw) gw.id = kv.gw;
          if (kv.fw) gw.fw = kv.fw;
          if (kv.proto) gw.proto = kv.proto;
          continue;
        }
        if (/^PING\b/i.test(line)) {
          write(gw, "PONG");
          continue;
        }
        onLine(line, gw);
      }
    });

    socket.on("error", (err) => drop(connKey, err.message || "socket error"));
    socket.on("close", () => drop(connKey, "closed"));
  }

  function drop(connKey, reason) {
    const gw = conns.get(connKey);
    if (!gw) return;
    conns.delete(connKey);
    try {
      gw._socket.destroy();
    } catch {
      /* already gone */
    }
    onDisconnect(gw, reason);
  }

  function write(gw, line) {
    if (!gw || !gw._socket || gw._socket.destroyed) return false;
    try {
      gw._socket.write(line.endsWith("\n") ? line : line + "\n");
      gw.sent += 1;
      return true;
    } catch {
      return false;
    }
  }

  /** Send to one gateway by its HELLO id. Returns true if it went out. */
  function send(gatewayId, line) {
    for (const gw of conns.values()) {
      if (gw.id === gatewayId) return write(gw, line);
    }
    return false;
  }

  /** Send to every connected gateway. Returns the number written. */
  function broadcast(line) {
    let n = 0;
    for (const gw of conns.values()) if (write(gw, line)) n += 1;
    return n;
  }

  /** Serialisable snapshot for the console. Never exposes the socket. */
  function list() {
    const t = now();
    return [...conns.values()]
      .map(({ _socket, _buf, ...g }) => ({
        ...g,
        ageMs: t - g.lastRxAt,
        stale: t - g.lastRxAt > staleMs,
        uptimeMs: t - g.connectedAt,
      }))
      .sort((a, b) => String(a.id ?? "~").localeCompare(String(b.id ?? "~")));
  }

  /** Destroy sockets idle beyond idleTimeoutMs. Call from a timer. */
  function reapIdle() {
    const t = now();
    let reaped = 0;
    for (const [key, gw] of [...conns]) {
      if (t - gw.lastRxAt > idleTimeoutMs) {
        drop(key, "idle timeout");
        reaped += 1;
      }
    }
    return reaped;
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server = net.createServer(handle);
      server.on("error", reject);
      server.listen(port, host, () => resolve({ port, host }));
    });
  }

  function close() {
    for (const key of [...conns.keys()]) drop(key, "server closing");
    return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  }

  return { listen, close, send, broadcast, list, reapIdle, port, host };
}

/** `gw=gw-01 fw=1.0.0` -> { gw: "gw-01", fw: "1.0.0" } */
function parseKv(s) {
  const out = {};
  for (const tok of String(s).trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

module.exports = { createGatewayLink, parseKv, MAX_LINE };
