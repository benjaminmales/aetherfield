/**
 * behaviours.js — "when this happens, do that", configured without code.
 *
 * A behaviour is a rule the client sets up in the console (or over
 * /api/v1/behaviours) that Demo Server runs locally, on the venue LAN, with
 * the internet unplugged:
 *
 *   {
 *     "id": "tag-press",
 *     "name": "Moving Tags light green",
 *     "enabled": true,
 *     "when": { "trigger": "motion", "zone": null, "product": "Aura Tag" },
 *     "then": [
 *       { "do": "light", "target": "device", "color": "#00ff66",
 *         "animation": "steady", "brightness": 255, "durationS": 5 },
 *       { "do": "webhook", "url": "http://10.0.0.20:8080/aura" }
 *     ],
 *     "cooldownS": 1
 *   }
 *
 * Triggers map onto the fleet events server.js already emits:
 *   motion / still       event kind "event", motion value 1 (started moving)
 *                        / 0 (came to rest)
 *   arrive / leave       event kind "zone" (to / from the filtered zone);
 *                        "arrive" with no zone filter also fires on first
 *                        sighting (presence online)
 *   quiet                presence offline
 *   any_event            any device event (motion, gesture)
 *
 * Light targets:
 *   device   the device that triggered it (unicast)
 *   zone     every device the triggering zone's Link reaches — note that a
 *            Link's radio does not stop at the zone's edge, so neighbours
 *            near the boundary will see it too
 *   all      the whole fleet, every Link
 *
 * `durationS` turns the light off again afterwards (target-scoped). Without
 * it the light stays as set.
 *
 * Execution is fire-and-forget and never blocks the radio path. Webhooks get
 * one attempt with a 2 s timeout — a trigger that lands late is worse than
 * one that never lands (same rule as lib/webhooks.js).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Aura devices receive commands, detect motion and report identity/status.
// There is no button on an Aura product, so there is no press trigger.
const TRIGGERS = ["motion", "still", "any_event", "arrive", "leave", "quiet"];
const TARGETS = ["device", "zone", "all"];
const WEBHOOK_TIMEOUT_MS = 2000;

function validate(b, { anims, parseColor }) {
  const when = b.when || {};
  if (!TRIGGERS.includes(when.trigger)) throw new Error(`when.trigger must be one of: ${TRIGGERS.join(", ")}`);
  const then = Array.isArray(b.then) ? b.then : [];
  if (!then.length) throw new Error("then must list at least one action");
  const actions = then.map((a, i) => {
    if (a.do === "light") {
      const target = a.target || "device";
      if (!TARGETS.includes(target)) throw new Error(`then[${i}].target must be one of: ${TARGETS.join(", ")}`);
      parseColor(a.color ?? "#ffffff");
      const animation = a.animation || "steady";
      if (!anims.includes(animation)) throw new Error(`then[${i}].animation must be one of: ${anims.join(", ")}`);
      const brightness = a.brightness ?? 255;
      if (!Number.isInteger(brightness) || brightness < 0 || brightness > 255) throw new Error(`then[${i}].brightness must be 0-255`);
      const durationS = a.durationS == null || a.durationS === "" ? null : Number(a.durationS);
      if (durationS !== null && !(durationS > 0 && durationS <= 3600)) throw new Error(`then[${i}].durationS must be 1-3600`);
      return { do: "light", target, color: a.color ?? "#ffffff", animation, brightness, durationS };
    }
    if (a.do === "webhook") {
      let u;
      try { u = new URL(a.url); } catch { throw new Error(`then[${i}].url must be an absolute URL`); }
      if (!/^https?:$/.test(u.protocol)) throw new Error(`then[${i}].url must be http(s)`);
      return { do: "webhook", url: u.toString() };
    }
    throw new Error(`then[${i}].do must be "light" or "webhook"`);
  });
  const cooldownS = b.cooldownS == null ? 1 : Number(b.cooldownS);
  if (!(cooldownS >= 0 && cooldownS <= 3600)) throw new Error("cooldownS must be 0-3600");
  return {
    id: b.id && /^[\w-]{1,32}$/.test(b.id) ? b.id : crypto.randomBytes(4).toString("hex"),
    name: String(b.name || when.trigger).slice(0, 80),
    enabled: b.enabled !== false,
    when: {
      trigger: when.trigger,
      zone: when.zone || null,
      product: when.product || null,
    },
    then: actions,
    cooldownS,
  };
}

/** Does this rule's `when` match this fleet event? Pure. */
function matches(rule, e) {
  const w = rule.when;
  if (w.product && (e.product || "").toLowerCase() !== w.product.toLowerCase()) return false;
  const zoneOf = (z) => (z && typeof z === "object" ? z.id : z) || null;
  switch (w.trigger) {
    case "motion":
    case "still":
      if (e.kind !== "event" || e.event !== "motion") return false;
      if (e.value !== (w.trigger === "motion" ? 1 : 0)) return false;
      return !w.zone || zoneOf(e.zone) === w.zone;
    case "any_event":
      return e.kind === "event" && (!w.zone || zoneOf(e.zone) === w.zone);
    case "arrive":
      if (e.kind === "zone") return !w.zone || zoneOf(e.to) === w.zone;
      if (e.kind === "presence" && e.state === "online") return !w.zone || zoneOf(e.zone) === w.zone;
      return false;
    case "leave":
      return e.kind === "zone" && (!w.zone ? Boolean(e.from) : zoneOf(e.from) === w.zone);
    case "quiet":
      return e.kind === "presence" && e.state === "offline" && (!w.zone || zoneOf(e.zone) === w.zone);
    default:
      return false;
  }
}

