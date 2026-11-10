import { distanceMeters } from "./geo";

function parseTimeToMin(str) {
  if (!str) return 0;
  const parts = String(str).split(":");
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  return parseInt(str, 10) || 0;
}

function nowMinutesOfDay() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function timeConditionMet(cond, minutesOfDay) {
  if (!cond || cond.type !== "time_window") return true;
  if (!String(cond.from || "").trim() && !String(cond.to || "").trim()) return true;
  const from = parseTimeToMin(cond.from || "0:00");
  const to = parseTimeToMin(cond.to || "23:59");
  if (from <= to) return minutesOfDay >= from && minutesOfDay <= to;
  return minutesOfDay >= from || minutesOfDay <= to;
}

/**
 * Detection radius when a target does not set one (m).
 *
 * 60 m, not the 30 m this started at. 30 was an indoor-venue assumption; on an
 * outdoor site it is far too small to place anything against — on the Las Vegas
 * Strip plan (~1.9 m per SVG unit) a 30 m ring is 16 units across, a dot.
 *
 * 60 m is deliberately conservative for a real crowd rather than a datasheet
 * figure: 2.4 GHz is absorbed by people, so clear-line-of-sight numbers in the
 * hundreds of metres do not survive a packed venue.
 */
export const DEFAULT_DETECTION_RADIUS_M = 60;
export const MAX_DETECTION_RADIUS_M = 60;

/** Radius a target detects within: gateways use detectionRadiusM. */
export function targetRadiusM(t) {
  const raw = Number(t?.detectionRadiusM ?? t?.coverageRadiusM ?? t?.activationRadiusM);
  return Math.min(
    MAX_DETECTION_RADIUS_M,
    Math.max(1, Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DETECTION_RADIUS_M),
  );
}

/**
 * Nearest detecting target the avatar is inside the radius of.
 *
 * Targets are GATEWAYS. The separate "activation node" was removed once the
 * gateway became the listener — a gateway already measures RSSI on every
 * packet, so the thing that senses and the thing on the map are one object.
 * See WHITEPAPER 3.2.
 *
 * `poiId` is kept as the result key so the sim, dashboards and export keep
 * working unchanged; it now holds a gateway id.
 *
 * @param {{x:number,y:number}} avatarContent
 * @param {object[]} targets gateways with position [x,y] and detectionRadiusM
 * @returns {{ poiId: string, distanceM: number } | null}
 */
export function nearestPoiInsideRadius(avatarContent, targets, metersPerSvgUserUnit) {
  const { x: ax, y: ay } = avatarContent;
  let best = null;
  let bestD = Infinity;
  for (const p of targets || []) {
    if (!p || p.active === false) continue;
    const pos = p.position;
    if (!pos || pos.length < 2) continue;
    const d = distanceMeters(ax, ay, pos[0], pos[1], metersPerSvgUserUnit);
    if (d <= targetRadiusM(p) && d < bestD) {
      bestD = d;
      best = { poiId: p.id, distanceM: d };
    }
  }
  return best;
}

/**
 * @param {object} opts
 * @param {{ x: number, y: number }} opts.avatarContent
 * @param {string|null} opts.currentLayerId
 * @param {object[]} [opts.gateways] detection targets (legacy alias: opts.pois)
 * @param {object[]} opts.rules
 * @param {number} opts.metersPerSvgUserUnit
 * @param {Record<string, number>} opts.lastFiredAt - ruleId -> timestamp ms
 * @param {number} opts.nowMs
 * @param {Record<string, number>} [opts.clusterOccupancy] - layerId -> detected user count (avatar already included by caller)
 * @param {number | null | undefined} [opts.simMinutesOfDay] - if set, use instead of real clock for time_window rules (simulation)
 * @param {boolean | undefined} [opts.messageEligible] - registered / opted-in wristband · messages & programmed rules skip when false (rehearsal + live planner). Omit for legacy “always eligible”.
 */
