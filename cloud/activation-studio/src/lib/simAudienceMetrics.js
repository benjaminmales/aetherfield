/**
 * Client-shaped audience metrics derived from aggregated simulation arrivals.
 * Estimates saturate so large raw sample counts collapse toward expected audience scale.
 */

/**
 * @param {number} totalArrivals
 * @param {number} expectedFootfall  — scenario headcount assumption
 */
export function estimateVenueWideUniqueVisitors(totalArrivals, expectedFootfall) {
  const cap = Math.max(Math.min(expectedFootfall, 1e6), 1);
  if (totalArrivals <= 0) return 0;
  const est = Math.round(cap * (1 - Math.exp(-totalArrivals / Math.max(cap * 1.25, 1))));
  return Math.min(totalArrivals, est);
}

/**
 * @param {number} zoneArrivals
 * @param {number} shareOfVenueTraffic  — zoneArrivals / totalArrivals
 * @param {number} expectedFootfall
 */
export function estimateZoneUniqueVisitors(zoneArrivals, shareOfVenueTraffic, expectedFootfall) {
  if (zoneArrivals <= 0) return 0;
  const cap = Math.max(
    1,
    Math.min(
      zoneArrivals,
      Math.round(expectedFootfall * Math.max(0.08, Math.min(1, shareOfVenueTraffic * 3.5)))
    )
  );
  return Math.min(
    zoneArrivals,
    Math.round(cap * (1 - Math.exp(-zoneArrivals / Math.max(cap * 1.8, 1))))
  );
}

/** @typedef {{ arrivals: number; dwellMs: number }} ZoneAgg */

/**
 * @param {Record<string, ZoneAgg>} zoneAudience
 * @param {number} expectedFootfall
 * @param {(layerId: string) => string} layerNameFn
 */
export function buildAudienceAreaRows(zoneAudience, expectedFootfall, layerNameFn) {
  const totalArr = Object.values(zoneAudience || {}).reduce((a, z) => a + (z?.arrivals || 0), 0);

  const rows = Object.entries(zoneAudience || {})
    .map(([layerId, z]) => {
      const arrivals = z?.arrivals || 0;
      const dwellMs = z?.dwellMs || 0;
      const share = totalArr > 0 ? arrivals / totalArr : 0;
      const uniq = estimateZoneUniqueVisitors(arrivals, share, expectedFootfall);
      const repeatTouches = Math.max(0, arrivals - uniq);
      const dwellMinutes = dwellMs / 60000;
      const avgDwellMin = uniq > 0 ? dwellMinutes / uniq : 0;

      return {
        layerId,
        name: layerNameFn(layerId),
        arrivals,
        dwellMinutes,
        uniqueEstimated: uniq,
        repeatTouches,
        avgDwellMin,
        shareOfTraffic: share,
      };
    })
    .filter((r) => r.arrivals > 0)
    .sort((a, b) => b.arrivals - a.arrivals);

  const uniqVenue = estimateVenueWideUniqueVisitors(totalArr, expectedFootfall);
  const repeatVenueTouches = Math.max(0, totalArr - uniqVenue);
  const totalDwellMinutes = Object.values(zoneAudience || {}).reduce((a, z) => a + ((z?.dwellMs || 0) / 60000), 0);

  let peakBand = "";
  let peakBandDetail = "";
  if (rows.length > 0) {
    const top = rows[0];
    peakBand = top.name || top.layerId;
    peakBandDetail = `${Math.round(top.shareOfTraffic * 100)}% of simulated presence touches`;
  }

  return {
    rows,
    totals: {
      totalPresenceEvents: totalArr,
      totalDwellSimMinutes: totalDwellMinutes,
      estimatedUniqueVenueWide: uniqVenue,
      estimatedRepeatTouchesVenueWide: repeatVenueTouches,
      peakAttentionZoneLabel: peakBand,
      peakAttentionZoneDetail: peakBandDetail,
    },
  };
}

/** Narrative arc from virtual event clock (minutes from midnight). */
export function peakPressureLabel(simMinutesOfDay) {
  const m = simMinutesOfDay ?? 600;
  /* Virtual day stretched 10:00 → 23:00 in simulateRules */
  if (m < 12 * 60) return "Build / opening intensity";
  if (m < 17 * 60) return "Daytime peak flow";
  if (m < 20 * 60) return "Peak evening";
  return "Late / wind-down";
}
