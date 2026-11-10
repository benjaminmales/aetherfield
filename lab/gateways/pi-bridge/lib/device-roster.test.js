/* Run: node device-roster.test.js  — exits non-zero on failure. */
const assert = require("node:assert/strict");
const { createRoster, normaliseUuid } = require("./device-roster");

let clock = 1_000_000;
const now = () => clock;
let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const line = (o) => ({
  node_id: 1, band_id: "3", uuid: "0x1A2B", rssi: -50,
  gesture: null, gesture_code: null, raw_line: "", ...o,
});

console.log("normaliseUuid");
t("hex with prefix", () => assert.equal(normaliseUuid("0x1a2b"), "0x1A2B"));
t("bare decimal", () => assert.equal(normaliseUuid("6699"), "0x1A2B"));
t("pads short values", () => assert.equal(normaliseUuid("0x5"), "0x0005"));
t("null for junk", () => assert.equal(normaliseUuid("zzz"), null));
t("null for empty", () => assert.equal(normaliseUuid(""), null));
t("null for undefined", () => assert.equal(normaliseUuid(undefined), null));

console.log("ingest");
t("creates a record", () => {
  const r = createRoster({ now });
  r.ingest(line());
  const [d] = r.list();
  assert.equal(d.uuid, "0x1A2B");
  assert.equal(d.packets, 1);
  assert.equal(d.rssi, -50);
  assert.equal(d.online, true);
});

t("decimal and hex forms are the same device", () => {
  const r = createRoster({ now });
  r.ingest(line({ uuid: "0x1A2B" }));
  r.ingest(line({ uuid: "6699" }));
  assert.equal(r.list().length, 1);
  assert.equal(r.list()[0].packets, 2);
});

t("ignores rows with no uuid", () => {
  const r = createRoster({ now });
  assert.equal(r.ingest(line({ uuid: null })), null);
  assert.equal(r.list().length, 0);
});

t("ignores null input", () => {
  const r = createRoster({ now });
  assert.equal(r.ingest(null), null);
});

t("rolling rssi average", () => {
  const r = createRoster({ now });
  r.ingest(line({ rssi: -40 }));
  r.ingest(line({ rssi: -60 }));
  const [d] = r.list();
  assert.equal(d.rssi, -60, "last");
  assert.equal(d.rssiAvg, -50, "avg");
});

t("collects distinct node ids", () => {
  const r = createRoster({ now });
  r.ingest(line({ node_id: 2 }));
  r.ingest(line({ node_id: 1 }));
  r.ingest(line({ node_id: 2 }));
  assert.deepEqual(r.list()[0].nodeIds, [1, 2]);
});

t("counts gestures", () => {
  const r = createRoster({ now });
  r.ingest(line({ gesture: "clap", gesture_code: 1 }));
  r.ingest(line());
  r.ingest(line({ gesture: "clap", gesture_code: 1 }));
  const [d] = r.list();
  assert.equal(d.gestureCount, 2);
  assert.equal(d.lastGesture, "clap");
});

t("v1 fields default to null under v0", () => {
  const r = createRoster({ now });
  r.ingest(line());
  const [d] = r.list();
  assert.equal(d.battery, null);
  assert.equal(d.caps, null);
});

t("v1 fields populate when present", () => {
  const r = createRoster({ now });
  r.ingest(line({ battery: 87, caps: 0x1d }));
  const [d] = r.list();
  assert.equal(d.battery, 87);
  assert.equal(d.caps, 0x1d);
});

console.log("staleness");
t("goes offline after onlineMs", () => {
  const r = createRoster({ now, onlineMs: 10_000 });
  r.ingest(line());
  assert.equal(r.list()[0].online, true);
  clock += 11_000;
  assert.equal(r.list()[0].online, false, "should be stale");
  assert.equal(r.list()[0].ageMs, 11_000);
  clock -= 11_000;
});

t("pruned after pruneMs", () => {
  const r = createRoster({ now, pruneMs: 60_000 });
  r.ingest(line());
  clock += 61_000;
  assert.equal(r.list().length, 0, "should be gone");
  clock -= 61_000;
});

t("online sorts before stale, then by signal", () => {
  const r = createRoster({ now, onlineMs: 10_000 });
  r.ingest(line({ uuid: "0x0001", rssi: -80 }));
  clock += 20_000;
  r.ingest(line({ uuid: "0x0002", rssi: -30 }));
  r.ingest(line({ uuid: "0x0003", rssi: -70 }));
  const order = r.list().map((d) => d.uuid);
  assert.deepEqual(order, ["0x0002", "0x0003", "0x0001"]);
  clock -= 20_000;
});

t("internal rssi samples never leak into the API", () => {
  const r = createRoster({ now });
  r.ingest(line());
  assert.equal("_rssiSamples" in r.list()[0], false);
});

t("stats counts online vs total", () => {
  const r = createRoster({ now, onlineMs: 10_000 });
  r.ingest(line({ uuid: "0x0001" }));
  clock += 20_000;
  r.ingest(line({ uuid: "0x0002" }));
  const s = r.stats();
  assert.equal(s.total, 2);
  assert.equal(s.online, 1);
  clock -= 20_000;
});

console.log(`\n${passed} passed${process.exitCode ? " — WITH FAILURES" : ""}`);
