/* Run: node gateway-link.test.js — real sockets on an ephemeral port. */
const assert = require("node:assert/strict");
const net = require("node:net");
const { createGatewayLink, parseKv, MAX_LINE } = require("./gateway-link");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;

async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ port, host: "127.0.0.1" }, () => resolve(s));
    s.on("error", reject);
  });
}

async function withLink(opts, fn) {
  const lines = [];
  const events = [];
  const link = createGatewayLink({
    port: 0,
    onLine: (l, gw) => lines.push({ line: l, gw: gw.id }),
    onConnect: (gw) => events.push(["connect", gw.connKey]),
    onDisconnect: (gw, r) => events.push(["disconnect", gw.id ?? gw.connKey, r]),
    ...opts,
  });
  // port 0 → ask the OS; re-read the real port from the server
  const net_ = require("node:net");
  const srv = net_.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  const link2 = createGatewayLink({
    port,
    host: "127.0.0.1",
    onLine: (l, gw) => lines.push({ line: l, gw: gw.id }),
    onConnect: (gw) => events.push(["connect", gw.connKey]),
    onDisconnect: (gw, r) => events.push(["disconnect", gw.id ?? gw.connKey, r]),
    ...opts,
  });
  await link2.listen();
  try {
    await fn({ link: link2, port, lines, events });
  } finally {
    await link2.close();
  }
}

