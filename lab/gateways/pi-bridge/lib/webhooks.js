/**
 * webhooks.js — the gateway's OUTBOUND direction.
 *
 * Art-Net already comes *in* and drives bands (see directDMX in server.js).
 * This is the other way round: something happens on the radio, and the gateway
 * tells a local machine about it — a media server, a lighting controller, a
 * TouchDesigner box on the same LAN.
 *
 * Why the gateway and not the cloud (WHITEPAPER §7.3): the receiving machine
 * sits behind the venue's NAT, so a cloud POST cannot reach it without a
 * tunnel on that machine. The gateway is already on the same wire. It is
 * faster, needs no tunnel, and the physical reaction keeps working when the
 * internet does not. The cloud's job is the part only the cloud can do —
 * resolving identity and sending the message.
 *
 * Three rules this module exists to enforce:
 *
 *   1. NEVER BLOCK THE SERIAL PATH. dispatch() returns immediately. Radio
 *      frames keep being parsed while an HTTP request is in flight.
 *   2. NO QUEUE, NO RETRY. One attempt, short timeout, then drop and record
 *      the error. A trigger that lands eight seconds late because a laptop
 *      was asleep is worse than one that never lands — the show has moved on.
 *      (Telemetry queues and replays; triggers must not. Same rule as
 *      downlink commands.)
 *   3. NO PII. The payload carries a device ADDRESS. Names and phone numbers
 *      live in the cloud tier and never reach the gateway, its logs, or its
 *      disk. Keeping that boundary clean is much cheaper than scrubbing it.
 *
 * Pure except for the injected fetch: no timers, no I/O of its own, clock and
 * transport both injectable so the tests are deterministic.
 */

/**
 * Substitute {{field}} placeholders from the payload, recursively through
 * objects and arrays. Non-strings pass through untouched, so numbers stay
 * numbers. A whole-string placeholder ("{{value}}") keeps the original type,
 * which matters when the receiver expects a number rather than "2".
 *
 * This exists so a hook can post the shape an EXISTING endpoint already wants
 * instead of us writing an adapter per integration. aura-registration's
 * /api/action, for instance, wants {device_id, command, message}.
 */
function render(tpl, vars) {
  if (typeof tpl === "string") {
    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(tpl);
    if (whole) return vars[whole[1]] !== undefined ? vars[whole[1]] : "";
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) =>
      vars[k] === undefined || vars[k] === null ? "" : String(vars[k]),
    );
  }
  if (Array.isArray(tpl)) return tpl.map((v) => render(v, vars));
  if (tpl && typeof tpl === "object") {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = render(v, vars);
    return out;
  }
  return tpl;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_COOLDOWN_MS = 1000;
const MAX_RECENT = 20;

/** Does one configured hook want this event? */
function matches(hook, evt) {
  if (hook.enabled === false) return false;
  if (hook.on && hook.on !== evt.kind) return false;

  const m = hook.match;
  if (!m) return true;

  // Every key present in `match` must equal the event's field. Absent keys
  // are wildcards, so {} matches everything of that kind.
  for (const [k, want] of Object.entries(m)) {
    if (want === undefined || want === null) continue;
    if (evt[k] !== want) return false;
  }
  return true;
}

/**
 * @param {object} opts
 * @param {() => object[]} opts.hooks   reads the live hook list (config can change)
 * @param {string} [opts.gatewayId]     stamped into every payload
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 */
function createWebhooks(opts = {}) {
  const readHooks = opts.hooks ?? (() => []);
  const gatewayId = opts.gatewayId ?? null;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());

  /** key -> last fire ms. Key is hook id, or `${id}:${device}` when perDevice. */
  const lastFired = new Map();
  const counters = new Map();
  const recent = [];

  function counter(id) {
    let c = counters.get(id);
    if (!c) {
      c = { id, fired: 0, suppressed: 0, failed: 0, lastAt: null, lastError: null };
      counters.set(id, c);
    }
    return c;
  }

  function cooldownKey(hook, evt) {
    return hook.perDevice === false ? hook.id : `${hook.id}:${evt.device || "-"}`;
  }

  function buildPayload(hook, evt, t) {
    const base = {
      v: 2,
      gateway: gatewayId,
      at: new Date(t).toISOString(),
      hook: hook.id,
      ...evt,
    };
    // A hook with no `body` posts the native shape. With one, it posts
    // whatever that endpoint expects, filled from the same fields.
    return hook.body ? render(hook.body, base) : base;
  }

  /**
   * Fire every hook matching this event. Returns the hooks that actually fired
   * (already dispatched — the promises are not awaited by design).
   *
   * @param {object} evt {kind:'event'|'contact'|'presence', device, ...}
   */
  function dispatch(evt) {
    const t = now();
    const fired = [];

    for (const hook of readHooks()) {
      if (!hook || !hook.id || !hook.url) continue;
      if (!matches(hook, evt)) continue;

      const key = cooldownKey(hook, evt);
      const cooldown = Number.isFinite(hook.cooldownMs) ? hook.cooldownMs : DEFAULT_COOLDOWN_MS;
      const last = lastFired.get(key);
      if (last !== undefined && t - last < cooldown) {
        counter(hook.id).suppressed += 1;
        continue;
      }
      lastFired.set(key, t);

      const c = counter(hook.id);
      c.fired += 1;
      c.lastAt = new Date(t).toISOString();

      const payload = buildPayload(hook, evt, t);
      const timeout = Number.isFinite(hook.timeoutMs) ? hook.timeoutMs : DEFAULT_TIMEOUT_MS;

      // Deliberately not awaited: the serial reader must not stall on a
      // laptop that stopped answering.
      Promise.resolve()
        .then(() =>
          doFetch(hook.url, {
            method: hook.method || "POST",
            headers: { "content-type": "application/json", ...(hook.headers || {}) },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeout),
          }),
        )
        .then((res) => {
          if (!res || res.ok) return;
          c.failed += 1;
          c.lastError = `HTTP ${res.status}`;
        })
        .catch((e) => {
          c.failed += 1;
          c.lastError = e?.name === "TimeoutError" ? `timeout after ${timeout}ms` : String(e?.message || e);
        });

      recent.push({ at: payload.at, hook: hook.id, url: hook.url, device: evt.device ?? null });
      while (recent.length > MAX_RECENT) recent.shift();
      fired.push(hook.id);
    }

    return fired;
  }

  function stats() {
    return {
      hooks: readHooks().map((h) => ({
        id: h.id,
        enabled: h.enabled !== false,
        on: h.on || "*",
        url: h.url,
        ...counter(h.id),
      })),
      recent: [...recent],
    };
  }

  function reset() {
    lastFired.clear();
    counters.clear();
    recent.length = 0;
  }

  return { dispatch, stats, reset };
}

module.exports = { createWebhooks, matches, render };
