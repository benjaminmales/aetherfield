import { distanceMeters } from "./geo";

/** Default physical gateway RF / site coverage (m). See ruleEval for why 60. */
export const GATEWAY_COVERAGE_RADIUS_M = 60;

/**
 * Compute which nodes are covered by at least one active gateway.
 *
 * A node is covered when its position is within {@link GATEWAY_COVERAGE_RADIUS_M} m of a gateway centre.
 * Inactive gateways or nodes are excluded from the calculation.
 *
 * @param {object[]} pois
 * @param {object[]} gateways
 * @param {number} metersPerSvgUserUnit
 * @returns {{
 *   coveredPoiIds: Set<string>,
 *   uncoveredPoiIds: Set<string>,
 *   activeGatewayCount: number,
 *   activePoiCount: number,
 * }}
 */
export function computeGatewayCoverage(pois, gateways, metersPerSvgUserUnit) {
  const activeGateways = (gateways || []).filter(
    (g) => g && g.active !== false && Array.isArray(g.position)
  );
  const activePois = (pois || []).filter(
    (p) => p && p.active !== false && Array.isArray(p.position)
  );
  const covered = new Set();
  const uncovered = new Set();
  for (const poi of activePois) {
    const [px, py] = poi.position;
    const radiusSumById = activeGateways.some((gw) => {
      const [gx, gy] = gw.position;
      const d = distanceMeters(px, py, gx, gy, metersPerSvgUserUnit);
      return d <= GATEWAY_COVERAGE_RADIUS_M;
    });
    if (radiusSumById) covered.add(poi.id);
    else uncovered.add(poi.id);
  }
  return {
    coveredPoiIds: covered,
    uncoveredPoiIds: uncovered,
    activeGatewayCount: activeGateways.length,
    activePoiCount: activePois.length,
  };
}
