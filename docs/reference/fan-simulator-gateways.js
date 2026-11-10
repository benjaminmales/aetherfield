/**
 * Gateway and wristband report simulation.
 * Gateways have positions in the venue; wristbands report to their best gateway (by RSSI).
 * RSSI is derived from distance (log-distance path loss). Wristbands prefer nearer gateways.
 */

// RSSI in dBm: -35 (very close) to -95 (out of range). dist in same units as fan x,y,z.
function distanceToRssi(dist) {
  const d = Math.max(dist, 0.0005);
  // Log-distance: ~-35 at 0.001, ~-55 at 0.01, ~-75 at 0.1
  return Math.round(-35 - 20 * Math.log10(d * 1000));
}

function euclidean(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Build gateway positions from fan positions (bounding box + grid overlay).
 * @param {Array<{x,y,z}>} positions - fan/wristband positions
 * @param {number} count - number of gateways
 * @returns {Array<{id, x, y, z}>}
 */
export function initGateways(positions, count = 24) {
  if (!positions.length) {
    const side = Math.ceil(Math.sqrt(count));
    const out = [];
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / side), col = i % side;
      out.push({ id: `GW-${i + 1}`, x: (col / side - 0.5) * 0.2, y: 0.05, z: (row / side - 0.5) * 0.2 });
    }
    return out;
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of positions) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  // Slight padding; gateways slightly above (ceiling) and spread in x,z
  const pad = 0.005;
  const spanX = maxX - minX + pad * 2, spanZ = maxZ - minZ + pad * 2;
  const cols = Math.ceil(Math.sqrt(count * (spanX / spanZ || 1)));
  const rows = Math.ceil(count / cols);
  const gateways = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols), col = i % cols;
    const x = minX - pad + (spanX * (col + 0.5)) / cols;
    const z = minZ - pad + (spanZ * (row + 0.5)) / rows;
    const y = maxY + 0.01; // above seats
    gateways.push({ id: `GW-${i + 1}`, x, y, z });
  }
  return gateways;
}

/**
 * For each fan, compute best gateway (max RSSI) and that RSSI.
 * @param {Array<{x,y,z}>} fans
 * @param {Array<{id,x,y,z}>} gateways
 * @returns {Map<number, { gatewayId, rssi }>} fan index -> best gateway info
 */
export function assignFansToGateways(fans, gateways) {
  const map = new Map();
  for (let i = 0; i < fans.length; i++) {
    const fan = fans[i];
    let bestRssi = -999, bestId = gateways[0]?.id ?? "GW-1";
    for (const gw of gateways) {
      const dist = euclidean(fan, gw);
      const rssi = distanceToRssi(dist);
      if (rssi > bestRssi) {
        bestRssi = rssi;
        bestId = gw.id;
      }
    }
    map.set(i, { gatewayId: bestId, rssi: bestRssi });
  }
  return map;
}

/**
 * Generate wristband reports: subset of fans report each tick (UUID, gesture, RSSI, gateway).
 * Report rate per fan per tick (e.g. 0.01 = 1% of fans report each tick → ~800/tick at 80k).
 * @param {Array<{device_id, gesture}>} fans
 * @param {Map<number, { gatewayId, rssi }>} fanToGateway
 * @param {number} tick
 * @param {number} showTime
 * @param {number} reportRate - probability each fan reports this tick (0–1)
 * @returns {Array<{ uuid, gesture, rssi, gateway_id, timestamp, tick }>}
 */
export function generateReports(fans, fanToGateway, tick, showTime, reportRate = 0.012) {
  const reports = [];
  for (let i = 0; i < fans.length; i++) {
    if (Math.random() >= reportRate) continue;
    const fan = fans[i];
    const gw = fanToGateway.get(i);
    if (!gw) continue;
    reports.push({
      uuid: fan.device_id,
      gesture: fan.gesture ?? "idle",
      rssi: gw.rssi,
      gateway_id: gw.gatewayId,
      timestamp: Math.round(showTime * 1000),
      tick,
    });
  }
  return reports;
}

export { distanceToRssi, euclidean };