/**
 * @param {object} o
 * @param {string} o.file                   data/behaviours.json
 * @param {object} o.link                   send(id,line) / broadcast(line)
 * @param {(o) => string} o.buildCmd
 * @param {(c) => {r,g,b}} o.parseColor
 * @param {string[]} o.anims
 * @param {(id) => object|null} o.device    live device lookup, for product + zone
 * @param {(type,obj)=>void} o.log
 * @param {typeof fetch} [o.fetchImpl]
 */
function createBehaviours(o) {
  const doFetch = o.fetchImpl ?? globalThis.fetch;
  let rules = [];
  const lastFired = new Map();
  const stats = new Map(); // id -> { fired, lastAt, lastError }

  try { rules = JSON.parse(fs.readFileSync(o.file, "utf8")).behaviours || []; } catch (e) {
    if (e.code !== "ENOENT") console.warn(`behaviours: ignoring unreadable ${o.file}: ${e.message}`);
  }

  function save() {
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    fs.writeFileSync(`${o.file}.tmp`, JSON.stringify({ behaviours: rules }, null, 2));
    fs.renameSync(`${o.file}.tmp`, o.file);
  }

  function upsert(body) {
    const r = validate(body, o);
    rules = rules.filter((x) => x.id !== r.id).concat(r);
    save();
    return r;
  }

  function remove(id) {
    const n = rules.length;
    rules = rules.filter((x) => x.id !== id);
    if (rules.length === n) return false;
    save();
    return true;
  }

  function light(a, e) {
    const c = o.parseColor(a.color);
    const anim = o.anims.indexOf(a.animation);
    const zoneId = (e.zone && e.zone.id) || (e.to && e.to.id) || null;
    const send = (line) => {
      if (a.target === "device") {
        // Aim at the Link that heard it; fall back to all if it has gone.
        return (zoneId && o.link.send(zoneId, line)) || o.link.broadcast(line);
      }
      if (a.target === "zone") return zoneId ? o.link.send(zoneId, line) : 0;
      return o.link.broadcast(line);
    };
    const dst = a.target === "device" ? e.id : undefined;
    send(o.buildCmd({ group: 0, anim, ...c, bright: a.brightness, dst }));
    if (a.durationS) {
      setTimeout(() => send(o.buildCmd({ group: 0, anim: 0, r: 0, g: 0, b: 0, bright: 0, dst })),
        a.durationS * 1000).unref();
    }
  }

  function webhook(rule, a, e) {
    const st = stats.get(rule.id);
    Promise.resolve()
      .then(() => doFetch(a.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ behaviour: rule.id, name: rule.name, event: e }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      }))
      .then((res) => { if (res && !res.ok) st.lastError = `HTTP ${res.status}`; })
      .catch((err) => { st.lastError = err?.name === "TimeoutError" ? "timeout" : String(err?.message || err); });
  }

  /** Run every enabled rule that matches this fleet event. Returns ids fired. */
  function handle(e) {
    const fired = [];
    // Events from the radio line don't carry product; enrich once.
    const ev = e.product === undefined && e.id ? { ...e, product: o.device(e.id)?.product ?? null } : e;
    const t = Date.now();
    for (const rule of rules) {
      if (!rule.enabled || !matches(rule, ev)) continue;
      const key = `${rule.id}:${ev.id}`;
      if (t - (lastFired.get(key) ?? 0) < rule.cooldownS * 1000) continue;
      lastFired.set(key, t);
      if (!stats.has(rule.id)) stats.set(rule.id, { fired: 0, lastAt: null, lastError: null });
      const st = stats.get(rule.id);
      st.fired += 1;
      st.lastAt = new Date(t).toISOString();
      for (const a of rule.then) {
        try {
          if (a.do === "light") light(a, ev);
          else if (a.do === "webhook") webhook(rule, a, ev);
        } catch (err) {
          st.lastError = err.message;
        }
      }
      o.log("behaviour", { id: rule.id, device: ev.id, trigger: rule.when.trigger });
      fired.push(rule.id);
    }
    return fired;
  }

  return {
    list: () => rules.map((r) => ({ ...r, stats: stats.get(r.id) || { fired: 0, lastAt: null, lastError: null } })),
    upsert,
    remove,
    handle,
  };
}

module.exports = { createBehaviours, matches, validate, TRIGGERS, TARGETS };