(async () => {
  console.log("parseKv");
  await t("splits key=value tokens", () => {
    assert.deepEqual(parseKv("gw=gw-01 fw=1.0.0 proto=2"),
      { gw: "gw-01", fw: "1.0.0", proto: "2" });
  });
  await t("ignores tokens with no =", () => {
    assert.deepEqual(parseKv("HELLO gw=a junk"), { gw: "a" });
  });

  console.log("gateway link");
  await t("HELLO names the gateway and it appears in list()", async () => {
    await withLink({}, async ({ link, port }) => {
      const s = await connect(port);
      s.write("HELLO gw=gw-01 fw=1.2.3 proto=2\n");
      await sleep(60);
      const [gw] = link.list();
      assert.equal(gw.id, "gw-01");
      assert.equal(gw.fw, "1.2.3");
      s.destroy();
    });
  });

  await t("beacon lines reach onLine, HELLO does not", async () => {
    await withLink({}, async ({ link, port, lines }) => {
      const s = await connect(port);
      s.write("HELLO gw=gw-01\n<BCN a=1A2B n=3 r=-52 caps=97 batt=88 fl=02 cseq=7\n");
      await sleep(60);
      assert.equal(lines.length, 1, "only the beacon");
      assert.match(lines[0].line, /^<BCN a=1A2B/);
      assert.equal(lines[0].gw, "gw-01", "line is attributed to the gateway");
      s.destroy();
    });
  });

  await t("reassembles a line split across TCP segments", async () => {
    await withLink({}, async ({ link, port, lines }) => {
      const s = await connect(port);
      s.write("HELLO gw=gw-01\n<BCN a=1A2B n=3 r=-5");
      await sleep(30);
      assert.equal(lines.length, 0, "nothing yet — no newline");
      s.write("2 caps=97 batt=88 fl=02 cseq=7\n");
      await sleep(40);
      assert.equal(lines.length, 1);
      assert.match(lines[0].line, /r=-52 caps=97/);
      s.destroy();
    });
  });

  await t("handles several lines in one segment", async () => {
    await withLink({}, async ({ link, port, lines }) => {
      const s = await connect(port);
      s.write("HELLO gw=g\n<EVT a=1 n=0 r=-1 t=button v=1 s=1\n<EVT a=2 n=0 r=-1 t=button v=1 s=1\n");
      await sleep(60);
      assert.equal(lines.length, 2);
      s.destroy();
    });
  });

  await t("tolerates CRLF and blank lines", async () => {
    await withLink({}, async ({ link, port, lines }) => {
      const s = await connect(port);
      s.write("HELLO gw=g\r\n\r\n<V0 a=1A2B n=0 r=-52 fl=02\r\n");
      await sleep(60);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].line, "<V0 a=1A2B n=0 r=-52 fl=02");
      s.destroy();
    });
  });

  await t("answers PING with PONG", async () => {
    await withLink({}, async ({ port }) => {
      const s = await connect(port);
      const got = [];
      s.on("data", (d) => got.push(d.toString()));
      s.write("HELLO gw=g\nPING\n");
      await sleep(80);
      assert.match(got.join(""), /PONG/);
      s.destroy();
    });
  });

  await t("send() targets one gateway by id", async () => {
    await withLink({}, async ({ link, port }) => {
      const a = await connect(port), b = await connect(port);
      const gotA = [], gotB = [];
      a.on("data", (d) => gotA.push(d.toString()));
      b.on("data", (d) => gotB.push(d.toString()));
      a.write("HELLO gw=gw-01\n");
      b.write("HELLO gw=gw-02\n");
      await sleep(60);
      assert.equal(link.send("gw-02", "aura identify 1A2B"), true);
      assert.equal(link.send("gw-99", "aura identify 1A2B"), false, "unknown id");
      await sleep(60);
      assert.equal(gotA.join("").includes("identify"), false, "gw-01 must not receive it");
      assert.match(gotB.join(""), /aura identify 1A2B/);
      a.destroy(); b.destroy();
    });
  });

  await t("broadcast() reaches every gateway", async () => {
    await withLink({}, async ({ link, port }) => {
      const a = await connect(port), b = await connect(port);
      const got = [];
      a.on("data", (d) => got.push("a:" + d));
      b.on("data", (d) => got.push("b:" + d));
      a.write("HELLO gw=gw-01\n");
      b.write("HELLO gw=gw-02\n");
      await sleep(60);
      assert.equal(link.broadcast("aura cmd 0 2 0 0 0 255 0 0 255"), 2);
      await sleep(60);
      assert.equal(got.filter((x) => x.includes("aura cmd")).length, 2);
      a.destroy(); b.destroy();
    });
  });

  await t("drops a peer that never sends a newline", async () => {
    await withLink({}, async ({ link, port, events }) => {
      const s = await connect(port);
      s.write("x".repeat(MAX_LINE + 100));
      await sleep(100);
      assert.equal(link.list().length, 0, "connection should be gone");
      assert.ok(events.some((e) => e[0] === "disconnect" && /too long/.test(e[2])));
      s.destroy();
    });
  });

  await t("disconnect removes it from list()", async () => {
    await withLink({}, async ({ link, port }) => {
      const s = await connect(port);
      s.write("HELLO gw=gw-01\n");
      await sleep(50);
      assert.equal(link.list().length, 1);
      s.destroy();
      await sleep(80);
      assert.equal(link.list().length, 0);
    });
  });

  await t("stale flag set by staleMs, socket left alone", async () => {
    let clock = 1_000_000;
    await withLink({ now: () => clock, staleMs: 1000 }, async ({ link, port }) => {
      const s = await connect(port);
      s.write("HELLO gw=gw-01\n");
      await sleep(50);
      assert.equal(link.list()[0].stale, false);
      clock += 5000;
      assert.equal(link.list()[0].stale, true, "flagged stale");
      assert.equal(link.list().length, 1, "but still connected");
      s.destroy();
    });
  });

  await t("reapIdle destroys sockets past idleTimeoutMs", async () => {
    let clock = 1_000_000;
    await withLink({ now: () => clock, idleTimeoutMs: 2000 }, async ({ link, port }) => {
      const s = await connect(port);
      s.write("HELLO gw=gw-01\n");
      await sleep(50);
      assert.equal(link.reapIdle(), 0);
      clock += 5000;
      assert.equal(link.reapIdle(), 1);
      assert.equal(link.list().length, 0);
      s.destroy();
    });
  });

  await t("re-HELLO after reboot updates the id in place", async () => {
    await withLink({}, async ({ link, port }) => {
      const s = await connect(port);
      s.write("HELLO gw=old\n");
      await sleep(50);
      assert.equal(link.list()[0].id, "old");
      s.write("HELLO gw=gw-01 fw=2.0.0\n");
      await sleep(50);
      assert.equal(link.list()[0].id, "gw-01");
      assert.equal(link.list()[0].fw, "2.0.0");
      s.destroy();
    });
  });

  await t("list() never leaks the socket or buffer", async () => {
    await withLink({}, async ({ link, port }) => {
      const s = await connect(port);
      s.write("HELLO gw=g\n");
      await sleep(50);
      const gw = link.list()[0];
      assert.equal("_socket" in gw, false);
      assert.equal("_buf" in gw, false);
      assert.equal(JSON.stringify(gw).length > 0, true, "must be serialisable");
      s.destroy();
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
