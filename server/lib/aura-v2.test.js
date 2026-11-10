const test = require("node:test");
const assert = require("node:assert");
const { parseV2Line, buildCmd, buildOp, buildIdentify } = require("./aura-v2");

test("aura-v2", async (t) => {
  await t.test("parses a beacon", () => {
    const b = parseV2Line("<BCN a=E45F n=3 r=-52 caps=97 batt=64 fl=02 cseq=7");
    assert.deepStrictEqual(b, {
      kind: "beacon", uuid: "0xE45F", node_id: 3, rssi: -52,
      caps: 0x97, battery: 64, flags: 0x02, cmd_seq: 7,
      raw_line: "<BCN a=E45F n=3 r=-52 caps=97 batt=64 fl=02 cseq=7",
    });
  });

  await t.test("battery 0xFF is unknown, not 255 percent", () => {
    assert.strictEqual(
      parseV2Line("<BCN a=E45F n=3 r=-52 caps=97 batt=255 fl=00 cseq=1").battery,
      null,
    );
  });

  await t.test("parses events and contacts", () => {
    const e = parseV2Line("<EVT a=E45F n=3 r=-52 t=gesture v=2 s=100");
    assert.strictEqual(e.kind, "event");
    assert.strictEqual(e.event, "gesture");
    assert.strictEqual(e.value, 2);
    assert.strictEqual(e.strength, 100);

    const c = parseV2Line("<CON a=E45F n=3 r=-52 peer=0C4D pr=-71 ev=open");
    assert.strictEqual(c.kind, "contact");
    assert.strictEqual(c.peer, "0x0C4D");
    assert.strictEqual(c.peer_rssi, -71);
  });

  await t.test("ignores everything that is not a v2 line", () => {
    // Critically the legacy twin: if this ever parsed, every beacon would be
    // counted twice - once here and once through parseTelemetryLine.
    assert.strictEqual(parseV2Line("NODE: id=3 UUID: 0x0000E45F RSSI: -52"), null);
    assert.strictEqual(parseV2Line("uart:~$ "), null);
    assert.strictEqual(parseV2Line(""), null);
    assert.strictEqual(parseV2Line("<BCN a=E45F truncated"), null);
  });

  await t.test("builds commands with defaults", () => {
    assert.strictEqual(buildCmd({}), "aura cmd 0 1 0 0 0 0 0 0 255");
    assert.strictEqual(
      buildCmd({ group: 2, anim: 3, animParam: 50, r: 255, g: 80, b: 0, bright: 200 }),
      "aura cmd 2 3 50 0 0 255 80 0 200",
    );
    assert.strictEqual(buildOp(1), "aura op 1");
    assert.strictEqual(buildOp(5, 30), "aura op 5 30");
    assert.strictEqual(buildIdentify("0xE45F"), "aura identify E45F");
  });

  await t.test("dst keeps the devFlags slot filled", () => {
    // `aura cmd` is positional: dst is arg 11, so devFlags cannot be skipped.
    assert.strictEqual(buildCmd({ dst: "0xE45F" }), "aura cmd 0 1 0 0 0 0 0 0 255 0 E45F");
  });

  await t.test("rejects out-of-range fields before they reach the radio", () => {
    assert.throws(() => buildCmd({ anim: 999 }), /Invalid anim/);
    assert.throws(() => buildCmd({ r: -1 }), /Invalid r/);
    assert.throws(() => buildOp(9), /Invalid op/);
    assert.throws(() => buildIdentify("nope"), /Invalid address/);
  });
});
