/**
 * sightings.js — collapse "the same beacon, heard by several gateways" into
 * one event.
 *
 * At three gateways this barely matters. At thirty it is the difference
 * between a fleet of 3,000 and a server processing 12,000 lines a second and
 * reporting a fleet of 3,000 anyway. Every duplicate is real work: a parse, a
 * roster write, a row in the API response.
 *
 * ---------------------------------------------------------------------------
 * How the duplicate is identified
 * ---------------------------------------------------------------------------
 *
 * A beacon carries no sequence number of its own. `cseq` is the last COMMAND
 * the device acted on — it stays put for minutes at a time, so it cannot
 * separate one beacon from the next. The only thing that distinguishes two
 * reports of one transmission from two genuinely separate beacons is TIME:
 * gateways hearing the same frame report it within milliseconds of each
 * other, while the same device's next beacon is a whole interval away.
 *
 * So: a sighting is opened when a device is first heard, stays open for
 * `dedupeMs`, and every report arriving in that window is treated as another
 * gateway hearing the SAME transmission.
 *
 * `dedupeMs` must sit comfortably between the two timescales — well above
 * gateway-to-server jitter, well below the beacon interval. 250 ms against a
 * 10 s interval is a factor of 40 either side. If you ever run beacons at
 * 100 ms this assumption collapses and the numbers will quietly lie; that is
 * why `maxDedupeRatio` refuses to stay silent about it.
 *
 * A second report from the SAME gateway inside one window is not another
 * gateway hearing the frame — it is a retransmit, a relay, or a genuine
 * double. Counted separately, because conflating it with multi-gateway
 * reception would inflate the coverage statistic that the whole 30-gateway
 * argument rests on.
 */

const DEFAULT_DEDUPE_MS = 250;
const DEFAULT_ONLINE_MS = 30_000;
const RSSI_WINDOW = 8;

/**
 * `0x1A2B` | `1a2b` | `1A2B` -> `0x1A2B`. Null if unusable.
 *
 * DELIBERATELY DIFFERENT from server/lib/device-roster.js, which reads an
 * unprefixed string as DECIMAL (so "6699" means 0x1A2B). That is defensible
 * there — it has a legacy path that carries decimal ids — but it means a bare
 * "4C51" silently becomes 0x0004, four orders of magnitude wrong and with no
 * error to notice.
 *
 * Here every address is hex, always: the band range is 0x1000-0xFFFD and the
 * gateway prints `a=4C51` with no prefix. Reading that as decimal would merge
 * unrelated devices and quietly halve the apparent fleet, which in a test
 * whose whole output is a fleet count is the worst possible failure. So: bare
 * means hex, and there is no ambiguity to get wrong.
 */
