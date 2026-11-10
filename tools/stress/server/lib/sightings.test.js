const test = require("node:test");
const assert = require("node:assert");
const { createFleet, normaliseUuid } = require("./sightings");

function harness(opts = {}) {
  let t = opts.start ?? 1_000_000;
  const fleet = createFleet({ ...opts, now: () => t });
  return { fleet, advance: (ms) => (t += ms), at: () => t };
}

const bcn = (uuid, gw, rssi) => ({ uuid, gw, rssi, caps: 1, battery: 90, cmdSeq: 0 });

test("sightings", async (t) => {
  await t.test("normalises address spellings to one device", () => {
    assert.strictEqual(normaliseUuid("0x4c51"), "0x4C51");
    assert.strictEqual(normaliseUuid("4C51"), "0x4C51");
    const { fleet } = harness();
    fleet.observe(bcn("0x4C51", "gw-01", -50));
    fleet.observe(bcn("4c51", "gw-02", -60));
    assert.strictEqual(fleet.stats().devices, 1);
  });

  await t.test("one beacon heard by three gateways is ONE sighting", () => {
    // The entire point of the module. At 30 gateways this is the difference
    // between a fleet of 3,000 and an apparent fleet of 3,000 costing
    // 12,000 lines/s of work.
    const { fleet, advance } = harness({ dedupeMs: 250 });
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(8);
    fleet.observe(bcn("0x1001", "gw-02", -61));
    advance(11);
    fleet.observe(bcn("0x1001", "gw-03", -70));

    const s = fleet.stats();
    assert.strictEqual(s.reports, 3);
    assert.strictEqual(s.sightings, 1);
    assert.strictEqual(s.multiGateway, 1);
    assert.strictEqual(s.duplicationFactor, 3);
  });

  await t.test("the next beacon is a new sighting", () => {
    const { fleet, advance } = harness({ dedupeMs: 250 });
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(10_000);
    fleet.observe(bcn("0x1001", "gw-01", -52));
    const s = fleet.stats();
    assert.strictEqual(s.sightings, 2);
    assert.strictEqual(s.reports, 2);
  });

  await t.test("the window boundary is exclusive", () => {
    const { fleet, advance } = harness({ dedupeMs: 250 });
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(250);
    fleet.observe(bcn("0x1001", "gw-02", -50));
    assert.strictEqual(fleet.stats().sightings, 1, "250 ms is still inside");
    advance(251);
    fleet.observe(bcn("0x1001", "gw-02", -50));
    assert.strictEqual(fleet.stats().sightings, 2);
  });

  await t.test("a repeat from the SAME gateway is not extra coverage", () => {
    // Conflating a retransmit with a second gateway hearing the frame would
    // inflate the coverage statistic the 30-gateway case rests on.
    const { fleet, advance } = harness({ dedupeMs: 250 });
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(5);
    fleet.observe(bcn("0x1001", "gw-01", -51));

    const s = fleet.stats();
    assert.strictEqual(s.sameGatewayDup, 1);
    assert.strictEqual(s.multiGateway, 0, "one gateway is not multi-gateway");
    assert.strictEqual(s.sightings, 1);
  });

  await t.test("keeps RSSI per gateway, never averaged across them", () => {
    // Averaging across gateways would destroy the only information that
    // locates anything.
    const { fleet, advance } = harness();
    for (let i = 0; i < 5; i++) {
      fleet.observe(bcn("0x1001", "gw-01", -50));
      fleet.observe(bcn("0x1001", "gw-02", -80));
      advance(10_000);
    }
    const d = fleet.list()[0];
    assert.strictEqual(d.gateways.length, 2);
    const near = d.gateways.find((g) => g.gw === "gw-01");
    const far = d.gateways.find((g) => g.gw === "gw-02");
    assert.ok(Math.abs(near.rssiAvg - -50) < 2, `near ${near.rssiAvg}`);
    assert.ok(Math.abs(far.rssiAvg - -80) < 2, `far ${far.rssiAvg}`);
    assert.strictEqual(d.gateways[0].gw, "gw-01", "strongest first");
  });

  await t.test("smooths a jumpy gateway", () => {
    const { fleet, advance } = harness();
    for (const r of [-60, -48, -72, -58, -62, -59]) {
      fleet.observe(bcn("0x1001", "gw-01", r));
      advance(10_000);
    }
    const g = fleet.list()[0].gateways[0];
    assert.ok(g.rssiAvg > -70 && g.rssiAvg < -52,
      `smoothed ${g.rssiAvg} should sit near the middle, not chase outliers`);
  });

  await t.test("counts sightings per device, not per report", () => {
    const { fleet, advance } = harness({ dedupeMs: 250 });
    for (let i = 0; i < 4; i++) {
      fleet.observe(bcn("0x1001", "gw-01", -50));
      fleet.observe(bcn("0x1001", "gw-02", -60));
      fleet.observe(bcn("0x1001", "gw-03", -70));
      advance(10_000);
    }
    const d = fleet.list()[0];
    assert.strictEqual(d.sightings, 4);
    assert.strictEqual(d.reports, 12);
    assert.strictEqual(fleet.stats().duplicationFactor, 3);
  });

  await t.test("tracks a fleet independently", () => {
    const { fleet, advance } = harness();
    for (let i = 0; i < 150; i++) {
      fleet.observe(bcn(`0x${(0x1000 + i).toString(16)}`, "gw-01", -55));
    }
    advance(10_000);
    for (let i = 0; i < 150; i++) {
      fleet.observe(bcn(`0x${(0x1000 + i).toString(16)}`, "gw-01", -55));
    }
    const s = fleet.stats();
    assert.strictEqual(s.devices, 150);
    assert.strictEqual(s.sightings, 300);
    assert.strictEqual(s.duplicationFactor, 1, "one gateway, no duplication");
  });

  await t.test("goes offline on silence and prunes later", () => {
    const { fleet, advance } = harness({ onlineMs: 30_000 });
    fleet.observe(bcn("0x1001", "gw-01", -50));
    assert.strictEqual(fleet.list()[0].online, true);
    advance(31_000);
    assert.strictEqual(fleet.list()[0].online, false);
    assert.strictEqual(fleet.stats().devices, 1, "offline is not forgotten");
    advance(300_000);
    assert.strictEqual(fleet.prune(60_000), 1);
    assert.strictEqual(fleet.stats().devices, 0);
  });

  await t.test("never serialises internal state", () => {
    const { fleet } = harness();
    fleet.observe(bcn("0x1001", "gw-01", -50));
    const json = JSON.stringify(fleet.list());
    assert.ok(!json.includes("_open"), "open-sighting state must not leak");
    assert.ok(!json.includes('"_n"'), "smoothing counter must not leak");
  });

  await t.test("shrinks the window when the fleet speeds up", () => {
    // The regression that mattered: at a 100 ms beacon interval a 250 ms
    // window merges CONSECUTIVE beacons and reports ~2.5x packet loss that
    // does not exist.
    const { fleet, advance } = harness({ dedupeMs: 250 });

    fleet.setBeaconInterval(100);
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(100);
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(100);
    fleet.observe(bcn("0x1001", "gw-01", -50));

    assert.strictEqual(fleet.stats().sightings, 3,
      "three beacons 100 ms apart are three sightings, not one");
  });

  await t.test("still dedupes across gateways at the faster rate", () => {
    const { fleet, advance } = harness({ dedupeMs: 250 });
    fleet.setBeaconInterval(100);           // window becomes 25 ms

    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(6);
    fleet.observe(bcn("0x1001", "gw-02", -62));
    advance(6);
    fleet.observe(bcn("0x1001", "gw-03", -71));

    const st = fleet.stats();
    assert.strictEqual(st.sightings, 1, "one frame, three gateways");
    assert.strictEqual(st.multiGateway, 1);
  });

  await t.test("never widens past the configured maximum", () => {
    const { fleet } = harness({ dedupeMs: 250 });
    assert.strictEqual(fleet.setBeaconInterval(60_000).dedupeMs, 250);
  });

  await t.test("floors the window so one frame is not split", () => {
    // Below gateway-to-server jitter the window would break ONE frame's
    // reports into several sightings — duplicates invented in the other
    // direction.
    const { fleet } = harness({ dedupeMs: 250 });
    const r = fleet.setBeaconInterval(20);
    assert.strictEqual(r.dedupeMs, 20);
    assert.strictEqual(r.safe, false, "20 ms beacons cannot be deduped safely");
  });

  await t.test("a first sighting is not a dropout", () => {
    // Silence before a device was ever heard is the device not having
    // started, not a gap. Counting it would mark every device dirty the
    // moment the run began.
    const { fleet } = harness({ presenceWindowMs: 6000 });
    fleet.observe(bcn("0x1001", "gw-01", -50));
    const d = fleet.list()[0];
    assert.strictEqual(d.missedWindows, 0);
    assert.strictEqual(d.lastGapMs, null);
  });

  await t.test("a gap wider than the window is a miss, and is remembered", () => {
    const { fleet, advance } = harness({ presenceWindowMs: 6000, dedupeMs: 250 });
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(1000);
    fleet.observe(bcn("0x1001", "gw-01", -50));
    assert.strictEqual(fleet.list()[0].missedWindows, 0, "1 s gap is fine");

    advance(9000);                       // eight seconds late
    fleet.observe(bcn("0x1001", "gw-01", -50));
    const d = fleet.list()[0];
    assert.strictEqual(d.missedWindows, 1);
    assert.strictEqual(d.maxGapMs, 9000);

    // And it STAYS dirty once it recovers — that is the whole point.
    advance(1000);
    fleet.observe(bcn("0x1001", "gw-01", -50));
    assert.strictEqual(fleet.list()[0].missedWindows, 1);
    assert.strictEqual(fleet.list()[0].maxGapMs, 9000);
  });

  await t.test("the OPEN gap counts against a device that went quiet", () => {
    // A device silent since minute two has not closed a gap, but eight
    // minutes of silence is the worst thing it has done and the run must
    // say so rather than reporting its best historical behaviour.
    const { fleet, advance } = harness({ presenceWindowMs: 6000 });
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(30_000);
    const d = fleet.list()[0];
    assert.strictEqual(d.missedWindows, 1, "silent right now is a miss");
    assert.strictEqual(d.maxGapMs, 30_000);
  });

  await t.test("with no window configured nothing is scored", () => {
    const { fleet, advance } = harness();
    fleet.observe(bcn("0x1001", "gw-01", -50));
    advance(60_000);
    assert.strictEqual(fleet.list()[0].missedWindows, 0);
  });

  await t.test("a unit stays counted after it is pruned away", () => {
    // The demo number is "did every unit ever check in", so it must survive
    // the roster forgetting a device that went quiet. Prune is right for a
    // live view and wrong for this.
    const { fleet, advance } = harness();
    fleet.observe(bcn("0x1001", "gw-01", -50));
    fleet.observe(bcn("0x1002", "gw-01", -50));
    assert.strictEqual(fleet.everSeenCount(), 2);

    advance(60 * 60_000);
    fleet.prune(10 * 60_000);
    assert.strictEqual(fleet.stats().devices, 0, "roster forgets them");
    assert.strictEqual(fleet.everSeenCount(), 2, "the run does not");
  });

  await t.test("reset clears the ever-seen set", () => {
    const { fleet } = harness();
    fleet.observe(bcn("0x1001", "gw-01", -50));
    fleet.reset();
    assert.strictEqual(fleet.everSeenCount(), 0);
  });

  await t.test("address spellings do not double-count a unit", () => {
    const { fleet } = harness();
    fleet.observe(bcn("0x1001", "gw-01", -50));
    fleet.observe(bcn("1001", "gw-02", -60));
    assert.strictEqual(fleet.everSeenCount(), 1);
  });

  await t.test("ignores unusable addresses", () => {
    const { fleet } = harness();
    assert.strictEqual(fleet.observe({ uuid: null, gw: "gw-01", rssi: -50 }), null);
    assert.strictEqual(fleet.observe({ uuid: "", gw: "gw-01", rssi: -50 }), null);
    assert.strictEqual(fleet.stats().devices, 0);
  });
});
