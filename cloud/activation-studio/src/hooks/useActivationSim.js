import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contentToScene } from "../lib/geo";
import { evaluateRules } from "../lib/ruleEval";
import { buildAudienceAreaRows, peakPressureLabel } from "../lib/simAudienceMetrics";
import { buildFullNodeAudienceReport } from "../lib/simNodeMetrics";
import { resolveAudienceLayerId } from "../lib/venueSampling";
import {
  CONVERSION_ATTRIBUTION_WINDOW_SIM_MS,
  pruneRuleFireHistory,
} from "../lib/simConversion";

const VIRTUAL_DAY_START_MIN = 10 * 60;
const VIRTUAL_DAY_END_MIN = 23 * 60;

/** Reference footfall and event length for scale=1 at density=1 (tuned to prior default). */
const FOOTFALL_REF = 400;
const REF_EVENT_MS = 4 * 3600 * 1000;

const TICK_MS = 90;

/** Rehearsal: extra probability mass for synthetic “goal visit” samples after triggers. */
const SIM_CONVERSION_FOLLOW_BASE_P = 0.06;
const SIM_CONVERSION_FOLLOW_PER_RULE_P = 0.1;

/** Share of devices that are registered for messaging (scenario knob; live would read telemetry). */
const DEFAULT_REGISTERED_AUDIENCE_PCT = 72;
const REHEARSAL_DEVICE_REUSE_AT_ANCHOR_P = 0.38;

function fireHistHasRecent(entries, elapsedMs, win, includeEqual) {
  const arr = Array.isArray(entries) ? entries : [];
  return arr.some((e) => {
    const t = typeof e === "number" ? e : e.t;
    if (includeEqual) {
      if (t > elapsedMs) return false;
    } else if (t >= elapsedMs) return false;
    const dt = elapsedMs - t;
    return dt >= 0 && dt <= win;
  });
}

/**
 * @param {string} anchorPoiId
 * @param {React.MutableRefObject<Record<string, string[]>>} reusePoolsRef
 * @param {React.MutableRefObject<Map<string, boolean>>} deviceRegistrationRef
 * @param {number} registrationScenarioPct
 */