function normaliseUuid(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^0x/i, "");
  if (!s || !/^[0-9a-f]+$/i.test(s)) return null;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return null;
  return `0x${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

function ewma(prev, next, alpha) {
  return prev === null || prev === undefined ? next : prev * (1 - alpha) + next * alpha;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.dedupeMs]  window in which reports are one transmission
 * @param {number} [opts.onlineMs]  silence before a device reads as gone
 * @param {() => number} [opts.now]
 */
function createFleet(opts = {}) {
  let dedupeMs = opts.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const onlineMs = opts.onlineMs ?? DEFAULT_ONLINE_MS;
  let presenceWindowMs = opts.presenceWindowMs ?? 0;

  /*
   * Every address heard at least once since the last reset.
   *
   * Separate from `devices` on purpose: prune() drops a device that has been
   * silent for ten minutes, which is right for a live roster and wrong for
   * "did this unit ever check in". A unit heard once at the start of a run
   * still counts an hour later — that is the whole point of the number.
   *
   * Holding 3,000 short strings costs nothing.
   */
  const everSeen = new Set();
  const now = opts.now ?? (() => Date.now());

  /** uuid -> device */
  const devices = new Map();

  const counters = {
    reports: 0,        // raw parsed beacon lines in
    sightings: 0,      // distinct transmissions
    multiGateway: 0,   // sightings heard by >1 gateway
    sameGatewayDup: 0, // second report from a gateway inside one window
  };

  function device(uuid) {
    let d = devices.get(uuid);
    if (!d) {
      d = {
        uuid,
        firstSeen: now(),
        lastSeen: now(),
        reports: 0,
        sightings: 0,
        caps: null,
        battery: null,
        cmdSeq: null,
        /*
         * Gap history — the raw material for the only question the client
         * actually asked: "were all 3,000 people detected, the whole time?"
         *
         * An instantaneous "seen in the last W seconds" can read 100% at
         * every sample and still hide a device that went dark for twelve
         * seconds at minute three. maxGapMs remembers that. missedWindows
         * counts how many times it happened.
         */
        prevSeen: null,
        lastGapMs: null,
        maxGapMs: 0,
        missedWindows: 0,
        /** gw id -> {gw, rssi, rssiAvg, count, lastSeen} */
        gateways: new Map(),
        // the sighting currently accepting reports
        _open: null,
      };
      devices.set(uuid, d);
    }
    return d;
  }

  /**
   * Feed one parsed beacon.
   * @param {object} r {uuid, gw, rssi, caps, battery, cmdSeq}
   * @returns {{device, sighting, duplicate, sameGateway}}
   */
  function observe(r) {
    const uuid = normaliseUuid(r.uuid);
    if (!uuid) return null;

    const t = now();
    const d = device(uuid);

    everSeen.add(uuid);
    counters.reports += 1;
    d.reports += 1;

    /*
     * Measure the gap BEFORE moving lastSeen. A first sighting has no gap:
     * the silence before a device was ever heard is not a dropout, it is
     * the device not having started yet.
     */
    if (d.prevSeen !== null) {
      const gap = t - d.prevSeen;
      d.lastGapMs = gap;
      if (gap > d.maxGapMs) d.maxGapMs = gap;
      if (presenceWindowMs && gap > presenceWindowMs) d.missedWindows += 1;
    }
    d.prevSeen = t;
    d.lastSeen = t;
    if (typeof r.caps === "number") d.caps = r.caps;
    if (typeof r.battery === "number") d.battery = r.battery;
    if (typeof r.cmdSeq === "number") d.cmdSeq = r.cmdSeq;

    // Per-gateway signal history. This is the raw material for positioning,
    // so it is kept per gateway and smoothed per gateway — averaging across
    // gateways would destroy exactly the information that locates anything.
    if (r.gw && typeof r.rssi === "number" && Number.isFinite(r.rssi)) {
      let g = d.gateways.get(r.gw);
      if (!g) {
        g = { gw: r.gw, rssi: r.rssi, rssiAvg: r.rssi, count: 0, lastSeen: t, _n: 0 };
        d.gateways.set(r.gw, g);
      }
      g.rssi = r.rssi;
      g._n = Math.min(g._n + 1, RSSI_WINDOW);
      g.rssiAvg = Math.round(ewma(g.rssiAvg, r.rssi, 1 / g._n) * 10) / 10;
      g.count += 1;
      g.lastSeen = t;
    }

    const open = d._open;
    const fresh = !open || t - open.t0 > dedupeMs;

    if (fresh) {
      const s = { t0: t, uuid, gateways: new Map(), duplicate: false };
      if (r.gw) s.gateways.set(r.gw, r.rssi);
      d._open = s;
      d.sightings += 1;
      counters.sightings += 1;
      return { device: d, sighting: s, duplicate: false, sameGateway: false };
    }

    const sameGateway = r.gw ? open.gateways.has(r.gw) : false;
    if (sameGateway) {
      counters.sameGatewayDup += 1;
    } else if (r.gw) {
      if (open.gateways.size === 1) counters.multiGateway += 1;
      open.gateways.set(r.gw, r.rssi);
    }
    return { device: d, sighting: open, duplicate: true, sameGateway };
  }

  /** Drop devices unheard for `pruneMs`. */
  function prune(pruneMs = onlineMs * 10) {
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

  /** Snapshot. `_open` is internal and never serialised. */
  function list() {
    const t = now();
    return [...devices.values()].map((d) => ({
      uuid: d.uuid,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      ageMs: t - d.lastSeen,
      online: t - d.lastSeen <= onlineMs,
      /*
       * The open gap counts. A device silent since minute two has a running
       * gap of eight minutes even though no sighting has closed it, and that
       * is the worst thing it has done, not its best historical gap.
       */
      maxGapMs: Math.max(d.maxGapMs, t - d.lastSeen),
      lastGapMs: d.lastGapMs,
      missedWindows: d.missedWindows +
        (presenceWindowMs && t - d.lastSeen > presenceWindowMs ? 1 : 0),
      reports: d.reports,
      sightings: d.sightings,
      caps: d.caps,
      battery: d.battery,
      cmdSeq: d.cmdSeq,
      gateways: [...d.gateways.values()]
        .map(({ _n, ...g }) => ({ ...g, ageMs: t - g.lastSeen }))
        .sort((a, b) => b.rssiAvg - a.rssiAvg),
    }));
  }

  function stats() {
    const all = list();
    const online = all.filter((d) => d.online);
    // How many gateways hear an average transmission. This is the number that
    // says what 30 gateways will cost the server, and it cannot be derived
    // from anything the gateways report on their own.
    const duplicationFactor = counters.sightings
      ? counters.reports / counters.sightings
      : 0;
    return {
      devices: all.length,
      online: online.length,
      ...counters,
      duplicationFactor: Math.round(duplicationFactor * 100) / 100,
      dedupeMs,
    };
  }

  /*
   * Keep the window well below the beacon interval.
   *
   * The whole method rests on two timescales being far apart: gateways
   * hearing ONE frame report it within milliseconds of each other, while the
   * same device's NEXT frame is a whole interval away. At a 10 s interval a
   * 250 ms window has a factor of 40 either side and the separation is
   * obvious.
   *
   * Sweep the fleet down to a 100 ms interval and that collapses: consecutive
   * beacons from one device now arrive well inside the window and get merged
   * as though they were one frame heard twice. The delivered rate then reads
   * roughly 2.5x low and the operator sees packet loss that does not exist —
   * which is exactly what happened the first time this was run at 100 ms.
   *
   * So the window follows the interval: a quarter of it, capped at the
   * configured value and floored at 20 ms (gateway-to-server jitter is a few
   * ms, and a window below that would split one frame's reports into several
   * sightings and invent duplicates in the other direction).
   */
  function setBeaconInterval(intervalMs) {
    const want = Math.round(intervalMs / 4);
    const next = Math.max(20, Math.min(opts.dedupeMs ?? DEFAULT_DEDUPE_MS, want));
    const changed = next !== dedupeMs;
    dedupeMs = next;
    return { dedupeMs, changed, safe: intervalMs >= dedupeMs * 4 };
  }

  /**
   * The success window, in ms. Devices score themselves against it as
   * sightings arrive, so changing it mid-run only affects gaps measured
   * from here on — call /api/reset if you want a clean comparison.
   */
  function setPresenceWindow(ms) {
    presenceWindowMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    return { presenceWindowMs };
  }

  function reset() {
    devices.clear();
    everSeen.clear();
    counters.reports = 0;
    counters.sightings = 0;
    counters.multiGateway = 0;
    counters.sameGatewayDup = 0;
  }

  return {
    observe, list, stats, prune, reset, devices, normaliseUuid,
    setBeaconInterval, setPresenceWindow,
    /** Distinct addresses heard at least once since reset. Survives prune. */
    everSeenCount: () => everSeen.size,
    everSeenHas: (uuid) => everSeen.has(uuid),
  };
}

module.exports = { createFleet, normaliseUuid };
