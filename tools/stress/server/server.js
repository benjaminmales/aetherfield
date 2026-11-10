/**
 * Aetherfield stress server.
 *
 *   20 load generators  --802.15.4-->  3..30 gateways  --TCP :9000-->  here
 *
 * Separate from ../../server on purpose. That one is the shipping artefact
 * and has to stay boring; this one exists to be pointed at a wall and is
 * allowed to be noisy, opinionated and full of instrumentation nobody wants
 * at a real event.
 *
 * It does NOT carry its own line parser or its own TCP handling: both are
 * required straight out of the shipping server. A second parser would drift
 * from the first, and then a difference in the measurement would be
 * indistinguishable from a difference in the product.
 *
 * ---------------------------------------------------------------------------
 * The number this exists to produce
 * ---------------------------------------------------------------------------
 *
 * The fleet size is KNOWN — 20 blocks of 150 contiguous addresses — and so is
 * the beacon interval. That makes the expected frame rate arithmetic rather
 * than guesswork, and delivery rate becomes a measurement instead of a
 * feeling:
 *
 *     expected/s = blocks * perBlock / (beaconIntervalMs / 1000)
 *     delivered  = distinct sightings/s   (multi-gateway copies collapsed)
 *     delivery   = delivered / expected
 *
 * Everything else on the dashboard is diagnosis; that ratio is the finding.
 */

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

// From the shipping server, deliberately. One parser, one TCP implementation.
const { createGatewayLink } = require("../../../server/lib/gateway-link");
const { parseV2Line, buildCmd, buildOp, buildIdentify, ANIM_NAMES, OP_NAMES } =
  require("../../../server/lib/aura-v2");

const { createFleet } = require("./lib/sightings");
const { estimate } = require("./lib/position");
const { createRate } = require("./lib/rates");

const CONFIG_PATH = process.env.STRESS_CONFIG || path.join(__dirname, "config.json");
const HTTP_PORT = Number(process.env.HTTP_PORT || 3200);
const GW_PORT = Number(process.env.GATEWAY_PORT || 9000);
const GW_HOST = process.env.GATEWAY_HOST || "0.0.0.0";

let cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const startedAt = Date.now();

const fleet = createFleet({ dedupeMs: cfg.dedupeMs, onlineMs: cfg.onlineMs });
const rateReports = createRate(20);
const rateSightings = createRate(20);
/** gw id -> rate, so one deaf or overloaded gateway is visible immediately. */
const rateByGateway = new Map();

const recent = [];
const RECENT_MAX = 300;
const counters = { lines: 0, beacons: 0, other: 0, unparsed: 0 };

let lastCmd = { seq: null, at: null, line: null };

function log(type, obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), type, ...obj }));
}

/* The band address range, from aura_radio.h. Blocks live anywhere inside it. */
const BAND_BASE = 0x1000;
const BAND_MAX = 0xFFFD;

/** blocks * perBlock, and the address range that implies. */
function expectedFleet() {
  const e = cfg.expected;
  return {
    devices: e.blocks * e.perBlock,
    blocks: e.blocks,
    perBlock: e.perBlock,
    base: e.base,
    top: e.base + e.blocks * e.perBlock - 1,
    intervalMs: e.beaconIntervalMs,
    beaconsPerSec: (e.blocks * e.perBlock) / (e.beaconIntervalMs / 1000),
    /*
     * The success window: how long a device may go unheard before the
     * activation considers it gone. This is a PRODUCT decision and it
     * dominates everything else — a short window forces short intervals,
     * which load the channel, which destroy per-beacon delivery. Widening it
     * buys more than any firmware change.
     */
    presenceWindowMs: e.presenceWindowMs ?? Math.max(e.beaconIntervalMs * 3, 5000),
  };
}

/* The roster scores gaps against the window as they arrive, so it has to
 * know the window from the first beacon, not just after the dashboard
 * posts /api/expected. */
fleet.setPresenceWindow(expectedFleet().presenceWindowMs);

