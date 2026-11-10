const test = require("node:test");
const assert = require("node:assert");
const { createRate } = require("./rates");

test("rates", async (t) => {
  await t.test("measures a steady rate", () => {
    let now = 1_000_000_000;
    const r = createRate(10, () => now);
    for (let s = 0; s < 12; s++) {
      for (let i = 0; i < 40; i++) r.add();
      now += 1000;
    }
    assert.ok(Math.abs(r.perSecond() - 40) < 0.001, `got ${r.perSecond()}`);
  });

  await t.test("excludes the second still filling", () => {
    // Otherwise every reading is dragged down by a partial bucket and the
    // operator sees phantom packet loss.
    let now = 1_000_000_000;
    const r = createRate(10, () => now);
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 100; i++) r.add();
      now += 1000;
    }
    r.add(); // one event into the current, incomplete second
    assert.ok(Math.abs(r.perSecond() - 100) < 0.001, `got ${r.perSecond()}`);
  });

  await t.test("settles at the new value within the window", () => {
    let now = 1_000_000_000;
    const r = createRate(10, () => now);
    for (let s = 0; s < 10; s++) { for (let i = 0; i < 100; i++) r.add(); now += 1000; }
    for (let s = 0; s < 10; s++) { for (let i = 0; i < 50; i++) r.add(); now += 1000; }
    assert.ok(Math.abs(r.perSecond() - 50) < 0.001,
      `should be exactly the new rate, not an asymptote: ${r.perSecond()}`);
  });

  await t.test("a silent window reads zero, not the last value", () => {
    let now = 1_000_000_000;
    const r = createRate(5, () => now);
    for (let i = 0; i < 100; i++) r.add();
    now += 20_000;
    assert.strictEqual(r.perSecond(), 0);
  });
});
