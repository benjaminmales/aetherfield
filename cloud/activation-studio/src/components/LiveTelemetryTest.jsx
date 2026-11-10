/**
 * LiveTelemetryTest.jsx
 * Minimal "is data reaching the cloud?" readout. Reads gateway_telemetry for the
 * selected project (initial fetch + realtime, with a polling fallback in case the
 * realtime publication isn't enabled on the live DB). Shows ID + RSSI only.
 *
 * Intentionally bypasses the registration gate — this is a pipeline test view.
 */
import { useEffect, useRef, useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabaseClient";
import "./LiveTelemetryTest.css";

const WINDOW = 40;

export default function LiveTelemetryTest({ projectId }) {
  const [rows, setRows] = useState([]);
  const [lastAt, setLastAt] = useState(null);
  const [error, setError] = useState("");
  const [, force] = useState(0); // tick to refresh "x s ago"
  const seen = useRef(new Set());

  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) { setError("Supabase not configured."); return undefined; }
    if (!projectId) { setRows([]); setError("Select a project first."); return undefined; }

    setError("");
    seen.current = new Set();
    let active = true;

    const ingest = (list) => {
      if (!active || !list?.length) return;
      let newest = null;
      const fresh = [];
      for (const r of list) {
        if (seen.current.has(r.id)) continue;
        seen.current.add(r.id);
        fresh.push(r);
        if (!newest || r.received_at > newest) newest = r.received_at;
      }
      if (fresh.length) {
        setRows((prev) => [...fresh, ...prev].slice(0, WINDOW));
        setLastAt((prev) => (!prev || (newest && newest > prev) ? newest : prev));
      }
    };

    const fetchLatest = async () => {
      const { data, error: e } = await supabase
        .from("gateway_telemetry")
        .select("id,node_uuid,node_id,rssi,gesture,received_at")
        .eq("project_id", projectId)
        .order("received_at", { ascending: false })
        .limit(WINDOW);
      if (!active) return;
      if (e) { setError(e.message); return; }
      ingest(data || []);
    };

    fetchLatest();

    // Realtime (works only if gateway_telemetry is in the supabase_realtime publication)
    const channel = supabase
      .channel(`telemetry_test:${projectId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "gateway_telemetry", filter: `project_id=eq.${projectId}` },
        (payload) => ingest([payload.new])
      )
      .subscribe();

    // Polling fallback so this works regardless of realtime config.
    const poll = setInterval(fetchLatest, 3000);

    return () => {
      active = false;
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const secsAgo = lastAt ? Math.max(0, Math.round((Date.now() - new Date(lastAt).getTime()) / 1000)) : null;
  const live = secsAgo != null && secsAgo <= 10;

  return (
    <div className="ltt">
      <div className="ltt-head">
        <h2>Live data (test)</h2>
        <span className={`ltt-dot ${live ? "ltt-dot--live" : ""}`} />
      </div>
      <p className="ltt-hint">
        Reads <code>gateway_telemetry</code> from the cloud for this project — confirms the
        band → gateway → bridge → cloud → app path. No pairing/registration required to view.
      </p>

      <div className="ltt-status">
        {error ? (
          <span className="ltt-err">{error}</span>
        ) : secsAgo == null ? (
          <span>Waiting for first telemetry row…</span>
        ) : live ? (
          <span className="ltt-ok">● Receiving — last row {secsAgo}s ago · {rows.length} in view</span>
        ) : (
          <span>Last row {secsAgo}s ago · {rows.length} in view</span>
        )}
      </div>

      <div className="ltt-table">
        <div className="ltt-row ltt-row--head">
          <span>Time</span><span>ID</span><span>RSSI</span><span>Gesture</span>
        </div>
        {rows.map((r) => (
          <div className="ltt-row" key={r.id}>
            <span>{new Date(r.received_at).toLocaleTimeString()}</span>
            <span className="ltt-id">{r.node_uuid || (r.node_id != null ? `#${r.node_id}` : "—")}</span>
            <span>{r.rssi != null ? `${r.rssi} dBm` : "—"}</span>
            <span>{r.gesture || "—"}</span>
          </div>
        ))}
        {rows.length === 0 && !error && (
          <div className="ltt-empty">Power a band near the gateway and rows will appear here.</div>
        )}
      </div>
    </div>
  );
}