/*
 * Is this address one of ours, or something else that wandered onto the PAN?
 *
 * The load generator used to take a contiguous range from a per-board Kconfig
 * fragment, so "ours" was base..top and the check was an interval test. Boards
 * now derive their own block from the factory device id — one binary for all
 * twenty instead of twenty builds — so the occupied blocks are scattered
 * anywhere in the band and we cannot name them in advance.
 *
 * What we can still say is that the band range belongs to bands. Anything
 * inside it is a simulated device; the fleet size comes from the board count,
 * which is a thing the operator knows by looking at the table.
 */
function inExpectedRange(uuid) {
  const n = parseInt(String(uuid).replace(/^0x/i, ""), 16);
  return Number.isFinite(n) && n >= BAND_BASE && n <= BAND_MAX;
}

/** Which 150-address block an address falls in. */
function blockOf(uuid) {
  const n = parseInt(String(uuid).replace(/^0x/i, ""), 16);
  if (!Number.isFinite(n) || n < BAND_BASE || n > BAND_MAX) return null;

  const per = expectedFleet().perBlock;
  // NaN would sail straight through a `!== null` guard and serialise as null,
  // which is how this returned a set containing one null.
  if (!Number.isFinite(per) || per <= 0) return null;

  return Math.floor((n - BAND_BASE) / per);
}

/* ------------------------------------------------------------- ingest -- */

const link = createGatewayLink({
  port: GW_PORT,
  host: GW_HOST,
  onConnect: (gw) => log("gateway_connect", { conn: gw.connKey, remote: gw.remote }),
  onDisconnect: (gw, reason) => log("gateway_disconnect", { gw: gw.id, reason }),
  onLine: (line, gw) => {
    counters.lines += 1;
    const v2 = parseV2Line(line);

    if (!v2) {
      // The gateway mirrors its own console — 'NODE:' twins and '>CMD' echoes
      // are expected traffic, not parse failures. See the main server for why
      // conflating the two makes the counter useless.
      if (!/^(NODE:|>)/.test(line)) counters.unparsed += 1;
      return;
    }

    if (v2.kind !== "beacon") {
      counters.other += 1;
      return;
    }

    counters.beacons += 1;
    rateReports.add();

    let r = rateByGateway.get(gw.id);
    if (!r) {
      r = createRate(20);
      rateByGateway.set(gw.id, r);
    }
    r.add();

    const out = fleet.observe({
      uuid: v2.uuid,
      gw: gw.id || gw.connKey,
      rssi: v2.rssi,
      caps: v2.caps,
      battery: v2.battery,
      cmdSeq: v2.cmd_seq,
    });

    if (out && !out.duplicate) {
      rateSightings.add();
      if (recent.length < RECENT_MAX) {
        recent.push({ t: Date.now(), uuid: v2.uuid, gw: gw.id, rssi: v2.rssi });
      } else {
        recent.shift();
        recent.push({ t: Date.now(), uuid: v2.uuid, gw: gw.id, rssi: v2.rssi });
      }
    }
  },
});

/* --------------------------------------------------------------- HTTP -- */

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

function positioned(d) {
  if (!d.gateways.length) return null;
  return estimate(d.gateways, cfg.gateways, {
    model: cfg.model,
    bounds: {
      minX: 0, maxX: cfg.venue.width,
      minY: 0, maxY: cfg.venue.height,
    },
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptimeMs: Date.now() - startedAt, counters });
});

app.get("/api/config", (_req, res) => {
  res.json({ ...cfg, expected: { ...cfg.expected, ...expectedFleet() } });
});

/**
 * The headline. Everything here is measured, not modelled, except
 * `expected.beaconsPerSec` which is arithmetic from the known fleet.
 */
