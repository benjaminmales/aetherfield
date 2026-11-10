import { estimateZoneUniqueVisitors } from "./simAudienceMetrics";

/** @typedef {{ arrivals: number; dwellMs: number }} NodeAgg */

/**
 * One row per experience node (inactive filtered client-side elsewhere).
 * Rows with zero sample traffic still listed so spreadsheets match the venue plan node list.
 *
 * @param {{ id: string; name?: string }[]} activePois
 * @param {Record<string, NodeAgg>} nodeAudience
 * @param {number} expectedFootfall
 * @param {(poiId: string) => string} poiNameFn
 */
export function buildFullNodeAudienceReport(activePois, nodeAudience, expectedFootfall, poiNameFn) {
  /** @type {Record<string, NodeAgg>} */
  const merged = {};
  for (const p of activePois) {
    const raw = nodeAudience[p.id];
    merged[p.id] = {
      arrivals: raw?.arrivals || 0,
      dwellMs: raw?.dwellMs || 0,
    };
  }

  const totalArr = Object.values(merged).reduce((a, z) => a + z.arrivals, 0);

  const rows = activePois.map((p) => {
    const arrivals = merged[p.id].arrivals;
    const dwellMs = merged[p.id].dwellMs;
    const share = totalArr > 0 ? arrivals / totalArr : 0;
    const uniqueEstimated =
      arrivals <= 0 ? 0 : estimateZoneUniqueVisitors(arrivals, share, expectedFootfall);
    const returnVisitsEst = Math.max(0, arrivals - uniqueEstimated);
    const dwellMinutes = dwellMs / 60000;
    const avgDwellMinPerPresenceTouch = arrivals > 0 ? dwellMinutes / arrivals : 0;
    const avgSimDwellMinPerUniqueEst = uniqueEstimated > 0 ? dwellMinutes / uniqueEstimated : 0;

    return {
      poiId: p.id,
      name: poiNameFn(p.id),
      arrivals,
      dwellMinutes,
      avgDwellMinPerPresenceTouch,
      avgSimDwellMinPerUniqueEst,
      uniqueEstimated,
      returnVisitsEst,
      shareOfSampleTraffic: share,
    };
  });

  const sumUniqueAcrossNodes = rows.reduce((a, r) => a + r.uniqueEstimated, 0);
  const sumReturnAcrossNodes = rows.reduce((a, r) => a + r.returnVisitsEst, 0);
  const totalDwellMinutes = rows.reduce((a, r) => a + r.dwellMinutes, 0);

  return {
    rows,
    totals: {
      totalPresenceTouchesNodes: totalArr,
      totalDwellSimMinutesNodes: totalDwellMinutes,
      /** Sum across nodes ignores visitor overlap · compare nodes relative to each other. */
      sumUniqueEstimatedAcrossNodes: sumUniqueAcrossNodes,
      sumReturnVisitsEstimatedAcrossNodes: sumReturnAcrossNodes,
    },
  };
}
