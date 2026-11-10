const test = require("node:test");
const assert = require("node:assert");
const { createWebhooks, matches, render } = require("./webhooks");

function harness(hooks, opts = {}) {
  const calls = [];
  let t = opts.start ?? 1_000_000;
  const wh = createWebhooks({
    hooks: () => hooks,
    gatewayId: "gw-test",
    now: () => t,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), init });
      return opts.response ?? { ok: true, status: 200 };
    },
  });
  return { wh, calls, advance: (ms) => (t += ms), at: () => t };
}

test("webhooks", async (t) => {
  await t.test("fires a matching hook and stamps the payload", async () => {
    const { wh, calls } = harness([
      { id: "td", on: "event", url: "http://10.0.0.5:9980/aura" },
    ]);
    wh.dispatch({ kind: "event", device: "0x1A2B", event: "gesture", value: 2, strength: 100 });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "http://10.0.0.5:9980/aura");
    assert.strictEqual(calls[0].init.method, "POST");
    assert.strictEqual(calls[0].body.gateway, "gw-test");
    assert.strictEqual(calls[0].body.device, "0x1A2B");
    assert.strictEqual(calls[0].body.value, 2);
    assert.strictEqual(calls[0].body.hook, "td");
  });

  await t.test("carries no personal data", () => {
    // The gateway never learns names or numbers; if this ever fails, the
    // cloud/gateway PII boundary (WHITEPAPER 9) has been breached upstream.
    const { wh, calls } = harness([{ id: "td", url: "http://x/" }]);
    wh.dispatch({ kind: "event", device: "0x1A2B", event: "gesture", value: 2 });
    const keys = Object.keys(calls.length ? calls[0].body : {});
    for (const forbidden of ["name", "phone", "email", "guest"]) {
      assert.ok(!keys.includes(forbidden), `payload leaked ${forbidden}`);
    }
  });

  await t.test("match filters on any event field; absent keys are wildcards", () => {
    const clap = { kind: "event", device: "0x1", event: "gesture", value: 2 };
    const raise = { kind: "event", device: "0x1", event: "gesture", value: 1 };
    const hook = { id: "h", on: "event", match: { event: "gesture", value: 2 }, url: "http://x/" };
    assert.ok(matches(hook, clap));
    assert.ok(!matches(hook, raise));
    assert.ok(matches({ id: "h", url: "http://x/" }, raise)); // no filter = everything
    assert.ok(!matches({ ...hook, enabled: false }, clap));
    assert.ok(!matches({ id: "h", on: "contact", url: "http://x/" }, clap));
  });

  await t.test("cooldown is per device by default", async () => {
    const { wh, calls, advance } = harness([
      { id: "td", on: "event", url: "http://x/", cooldownMs: 2000 },
    ]);
    wh.dispatch({ kind: "event", device: "0xAAAA", event: "gesture" });
    wh.dispatch({ kind: "event", device: "0xAAAA", event: "gesture" }); // suppressed
    wh.dispatch({ kind: "event", device: "0xBBBB", event: "gesture" }); // different band
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls.length, 2);

    advance(2001);
    wh.dispatch({ kind: "event", device: "0xAAAA", event: "gesture" });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls.length, 3);

    assert.strictEqual(wh.stats().hooks[0].suppressed, 1);
  });

  await t.test("perDevice:false shares one cooldown across the fleet", async () => {
    const { wh, calls } = harness([
      { id: "td", url: "http://x/", cooldownMs: 5000, perDevice: false },
    ]);
    wh.dispatch({ kind: "event", device: "0xAAAA" });
    wh.dispatch({ kind: "event", device: "0xBBBB" });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls.length, 1);
  });

  await t.test("dispatch never throws or blocks when the target is down", async () => {
    const wh = createWebhooks({
      hooks: () => [{ id: "dead", url: "http://127.0.0.1:1/" }],
      fetchImpl: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
      },
    });
    assert.deepStrictEqual(wh.dispatch({ kind: "event", device: "0x1" }), ["dead"]);
    await new Promise((r) => setImmediate(r));
    const h = wh.stats().hooks[0];
    assert.strictEqual(h.failed, 1);
    assert.match(h.lastError, /ECONNREFUSED/);
  });

  await t.test("records a non-2xx as a failure", async () => {
    const { wh } = harness([{ id: "td", url: "http://x/" }], {
      response: { ok: false, status: 503 },
    });
    wh.dispatch({ kind: "event", device: "0x1" });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(wh.stats().hooks[0].lastError, "HTTP 503");
  });

  await t.test("body template posts the shape an existing endpoint wants", async () => {
    // aura-registration's /api/action contract: {device_id, command, message}.
    const { wh, calls } = harness([
      {
        id: "sms",
        on: "presence",
        url: "https://app.example/api/action",
        body: {
          device_id: "{{device}}",
          command: "audience_sample",
          message: "Welcome — band {{device}} just arrived",
        },
      },
    ]);
    wh.dispatch({ kind: "presence", device: "0xE45F", event: "enter", rssi: -52 });
    await new Promise((r) => setImmediate(r));

    assert.deepStrictEqual(calls[0].body, {
      device_id: "0xE45F",
      command: "audience_sample",
      message: "Welcome — band 0xE45F just arrived",
    });
  });

  await t.test("a whole-string placeholder keeps its type", async () => {
    // {{value}} alone must stay the number 2, not become the string "2" —
    // receivers that range-check a numeric field would reject the string.
    const { wh, calls } = harness([
      { id: "h", url: "http://x/", body: { n: "{{value}}", s: "v={{value}}" } },
    ]);
    wh.dispatch({ kind: "event", device: "0x1", value: 2 });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls[0].body.n, 2);
    assert.strictEqual(calls[0].body.s, "v=2");
  });

  await t.test("missing template fields render empty, never 'undefined'", () => {
    assert.deepStrictEqual(render({ a: "{{nope}}", b: "x{{nope}}y" }, { device: "0x1" }), {
      a: "",
      b: "xy",
    });
  });

  await t.test("ignores hooks with no id or no url", () => {
    const { wh, calls } = harness([{ url: "http://x/" }, { id: "no-url" }]);
    assert.deepStrictEqual(wh.dispatch({ kind: "event", device: "0x1" }), []);
    assert.strictEqual(calls.length, 0);
  });
});
