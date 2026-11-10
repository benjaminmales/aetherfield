import { useCallback, useEffect, useRef, useState } from "react";
import { GATEWAY_COVERAGE_RADIUS_M } from "../lib/gatewayCoverage";
import { parseIndividualSvg, parseMasterSvg } from "../lib/svgImport";

const STORAGE_KEY = "mas_venue_v1";

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function defaultVenue() {
  return {
    viewBox: null,
    world: { metersPerSvgUserUnit: 0.05 },
    layers: [],
    pois: [],
    gateways: [],
    defs: "",
  };
}

function normalizeVenue(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.layers)) {
    return defaultVenue();
  }
  return {
    ...defaultVenue(),
    ...raw,
    world: { ...defaultVenue().world, ...(raw.world || {}) },
    layers: raw.layers,
    pois: Array.isArray(raw.pois) ? raw.pois : [],
    gateways: Array.isArray(raw.gateways) ? raw.gateways : [],
    defs: typeof raw.defs === "string" ? raw.defs : "",
  };
}

function loadVenue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return normalizeVenue(JSON.parse(raw));
    }
  } catch {
    /* ignore */
  }
  return defaultVenue();
}

export default function useVenueStore() {
  const [state, setState] = useState(loadVenue);
  /** Draft string for metres/SVG input so users can clear and re-type without the store snapping back. */
  const [metersPerUnitDraft, setMetersPerUnitDraft] = useState(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  const applyMasterSvg = useCallback((svgText) => {
    const parsed = parseMasterSvg(svgText);
    if (!parsed) return;
    setMetersPerUnitDraft(null);
    setState((prev) => ({
      ...prev,
      viewBox: parsed.viewBox,
      layers: parsed.layers.map((l, i) => ({ ...l, order: i })),
      pois: [],
      defs: parsed.defs || "",
    }));
  }, []);

  const applyIndividualSvg = useCallback((svgText, filename) => {
    const parsed = parseIndividualSvg(svgText, filename);
    if (!parsed) return;
    setMetersPerUnitDraft(null);
    setState((prev) => ({
      ...prev,
      viewBox: prev.viewBox || parsed.viewBox,
      layers: [...prev.layers, { ...parsed.layer, order: prev.layers.length }],
      defs: (prev.defs || "") + (parsed.defs || ""),
    }));
  }, []);

  const setMetersPerUnit = useCallback((value) => {
    const s = String(value);
    setMetersPerUnitDraft(s);
    const n = Number(s.trim());
    if (Number.isFinite(n) && n > 0) {
      setState((prev) => ({
        ...prev,
        world: { ...prev.world, metersPerSvgUserUnit: n },
      }));
    }
  }, []);

  const finalizeMetersPerUnit = useCallback(() => {
    setMetersPerUnitDraft((d) => {
      if (d === null) return null;
      const n = Number(String(d).trim());
      if (Number.isFinite(n) && n > 0) {
        setState((prev) => ({
          ...prev,
          world: { ...prev.world, metersPerSvgUserUnit: n },
        }));
      }
      return null;
    });
  }, []);

  const updateLayer = useCallback((layerId, updates) => {
    setState((prev) => ({
      ...prev,
      layers: prev.layers.map((l) => (l.id === layerId ? { ...l, ...updates } : l)),
    }));
  }, []);

  const addPoi = useCallback((position, parentLayerId) => {
    const id = `poi_${genId()}`;
    const newPoi = {
      id,
      name: "",
      position,
      parentLayer: parentLayerId,
      accessLayers: parentLayerId ? [parentLayerId] : [],
      activationRadiusM: 5,
      active: true,
      deviceId: null,
    };
    setState((prev) => ({ ...prev, pois: [...prev.pois, newPoi] }));
    return id;
  }, []);

  const updatePoi = useCallback((poiId, updates) => {
    setState((prev) => ({
      ...prev,
      pois: prev.pois.map((p) => (p.id === poiId ? { ...p, ...updates } : p)),
    }));
  }, []);

  const deletePoi = useCallback((poiId) => {
    setState((prev) => ({
      ...prev,
      pois: prev.pois.filter((p) => p.id !== poiId),
    }));
  }, []);

  const addGateway = useCallback((position) => {
    const id = `gw_${genId()}`;
    const newGateway = {
      id,
      name: "",
      position,
      // Radius this gateway detects within. Rules target gateways, so this is
      // both the RF coverage ring drawn on the map and the trigger distance.
      detectionRadiusM: GATEWAY_COVERAGE_RADIUS_M,
      active: true,
      deviceId: null,
    };
    setState((prev) => ({ ...prev, gateways: [...(prev.gateways || []), newGateway] }));
    return id;
  }, []);

  const updateGateway = useCallback((gatewayId, updates) => {
    setState((prev) => ({
      ...prev,
      gateways: (prev.gateways || []).map((g) => (g.id === gatewayId ? { ...g, ...updates } : g)),
    }));
  }, []);

  const deleteGateway = useCallback((gatewayId) => {
    setState((prev) => ({
      ...prev,
      gateways: (prev.gateways || []).filter((g) => g.id !== gatewayId),
    }));
  }, []);

  const exportConfig = useCallback(() => {
    const blob = new Blob([JSON.stringify(stateRef.current, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "activation_venue.json";
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importConfig = useCallback((jsonText) => {
    try {
      const data = JSON.parse(jsonText);
      if (data && Array.isArray(data.layers) && data.viewBox) {
        setMetersPerUnitDraft(null);
        setState({
          ...defaultVenue(),
          ...data,
          world: { ...defaultVenue().world, ...(data.world || {}) },
          pois: Array.isArray(data.pois) ? data.pois : [],
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  const clearVenue = useCallback(() => {
    setMetersPerUnitDraft(null);
    setState(defaultVenue());
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const loadSnapshot = useCallback((snapshot) => {
    setMetersPerUnitDraft(null);
    setState(normalizeVenue(snapshot));
  }, []);

  const metersPerUnitInput =
    metersPerUnitDraft !== null ? metersPerUnitDraft : String(state.world?.metersPerSvgUserUnit ?? 0.05);

  return {
    ...state,
    metersPerUnitInput,
    applyMasterSvg,
    applyIndividualSvg,
    setMetersPerUnit,
    finalizeMetersPerUnit,
    updateLayer,
    addPoi,
    updatePoi,
    deletePoi,
    addGateway,
    updateGateway,
    deleteGateway,
    exportConfig,
    importConfig,
    clearVenue,
    loadSnapshot,
  };
}
