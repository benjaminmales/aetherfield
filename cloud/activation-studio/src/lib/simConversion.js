/** Simulated clock: arrivals at conversion-goal POIs shortly after a trigger count toward attribution. */
export const CONVERSION_ATTRIBUTION_WINDOW_SIM_MS = 45 * 60 * 1000;

/**
 * @typedef {{ t: number; visitorId: string }} RuleFireEvt
 */

/**
 * Drop very old timestamps to keep fire history bounded (keeps overlap with attribution window).
 * @param {Record<string, Array<RuleFireEvt | number>>} map
 * @param {number} elapsedSimMs
 * @param {number} windowMs
 */
export function pruneRuleFireHistory(map, elapsedSimMs, windowMs) {
  const cutoff = elapsedSimMs - windowMs * 2;
  for (const k of Object.keys(map)) {
    map[k] = (map[k] || []).filter((e) => {
      const t = typeof e === "number" ? e : e.t;
      return t >= cutoff && t <= elapsedSimMs;
    });
  }
}

/** @param {Array<RuleFireEvt | number>} entries */
export function ruleFireEvtTime(evt) {
  return typeof evt === "number" ? evt : evt.t;
}