export function evaluateRules({
  avatarContent,
  currentLayerId,
  gateways,
  pois,
  rules,
  metersPerSvgUserUnit,
  lastFiredAt,
  nowMs,
  clusterOccupancy,
  simMinutesOfDay,
  messageEligible,
}) {
  // `pois` is the legacy argument name; callers now pass gateways.
  const targets = gateways ?? pois ?? [];
  const inside = nearestPoiInsideRadius(avatarContent, targets, metersPerSvgUserUnit);

  /** Programmable rules (messages / LED hooks) fire only when the device may receive messages. */
  if (messageEligible === false) {
    return { hits: [], inside };
  }

  const minutesOfDay =
    simMinutesOfDay != null && Number.isFinite(simMinutesOfDay)
      ? Math.max(0, Math.min(24 * 60 - 1, Math.floor(simMinutesOfDay)))
      : nowMinutesOfDay();
  const active = (rules || []).filter((r) => r && r.active !== false);
  const hits = [];

  for (const rule of active) {
    const targeting = rule.targeting || {};
    // "node" is the legacy value for what is now a gateway trigger. Rules
    // already saved in localStorage still carry it, so both are accepted.
    const rawType = targeting.interactionType || "gateway";
    const interactionType = rawType === "node" ? "gateway" : rawType;

    /** Inbound webhooks / external platforms — not evaluated from avatar or sim samples yet. */
    if (interactionType === "external_signal") continue;

    if (interactionType === "gateway") {
      if (!inside) continue;
      const ids = Array.isArray(targeting.gatewayIds)
        ? targeting.gatewayIds
        : Array.isArray(targeting.poiIds)
          ? targeting.poiIds
          : [];
      if (ids.length > 0 && !ids.includes(inside.poiId)) continue;
    }

    const accessLayers = targeting.accessLayers;
    if (interactionType === "cluster") {
      if (!currentLayerId) continue;
      if (Array.isArray(accessLayers) && accessLayers.length > 0 && !accessLayers.includes(currentLayerId)) {
        continue;
      }
      const minUsers = Math.max(1, Number(targeting.minUsers) || 1);
      const occupancy = Math.max(0, Number(clusterOccupancy?.[currentLayerId]) || 0);
      if (occupancy < minUsers) continue;
    } else if (Array.isArray(accessLayers) && accessLayers.length > 0 && currentLayerId) {
      if (!accessLayers.includes(currentLayerId)) continue;
    }

    const conditions = rule.conditions || [];
    const ok =
      conditions.length === 0 ||
      conditions.every((c) => {
        if (c.type === "time_window") return timeConditionMet(c, minutesOfDay);
        return true;
      });
    if (!ok) continue;

    const cooldownMin = Math.max(0, Number(targeting.cooldown ?? 0));
    const last = lastFiredAt[rule.id] || 0;
    if (cooldownMin > 0 && nowMs - last < cooldownMin * 60 * 1000) continue;

    if (interactionType === "gateway") {
      hits.push({
        rule,
        poiId: inside?.poiId || null,
        gatewayId: inside?.poiId || null,
        distanceM: inside?.distanceM ?? null,
        triggerType: "gateway",
      });
    } else if (interactionType === "cluster") {
      const occupancy = Math.max(0, Number(clusterOccupancy?.[currentLayerId]) || 0);
      hits.push({
        rule,
        poiId: null,
        distanceM: null,
        triggerType: "cluster",
        clusterId: currentLayerId,
        clusterCount: occupancy,
      });
    } else {
      hits.push({ rule, poiId: null, distanceM: null, triggerType: "time" });
    }
  }

  hits.sort((a, b) => (Number(b.rule.priority) || 0) - (Number(a.rule.priority) || 0));
  return { hits, inside };
}

/**
 * Who a downlink is addressed to.
 *
 * The protocol carries a unicast destination in the CMD frame (`dst`), so a
 * rule can light ONE band rather than the room. A proximity rule usually wants
 * `band` — the guest who just walked past — which needs no picker, because the
 * detection already carries the address that triggered it. `all` is the
 * broadcast every band acts on; `group` uses the band's group mask.
 */
export const LED_SCOPES = [
  { value: "band", label: "The band that triggered it" },
  { value: "group", label: "Its group" },
  { value: "all", label: "Every band" },
];

export function defaultLedPayload() {
  return { mode: 2, rate: 120, r: 255, g: 180, b: 40, durationMs: 2800, scope: "band" };
}
