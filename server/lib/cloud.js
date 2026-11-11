/**
 * cloud.js — the identity tier.
 *
 * The local server deliberately knows nothing about people. It has addresses:
 * 0x4C51 beaconed, 0x4C51 is at -54 dBm, 0x4C51 raised a hand. Turning that
 * into "text Alex on +44..." needs a name and a phone number, and those live
 * in the aura-registration app (Next.js on Vercel, Postgres behind it) and
 * nowhere else. See webhooks.js — same boundary, same reason: PII never
 * reaches this box, its logs, or its disk.
 *
 * This module is the ONLY place the local server talks to that app. Two calls:
 *
 *   GET  /api/registrations          -> who is registered (cached)
 *   POST /api/action                 -> send one of them an SMS via Twilio
 *
 * Three rules, all of which exist because this runs at a live event:
 *
 *   1. THE CLOUD IS NEVER IN THE PATH. Every function here fails soft. If
 *      Vercel is down, or the venue's uplink is, the console still shows the
 *      fleet and the lights still take commands. The only thing that stops
 *      working is messaging, which is the one thing that genuinely cannot work
 *      without the internet.
 *   2. REGISTRATIONS ARE CACHED AND SERVED STALE. A dashboard polling at 1 Hz
 *      must not put 1 req/s on Vercel for a list that changes when somebody
 *      fills in a form. On a fetch failure the last good list is kept and
 *      returned, so a brief blip does not blank every name on screen mid-demo.
 *   3. IDENTITY IS THE RADIO ADDRESS. The roster says "0x4C51"; the cloud app
 *      keys on "4C51". deviceId() is the single place that conversion happens,
 *      so the two tiers cannot drift into disagreeing about who a device is.
 *
 * Injectable fetch and clock: the tests never touch the network.
 */

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_CACHE_MS = 5000;

/**
 * Roster address -> cloud device_id.
 *
 * `0x4C51` | `4c51` | `4C51` -> `4C51`. Null for anything unusable, so a
 * caller can tell "no id" from "id that happens to be falsy".
 */
function deviceId(uuid) {
  if (uuid === null || uuid === undefined) return null;
  const s = String(uuid).trim();
  if (!s) return null;
  const bare = /^0x/i.test(s) ? s.slice(2) : s;
  if (!bare) return null;
  return bare.toUpperCase();
}

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  root of the aura-registration deployment
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @param {number} [opts.cacheMs]
 * @param {number} [opts.timeoutMs]
 */
function createCloud(opts = {}) {
  const baseUrl = (opts.baseUrl || "").trim().replace(/\/+$/, "");
  // Shared secret; the app's machine endpoints are fail-closed without it.
  const apiToken = (opts.apiToken || "").trim();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const cacheMs = Number.isFinite(opts.cacheMs) ? opts.cacheMs : DEFAULT_CACHE_MS;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  /** device_id -> {name, cell}. Last known good; survives a failed refresh. */
  let cache = new Map();
  let fetchedAt = 0;
  let inFlight = null;

  const state = {
    lastError: null,
    lastOkAt: null,
    refreshes: 0,
    failures: 0,
    sent: 0,
    sendFailures: 0,
  };

  const configured = () => Boolean(baseUrl);

  function url(p) {
    return `${baseUrl}${p}`;
  }

  async function json(path, init) {
    const headers = {
      ...(init && init.headers),
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
    };
    const res = await doFetch(url(path), {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Carry the app's own status up. A 404 "no registration for this
      // device" is the operator's problem to fix (get them to scan the QR);
      // a 500 is ours. Flattening both to one code loses that.
      const err = new Error(body.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /**
   * Refresh the registration cache if it is older than cacheMs.
   *
   * Concurrent callers share one request — the dashboard polls every second
   * and several widgets want the same list, and three in-flight requests for
   * one answer is how you get rate-limited by your own console.
   */
  async function refresh(force = false) {
    if (!configured()) return cache;
    if (!force && now() - fetchedAt < cacheMs) return cache;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const body = await json("/api/registrations");
        const rows = Array.isArray(body) ? body : body.registrations || [];
        const next = new Map();
        for (const r of rows) {
          const id = deviceId(r.device_id ?? r.deviceId);
          if (!id) continue;
          next.set(id, {
            deviceId: id,
            name: r.name ?? null,
            cell: r.cell ?? null,
            updatedAt: r.updated_at ?? r.updatedAt ?? null,
          });
        }
        cache = next;
        fetchedAt = now();
        state.lastOkAt = new Date(fetchedAt).toISOString();
        state.lastError = null;
        state.refreshes += 1;
      } catch (e) {
        // Deliberately keep the old cache. A 4-second blip should not blank
        // every name on the operator's screen.
        state.failures += 1;
        state.lastError = e?.name === "TimeoutError"
          ? `timeout after ${timeoutMs}ms`
          : String(e?.message || e);
      } finally {
        inFlight = null;
      }
      return cache;
    })();

    return inFlight;
  }

  /** Cached view. Never throws, never blocks on the network. */
  function registrations() {
    return [...cache.values()];
  }

  /** One device's registration, or null. Cache only — callers poll refresh(). */
  function lookup(uuid) {
    const id = deviceId(uuid);
    return id ? cache.get(id) || null : null;
  }

  /**
   * Send an SMS to whoever registered this device.
   *
   * Shape is aura-registration's POST /api/action: it resolves device_id ->
   * registration -> cell itself and calls Twilio. When that app has no Twilio
   * env set it answers {dryRun:true, preview} instead of sending, which is
   * exactly what you want when rehearsing.
   */
  async function send(uuid, message) {
    const id = deviceId(uuid);
    // Local validation first, and marked as the caller's fault: none of these
    // should spend a request, and none of them is the cloud being down.
    if (!configured()) throw Object.assign(new Error("CLOUD_URL is not set"), { status: 503 });
    if (!id) throw Object.assign(new Error("No device address"), { status: 400 });
    const text = String(message ?? "").trim();
    if (!text) throw Object.assign(new Error("Message is empty"), { status: 400 });

    try {
      const body = await json("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "audience_sample",
          device_id: id,
          message: text,
        }),
      });
      state.sent += 1;
      return { ...body, deviceId: id };
    } catch (e) {
      state.sendFailures += 1;
      throw e;
    }
  }

  function stats() {
    return {
      configured: configured(),
      baseUrl: baseUrl || null,
      token: Boolean(apiToken),
      cached: cache.size,
      ageMs: fetchedAt ? now() - fetchedAt : null,
      ...state,
    };
  }

  return { configured, refresh, registrations, lookup, send, stats, deviceId };
}

module.exports = { createCloud, deviceId };
