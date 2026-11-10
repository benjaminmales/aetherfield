import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActivationMap from "./ActivationMap";
import useActivationSim from "../hooks/useActivationSim";
import { downloadActivationMonitorReportXlsx } from "../lib/exportActivationMonitorReportXlsx";
import { CONVERSION_ATTRIBUTION_WINDOW_SIM_MS } from "../lib/simConversion";
import { SIM_SCENARIO_POPUP_SOURCES, scenarioBroadcastChannelId } from "../lib/simScenarioBroadcast";
import "./ActivationSimDashboard.css";

const MONITOR_SPLIT_LS = "mas_monitor_split_px_v1";
const MONITOR_SPLIT_MIN_LEFT = 280;
const MONITOR_MAP_MIN_RIGHT = 220;
const MONITOR_SPLIT_RESIZER_PX = 10;

/** @returns {number | null} */
function readStoredMonitorSplitPx() {
  try {
    const raw = localStorage.getItem(MONITOR_SPLIT_LS);
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Normalize snapshot: multi-page `pages[]` or legacy flat shape. */
function getSimPages(snapshot) {
  if (Array.isArray(snapshot?.pages) && snapshot.pages.length > 0) return snapshot.pages;
  if (snapshot?.viewBox) {
    return [
      {
        id: "_legacy",
        title: snapshot.meta?.pageTitle || "Layer",
        viewBox: snapshot.viewBox,
        layers: snapshot.layers,
        defs: snapshot.defs,
        pois: snapshot.pois,
        gateways: snapshot.gateways || [],
        rules: snapshot.rules,
        metersPerSvgUserUnit: snapshot.metersPerSvgUserUnit,
        flatSamples: snapshot.flatSamples || [],
      },
    ];
  }
  return [];
}

function pageToSimSnapshot(snapshot, page) {
  return {
    viewBox: page.viewBox,
    layers: page.layers,
    defs: page.defs,
    pois: page.pois,
    gateways: page.gateways || [],
    rules: page.rules,
    metersPerSvgUserUnit: page.metersPerSvgUserUnit,
    flatSamples: page.flatSamples || [],
    meta: {
      ...(snapshot.meta || {}),
      pageTitle: page.title,
      simPageId: page.id,
    },
  };
}

function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatSimTimeMin(ms) {
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * @param {{ snapshot: object; onClose: () => void }} props
 */
export default function ActivationSimDashboard({ snapshot, onClose }) {
  const simPages = useMemo(() => getSimPages(snapshot), [snapshot]);
  const [userLayerId, setUserLayerId] = useState(null);

  const autoPageId = useMemo(() => {
    if (!simPages.length) return null;
    const initial = snapshot?.meta?.initialPageId;
    if (initial && simPages.some((p) => p.id === initial)) return initial;
    return simPages[0].id;
  }, [snapshot, simPages]);

  const simPageId =
    userLayerId && simPages.some((p) => p.id === userLayerId) ? userLayerId : autoPageId;

  const activePage = useMemo(
    () => (simPageId ? simPages.find((p) => p.id === simPageId) : null) || simPages[0] || null,
    [simPageId, simPages]
  );

  const effectiveSnapshot = useMemo(() => {
    if (!activePage || !snapshot) return snapshot;
    return pageToSimSnapshot(snapshot, activePage);
  }, [snapshot, activePage]);

  const sim = useActivationSim(effectiveSnapshot);
  const meta = effectiveSnapshot?.meta || {};
  const simRef = useRef(sim);
  simRef.current = sim;

  const [logVerbose, setLogVerbose] = useState(true);
  const [reportExporting, setReportExporting] = useState(false);
  /** @type {[number | null, React.Dispatch<React.SetStateAction<number | null>>]} */
  const [monitorSplitLeftPx, setMonitorSplitLeftPx] = useState(readStoredMonitorSplitPx);
  const monitorSplitDragging = useRef(false);
  const monitorSplitStartX = useRef(0);
  const monitorSplitStartWidth = useRef(0);
  const splitContainerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  /** Tear down pointer listeners if dashboard unmounts mid-drag */
  const monitorSplitDetachRef = useRef(() => {});

  const stopMonitorSplitDrag = useCallback(() => {
    if (!monitorSplitDragging.current) return;
    monitorSplitDragging.current = false;
    document.body.classList.remove("mas-sim-monitor-split-dragging");
  }, []);

  const onMonitorSplitPointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      const root = splitContainerRef.current;
      const leftEl = root?.querySelector(".mas-sim-monitor-left");
      const rect = leftEl instanceof HTMLElement ? leftEl.getBoundingClientRect() : null;

      monitorSplitDragging.current = true;
      monitorSplitStartX.current = e.clientX;
      monitorSplitStartWidth.current =
        monitorSplitLeftPx != null ? monitorSplitLeftPx : rect?.width ?? MONITOR_SPLIT_MIN_LEFT;
      document.body.classList.add("mas-sim-monitor-split-dragging");
      /** @type {HTMLElement} */
      (e.currentTarget).setPointerCapture(e.pointerId);

      const onMove = (/** @type {PointerEvent} */ ev) => {
        if (!monitorSplitDragging.current) return;
        const rt = splitContainerRef.current;
        if (!rt) return;
        const total = rt.getBoundingClientRect().width;
        const maxLeft = Math.max(
          MONITOR_SPLIT_MIN_LEFT,
          total - MONITOR_MAP_MIN_RIGHT - MONITOR_SPLIT_RESIZER_PX
        );
        const next = monitorSplitStartWidth.current + (ev.clientX - monitorSplitStartX.current);
        setMonitorSplitLeftPx(Math.min(maxLeft, Math.max(MONITOR_SPLIT_MIN_LEFT, next)));
      };

      const onUp = () => {
        monitorSplitDragging.current = false;
        document.body.classList.remove("mas-sim-monitor-split-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        monitorSplitDetachRef.current = () => {};
        try {
          if (splitContainerRef.current) {
            const tel = splitContainerRef.current.querySelector(".mas-sim-monitor-left");
            if (tel instanceof HTMLElement) {
              const w = Math.round(tel.getBoundingClientRect().width);
              if (w >= MONITOR_SPLIT_MIN_LEFT) localStorage.setItem(MONITOR_SPLIT_LS, String(w));
            }
          }
        } catch {
          /* ignore */
        }
      };

      monitorSplitDetachRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      e.preventDefault();
    },
    [monitorSplitLeftPx]
  );

  /** Keep stored width sane if viewport shrinks */
  useEffect(() => {
    const onResize = () => {
      setMonitorSplitLeftPx((prev) => {
        if (prev == null) return prev;
        const root = splitContainerRef.current;
        if (!root) return prev;
        const total = root.getBoundingClientRect().width;
        if (total <= 960) return prev;
        const maxLeft = Math.max(
          MONITOR_SPLIT_MIN_LEFT,
          total - MONITOR_MAP_MIN_RIGHT - MONITOR_SPLIT_RESIZER_PX
        );
        return Math.min(maxLeft, Math.max(MONITOR_SPLIT_MIN_LEFT, prev));
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Clean up stray drag styling / listeners if dashboard unmounts mid-drag */
  useEffect(() => {
    return () => {
      monitorSplitDetachRef.current();
      monitorSplitDetachRef.current = () => {};
      stopMonitorSplitDrag();
    };
  }, [stopMonitorSplitDrag]);

  const scenarioChannelToken = useMemo(
    () =>
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `sc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    []
  );

  const scenarioBcName = scenarioBroadcastChannelId(scenarioChannelToken);
  const scenarioChRef = useRef(null);

  useEffect(() => {
    if (!scenarioBcName) return undefined;
    const ch = new BroadcastChannel(scenarioBcName);
    scenarioChRef.current = ch;

    const flushScenarioState = () => {
      const s = simRef.current;
      try {
        ch.postMessage({
          source: SIM_SCENARIO_POPUP_SOURCES.parent,
          type: "scenarioState",
          state: {
            expectedFootfall: s.expectedFootfall,
            eventDurationMs: s.eventDurationMs,
            wallPlaybackMs: s.wallPlaybackMs,
            density: s.density,
            intensityScale: s.intensityScale,
            registeredAudiencePct: s.registeredAudiencePct,
            observedRegisteredAudiencePct: s.observedRegisteredAudiencePct,
            status: s.status,
            progress: s.progress,
            simElapsedMs: s.simElapsedMs,
          },
        });
      } catch {
        /* ignore */
      }
    };

    const onMsg = (e) => {
      if (e.data?.source !== SIM_SCENARIO_POPUP_SOURCES.scenario) return;
      const api = simRef.current;
      const type = e.data.type;
      const value = e.data.value;
      try {
        switch (type) {
          case "HELLO":
            break;
          case "SET_EXPECTED_FOOTFALL":
            api.setExpectedFootfall(value);
            break;
          case "SET_EVENT_DURATION_MS":
            api.setEventDurationMs(value);
            break;
          case "SET_WALL_PLAYBACK_MS":
            api.setWallPlaybackMs(value);
            break;
          case "SET_DENSITY":
            api.setDensity(value);
            break;
          case "SET_REGISTERED_AUDIENCE_PCT":
            api.setRegisteredAudiencePct(value);
            break;
          case "START":
            api.start();
            break;
          case "PAUSE":
            api.pause();
            break;
          case "RESUME":
            api.resume();
            break;
          case "RESET":
            api.reset();
            break;
          default:
            return;
        }
      } finally {
        flushScenarioState();
      }
    };

    ch.addEventListener("message", onMsg);
    flushScenarioState();

    return () => {
      ch.removeEventListener("message", onMsg);
      ch.close();
      scenarioChRef.current = null;
    };
  }, [scenarioBcName]);

  const coarseSimTick = Math.floor(sim.simElapsedMs / 200);
  useEffect(() => {
    const ch = scenarioChRef.current;
    if (!ch) return;
    const s = simRef.current;
    try {
      ch.postMessage({
        source: SIM_SCENARIO_POPUP_SOURCES.parent,
        type: "scenarioState",
        state: {
          expectedFootfall: s.expectedFootfall,
          eventDurationMs: s.eventDurationMs,
          wallPlaybackMs: s.wallPlaybackMs,
          density: s.density,
          intensityScale: s.intensityScale,
          registeredAudiencePct: s.registeredAudiencePct,
          observedRegisteredAudiencePct: s.observedRegisteredAudiencePct,
          status: s.status,
          progress: s.progress,
          simElapsedMs: s.simElapsedMs,
        },
      });
    } catch {
      /* ignore */
    }
  }, [
    scenarioBcName,
    sim.expectedFootfall,
    sim.eventDurationMs,
    sim.wallPlaybackMs,
    sim.density,
    sim.intensityScale,
    sim.registeredAudiencePct,
    sim.observedRegisteredAudiencePct,
    sim.status,
    sim.progress,
    coarseSimTick,
  ]);

  const prevSimPageRef = useRef(null);
  useEffect(() => {
    if (simPageId == null) return;
    if (prevSimPageRef.current === null) {
      prevSimPageRef.current = simPageId;
      return;
    }
    if (prevSimPageRef.current !== simPageId) {
      prevSimPageRef.current = simPageId;
      sim.reset();
    }
  }, [simPageId, sim.reset, sim]);

  const topNodesByDistinctDevices = useMemo(() => {
    const rows = sim.nodeAudienceReport?.rows ?? [];
    return [...rows]
      .filter((r) => (r.uniqueDevicesAtAnchor ?? 0) > 0)
      .sort((a, b) => (b.uniqueDevicesAtAnchor ?? 0) - (a.uniqueDevicesAtAnchor ?? 0))
      .slice(0, 5)
      .map((r) => ({ id: r.poiId, name: r.name, devices: r.uniqueDevicesAtAnchor ?? 0 }));
  }, [sim.nodeAudienceReport.rows]);

  const firesByRuleRows = useMemo(() => {
    const rules = effectiveSnapshot?.rules ?? [];
    return rules
      .filter((r) => r.active !== false && (sim.firesByRuleId?.[r.id] ?? 0) > 0)
      .map((r) => ({ id: r.id, name: r.name || r.id, count: sim.firesByRuleId[r.id] }));
  }, [effectiveSnapshot, sim.firesByRuleId]);

  const nodeExcelExportRows = useMemo(() => {
    const fires = sim.experienceFiresByPoiId || {};
    return sim.nodeAudienceReport.rows.map((r, idx) => {
      const tr = fires[r.poiId] ?? 0;
      const uni = r.uniqueDevicesAtAnchor ?? 0;
      return {
        rank: idx + 1,
        poiId: r.poiId,
        name: r.name,
        arrivals: r.arrivals,
        dwellMinutes: r.dwellMinutes,
        uniqueEstimated: r.uniqueEstimated,
        returnVisitsEst: r.returnVisitsEst,
        avgDwellMinPerPresenceTouch: r.avgDwellMinPerPresenceTouch,
        avgSimDwellMinPerUniqueEst: r.avgSimDwellMinPerUniqueEst,
        shareOfSampleTraffic: r.shareOfSampleTraffic,
        uniqueDevicesAtAnchor: uni,
        triggersAtNode: tr,
      };
    });
  }, [sim.nodeAudienceReport.rows, sim.experienceFiresByPoiId]);

  const triggerExportRows = useMemo(() => {
    return sim.rulePerformanceReport.rows.map((r) => ({
      id: r.ruleId,
      name: r.name,
      count: r.triggers,
      conversionGoals: r.conversionGoalLabel,
      attributedVisits: r.hasConversionGoal ? Math.round(r.attributedVisits) : null,
      conversionRatePct: r.conversionRatePct,
    }));
  }, [sim.rulePerformanceReport.rows]);

  const controlsLocked = sim.status === "running";
  const multiLayer = simPages.length > 1;

  const handleDownloadExcelReport = useCallback(async () => {
    setReportExporting(true);
    try {
      const venueLayerTitle = multiLayer
        ? activePage?.title || simPageId || "—"
        : meta.pageTitle || activePage?.title || "—";
      const summary = {
        "Run status": sim.status,
        "Elapsed (playback)": `${formatClock(sim.simElapsedMs)} of ${formatClock(sim.eventDurationMs)}`,
        "Virtual clock": sim.simPulseLabel,
        "Experience moments (total)": sim.experienceMomentsTotal,
        "Expected footfall (scenario)": sim.expectedFootfall,
        "Event span (compressed)": formatClock(sim.eventDurationMs),
        "Wall playback": formatClock(sim.wallPlaybackMs),
        "Crowd intensity multiplier": `${sim.density.toFixed(2)}×`,
        "Scale vs reference": `${sim.intensityScale.toFixed(2)}×`,
        "Approx visitors / sim hour": Math.round(sim.visitorsPerSimHour),
        "Approx samples / wall sec": Number(sim.approxSamplesPerWallSec.toFixed(1)),
        "Registered audience (scenario %)": sim.registeredAudiencePct,
        "Observed registered share (rehearsal %)":
          sim.observedRegisteredAudiencePct != null
            ? Number(sim.observedRegisteredAudiencePct.toFixed(1))
            : "—",
      };

      const MAX_LOG = 8000;
      const logSlice = sim.logs.slice(0, MAX_LOG);
      const logRows = logSlice.map((row) => ({
        simMinutes: row.t / 60000,
        message: row.text,
      }));

      await downloadActivationMonitorReportXlsx({
        generatedAt: new Date(),
        reportTitle: "Activation monitor report (rehearsal playback)",
        venueLayerTitle,
        projectLayersCount: meta.pagesCount ?? simPages.length,
        pushedAt: snapshot?.meta?.pushedAt ?? null,
        summary,
        areaRows: sim.audienceReport.rows,
        venueTotals: sim.audienceReport.totals,
        nodeMetaRows: nodeExcelExportRows,
        triggerRows: triggerExportRows,
        logRows,
      });
    } catch (err) {
      console.error(err);
      window.alert("Could not build the Excel file. Check the console for details.");
    } finally {
      setReportExporting(false);
    }
  }, [
    activePage?.title,
    nodeExcelExportRows,
    triggerExportRows,
    meta.pageTitle,
    meta.pagesCount,
    multiLayer,
    simPageId,
    simPages.length,
    snapshot?.meta?.pushedAt,
    sim.status,
    sim.simElapsedMs,
    sim.eventDurationMs,
    sim.simPulseLabel,
    sim.experienceMomentsTotal,
    sim.expectedFootfall,
    sim.wallPlaybackMs,
    sim.density,
    sim.intensityScale,
    sim.visitorsPerSimHour,
    sim.approxSamplesPerWallSec,
    sim.registeredAudiencePct,
    sim.observedRegisteredAudiencePct,
    sim.logs,
    sim.audienceReport,
    sim.nodeAudienceReport,
  ]);

  const openScenarioWindow = () => {
    const q = new URLSearchParams({
      insights: "sim-scenario",
      channel: scenarioChannelToken,
    });
    const url = `${window.location.origin}${window.location.pathname}?${q.toString()}`;
    window.open(url, "mas_activation_scenario", "width=460,height=780,noopener,noreferrer");
  };

  return (
    <div className="mas-sim-dash" role="dialog" aria-label="Activation monitor · rehearsal playback">
      <header className="mas-sim-dash-head mas-sim-dash-head--monitor">
        <div className="mas-sim-dash-head-text">
          <div className="mas-sim-dash-head-title-row">
            <span className="mas-sim-dash-live-pill mas-sim-dash-live-pill--rehearse">Playback</span>
            <h2>Activation monitor</h2>
          </div>
          <p className="mas-sim-dash-sub mas-sim-dash-sub--muted">
            Rehearsing your layout · open Scenario to steer crowd level, pacing, and run controls.
          </p>
        </div>
        <div className="mas-sim-dash-head-actions">
          <button
            type="button"
            className="btn mas-sim-dash-export"
            disabled={reportExporting}
            onClick={() => void handleDownloadExcelReport()}
          >
            {reportExporting ? "Preparing…" : "Download Excel report"}
          </button>
          <button type="button" className="btn mas-sim-dash-popout" onClick={openScenarioWindow}>
            Scenario · new window
          </button>
          <button type="button" className="btn mas-sim-dash-close" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      <div ref={splitContainerRef} className="mas-sim-monitor-split">
        <div
          className={`mas-sim-monitor-left${monitorSplitLeftPx != null ? " mas-sim-monitor-left--sized" : ""}`}
          style={
            monitorSplitLeftPx != null
              ? {
                  flexBasis: `${monitorSplitLeftPx}px`,
                  flexShrink: 0,
                  flexGrow: 0,
                  maxWidth: "none",
                  minWidth: 0,
                }
              : undefined
          }
        >
          <section className="mas-sim-dash-summary mas-sim-dash-summary--monitor" aria-label="Run summary">
            <div className="mas-sim-dash-summary-inner">
              <div className="mas-sim-dash-summary-item mas-sim-dash-summary-item--layer mas-sim-dash-summary-item--dark">
                <span className="mas-sim-dash-summary-k mas-sim-dash-summary-k--on-dark">Venue layer</span>
                {multiLayer ? (
                  <select
                    className="mas-sim-dash-layer-select mas-sim-dash-layer-select--dark"
                    aria-label="Venue layer"
                    value={simPageId || ""}
                    disabled={controlsLocked}
                    onChange={(e) => setUserLayerId(e.target.value)}
                  >
                    {simPages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title || p.id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="mas-sim-dash-summary-v mas-sim-dash-summary-v--on-dark">
                    {meta.pageTitle || activePage?.title || "—"}
                  </span>
                )}
              </div>
              <div className="mas-sim-dash-summary-item mas-sim-dash-summary-item--dark">
                <span className="mas-sim-dash-summary-k mas-sim-dash-summary-k--on-dark">Run status</span>
                <span className="mas-sim-dash-summary-v mas-sim-dash-summary-v--on-dark">
                  <span className={`mas-sim-dash-pill mas-sim-dash-pill--${sim.status}`}>{sim.status}</span>
                  <span className="mas-sim-dash-summary-time mas-sim-dash-summary-time--on-dark">
                    {formatClock(sim.simElapsedMs)} / {formatClock(sim.eventDurationMs)}
                  </span>
                </span>
              </div>
              <div className="mas-sim-dash-summary-item mas-sim-dash-summary-item--dark">
                <span className="mas-sim-dash-summary-k mas-sim-dash-summary-k--on-dark">Clock</span>
                <span className="mas-sim-dash-summary-v mas-sim-dash-summary-v--on-dark mas-sim-dash-summary-v--emph">
                  {sim.simPulseLabel}
                </span>
              </div>
              <div className="mas-sim-dash-summary-item mas-sim-dash-summary-item--dark">
                <span className="mas-sim-dash-summary-k mas-sim-dash-summary-k--on-dark">Experience moments</span>
                <span className="mas-sim-dash-summary-v mas-sim-dash-summary-v--on-dark mas-sim-dash-summary-v--num-dark">
                  {sim.experienceMomentsTotal.toLocaleString()}
                </span>
              </div>
              <div className="mas-sim-dash-summary-item mas-sim-dash-summary-item--dark">
                <span className="mas-sim-dash-summary-k mas-sim-dash-summary-k--on-dark">Registered share</span>
                <span className="mas-sim-dash-summary-v mas-sim-dash-summary-v--on-dark mas-sim-dash-summary-v--num-dark">
                  {sim.observedRegisteredAudiencePct != null
                    ? `${sim.observedRegisteredAudiencePct.toFixed(1)}% observed`
                    : "—"}
                  <span className="mas-sim-dash-summary-time mas-sim-dash-summary-time--on-dark">
                    {" "}
                    · {sim.registeredAudiencePct}% scenario
                  </span>
                </span>
              </div>
            </div>
          </section>

          <div className="mas-sim-monitor-stack">
            <section className="mas-sim-dash-card mas-sim-dash-card--monitor mas-sim-dash-card--node-meta">
              <h3>Experience nodes · meta</h3>
              <p className="mas-sim-dash-hint">
                Rehearsal dwell = simulated proximity minutes (time-in-view proxy); live product will treat each visit
                as a discrete dwell session (enter → complete when the backend closes the session; a return visit is a new
                dwell—completion rules validated in the field). Triggers = programmable rule hits at the node
                (registered-eligible rehearsal); cooldowns and programme rules cap how often these fire. Unique / returns:
                saturation estimates · not field counts.
              </p>
              <div className="mas-node-meta-wrap">
                <table className="mas-node-meta-table">
                  <thead>
                    <tr>
                      <th scope="col">Node</th>
                      <th scope="col">Dwell (sim min)</th>
                      <th scope="col">Unique (est.)</th>
                      <th scope="col">Returns (est.)</th>
                      <th scope="col">Triggers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sim.nodeAudienceReport.rows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="mas-node-meta-empty">
                          No active nodes · add points on the layer.
                        </td>
                      </tr>
                    ) : (
                      sim.nodeAudienceReport.rows.map((r) => {
                        const trig = sim.experienceFiresByPoiId?.[r.poiId] ?? 0;
                        return (
                          <tr key={r.poiId}>
                            <td>
                              <span className="mas-node-meta-name">{r.name}</span>
                              <span className="mas-node-meta-pct">{Math.round(r.shareOfSampleTraffic * 100)}%</span>
                            </td>
                            <td>{Number(r.dwellMinutes.toFixed(2))}</td>
                            <td>{r.uniqueEstimated.toLocaleString()}</td>
                            <td>{r.returnVisitsEst.toLocaleString()}</td>
                            <td title="Programmable rule hits at this placement (cooldown-aware rehearsal) · registered-eligible devices only">
                              {trig.toLocaleString()}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              {sim.nodeAudienceReport.totals.totalPresenceTouchesNodes > 0 ? (
                <p className="mas-node-meta-footer">
                  Layer totals · sim dwell (nodes):{" "}
                  <strong>{sim.nodeAudienceReport.totals.totalDwellSimMinutesNodes.toFixed(1)}</strong>{" "}
                  min · ∑ unique across nodes{" "}
                  <strong>{sim.nodeAudienceReport.totals.sumUniqueEstimatedAcrossNodes.toLocaleString()}</strong>
                  <span className="mas-node-meta-caveat"> (non-additive vs venue badge)</span>
                </p>
              ) : null}
            </section>

            <section className="mas-sim-dash-card mas-sim-dash-card--monitor mas-sim-dash-card--rule-perf">
              <h3>Rules · performance</h3>
              <p className="mas-sim-dash-hint">
                Triggers fire only for registered (message-eligible) devices. Conversion counts a goal visit when the
                same visitor had a qualifying trigger from that rule within {formatClock(CONVERSION_ATTRIBUTION_WINDOW_SIM_MS)}{" "}
                simulated time; each rule is tallied separately (at most once per visitor per rule). Synthetic follow-on
                samples help surface non-zero conversion in rehearsal · not field proof of causality.
              </p>
              <div className="mas-node-meta-wrap">
                <table className="mas-node-meta-table">
                  <thead>
                    <tr>
                      <th scope="col">Rule</th>
                      <th scope="col">Triggers</th>
                      <th scope="col">Goals</th>
                      <th scope="col">Attributed (est.)</th>
                      <th scope="col">Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sim.rulePerformanceReport.rows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="mas-node-meta-empty">
                          No active rules on this layer.
                        </td>
                      </tr>
                    ) : (
                      sim.rulePerformanceReport.rows.map((r) => (
                        <tr key={r.ruleId}>
                          <td>
                            <span className="mas-node-meta-name">{r.name}</span>
                          </td>
                          <td>{r.triggers.toLocaleString()}</td>
                          <td>{r.conversionGoalLabel ?? "—"}</td>
                          <td>{r.hasConversionGoal ? Math.round(r.attributedVisits).toLocaleString() : "—"}</td>
                          <td>
                            {r.hasConversionGoal && r.triggers > 0 && r.conversionRatePct != null
                              ? `${r.conversionRatePct.toFixed(1)}%`
                              : "—"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mas-sim-dash-card mas-sim-dash-card--results mas-sim-dash-card--monitor">
              <h3>Highlights</h3>
              {topNodesByDistinctDevices.length > 0 ? (
                <div className="mas-sim-dash-top-pois">
                  <span className="mas-sim-dash-label">Busiest nodes by distinct devices (rehearsal)</span>
                  <ol className="mas-sim-dash-top-pois-list">
                    {topNodesByDistinctDevices.map((row) => (
                      <li key={row.id}>
                        <span className="mas-sim-dash-top-pois-name">{row.name}</span>
                        <span className="mas-sim-dash-top-pois-val">{row.devices.toLocaleString()}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="mas-sim-dash-hint">Start from Scenario to populate highlights.</p>
              )}

              {firesByRuleRows.length > 0 ? (
                <div className="mas-sim-dash-fires-by-rule">
                  <span className="mas-sim-dash-label">Experience triggers</span>
                  <ul className="mas-sim-dash-fires-by-rule-list">
                    {firesByRuleRows.map((row) => (
                      <li key={row.id}>
                        <span className="mas-sim-dash-fires-by-rule-name">{row.name}</span>
                        <span className="mas-sim-dash-fires-by-rule-count">{row.count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>

            <section className="mas-sim-dash-log mas-sim-dash-log--monitor">
              <div className="mas-sim-dash-log-head">
                <h3>Activity stream</h3>
                <label className="mas-sim-dash-log-toggle">
                  <input
                    type="checkbox"
                    checked={logVerbose}
                    onChange={(e) => setLogVerbose(e.target.checked)}
                  />
                  Verbose
                </label>
              </div>
              <div className="mas-sim-dash-log-scroll">
                {sim.logs.length === 0 ? (
                  <p className="mas-sim-dash-log-empty">Waiting for activity…</p>
                ) : (
                  sim.logs.map((row, idx) => (
                    <div
                      key={row.id}
                      className={`mas-sim-dash-log-row${idx % 2 === 1 ? " mas-sim-dash-log-row--alt" : ""}`}
                    >
                      <span className="mas-sim-dash-log-time">{formatSimTimeMin(row.t)}</span>
                      <span className="mas-sim-dash-log-msg">
                        {logVerbose ? row.text : row.text.replace(/^\d+\.\d+m sim · /, "")}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>

        <button
          type="button"
          className="mas-sim-monitor-resizer"
          aria-label="Drag to resize the metrics panel and map"
          onPointerDown={onMonitorSplitPointerDown}
        />

        <div className="mas-sim-monitor-map" aria-label="Venue rehearsal map">
          <div className="mas-sim-monitor-map-head">
            <span className="mas-sim-monitor-map-title">Venue · dwell (simulated)</span>
          </div>
          <div className="mas-sim-dash-map-wrap mas-sim-dash-map-wrap--monitor">
            <ActivationMap
              key={simPageId || "sim"}
              viewBox={effectiveSnapshot.viewBox}
              layers={effectiveSnapshot.layers}
              defs={effectiveSnapshot.defs}
              pois={effectiveSnapshot.pois}
              gateways={effectiveSnapshot.gateways || []}
              uncoveredPoiIds={null}
              metersPerSvgUserUnit={effectiveSnapshot.metersPerSvgUserUnit}
              placingPoi={false}
              onPlacePoi={() => {}}
              selectedPoiId={null}
              onSelectPoi={() => {}}
              onMovePoi={() => {}}
              placingGateway={false}
              onPlaceGateway={() => {}}
              selectedGatewayId={null}
              onSelectGateway={() => {}}
              onMoveGateway={() => {}}
              avatarContent={{ x: 0, y: 0 }}
              onAvatarMove={() => {}}
              flatSamples={effectiveSnapshot.flatSamples}
              previewOnlyAvatar
              hideAvatar
              mode="preview"
              mapBackdropFill="#ffffff"
              simHeatClassic
              simPoiHeat={sim.poiDwellIntensityByPoiId}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
