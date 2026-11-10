/**
 * rest-v1.js — the client integration API, /api/v1.
 *
 * Built for one job: let a client's own software (a show controller, a CMS,
 * TouchDesigner, a ticketing system) read the fleet and drive it, without
 * knowing anything about radio. Everything here is plain JSON over HTTP on the
 * venue LAN, served by Aura Server, so it keeps working with the internet
 * unplugged.
 *
 *   READ     GET  /api/v1/devices[?online&zone&product]   the fleet
 *            GET  /api/v1/devices/:id
 *            GET  /api/v1/zones                            one zone per Aura Link
 *            GET  /api/v1/zones/:id/devices
 *            GET  /api/v1/events?since=<seq>&limit=        cursor-paged event log
 *   CONTROL  POST /api/v1/light                            whole fleet or a group
 *            POST /api/v1/devices/:id/light                one device
 *            POST /api/v1/devices/:id/identify
 *            POST /api/v1/zones/:id/locate                 flash a Link's LED
 *   SETUP    PUT  /api/v1/devices/:id   {niceName}
 *            PUT  /api/v1/zones/:id     {name}
 *            GET/POST/DELETE /api/v1/hooks                 push every matching event to your URL
 *            GET/POST/PUT/DELETE /api/v1/behaviours        when X happens, do Y (light / webhook)
 *            GET/PUT /api/v1/settings                      proximity calibration
 *
 * Device objects are identical to the /ws live feed (lib/live-api.js), so a
 * client can poll first and move to push later without remapping anything.
 *
 * Auth: if API_KEY is set, every non-GET call needs `Authorization: Bearer
 * <key>` (or `X-API-Key`). Reads stay open so a dashboard on the same LAN just
 * works; set API_KEY_READS=1 to lock those too.
 */

const express = require("express");
const { hexAddr } = require("./aura-v2");

const EVENT_LOG_MAX = 5000;

/** "#00ff88" | "00ff88" | {r,g,b} | [r,g,b] -> {r,g,b}. Throws on garbage. */
function parseColor(c) {
  if (c === undefined || c === null) return null;
  if (Array.isArray(c) && c.length === 3) c = { r: c[0], g: c[1], b: c[2] };
  if (typeof c === "object") {
    const out = {};
    for (const k of ["r", "g", "b"]) {
      const n = Number(c[k] ?? 0);
      if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`color.${k} must be 0-255`);
      out[k] = n;
    }
    return out;
  }
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c).trim());
  if (!m) throw new Error('color must be "#rrggbb", [r,g,b] or {r,g,b}');
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Name or index -> index, against a names array. */
function enumArg(v, names, what) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && names[v] !== undefined) return v;
  const i = names.indexOf(String(v).toLowerCase());
  if (i >= 0) return i;
  throw new Error(`${what} must be one of: ${names.join(", ")}`);
}

function createEventLog(max = EVENT_LOG_MAX) {
  const items = [];
  let seq = 0;
  return {
    push(e) {
      const item = { seq: ++seq, t: new Date().toISOString(), ...e };
      items.push(item);
      while (items.length > max) items.shift();
      return item;
    },
    since(after = 0, limit = 200) {
      const out = items.filter((e) => e.seq > after).slice(0, limit);
      return { events: out, next: out.length ? out[out.length - 1].seq : Math.max(after, 0), latest: seq };
    },
    latest: () => seq,
  };
}

/**
 * @param {object} d
 * @param {() => object[]} d.devices      live device objects
 * @param {() => object[]} d.zones        gateway objects (with name)
 * @param {object} d.names
 * @param {object} d.link                 gateway link: send(id,line), broadcast(line)
 * @param {object} d.v2                   { buildCmd, buildIdentify, ANIM_NAMES, OP_NAMES }
 * @param {object} d.events               createEventLog()
 * @param {object} d.hooks                { list, add, remove, stats }
 * @param {string} d.serverId
 * @param {string} d.schema
 * @param {(type, obj) => void} d.log
 */