app.get("/api/stats", (_req, res) => {
  const e = expectedFleet();
  const all = fleet.list();
  const online = all.filter((d) => d.online);
  const mine = online.filter((d) => inExpectedRange(d.uuid));

  const delivered = rateSightings.perSecond();

  /*
   * Command adoption, without the server knowing what it sent.
   *
   * The SEQUENCE NUMBER IS THE GATEWAY'S: send_cmd() does g_state.seq++ on
   * the gateway, so a server that built the line with buildCmd() has no idea
   * which seq went out. An earlier version stored one anyway and always
   * reported "-", which is worse than not showing it.
   *
   * What can be measured, and is arguably the better question, is whether the
   * fleet AGREES. Take the most common cmd_seq the devices are echoing: that
   * is by definition the command that has propagated furthest, and the share
   * holding it is the proportion of the fleet in step. After a command it
   * climbs to 100% as the stragglers catch up; if it sticks below, that gap
   * is real downlink loss.
   */
  const hist = new Map();
  for (const d of mine) {
    if (typeof d.cmdSeq !== "number") continue;
    hist.set(d.cmdSeq, (hist.get(d.cmdSeq) || 0) + 1);
  }
  let seqTarget = null;
  let current = null;
  for (const [seq, n] of hist) {
    if (current === null || n > current) { current = n; seqTarget = seq; }
  }

  /*
   * Presence, which is the thing the product actually sells.
   *
   * Delivery is per-BEACON reliability. Detection only needs ONE beacon to
   * arrive within the presence window, and a device sends several per window,
   * so the two numbers are very different and the gap is exponential:
   *
   *     P(device missed) = (1 - delivery) ^ beacons_per_window
   *
   * At 50% per-beacon delivery over ten beacons that is one device in a
   * thousand — quoting the 50% to a client would badly undersell what they
   * would see in the room. Delivery still matters as headroom: it is the
   * early warning that the channel is filling up, and it falls long before
   * presence does. But presence is the promise.
   */
  const presenceWindowMs = e.presenceWindowMs;
  const beaconsPerWindow = Math.max(1, presenceWindowMs / e.intervalMs);
  const inWindow = all.filter(
    (d) => inExpectedRange(d.uuid) && d.ageMs <= presenceWindowMs);
  // null, not 0, when nothing is in the window: "worst gap among the devices
  // we can currently see" has no answer when we can see none of them, and a
  // reassuring 0 next to a detection rate of 0% is the wrong story.
  const worstGapMs = inWindow.length
    ? inWindow.reduce((m, d) => Math.max(m, d.ageMs), 0)
    : null;

  /*
   * Instantaneous presence is a snapshot: everyone seen right now. It can
   * read 100% at every sample and still hide a device that went dark for
   * twelve seconds at minute three — nobody was looking at that moment.
   *
   * Sustained presence is the run's record. A device is clean if no gap
   * between consecutive sightings ever exceeded the window, counted since
   * the last /api/reset. This is the number that answers "can we detect
   * 3,000 people at once", because it is the only one that cannot be
   * rescued by a lucky sample.
   */
  const everSeen = all.filter((d) => inExpectedRange(d.uuid));

  /*
   * Proximity, which is what RSSI can honestly support.
   *
   * Trilateration wanted coordinates out of RSSI and could not deliver them —
   * a metre-level answer from a measurement that moves 10 dB when someone
   * turns around. What RSSI IS reliable for is ordering: the gateway hearing a
   * device loudest is almost always the nearest one, and that judgement
   * survives noise that destroys a position fix.
   *
   * So each device is attributed to its strongest gateway and bucketed by how
   * loud it is there. No coordinates are claimed, and moving a board across
   * the room visibly moves it between bars — which is the thing worth showing.
   */
  const NEAR_DBM = -65;
  const MID_DBM = -80;

  /*
   * A gateway has no id until it sends HELLO, and it is in link.list() from
   * the moment the socket opens. Sorting those by name threw on null and took
   * the WHOLE endpoint down with it — the dashboard's gateway table then read
   * as "no gateways", which is the one thing it must never say wrongly.
   *
   * Connections without a name still get a row, labelled by connection key.
   */
  const gwName = (g) => g.id || g.connKey || g.remote || "(no HELLO)";

  const prox = new Map();
  for (const g of link.list()) {
    const name = gwName(g);
    prox.set(name, { gw: name, near: 0, mid: 0, far: 0, total: 0 });
  }

  /*
   * Every gateway's own signal distribution, over every device it hears —
   * not just the ones it wins.
   *
   * Attribution to the loudest gateway is only meaningful if the gateways are
   * comparable. One with an external antenna fitted while the others use the
   * chip antenna reads 10-20 dB hotter on EVERY device, so it wins every
   * comparison and the bars collapse onto it. That looks like all the devices
   * being in one place and is really a hardware difference.
   *
   * Median RSSI per gateway makes that visible: three gateways in one room
   * hearing the same fleet should be within a few dB of each other.
   */
  const heard = new Map();

  for (const d of everSeen) {
    if (!d.online || !d.gateways?.length) continue;

    for (const g of d.gateways) {
      if (!Number.isFinite(g.rssiAvg)) continue;
      const name = g.gw;
      if (!heard.has(name)) heard.set(name, []);
      heard.get(name).push(g.rssiAvg);
    }

    // list() sorts gateways by rssiAvg descending, so [0] is the loudest.
    const best = d.gateways[0];
    let row = prox.get(best.gw);
    if (!row) {
      row = { gw: best.gw, near: 0, mid: 0, far: 0, total: 0 };
      prox.set(best.gw, row);
    }
    const r = best.rssiAvg;
    if (r >= NEAR_DBM) row.near += 1;
    else if (r >= MID_DBM) row.mid += 1;
    else row.far += 1;
    row.total += 1;
  }

  const medianOf = (a) => {
    if (!a.length) return null;
    const v = [...a].sort((x, y) => x - y);
    return Math.round(v[Math.floor(v.length / 2)] * 10) / 10;
  };

  for (const row of prox.values()) {
    const rs = heard.get(row.gw) || [];
    row.hears = rs.length;            // devices this gateway can hear at all
    row.medianRssi = medianOf(rs);    // how loud they are to IT
  }

  const proximity = {
    nearDbm: NEAR_DBM,
    midDbm: MID_DBM,
    gateways: [...prox.values()]
      .sort((a, b) => String(a.gw).localeCompare(String(b.gw))),
  };

  /*
   * Block occupancy — the clash detector.
   *
   * Each board derives its block from its factory device id, and twenty boards
   * into 409 blocks clash with probability 37.6%. A clash is silent and looks
   * like loss: two boards emit the same 150 addresses, this server dedupes
   * them into one device, and the fleet reads 150 short.
   *
   * Counting distinct blocks makes it loud. Fewer blocks than boards powered
   * up means a clash, not packet loss, and 'sim block <n>' on one of them
   * fixes it over RTT without a rebuild.
   */
  const blocksSeen = new Set();

  /*
   * Which block holds TWO boards.
   *
   * A clash is not silent if you look in the right place. Both boards emit the
   * same 150 addresses, so every device in that block is beaconing twice as
   * often as the rest of the fleet — the addresses overlap exactly, but the
   * sighting RATE does not. The doubled block is the clashed one.
   *
   * That turns "power up boards one at a time until the count stops rising"
   * into a number on the screen.
   */
  const blockReports = new Map();

  for (const d of everSeen) {
    const b = blockOf(d.uuid);
    if (!Number.isInteger(b)) continue;
    blocksSeen.add(b);
    const cur = blockReports.get(b) || { devices: 0, reports: 0 };
    cur.devices += 1;
    cur.reports += d.reports || 0;
    blockReports.set(b, cur);
  }

  /* Reports per device, per block; then which blocks sit well above the
   * fleet's median. A clash shows as roughly 2x. */
  const perBlockRate = [...blockReports.entries()]
    .map(([block, v]) => ({ block, perDevice: v.devices ? v.reports / v.devices : 0 }))
    .sort((a, b) => a.perDevice - b.perDevice);

  const median = perBlockRate.length
    ? perBlockRate[Math.floor(perBlockRate.length / 2)].perDevice
    : 0;

  const doubled = median > 0
    ? perBlockRate.filter((r) => r.perDevice > median * 1.6)
        .map((r) => ({ block: r.block, ratio: Math.round((r.perDevice / median) * 100) / 100 }))
    : [];
  const boardsExpected = e.blocks;
  const blockClash = blocksSeen.size < boardsExpected;
  const clean = everSeen.filter((d) => !d.missedWindows);
  const worstEverMs = everSeen.reduce((m, d) => Math.max(m, d.maxGapMs || 0), 0);
  const p = e.beaconsPerSec ? Math.min(1, delivered / e.beaconsPerSec) : 0;

  res.json({
    uptimeMs: Date.now() - startedAt,
    proximity,
    /*
     * The reassurance number: distinct units that have checked in at least
     * once since the last reset. Survives the roster pruning a quiet device,
     * because "did all 3,000 reach the system" is a question about the run,
     * not about this instant.
     */
    units: {
      seen: fleet.everSeenCount(),
      of: e.devices,
      rate: e.devices
        ? Math.round((fleet.everSeenCount() / e.devices) * 1000) / 1000
        : null,
    },
    presence: {
      windowMs: presenceWindowMs,
      beaconsPerWindow: Math.round(beaconsPerWindow * 10) / 10,
      seen: inWindow.length,
      of: e.devices,
      /*
       * Devices that have never missed the window, over the expected fleet.
       * Anything never heard from at all is a miss by omission — it is in
       * the denominator and not the numerator, which is correct.
       */
      blocks: {
        seen: blocksSeen.size,
        /* Blocks beaconing well above the fleet median — two boards sharing
         * one block. The address to identify is base + block * perBlock. */
        doubled,
        boardsExpected,
        clash: blockClash,
        list: [...blocksSeen].sort((a, b) => a - b),
      },
      sustained: {
        clean: clean.length,
        everSeen: everSeen.length,
        neverSeen: Math.max(0, e.devices - everSeen.length),
        rate: e.devices ? Math.round((clean.length / e.devices) * 1000) / 1000 : null,
        worstEverMs,
      },
      rate: e.devices ? Math.round((inWindow.length / e.devices) * 1000) / 1000 : null,
      worstGapMs,
      // What the measured per-beacon delivery predicts. Diverging badly from
      // the observed rate means loss is CONCENTRATED on particular devices
      // rather than spread evenly — a very different problem, and a worse one.
      modelledDetection:
        Math.round((1 - Math.pow(1 - p, beaconsPerWindow)) * 10000) / 10000,
    },
    gateways: link.list().map((g) => ({
      id: g.id, remote: g.remote, lines: g.lines, ageMs: g.ageMs, stale: g.stale,
      perSecond: Math.round((rateByGateway.get(g.id)?.perSecond() ?? 0) * 10) / 10,
      positioned: Boolean(cfg.gateways[g.id]),
    })),
    expected: e,
    measured: {
      reportsPerSec: Math.round(rateReports.perSecond() * 10) / 10,
      sightingsPerSec: Math.round(delivered * 10) / 10,
      deliveryRate: e.beaconsPerSec
        ? Math.round((delivered / e.beaconsPerSec) * 1000) / 1000
        : null,
      devicesSeen: mine.length,
      devicesUnexpected: online.length - mine.length,
      coverage: e.devices ? Math.round((mine.length / e.devices) * 1000) / 1000 : null,
    },
    downlink: {
      ...lastCmd,
      // The seq the largest part of the fleet is echoing, and its share.
      seqInFleet: seqTarget,
      adopted: current,
      distinctSeqs: hist.size,
      adoptionRate: current === null || mine.length === 0
        ? null
        : Math.round((current / mine.length) * 1000) / 1000,
    },
    dedupe: {
      ms: fleet.stats().dedupeMs,
      safe: cfg.expected.beaconIntervalMs >= fleet.stats().dedupeMs * 4,
    },
    fleet: fleet.stats(),
    counters,
  });
});

