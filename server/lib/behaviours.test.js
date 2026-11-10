const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { matches, validate, createBehaviours } = require("./behaviours");
const { parseColor } = require("./rest-v1");
const { buildCmd, ANIM_NAMES } = require("./aura-v2");

const deps = { anims: ANIM_NAMES, parseColor };
const rule = (when, then = [{ do: "light", target: "device", color: "#00ff00" }]) => validate({ when, then }, deps);

test("motion matches motion value 1 only", () => {
  const r = rule({ trigger: "motion" });
  assert.equal(matches(r, { kind: "event", event: "motion", value: 1 }), true);
  assert.equal(matches(r, { kind: "event", event: "motion", value: 0 }), false);
  assert.equal(matches(r, { kind: "event", event: "gesture", value: 1 }), false);
});

test("still matches motion value 0", () => {
  assert.equal(matches(rule({ trigger: "still" }), { kind: "event", event: "motion", value: 0 }), true);
});

test("there is no press trigger: Aura devices have no button input", () => {
  assert.throws(() => validate({ when: { trigger: "press" }, then: [{ do: "light" }] }, deps), /when.trigger/);
});

test("zone filter applies to motion", () => {
  const r = rule({ trigger: "motion", zone: "bar" });
  assert.equal(matches(r, { kind: "event", event: "motion", value: 1, zone: { id: "bar" } }), true);
  assert.equal(matches(r, { kind: "event", event: "motion", value: 1, zone: { id: "door" } }), false);
});

test("arrive: zone change into the zone, or first sighting there", () => {
  const r = rule({ trigger: "arrive", zone: "bar" });
  assert.equal(matches(r, { kind: "zone", to: { id: "bar" }, from: { id: "door" } }), true);
  assert.equal(matches(r, { kind: "zone", to: { id: "door" }, from: { id: "bar" } }), false);
  assert.equal(matches(r, { kind: "presence", state: "online", zone: { id: "bar" } }), true);
});

test("leave and quiet", () => {
  assert.equal(matches(rule({ trigger: "leave", zone: "bar" }), { kind: "zone", from: { id: "bar" }, to: { id: "door" } }), true);
  assert.equal(matches(rule({ trigger: "quiet" }), { kind: "presence", state: "offline" }), true);
  assert.equal(matches(rule({ trigger: "quiet" }), { kind: "presence", state: "online" }), false);
});

test("product filter", () => {
  const r = rule({ trigger: "motion", product: "Aura Tag" });
  assert.equal(matches(r, { kind: "event", event: "motion", value: 1, product: "Aura Tag" }), true);
  assert.equal(matches(r, { kind: "event", event: "motion", value: 1, product: "Aura One" }), false);
});

test("validation rejects bad input with a useful message", () => {
  assert.throws(() => validate({ when: { trigger: "sneeze" }, then: [] }, deps), /when.trigger/);
  assert.throws(() => validate({ when: { trigger: "motion" }, then: [] }, deps), /at least one action/);
  assert.throws(() => validate({ when: { trigger: "motion" }, then: [{ do: "light", color: "blue!" }] }, deps), /color/);
  assert.throws(() => validate({ when: { trigger: "motion" }, then: [{ do: "webhook", url: "ftp://x" }] }, deps), /http/);
});

test("handle: lights the device via the Link that heard it, honours cooldown, persists", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "beh-")), "b.json");
  const sent = [];
  const link = { send: (id, l) => { sent.push([id, l]); return 1; }, broadcast: (l) => { sent.push(["*", l]); return 1; } };
  const b = createBehaviours({ file, link, buildCmd, parseColor, anims: ANIM_NAMES, device: () => ({ product: "Aura Tag" }), log: () => {} });
  b.upsert({ id: "t", when: { trigger: "motion", product: "Aura Tag" }, then: [{ do: "light", target: "device", color: "#00ff00" }], cooldownS: 10 });
  const e = { kind: "event", event: "motion", value: 1, id: "0x1A2B", zone: { id: "bar" } };
  assert.deepEqual(b.handle(e), ["t"]);
  assert.deepEqual(b.handle(e), []); // cooldown
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "bar");
  assert.match(sent[0][1], /^aura cmd 0 1 0 0 0 0 255 0 255 0 1A2B$/);
  const again = createBehaviours({ file, link, buildCmd, parseColor, anims: ANIM_NAMES, device: () => null, log: () => {} });
  assert.equal(again.list().length, 1);
});
