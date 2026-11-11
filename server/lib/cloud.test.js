const test = require("node:test");
const assert = require("node:assert");
const { createCloud, deviceId } = require("./cloud");

function harness(opts = {}) {
  const calls = [];
  let t = opts.start ?? 1_000_000;
  const responses = opts.responses ?? [];
  let i = 0;

  const cloud = createCloud({
    baseUrl: opts.baseUrl ?? "https://demo.example.com",
    cacheMs: opts.cacheMs,
    now: () => t,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r ?? { ok: true, status: 200, json: async () => [] };
    },
  });
  return { cloud, calls, advance: (ms) => (t += ms) };
}

const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
const fail = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

test("cloud", async (t) => {
  await t.test("normalises roster addresses to cloud device ids", () => {
    assert.strictEqual(deviceId("0x4C51"), "4C51");
    assert.strictEqual(deviceId("4c51"), "4C51");
    assert.strictEqual(deviceId("  0X4c51 "), "4C51");
    assert.strictEqual(deviceId(null), null);
    assert.strictEqual(deviceId(""), null);
    assert.strictEqual(deviceId("0x"), null);
  });

  await t.test("is inert until CLOUD_URL is set", async () => {
    const { cloud, calls } = harness({ baseUrl: "" });
    assert.strictEqual(cloud.configured(), false);
    await cloud.refresh();
    assert.strictEqual(calls.length, 0, "must not dial out when unconfigured");
    assert.deepStrictEqual(cloud.registrations(), []);
    await assert.rejects(() => cloud.send("0x4C51", "hi"), /CLOUD_URL/);
  });

  await t.test("caches registrations and keys them by address", async () => {
    const { cloud, calls } = harness({
      responses: [ok([{ device_id: "4c51", name: "Alex", cell: "+15551234567" }])],
      cacheMs: 5000,
    });
    await cloud.refresh();
    assert.strictEqual(calls[0].url, "https://demo.example.com/api/registrations");
    assert.deepStrictEqual(cloud.lookup("0x4C51").name, "Alex");
    assert.deepStrictEqual(cloud.lookup("4C51").cell, "+15551234567");
    assert.strictEqual(cloud.lookup("0xFFFF"), null);
  });

  await t.test("does not re-fetch inside the cache window", async () => {
    const { cloud, calls, advance } = harness({ responses: [ok([])], cacheMs: 5000 });
    await cloud.refresh();
    await cloud.refresh();
    advance(4999);
    await cloud.refresh();
    assert.strictEqual(calls.length, 1);
    advance(2);
    await cloud.refresh();
    assert.strictEqual(calls.length, 2);
  });

  await t.test("shares one request between concurrent callers", async () => {
    const { cloud, calls } = harness({ responses: [ok([])], cacheMs: 5000 });
    await Promise.all([cloud.refresh(), cloud.refresh(), cloud.refresh()]);
    assert.strictEqual(calls.length, 1, "a 1 Hz dashboard must not fan out");
  });

  await t.test("serves the last good list when a refresh fails", async () => {
    // The point of the whole module: a blip must not blank the operator's
    // screen mid-show.
    const { cloud, advance } = harness({
      responses: [ok([{ device_id: "4C51", name: "Alex", cell: "+1" }]), new Error("ENOTFOUND")],
      cacheMs: 1000,
    });
    await cloud.refresh();
    advance(2000);
    await cloud.refresh();
    assert.strictEqual(cloud.lookup("4C51").name, "Alex");
    assert.match(cloud.stats().lastError, /ENOTFOUND/);
  });

  await t.test("refresh never throws", async () => {
    const { cloud } = harness({ responses: [new Error("boom")] });
    await cloud.refresh();
    assert.strictEqual(cloud.stats().failures, 1);
  });

  await t.test("sends in the shape /api/action expects", async () => {
    const { cloud, calls } = harness({ responses: [ok({ ok: true, sid: "SM1" })] });
    const r = await cloud.send("0x4C51", "  Your pixel is blue  ");
    assert.strictEqual(calls[0].url, "https://demo.example.com/api/action");
    assert.strictEqual(calls[0].init.method, "POST");
    assert.deepStrictEqual(calls[0].body, {
      command: "audience_sample",
      device_id: "4C51",
      message: "Your pixel is blue",
    });
    assert.strictEqual(r.sid, "SM1");
    assert.strictEqual(r.deviceId, "4C51");
  });

  await t.test("surfaces a dry run rather than pretending it sent", async () => {
    const { cloud } = harness({ responses: [ok({ ok: true, dryRun: true, preview: "hi" })] });
    const r = await cloud.send("4C51", "hi");
    assert.strictEqual(r.dryRun, true);
  });

  await t.test("refuses an empty message before spending a request", async () => {
    const { cloud, calls } = harness();
    await assert.rejects(() => cloud.send("4C51", "   "), (e) => {
      assert.strictEqual(e.status, 400, "a bad request is not a bad gateway");
      return true;
    });
    assert.strictEqual(calls.length, 0);
  });

  await t.test("reports the app's own error text", async () => {
    const { cloud } = harness({ responses: [fail(404, "No registration for this device")] });
    await assert.rejects(() => cloud.send("4C51", "hi"), (e) => {
      assert.match(e.message, /No registration/);
      assert.strictEqual(e.status, 404, "the app's own status must survive");
      return true;
    });
    assert.strictEqual(cloud.stats().sendFailures, 1);
  });

  await t.test("sends the bearer token on every call when configured", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push([url, (init.headers || {}).authorization || null]);
      return { ok: true, json: async () => [] };
    };
    const c = createCloud({ baseUrl: "https://x.test", apiToken: "s3cret", fetchImpl });
    await c.refresh(true);
    await c.send("0x4C51", "hi").catch(() => {});
    assert.ok(seen.length >= 2);
    for (const [, auth] of seen) assert.equal(auth, "Bearer s3cret");
    assert.equal(c.stats().token, true);
  });

  await t.test("sends no auth header when no token is set", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push((init.headers || {}).authorization || null);
      return { ok: true, json: async () => [] };
    };
    const c = createCloud({ baseUrl: "https://x.test", fetchImpl });
    await c.refresh(true);
    assert.equal(seen[0], null);
    assert.equal(c.stats().token, false);
  });
});