/**
 * `?positions=1` runs the estimator over every device. That is the expensive
 * call — 3,000 least-squares solves — so it is opt-in rather than the default
 * the 1 Hz dashboard hits.
 */
app.get("/api/devices", (req, res) => {
  const withPos = req.query.positions === "1";
  const limit = Math.min(Number(req.query.limit) || 5000, 5000);
  const onlineOnly = req.query.online !== "0";

  let devices = fleet.list();
  if (onlineOnly) devices = devices.filter((d) => d.online);
  devices = devices.slice(0, limit);

  res.json({
    count: devices.length,
    devices: devices.map((d) => (withPos ? { ...d, position: positioned(d) } : d)),
  });
});

/** Positions only — what the map polls. A tenth the bytes of the full list. */
app.get("/api/positions", (_req, res) => {
  const out = [];
  for (const d of fleet.list()) {
    if (!d.online) continue;
    const p = positioned(d);
    // resolved/pinned/rms travel with the point: the map needs to know
    // whether the clamp is what put it there before it draws a dot.
    if (p) {
      out.push({ uuid: d.uuid, x: p.x, y: p.y, r: p.r, n: p.n,
                 resolved: p.resolved, pinned: p.pinned, rms: p.rms });
    }
  }
  res.json({ count: out.length, venue: cfg.venue, gateways: cfg.gateways, devices: out });
});