function createRestV1(d) {
  const r = express.Router();
  const apiKey = process.env.API_KEY || "";
  const lockReads = process.env.API_KEY_READS === "1";

  // CORS: client tools are often a browser page on another port or host on
  // the same LAN. The API key, not the origin, is the access control.
  r.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "content-type, authorization, x-api-key");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  r.use((req, res, next) => {
    if (!apiKey) return next();
    if (req.method === "GET" && !lockReads) return next();
    const got = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || req.get("x-api-key") || "";
    if (got === apiKey) return next();
    res.status(401).json({ error: "API key required (Authorization: Bearer <key>)" });
  });

  const fail = (res, code, msg) => res.status(code).json({ error: msg });

  function findDevice(id) {
    const want = hexAddr(id);
    return want ? d.devices().find((x) => x.id === want) || null : null;
  }

  /** Turn a light request body into a gateway command line. */
  function lightLine(body = {}, dst) {
    const c = parseColor(body.color) || { r: 255, g: 255, b: 255 };
    const anim = enumArg(body.animation ?? body.anim, d.v2.ANIM_NAMES, "animation") ?? 1;
    const op = enumArg(body.mode ?? body.op, d.v2.OP_NAMES, "mode") ?? 0;
    const bright = body.brightness ?? body.bright ?? 255;
    let group = 0;
    if (body.group !== undefined) {
      group = Number(body.group);
      if (!Number.isInteger(group) || group < 0 || group > 255) throw new Error("group must be a 0-255 bitmask");
    }
    // anim_param on the wire is the animation PERIOD in 10 ms units (0 = 1 s
    // default, max 2.55 s). Exposed as periodMs so nobody reads it as a speed.
    let animParam = body.animParam ?? 0;
    if (body.periodMs !== undefined) {
      const p = Number(body.periodMs);
      if (!(p >= 10 && p <= 2550)) throw new Error("periodMs must be 10-2550");
      animParam = Math.round(p / 10);
    }
    return d.v2.buildCmd({
      group, anim, animParam,
      op, opParam: body.modeParam ?? 0,
      ...c, bright, dst,
    });
  }

  function sendLine(line, zone) {
    return zone ? (d.link.send(zone, line) ? 1 : 0) : d.link.broadcast(line);
  }

  /* ---------------------------------------------------------- index -- */

  r.get("/", (_req, res) => {
    res.json({
      api: "aura/v1",
      schema: d.schema,
      server: d.serverId,
      auth: apiKey ? (lockReads ? "all" : "writes") : "none",
      docs: "https://aetherfield.ai/wiki/aura-server/api",
      live: "/ws",
      animations: d.v2.ANIM_NAMES,
      triggers: require("./behaviours").TRIGGERS,
      events: { motion: { 1: "started moving", 0: "came to rest" } },
      modes: d.v2.OP_NAMES,
    });
  });

  /* -------------------------------------------------------- devices -- */

  r.get("/devices", (req, res) => {
    let list = d.devices();
    const { online, zone, product, q } = req.query;
    if (online !== undefined) list = list.filter((x) => x.online === (online !== "0" && online !== "false"));
    if (zone) list = list.filter((x) => x.zone?.id === zone);
    if (product) list = list.filter((x) => (x.product || "").toLowerCase() === String(product).toLowerCase());
    if (q) {
      const s = String(q).toLowerCase();
      list = list.filter((x) => x.id.toLowerCase().includes(s) || (x.niceName || "").toLowerCase().includes(s));
    }
    res.json({ t: new Date().toISOString(), count: list.length, devices: list });
  });

  r.get("/devices/:id", (req, res) => {
    const dev = findDevice(req.params.id);
    return dev ? res.json(dev) : fail(res, 404, "Device not heard recently");
  });

  r.put("/devices/:id", (req, res) => {
    try {
      const name = d.names.setDevice(req.params.id, req.body?.niceName ?? req.body?.name);
      res.json({ ok: true, id: hexAddr(req.params.id), niceName: name });
    } catch (e) { fail(res, 400, e.message); }
  });

  r.post("/devices/:id/light", (req, res) => {
    const id = hexAddr(req.params.id);
    if (!id) return fail(res, 400, "Invalid device id");
    let line;
    try { line = lightLine(req.body, id); } catch (e) { return fail(res, 400, e.message); }
    const zone = req.body?.zone || findDevice(id)?.zone?.id; // aim at the Link that hears it
    const sent = sendLine(line, zone) || (zone ? sendLine(line) : 0);
    if (!sent) return fail(res, 503, "No Aura Link connected");
    d.log("api_light", { id, line });
    res.json({ ok: true, id, linksSent: sent, delivery: "unacknowledged — confirm via device.lastCmdSeq" });
  });

  r.post("/devices/:id/identify", (req, res) => {
    let line;
    try { line = d.v2.buildIdentify(req.params.id); } catch (e) { return fail(res, 400, e.message); }
    const sent = sendLine(line);
    if (!sent) return fail(res, 503, "No Aura Link connected");
    res.json({ ok: true, id: hexAddr(req.params.id), linksSent: sent });
  });

  /* ---------------------------------------------------------- fleet -- */

  r.post("/light", (req, res) => {
    let line;
    try { line = lightLine(req.body); } catch (e) { return fail(res, 400, e.message); }
    const sent = sendLine(line, req.body?.zone);
    if (!sent) return fail(res, 503, req.body?.zone ? `Link ${req.body.zone} not connected` : "No Aura Link connected");
    d.log("api_light", { line, zone: req.body?.zone || "*" });
    res.json({ ok: true, linksSent: sent, delivery: "unacknowledged — confirm via device.lastCmdSeq" });
  });

  /* ---------------------------------------------------------- zones -- */

  r.get("/zones", (_req, res) => {
    const devs = d.devices();
    const zones = d.zones().map((z) => ({
      id: z.id,
      name: z.name,
      connected: !z.stale,
      remote: z.remote ?? null,
      firmware: z.fw ?? z.hello?.fw ?? null,
      devices: devs.filter((x) => x.online && x.zone?.id === z.id).length,
    }));
    res.json({ zones });
  });

  r.get("/zones/:id/devices", (req, res) => {
    const list = d.devices().filter((x) => x.online && x.zone?.id === req.params.id);
    res.json({ zone: req.params.id, name: d.names.gateway(req.params.id), count: list.length, devices: list });
  });

  r.put("/zones/:id", (req, res) => {
    try {
      const name = d.names.setGateway(req.params.id, req.body?.name);
      res.json({ ok: true, id: req.params.id, name });
    } catch (e) { fail(res, 400, e.message); }
  });

  r.post("/zones/:id/locate", (req, res) => {
    const s = Math.min(Math.max(Number(req.body?.seconds) || 10, 1), 300);
    if (!d.link.send(req.params.id, `link locate ${s}`)) return fail(res, 404, `Link ${req.params.id} not connected`);
    res.json({ ok: true, id: req.params.id, seconds: s });
  });

  /* --------------------------------------------------------- events -- */

  r.get("/events", (req, res) => {
    const since = Number(req.query.since ?? 0) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    res.json(d.events.since(since, limit));
  });

  /* ---------------------------------------------------------- hooks -- */

  r.get("/hooks", (_req, res) => res.json({ hooks: d.hooks.list(), stats: d.hooks.stats() }));

  r.post("/hooks", (req, res) => {
    try { res.status(201).json({ ok: true, hook: d.hooks.add(req.body || {}) }); } catch (e) { fail(res, 400, e.message); }
  });

  r.delete("/hooks/:id", (req, res) => {
    return d.hooks.remove(req.params.id) ? res.json({ ok: true }) : fail(res, 404, "No such hook");
  });

  /* ----------------------------------------------------- behaviours -- */

  r.get("/behaviours", (_req, res) => res.json({ behaviours: d.behaviours.list() }));

  r.post("/behaviours", (req, res) => {
    try { res.status(201).json({ ok: true, behaviour: d.behaviours.upsert(req.body || {}) }); } catch (e) { fail(res, 400, e.message); }
  });

  r.put("/behaviours/:id", (req, res) => {
    try { res.json({ ok: true, behaviour: d.behaviours.upsert({ ...(req.body || {}), id: req.params.id }) }); } catch (e) { fail(res, 400, e.message); }
  });

  r.delete("/behaviours/:id", (req, res) => (d.behaviours.remove(req.params.id) ? res.json({ ok: true }) : fail(res, 404, "No such behaviour")));

  /* ------------------------------------------------------- settings -- */

  r.get("/settings", (_req, res) => res.json({ settings: d.site.get(), defaults: d.site.defaults() }));

  r.put("/settings", (req, res) => {
    try { res.json({ ok: true, settings: d.site.update(req.body || {}) }); } catch (e) { fail(res, 400, e.message); }
  });

  r.use((_req, res) => fail(res, 404, "Unknown endpoint — GET /api/v1 lists them"));

  return r;
}

module.exports = { createRestV1, createEventLog, parseColor, enumArg };
