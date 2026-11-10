/**
 * Optional forward of batched wristband reports to a control server (Phase D).
 * Set CONTROL_SERVER_URL (e.g. http://127.0.0.1:4000) to enable. Fire-and-forget; does not block the tick.
 */

function groupReportsByGateway(reports) {
  const m = new Map();
  for (const r of reports) {
    const id = r.gateway_id;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(r);
  }
  return [...m.entries()].map(([gateway_id, reports]) => ({ gateway_id, reports }));
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {null | ((tick: number, reports: Array<unknown>) => void)}
 */
export function createReportForwarder(env = process.env) {
  const base = (env.CONTROL_SERVER_URL || "").trim().replace(/\/$/, "");
  if (!base) return null;
  const path = env.CONTROL_SERVER_REPORTS_PATH || "/api/wristband-reports/batch";
  const url = base.includes("://") ? new URL(path, base + "/") : new URL(`http://${base}${path.startsWith("/") ? "" : "/"}${path}`);

  return function forwardReports(tick, reports) {
    if (!reports?.length) return;
    const batches = groupReportsByGateway(reports);
    const body = JSON.stringify({ tick, batches, source: "fan-simulator" });
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch((err) => console.warn("[fan-simulator] control forward:", err.message));
  };
}

export { groupReportsByGateway };