app.get("/api/recent", (req, res) => {
  const n = Math.min(Number(req.query.n) || 40, RECENT_MAX);
  res.json({ lines: recent.slice(-n) });
});

/**
 * Downlink. Sends to every gateway and remembers the seq, so the adoption
 * rate in /api/stats answers "how much of the fleet actually got it" from the
 * cmd_seq the devices echo back — the only delivery statistic an
 * unacknowledged broadcast protocol has.
 */
app.post("/api/cmd", (req, res) => {
  let line;
  try {
    // buildCmd from the shipping server, NOT a string assembled here. The
    // loadgen boards run the shipping aura_band, so the only way this test
    // measures the real system is if both ends of the command path are the
    // real ones too. A hand-written 'aura cmd ...' here would be a second
    // implementation of the thing under test.
    line = buildCmd(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const sent = link.broadcast(line);
  if (!sent) return res.status(503).json({ error: "No gateway connected", line });

  lastCmd = { seq: null, at: new Date().toISOString(), line, gateways: sent };
  log("cmd", { line, sent });
  res.json({ ok: true, line, gatewaysSent: sent });
});

app.post("/api/op", (req, res) => {
  let line;
  try {
    line = buildOp(req.body?.mode, req.body?.param);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const sent = link.broadcast(line);
  if (!sent) return res.status(503).json({ error: "No gateway connected", line });
  log("op", { line, sent });
  res.json({ ok: true, line, gatewaysSent: sent });
});

/** Flash one device so you can find it in a room of 3,000. */
app.post("/api/identify", (req, res) => {
  let line;
  try {
    line = buildIdentify(req.body?.addr);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const sent = link.broadcast(line);
  if (!sent) return res.status(503).json({ error: "No gateway connected", line });
  res.json({ ok: true, line, gatewaysSent: sent });
});

app.get("/api/meta", (_req, res) => {
  res.json({ anims: ANIM_NAMES, ops: OP_NAMES });
});

/** Move a gateway without restarting. Calibration is an iterative business. */
app.post("/api/gateways/:id/position", (req, res) => {
  const { x, y } = req.body || {};
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: "x and y must be numbers, in metres" });
  }
  cfg.gateways[req.params.id] = { x, y };
  res.json({ ok: true, gateways: cfg.gateways });
});

/**
 * Tell the server what the fleet is currently doing.
 *
 * Delivery rate is measured against an EXPECTATION, so the moment you type
 * 'sim rate 2000' on the boards, this server is still dividing by the old
 * number and the headline percentage is wrong — usually flatteringly wrong,
 * which is the dangerous direction. Change it here in the same breath.
 */
app.post("/api/expected", (req, res) => {
  const b = req.body || {};
  if (Number.isFinite(b.blocks)) cfg.expected.blocks = b.blocks;
  if (Number.isFinite(b.perBlock)) cfg.expected.perBlock = b.perBlock;
  /*
   * A flat device count is easier to type than blocks x perBlock, but it
   * cannot be the whole story any more: each board now derives its own block,
   * so the server needs to know HOW MANY BOARDS make up that total in order to
   * size a block and count them.
   *
   * Collapsing to blocks=1 (which is what this did) set the block width to the
   * entire fleet, so "boards seen" counted 3000-address slabs of the band
   * instead of boards — reporting things like 14/1 — and the clash detector,
   * the one thing that catches two boards sharing a block, silently could not
   * fire.
   */
  if (Number.isFinite(b.devices)) {
    const boards = Number.isFinite(b.boards) && b.boards > 0
      ? Math.round(b.boards)
      : cfg.expected.blocks || 1;

    cfg.expected.blocks = boards;
    cfg.expected.perBlock = Math.max(1, Math.round(b.devices / boards));
  } else if (Number.isFinite(b.boards) && b.boards > 0) {
    cfg.expected.blocks = Math.round(b.boards);
  }
  if (Number.isFinite(b.base)) cfg.expected.base = b.base;
  if (Number.isFinite(b.beaconIntervalMs)) cfg.expected.beaconIntervalMs = b.beaconIntervalMs;
  if (Number.isFinite(b.presenceWindowMs)) cfg.expected.presenceWindowMs = b.presenceWindowMs;

  // The dedupe window only works while it sits far below the beacon interval.
  // Tie them together so speeding the fleet up cannot silently start merging
  // consecutive beacons and reporting loss that is not there.
  const dd = fleet.setBeaconInterval(cfg.expected.beaconIntervalMs);
  fleet.setPresenceWindow(expectedFleet().presenceWindowMs);

  log("expected", { ...expectedFleet(), ...dd });
  res.json({ ok: true, expected: expectedFleet(), dedupe: dd });
});

/** Same for the path-loss model — the two numbers worth calibrating live. */
app.post("/api/model", (req, res) => {
  const { refRssi, pathLossExp } = req.body || {};
  if (Number.isFinite(refRssi)) cfg.model.refRssi = refRssi;
  if (Number.isFinite(pathLossExp)) cfg.model.pathLossExp = pathLossExp;
  res.json({ ok: true, model: cfg.model });
});

app.post("/api/reset", (_req, res) => {
  fleet.reset();
  rateReports.reset();
  rateSightings.reset();
  for (const r of rateByGateway.values()) r.reset();
  counters.lines = counters.beacons = counters.other = counters.unparsed = 0;
  recent.length = 0;
  lastCmd = { seq: null, at: null, line: null };
  log("reset", {});
  res.json({ ok: true });
});

/* --------------------------------------------------------------- boot -- */

async function main() {
  const { port, host } = await link.listen();
  log("gateway_listener", { host, port });

  setInterval(() => {
    const n = link.reapIdle();
    if (n) log("gateway_reaped", { count: n });
    fleet.prune(10 * 60_000);
  }, 30_000).unref();

  const e = expectedFleet();
  app.listen(HTTP_PORT, () => {
    log("ready", {
      console: `http://localhost:${HTTP_PORT}/`,
      expectedDevices: e.devices,
      addressRange: `0x${e.base.toString(16).toUpperCase()}..0x${e.top.toString(16).toUpperCase()}`,
      expectedBeaconsPerSec: e.beaconsPerSec,
    });
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { app, fleet, link };