function rehearsalDeviceAtAnchor(anchorPoiId, reusePoolsRef, deviceRegistrationRef, registrationScenarioPct) {
  const pools = reusePoolsRef.current;
  if (!pools[anchorPoiId]) pools[anchorPoiId] = [];
  const poolArr = pools[anchorPoiId];
  let visitorId;
  if (poolArr.length > 0 && Math.random() < REHEARSAL_DEVICE_REUSE_AT_ANCHOR_P) {
    visitorId = poolArr[Math.floor(Math.random() * poolArr.length)];
  } else {
    visitorId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `d_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    poolArr.push(visitorId);
    if (poolArr.length > 400) poolArr.shift();
  }
  if (!deviceRegistrationRef.current.has(visitorId)) {
    deviceRegistrationRef.current.set(
      visitorId,
      Math.random() * 100 < clamp(registrationScenarioPct, 0, 100)
    );
  }
  const isRegistered = deviceRegistrationRef.current.get(visitorId) === true;
  return { visitorId, isRegistered };
}

/**
 * @param {{
 *   activePois: { id: string; position?: [number, number]; activationRadiusM?: number }[];
 *   activeRules: { id: string; targeting?: { conversionPoiIds?: string[] }; active?: boolean }[];
 *   ruleFireHistorySnapshot: Record<string, Array<{ t: number; visitorId: string } | number>>;
 *   visitorIdsTriggeredByRule: Record<string, string[]>;
 *   elapsedMs: number;
 *   attribWindowMs: number;
 *   metersPerSvgUserUnit: number;
 *   scale: number;
 *   deviceRegistrationRef: React.MutableRefObject<Map<string, boolean>>;
 * }} p
 */
function buildConversionFollowSamples(p) {
  const {
    activePois,
    activeRules,
    ruleFireHistorySnapshot,
    visitorIdsTriggeredByRule,
    elapsedMs,
    attribWindowMs,
    metersPerSvgUserUnit,
    scale,
    deviceRegistrationRef,
  } = p;
  const poiById = new Map(activePois.map((x) => [String(x.id), x]));
  const out = [];

  /** Rules that have both goals on-map and some trigger signal this window */
  const qualifiedGoals = [];
  for (const r of activeRules) {
    const raw = r.targeting?.conversionPoiIds;
    if (!Array.isArray(raw)) continue;
    const cids = raw.map((id) => String(id)).filter((id) => poiById.has(id));
    if (!cids.length) continue;

    const fromRound = visitorIdsTriggeredByRule[r.id] || [];
    const firedThisRound = fromRound.length;
    const hadRecentTrigger =
      fireHistHasRecent(ruleFireHistorySnapshot[r.id], elapsedMs, attribWindowMs, true) || firedThisRound > 0;
    if (!hadRecentTrigger) continue;

    qualifiedGoals.push({ r, cids });
  }

  if (qualifiedGoals.length === 0) return out;

  const qualifiedRulesThisTick = qualifiedGoals.length;
  const scaleBump = clamp(scale * SIM_CONVERSION_FOLLOW_BASE_P, 0.02, 0.38);

  for (const { r, cids } of qualifiedGoals) {
    const fromRound = visitorIdsTriggeredByRule[r.id] || [];
    const firedThisRound = fromRound.length;

    const pTry =
      scaleBump +
      SIM_CONVERSION_FOLLOW_PER_RULE_P +
      clamp(firedThisRound * 0.08, 0, 0.32) -
      qualifiedRulesThisTick * 0.018;
    const pHit = clamp(pTry, 0.05, 0.68);
    if (Math.random() > pHit) continue;

    const visitorId = pickFollowVisitorId(
      r.id,
      ruleFireHistorySnapshot,
      visitorIdsTriggeredByRule,
      elapsedMs,
      attribWindowMs
    );
    if (!visitorId) continue;

    const goalId = cids[Math.floor(Math.random() * cids.length)];
    const poi = poiById.get(goalId);
    if (!poi) continue;

    const pt = randomPointNearPoi(poi, metersPerSvgUserUnit);
    const isRegistered = deviceRegistrationRef.current.get(visitorId) === true;
    out.push({
      visitorId,
      isRegistered,
      anchorPoiId: goalId,
      x: pt.x,
      y: pt.y,
    });
  }

  return out;
}

function pickFollowVisitorId(ruleId, histSnapshot, visitorIdsThisRound, elapsedMs, win) {
  const round = visitorIdsThisRound[ruleId] || [];
  if (round.length) return round[Math.floor(Math.random() * round.length)];
  const h = histSnapshot[ruleId] || [];
  const cand = [];
  for (const e of h) {
    if (typeof e === "number") continue;
    const t = e.t;
    const dt = elapsedMs - t;
    if (dt >= 0 && dt <= win && t <= elapsedMs && e.visitorId) cand.push(e.visitorId);
  }
  if (!cand.length) return null;
  return cand[Math.floor(Math.random() * cand.length)];
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/** Scale synthetic intensity: higher footfall or shorter event vs 4h ref → busier. */
function footfallIntensityScale(expectedFootfall, eventDurationMs, density) {
  const raw =
    (expectedFootfall * REF_EVENT_MS) / (FOOTFALL_REF * Math.max(eventDurationMs, 1)) * density;
  return clamp(raw, 0.05, 30);
}

/** Uniform random point in disk around POI (content coordinates). */
function randomPointNearPoi(poi, metersPerSvgUserUnit) {
  const m = Number(metersPerSvgUserUnit) || 0.05;
  const [cx, cy] = poi.position || [0, 0];
  const rM = Math.min(30, Math.max(0.5, Number(poi.activationRadiusM) || 5));
  const maxR = (rM / m) * 0.92;
  const ang = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * maxR;
  return { x: cx + Math.cos(ang) * dist, y: cy + Math.sin(ang) * dist };
}

function simMinutesOfDayFromProgress(simElapsedMs, eventDurationMs) {
  if (!eventDurationMs) return VIRTUAL_DAY_START_MIN;
  const t = clamp(simElapsedMs / eventDurationMs, 0, 1);
  return VIRTUAL_DAY_START_MIN + t * (VIRTUAL_DAY_END_MIN - VIRTUAL_DAY_START_MIN);
}

/**
 * Node-centric rehearsal simulation (no walking agents). Zone/node aggregates from anchored
 * samples; map shading uses simulated dwell (time-at-node proxy). Node-bound rule fires accrue into per-POI trigger counts.
 */
export default function useActivationSim(snapshot) {
  const [status, setStatus] = useState("idle");
  const [simElapsedMs, setSimElapsedMs] = useState(0);
  const [eventDurationMs, setEventDurationMs] = useState(4 * 3600 * 1000);
  const [wallPlaybackMs, setWallPlaybackMs] = useState(120 * 1000);
  const [density, setDensity] = useState(1);
  const [expectedFootfall, setExpectedFootfallState] = useState(400);
  /** Node-bound rule fires (digital-style “interactions” at that placement) */
  const [experienceFiresByPoiId, setExperienceFiresByPoiId] = useState({});
  const [logs, setLogs] = useState([]);
  const [firesTotal, setFiresTotal] = useState(0);
  const [firesByRuleId, setFiresByRuleId] = useState({});
  /** Per sampled zone @typedef {{ arrivals: number; dwellMs: number }} ZoneAgg */
  const [zoneAudience, setZoneAudience] = useState({});
  /** Per anchor POI for synthetic sampling @typedef {{ arrivals: number; dwellMs: number }} NodeAgg */
  const [nodeAudience, setNodeAudience] = useState({});
  /** Integer · at most one credited conversion per visitor per rule (rehearsal) */
  const [conversionAttributedByRule, setConversionAttributedByRule] = useState({});
  const [registeredAudiencePct, setRegisteredAudiencePctState] = useState(DEFAULT_REGISTERED_AUDIENCE_PCT);
  const [simAudienceStats, setSimAudienceStats] = useState({
    totalPresenceSamples: 0,
    registeredSamples: 0,
  });
  const [anchorUniqueDevicesByPoiId, setAnchorUniqueDevicesByPoiId] = useState({});

  const lastFiredRef = useRef({});
  /** @type {React.MutableRefObject<Record<string, Array<{ t: number; visitorId: string }>>>} */
  const ruleFireHistoryRef = useRef({});
  /** One conversion credit per visitor per rule */
  const convertedVisitorsByRuleRef = useRef(/** @type {Record<string, Set<string>>} */ ({}));
  /** Device UUID reuse pool keyed by anchored node (repeat visits). */
  const rehearsalReusePoolsRef = useRef(/** @type {Record<string, string[]>} */ ({}));
  /** deviceId → registered profile is message-eligible */
  const deviceRegistrationRef = useRef(/** @type {Map<string, boolean>} */ (new Map()));
  /** Distinct visitorIds seen at anchor (all devices monitored). */
  const anchorVisitorSetsRef = useRef(/** @type {Record<string, Set<string>>} */ ({}));

  const simElapsedRef = useRef(0);

  const viewBox = snapshot?.viewBox;
  const flatSamples = snapshot?.flatSamples;
  // Detection targets. Named `pois` throughout this hook for now because the
  // per-target metrics, dashboards and xlsx export all key off that name; the
  // objects in it are GATEWAYS. Renaming is a separate mechanical pass.
  const pois = useMemo(() => snapshot?.gateways ?? [], [snapshot]);
  const rules = useMemo(() => snapshot?.rules ?? [], [snapshot]);
  const layers = useMemo(() => snapshot?.layers ?? [], [snapshot]);
  const metersPerSvgUserUnit = snapshot?.metersPerSvgUserUnit ?? 0.05;

  const activePois = useMemo(() => pois.filter((p) => p.active !== false), [pois]);

  const setExpectedFootfall = useCallback((n) => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return;
    setExpectedFootfallState(clamp(v, 50, 50000));
  }, []);

  const setRegisteredAudiencePct = useCallback((n) => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return;
    setRegisteredAudiencePctState(clamp(v, 0, 100));
  }, []);

  const intensityScale = useMemo(
    () => footfallIntensityScale(expectedFootfall, eventDurationMs, density),
    [expectedFootfall, eventDurationMs, density]
  );

  const simEventHours = eventDurationMs / 3600000;
  const visitorsPerSimHour = simEventHours > 0 ? expectedFootfall / simEventHours : 0;

  const approxSamplesPerWallSec = useMemo(() => {
    if (activePois.length === 0 || !flatSamples?.length) return 0;
    const nSamples = Math.max(1, Math.round((5 + activePois.length * 2.5) * intensityScale));
    return (nSamples * 1000) / TICK_MS;
  }, [activePois.length, flatSamples?.length, intensityScale]);

  const reset = useCallback(() => {
    setStatus("idle");
    simElapsedRef.current = 0;
    setSimElapsedMs(0);
    setExperienceFiresByPoiId({});
    setLogs([]);
    setFiresTotal(0);
    setFiresByRuleId({});
    setZoneAudience({});
    setNodeAudience({});
    ruleFireHistoryRef.current = {};
    setConversionAttributedByRule({});
    lastFiredRef.current = {};
    convertedVisitorsByRuleRef.current = {};
    rehearsalReusePoolsRef.current = {};
    deviceRegistrationRef.current = new Map();
    anchorVisitorSetsRef.current = {};
    setSimAudienceStats({ totalPresenceSamples: 0, registeredSamples: 0 });
    setAnchorUniqueDevicesByPoiId({});
  }, []);

  const start = useCallback(() => {
    lastFiredRef.current = {};
    ruleFireHistoryRef.current = {};
    convertedVisitorsByRuleRef.current = {};
    rehearsalReusePoolsRef.current = {};
    deviceRegistrationRef.current = new Map();
    anchorVisitorSetsRef.current = {};
    setConversionAttributedByRule({});
    setSimAudienceStats({ totalPresenceSamples: 0, registeredSamples: 0 });
    setAnchorUniqueDevicesByPoiId({});
    simElapsedRef.current = 0;
    setSimElapsedMs(0);
    setExperienceFiresByPoiId({});
    setLogs([]);
    setFiresTotal(0);
    setFiresByRuleId({});
    setZoneAudience({});
    setNodeAudience({});
    setStatus("running");
  }, []);

  const pause = useCallback(() => {
    setStatus((s) => (s === "running" ? "paused" : s));
  }, []);

  const resume = useCallback(() => {
    setStatus((s) => (s === "paused" ? "running" : s));
  }, []);

  useEffect(() => {
    if (status !== "running" || !viewBox) return undefined;

    const id = setInterval(() => {
      if (simElapsedRef.current >= eventDurationMs) return;
      const speed = eventDurationMs / Math.max(1, wallPlaybackMs);
      const simDelta = TICK_MS * speed;
      let elapsed = simElapsedRef.current + simDelta;
      if (elapsed >= eventDurationMs) {
        elapsed = eventDurationMs;
        simElapsedRef.current = elapsed;
        setSimElapsedMs(elapsed);
        setStatus("finished");
        return;
      }
      simElapsedRef.current = elapsed;
      setSimElapsedMs(elapsed);

      const scale = footfallIntensityScale(expectedFootfall, eventDurationMs, density);

      const simMin = simMinutesOfDayFromProgress(elapsed, eventDurationMs);
      const newLogs = [];
      let fires = 0;
      const firesByRuleDelta = {};
      const experienceFiresByPoiDelta = {};

      if (activePois.length > 0 && flatSamples?.length) {
        pruneRuleFireHistory(ruleFireHistoryRef.current, elapsed, CONVERSION_ATTRIBUTION_WINDOW_SIM_MS);

        const nSamples = Math.max(1, Math.round((5 + activePois.length * 2.5) * scale));
        const samples = [];
        for (let i = 0; i < nSamples; i++) {
          const poi = activePois[Math.floor(Math.random() * activePois.length)];
          const pt = randomPointNearPoi(poi, metersPerSvgUserUnit);
          const { visitorId, isRegistered } = rehearsalDeviceAtAnchor(
            poi.id,
            rehearsalReusePoolsRef,
            deviceRegistrationRef,
            registeredAudiencePct
          );
          samples.push({
            visitorId,
            isRegistered,
            anchorPoiId: poi.id,
            x: pt.x,
            y: pt.y,
          });
        }

        /** Layer occupancy for programmable cluster rules counts registered devices only */
        const occReg = {};
        const zoneDelta = {};
        const nodeDelta = {};

        const dwellFraction = Math.max(simDelta / Math.max(nSamples, 1), 0);

        for (const s of samples) {
          const sc = contentToScene(s.x, s.y, viewBox);
          const lid = resolveAudienceLayerId(flatSamples, sc.x, sc.y);
          if (lid) {
            occReg[lid] = (occReg[lid] || 0) + (s.isRegistered ? 1 : 0);
            if (!zoneDelta[lid]) zoneDelta[lid] = { arrivals: 0, dwellMs: 0 };
            zoneDelta[lid].arrivals += 1;
            zoneDelta[lid].dwellMs += dwellFraction;
          }

          const np = s.anchorPoiId;
          if (np) {
            if (!nodeDelta[np]) nodeDelta[np] = { arrivals: 0, dwellMs: 0 };
            nodeDelta[np].arrivals += 1;
            nodeDelta[np].dwellMs += dwellFraction;
            const anchSet = anchorVisitorSetsRef.current[np] ?? (anchorVisitorSetsRef.current[np] = new Set());
            anchSet.add(s.visitorId);
          }
        }

        const visitorIdsTriggeredByRule = {};

        for (const s of samples) {
          const scene = contentToScene(s.x, s.y, viewBox);
          const currentLayerId = resolveAudienceLayerId(flatSamples, scene.x, scene.y);
          const pt = { x: s.x, y: s.y };
          const { hits } = evaluateRules({
            avatarContent: pt,
            currentLayerId,
            pois,
            rules,
            metersPerSvgUserUnit,
            lastFiredAt: lastFiredRef.current,
            nowMs: elapsed,
            clusterOccupancy: occReg,
            simMinutesOfDay: simMin,
            messageEligible: s.isRegistered,
          });

          for (const h of hits) {
            fires += 1;
            lastFiredRef.current[h.rule.id] = elapsed;
            firesByRuleDelta[h.rule.id] = (firesByRuleDelta[h.rule.id] || 0) + 1;
            const histArr = ruleFireHistoryRef.current[h.rule.id] || [];
            histArr.push({ t: elapsed, visitorId: s.visitorId });
            ruleFireHistoryRef.current[h.rule.id] = histArr;
            if (!visitorIdsTriggeredByRule[h.rule.id]) visitorIdsTriggeredByRule[h.rule.id] = [];
            visitorIdsTriggeredByRule[h.rule.id].push(s.visitorId);
            if (h.poiId) {
              experienceFiresByPoiDelta[h.poiId] = (experienceFiresByPoiDelta[h.poiId] || 0) + 1;
            }
            newLogs.push({
              id: `${elapsed}-${h.rule.id}-${Math.random()}`,
              t: elapsed,
              text: `${(elapsed / 60000).toFixed(1)}m sim · “${h.rule.name || h.rule.id}” · ${h.triggerType}${
                h.clusterId ? ` · zone` : ""
              }`,
            });
          }
        }

        const histSnap = {};
        for (const rk of Object.keys(ruleFireHistoryRef.current)) {
          histSnap[rk] = [...(ruleFireHistoryRef.current[rk] || [])];
        }

        const conversionFollowSamples = buildConversionFollowSamples({
          activePois,
          activeRules: rules.filter((r) => r.active !== false),
          ruleFireHistorySnapshot: histSnap,
          visitorIdsTriggeredByRule,
          elapsedMs: elapsed,
          attribWindowMs: CONVERSION_ATTRIBUTION_WINDOW_SIM_MS,
          metersPerSvgUserUnit,
          scale,
          deviceRegistrationRef,
        });

        let regAddsThisTick = 0;
        for (const s of samples) if (s.isRegistered) regAddsThisTick += 1;

        for (const s of conversionFollowSamples) {
          const sc = contentToScene(s.x, s.y, viewBox);
          const lid = resolveAudienceLayerId(flatSamples, sc.x, sc.y);
          if (lid) {
            occReg[lid] = (occReg[lid] || 0) + (s.isRegistered ? 1 : 0);
            if (!zoneDelta[lid]) zoneDelta[lid] = { arrivals: 0, dwellMs: 0 };
            zoneDelta[lid].arrivals += 1;
            zoneDelta[lid].dwellMs += dwellFraction;
          }

          const np = s.anchorPoiId;
          if (np) {
            if (!nodeDelta[np]) nodeDelta[np] = { arrivals: 0, dwellMs: 0 };
            nodeDelta[np].arrivals += 1;
            nodeDelta[np].dwellMs += dwellFraction;
            const anchSet = anchorVisitorSetsRef.current[np] ?? (anchorVisitorSetsRef.current[np] = new Set());
            anchSet.add(s.visitorId);
          }
          if (s.isRegistered) regAddsThisTick += 1;
        }

        const winMs = CONVERSION_ATTRIBUTION_WINDOW_SIM_MS;
        const activeRules = rules.filter((r) => r.active !== false);
        /** @type {Record<string, number>} */
        const conversionAttribDelta = {};
        /** @type {Array<{ visitorId: string; anchorPoiId?: string | null }>} */
        const allAttribSamples = samples.concat(conversionFollowSamples);

        for (const s of allAttribSamples) {
          const anchor = s.anchorPoiId;
          const visitorId = s.visitorId;
          if (!anchor || !visitorId) continue;

          const eligible = [];
          for (const r of activeRules) {
            const rawCids = r.targeting?.conversionPoiIds;
            if (!Array.isArray(rawCids) || rawCids.length === 0) continue;
            if (!rawCids.some((cid) => String(cid) === String(anchor))) continue;
            const hist = ruleFireHistoryRef.current[r.id] || [];
            const hadTrigger = hist.some((e) => {
              const t = typeof e === "number" ? e : e.t;
              const vid = typeof e === "number" ? null : e.visitorId;
              if (vid == null || vid !== visitorId) return false;
              const dt = elapsed - t;
              return dt >= 0 && dt <= winMs;
            });
            if (!hadTrigger) continue;
            if (!convertedVisitorsByRuleRef.current[r.id]) convertedVisitorsByRuleRef.current[r.id] = new Set();
            if (convertedVisitorsByRuleRef.current[r.id].has(visitorId)) continue;
            eligible.push(r);
          }
          if (eligible.length === 0) continue;
          eligible.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
          for (const rCred of eligible) {
            convertedVisitorsByRuleRef.current[rCred.id].add(visitorId);
            conversionAttribDelta[rCred.id] = (conversionAttribDelta[rCred.id] || 0) + 1;
          }
        }

        if (Object.keys(conversionAttribDelta).length > 0) {
          setConversionAttributedByRule((prev) => {
            const out = { ...prev };
            for (const [k, v] of Object.entries(conversionAttribDelta)) {
              out[k] = (out[k] || 0) + v;
            }
            return out;
          });
        }

        setSimAudienceStats((st) => ({
          totalPresenceSamples: st.totalPresenceSamples + samples.length + conversionFollowSamples.length,
          registeredSamples: st.registeredSamples + regAddsThisTick,
        }));

        const uniqMap = {};
        for (const p of activePois) {
          uniqMap[p.id] = anchorVisitorSetsRef.current[p.id]?.size ?? 0;
        }
        setAnchorUniqueDevicesByPoiId(uniqMap);

        if (Object.keys(zoneDelta).length > 0) {
          setZoneAudience((z0) => {
            const out = { ...z0 };
            for (const [lid, agg] of Object.entries(zoneDelta)) {
              const prev = out[lid] || { arrivals: 0, dwellMs: 0 };
              out[lid] = {
                arrivals: prev.arrivals + agg.arrivals,
                dwellMs: prev.dwellMs + agg.dwellMs,
              };
            }
            return out;
          });
        }

        if (Object.keys(nodeDelta).length > 0) {
          setNodeAudience((n0) => {
            const out = { ...n0 };
            for (const [nid, agg] of Object.entries(nodeDelta)) {
              const prev = out[nid] || { arrivals: 0, dwellMs: 0 };
              out[nid] = {
                arrivals: prev.arrivals + agg.arrivals,
                dwellMs: prev.dwellMs + agg.dwellMs,
              };
            }
            return out;
          });
        }
      }

      if (Object.keys(experienceFiresByPoiDelta).length > 0) {
        setExperienceFiresByPoiId((prev) => {
          const out = { ...prev };
          for (const [k, v] of Object.entries(experienceFiresByPoiDelta)) {
            out[k] = (out[k] || 0) + v;
          }
          return out;
        });
      }

      if (Object.keys(firesByRuleDelta).length > 0) {
        setFiresByRuleId((prev) => {
          const out = { ...prev };
          for (const [k, v] of Object.entries(firesByRuleDelta)) {
            out[k] = (out[k] || 0) + v;
          }
          return out;
        });
      }

      if (fires) setFiresTotal((t) => t + fires);
      if (newLogs.length) {
        const cap = newLogs.slice(0, 40);
        setLogs((prev) => [...cap, ...prev].slice(0, 220));
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, [
    status,
    viewBox,
    flatSamples,
    pois,
    rules,
    activePois,
    density,
    expectedFootfall,
    metersPerSvgUserUnit,
    eventDurationMs,
    wallPlaybackMs,
    registeredAudiencePct,
  ]);

  const progress = eventDurationMs > 0 ? simElapsedMs / eventDurationMs : 0;

  const simPulseLabel = peakPressureLabel(
    simMinutesOfDayFromProgress(simElapsedMs, eventDurationMs)
  );

  const layerNameLookup = useCallback(
    (layerId) => layers.find((l) => l.id === layerId)?.name || layerId,
    [layers]
  );

  const audienceReport = useMemo(
    () => buildAudienceAreaRows(zoneAudience, expectedFootfall, layerNameLookup),
    [zoneAudience, expectedFootfall, layerNameLookup]
  );

  const poiNameLookup = useCallback(
    (poiId) => pois.find((p) => p.id === poiId)?.name || poiId,
    [pois]
  );

  const nodeAudienceReport = useMemo(() => {
    const base = buildFullNodeAudienceReport(activePois, nodeAudience, expectedFootfall, poiNameLookup);
    return {
      ...base,
      rows: base.rows.map((r) => ({
        ...r,
        uniqueDevicesAtAnchor: anchorUniqueDevicesByPoiId[r.poiId] ?? 0,
      })),
    };
  }, [activePois, nodeAudience, expectedFootfall, poiNameLookup, anchorUniqueDevicesByPoiId]);

  /** Map intensity: simulated dwell time at node (ms) — analogous to digital “time in view”. */
  const poiDwellIntensityByPoiId = useMemo(() => {
    const out = {};
    for (const p of activePois) {
      out[p.id] = nodeAudience[p.id]?.dwellMs ?? 0;
    }
    return out;
  }, [activePois, nodeAudience]);

  const rulePerformanceReport = useMemo(() => {
    const activeRules = rules.filter((r) => r.active !== false);
    const rows = activeRules
      .map((r) => {
        const triggers = firesByRuleId[r.id] ?? 0;
        const cids = Array.isArray(r.targeting?.conversionPoiIds) ? r.targeting.conversionPoiIds : [];
        const attributed = conversionAttributedByRule[r.id] ?? 0;
        const hasGoal = cids.length > 0;
        const conversionRatePct =
          hasGoal && triggers > 0
            ? Math.min(100, (attributed / Math.max(triggers, 1)) * 100)
            : null;
        const goalLabels = cids.map((id) => poiNameLookup(id)).join("; ") || "—";
        return {
          ruleId: r.id,
          name: r.name || "Unnamed",
          triggers,
          hasConversionGoal: hasGoal,
          conversionGoalLabel: hasGoal ? goalLabels : null,
          attributedVisits: attributed,
          conversionRatePct,
        };
      });
    return { rows };
  }, [rules, firesByRuleId, conversionAttributedByRule, poiNameLookup]);

  const observedRegisteredAudiencePct = useMemo(() => {
    const t = simAudienceStats.totalPresenceSamples;
    if (!t) return null;
    return (100 * simAudienceStats.registeredSamples) / t;
  }, [simAudienceStats.totalPresenceSamples, simAudienceStats.registeredSamples]);

  const experienceMomentsTotal = firesTotal;

  return {
    status,
    simElapsedMs,
    eventDurationMs,
    wallPlaybackMs,
    density,
    expectedFootfall,
    intensityScale,
    visitorsPerSimHour,
    approxSamplesPerWallSec,
    progress,
    experienceFiresByPoiId,
    poiDwellIntensityByPoiId,
    registeredAudiencePct,
    observedRegisteredAudiencePct,
    simAudienceStats,
    anchorUniqueDevicesByPoiId,
    logs,
    firesTotal,
    firesByRuleId,
    simPulseLabel,
    audienceReport,
    nodeAudienceReport,
    rulePerformanceReport,
    conversionAttributedByRule,
    experienceMomentsTotal,
    setEventDurationMs,
    setWallPlaybackMs,
    setDensity,
    setExpectedFootfall,
    setRegisteredAudiencePct,
    start,
    pause,
    resume,
    reset,
  };
}

export const SIM_EVENT_PRESETS = [
  { label: "1 hour", ms: 3600 * 1000 },
  { label: "4 hours", ms: 4 * 3600 * 1000 },
  { label: "8 hours", ms: 8 * 3600 * 1000 },
  { label: "24 hours", ms: 24 * 3600 * 1000 },
];

export const SIM_WALL_PRESETS = [
  { label: "30 sec", ms: 30 * 1000 },
  { label: "2 min", ms: 120 * 1000 },
  { label: "5 min", ms: 300 * 1000 },
  { label: "15 min", ms: 900 * 1000 },
];

export const FOOTFALL_PRESETS = [
  { label: "200", value: 200 },
  { label: "400", value: 400 },
  { label: "1k", value: 1000 },
  { label: "2.5k", value: 2500 },
  { label: "10k", value: 10000 },
];

export const REGISTERED_AUDIENCE_PRESETS = [
  { label: "40%", value: 40 },
  { label: "72%", value: 72 },
  { label: "90%", value: 90 },
];
