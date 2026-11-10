import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ActivationMap from "./components/ActivationMap";
import EventLog from "./components/EventLog";
import GatewayPanel from "./components/GatewayPanel";
import LiveActivationPostDeploy from "./components/LiveActivationPostDeploy";
import LiveTelemetryTest from "./components/LiveTelemetryTest";
import RulesPanel from "./components/RulesPanel";
const VirtualWristbandPreview = lazy(() => import("./components/VirtualWristbandPreview.jsx"));
const ActivationSimDashboard = lazy(() => import("./components/ActivationSimDashboard.jsx"));
import SvgUpload from "./components/SvgUpload";
import WristbandSyncPanel from "./components/WristbandSyncPanel";
import useActivationSampling from "./hooks/useActivationSampling";
import useRulesStore, { createDefaultRule } from "./hooks/useRulesStore";
import useVenueStore from "./hooks/useVenueStore";
import useWristbandSync from "./hooks/useWristbandSync";
import { contentToScene, planDimensionsMeters } from "./lib/geo";
import { evaluateRules } from "./lib/ruleEval";
import {
  buildVenueSnapshot,
  EMPTY_VENUE_SNAPSHOT,
  genPageId,
  normalizeProjectState,
  serializeProjectState,
} from "./lib/activationPages";
import { supabase, supabaseConfigured } from "./lib/supabaseClient";
import {
  buildFlatSamples,
  buildFlatSamplesForVenue,
  parseViewBox,
  resolveAudienceLayerId,
  sceneOffsets,
} from "./lib/venueSampling";
import "./App.css";

function timeStr() {
  const d = new Date();
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const IDLE_BAND_LED = { mode: 0, rate: 100, r: 52, g: 54, b: 62 };
const DEFAULT_LED_FLASH_AUTO_OFF_MS = 2800;
const PROJECTS_TABLE = "activation_projects";

function getLedFlashDurationMs(led) {
  const parsed = Number(led?.durationMs);
  if (!Number.isFinite(parsed)) return DEFAULT_LED_FLASH_AUTO_OFF_MS;
  return Math.min(30000, Math.max(100, Math.round(parsed)));
}

const NO_POIS = [];

const SIDEBAR_TABS = [
  { id: "plan", label: "Plan" },
  { id: "gateways", label: "Gateways" },
  { id: "rules", label: "Rules" },
  { id: "live", label: "Live" },
  { id: "preview", label: "Preview" },
];

export default function App() {
  const venue = useVenueStore();
  const loadVenueSnapshot = venue.loadSnapshot;
  const { rules, addRule, updateRule, deleteRule, loadSnapshot: loadRuleSnapshot } = useRulesStore();
  const wristband = useWristbandSync();
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("sign_in");
  const [authForm, setAuthForm] = useState({ email: "", password: "" });
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  // virtual_id -> hardware_id, derived from device_bindings (source of truth for pairing)
  const [bindingsByVirtualId, setBindingsByVirtualId] = useState({});
  const wristRef = useRef(wristband);
  useLayoutEffect(() => {
    wristRef.current = wristband;
  }, [wristband]);

  const { viewBox, layers, gateways: rawGateways, world, defs } = venue;
  // Merge pairing status from device_bindings into placeholders so the UI reflects
  // physical pairing without persisting deviceId into the saved project state.
  const gateways = useMemo(
    () => (rawGateways || []).map((g) =>
      bindingsByVirtualId[g.id] ? { ...g, deviceId: g.deviceId || bindingsByVirtualId[g.id] } : g),
    [rawGateways, bindingsByVirtualId]
  );
  const metersPerSvgUserUnit = world?.metersPerSvgUserUnit ?? 0.05;
  const hasLayers = layers.length > 0;

  const [sidebarTab, setSidebarTab] = useState("plan");

  const controllableSections = useMemo(
    () => layers.filter((l) => l.visible && l.active !== false),
    [layers]
  );

  const { sampledByLayer, warnings } = useActivationSampling(layers, viewBox);

  const flatSamples = useMemo(() => {
    if (!viewBox || !controllableSections.length) return [];
    const { offsetX, offsetY } = sceneOffsets(viewBox);
    return buildFlatSamples({
      controllableSections,
      sampledByLayer,
      offsetX,
      offsetY,
    });
  }, [viewBox, controllableSections, sampledByLayer]);

  const vb = parseViewBox(viewBox);
  const [avatar, setAvatar] = useState(() => ({
    x: vb.x + vb.w / 2,
    y: vb.y + vb.h / 2,
  }));

  useLayoutEffect(() => {
    if (!viewBox) return;
    const v = parseViewBox(viewBox);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional recentre on venue change
    setAvatar({ x: v.x + v.w / 2, y: v.y + v.h / 2 });
  }, [viewBox]);

  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const [placingGateway, setPlacingGateway] = useState(false);
  const [selectedGatewayId, setSelectedGatewayId] = useState(null);
  const [runModalOpen, setRunModalOpen] = useState(false);
  /** "live" = stub push only; "simulated" = push + open activity simulation dashboard */
  const [runActivationMode, setRunActivationMode] = useState("simulated");
  const [simDashboardOpen, setSimDashboardOpen] = useState(false);
  const [simSnapshot, setSimSnapshot] = useState(null);
  /** Live push: full-screen dashboard + registration warning modal; cleared on dismiss. */
  const [livePostDeployData, setLivePostDeployData] = useState(null);
  const [deployStatus, setDeployStatus] = useState({ status: "draft", deployedAt: null });
  const [pages, setPages] = useState([]);
  const [activePageId, setActivePageId] = useState("");
  const [renamingLayerId, setRenamingLayerId] = useState(null);
  const [renamingLayerDraft, setRenamingLayerDraft] = useState("");
  const layerRenameDraftRef = useRef("");
  const layerRenameTargetIdRef = useRef(null);
  const layerRenameInputRef = useRef(null);
  /** Fixed-position layer menu (escapes strip overflow); { id, top, right } in px */
  const [layerMenu, setLayerMenu] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(360);
  const sidebarResizeActiveRef = useRef(false);
  const [log, setLog] = useState([]);
  const lastFiredAt = useRef({});
  const lastLedSig = useRef("");
  const flashResetTimerRef = useRef(null);

  const [preview, setPreview] = useState({
    title: "",
    body: "",
    ledRgb: { r: 52, g: 54, b: 62 },
  });
  const [simulatedOthersInCluster, setSimulatedOthersInCluster] = useState(0);
  const [currentClusterId, setCurrentClusterId] = useState(null);
  const [narrowViewport, setNarrowViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 720px)")?.matches === true
  );

  const pushLog = useCallback((text) => {
    setLog((prev) => [{ id: `${Date.now()}-${Math.random()}`, t: timeStr(), text }, ...prev].slice(0, 50));
  }, []);

  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 720px)");
    if (!mq) return undefined;
    const onChange = () => setNarrowViewport(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  useLayoutEffect(() => {
    if (!session?.user?.id) return;
    setPages((prev) => {
      if (prev.length > 0) return prev;
      const id = genPageId();
      return [
        {
          id,
          title: "Layer 1",
          venue: buildVenueSnapshot(venue),
          rules: JSON.parse(JSON.stringify(rules)),
        },
      ];
    });
  }, [session?.user?.id, venue, rules]);

  useEffect(() => {
    if (pages.length === 0) return;
    setActivePageId((id) => (id && pages.some((p) => p.id === id) ? id : pages[0].id));
  }, [pages]);

  useEffect(() => {
    if (sidebarTab !== "preview") return;
    setPlacingGateway(false);
    setSelectedGatewayId(null);
  }, [sidebarTab]);

  useEffect(() => {
    if (sidebarTab !== "plan" && selectedLayerId) setSelectedLayerId(null);
  }, [sidebarTab, selectedLayerId]);

  useEffect(() => {
    if (sidebarTab !== "gateways") {
      setPlacingGateway(false);
      if (selectedGatewayId) setSelectedGatewayId(null);
    }
  }, [sidebarTab, selectedGatewayId]);

  const sampleAuraRgb = useCallback(() => preview.ledRgb, [preview.ledRgb]);

  const loadProjects = useCallback(async () => {
    if (!supabaseConfigured || !supabase || !session?.user?.id) return;
    setAuthError("");
    const { data, error } = await supabase
      .from(PROJECTS_TABLE)
      .select("id,name,state,updated_at")
      .eq("owner_id", session.user.id)
      .order("updated_at", { ascending: false });
    if (error) {
      setAuthError(`Could not load projects: ${error.message}`);
      return [];
    }
    const list = data || [];
    setProjects(list);
    return list;
  }, [session?.user?.id]);

  const loadProjectState = useCallback(
    (project) => {
      if (!project) return;
      const { pages: nextPages, activePageId: nextActive, deployment } = normalizeProjectState(
        project.state || {}
      );
      setPages(nextPages);
      setActivePageId(nextActive);
      const active = nextPages.find((p) => p.id === nextActive) || nextPages[0];
      loadVenueSnapshot(active.venue);
      loadRuleSnapshot(active.rules);
      setDeployStatus(
        deployment && typeof deployment === "object"
          ? {
              status: deployment.status === "deployed" ? "deployed" : "draft",
              deployedAt: deployment.deployedAt || null,
            }
          : { status: "draft", deployedAt: null }
      );
    },
    [loadRuleSnapshot, loadVenueSnapshot]
  );

  useEffect(() => {
    if (!supabaseConfigured || !supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
      setAuthError("");
    });
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user?.id) {
      setProjects([]);
      setSelectedProjectId("");
      setPages([]);
      setActivePageId("");
      return;
    }
    void loadProjects();
  }, [loadProjects, session?.user?.id]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const project = projects.find((p) => p.id === selectedProjectId);
    if (project) loadProjectState(project);
  }, [loadProjectState, projects, selectedProjectId]);

  // Load device_bindings for the selected project and keep them live (realtime).
  useEffect(() => {
    if (!supabaseConfigured || !supabase || !selectedProjectId) {
      setBindingsByVirtualId({});
      return undefined;
    }
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from("device_bindings")
        .select("virtual_id,hardware_id")
        .eq("project_id", selectedProjectId);
      if (!active || error) return;
      const map = {};
      for (const r of data || []) map[r.virtual_id] = r.hardware_id;
      setBindingsByVirtualId(map);
    };
    load();
    const channel = supabase
      .channel(`device_bindings:${selectedProjectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "device_bindings", filter: `project_id=eq.${selectedProjectId}` },
        load
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [selectedProjectId]);

  const handleAuthSubmit = useCallback(async () => {
    if (!supabaseConfigured || !supabase) return;
    setAuthBusy(true);
    setAuthError("");
    const email = authForm.email.trim();
    const password = authForm.password;
    if (!email || !password) {
      setAuthBusy(false);
      setAuthError("Email and password are required.");
      return;
    }
    const fn =
      authMode === "sign_up"
        ? supabase.auth.signUp({ email, password })
        : supabase.auth.signInWithPassword({ email, password });
    const { error } = await fn;
    setAuthBusy(false);
    if (error) {
      setAuthError(error.message);
      return;
    }
    if (authMode === "sign_up") {
      setAuthError("Account created. Check your inbox if email confirmation is enabled.");
    }
  }, [authForm.email, authForm.password, authMode]);

  const buildCurrentProjectState = useCallback(() => {
    const effectiveActive =
      activePageId && pages.some((p) => p.id === activePageId) ? activePageId : pages[0]?.id;
    if (pages.length === 0 || !effectiveActive) {
      const id = genPageId();
      return serializeProjectState(
        [
          {
            id,
            title: "Layer 1",
            venue: buildVenueSnapshot(venue),
            rules: JSON.parse(JSON.stringify(rules)),
          },
        ],
        id,
        deployStatus
      );
    }
    const merged = pages.map((p) =>
      p.id === effectiveActive
        ? {
            ...p,
            venue: buildVenueSnapshot(venue),
            rules: JSON.parse(JSON.stringify(rules)),
          }
        : p
    );
    return serializeProjectState(merged, effectiveActive, deployStatus);
  }, [activePageId, deployStatus, pages, rules, venue]);

  const switchToPage = useCallback(
    (targetId) => {
      setLayerMenu(null);
      if (targetId === activePageId) return;
      const flushed = pages.map((p) =>
        p.id === activePageId
          ? { ...p, venue: buildVenueSnapshot(venue), rules: JSON.parse(JSON.stringify(rules)) }
          : p
      );
      const next = flushed.find((p) => p.id === targetId);
      if (!next) return;
      loadVenueSnapshot(next.venue);
      loadRuleSnapshot(next.rules);
      setPages(flushed);
      setActivePageId(targetId);
    },
    [activePageId, pages, venue, rules, loadVenueSnapshot, loadRuleSnapshot]
  );

  const handleAddPage = useCallback(() => {
    const flushed = pages.map((p) =>
      p.id === activePageId
        ? { ...p, venue: buildVenueSnapshot(venue), rules: JSON.parse(JSON.stringify(rules)) }
        : p
    );
    const nid = genPageId();
    const newPage = {
      id: nid,
      title: `Layer ${flushed.length + 1}`,
      venue: { ...EMPTY_VENUE_SNAPSHOT },
      rules: [createDefaultRule()],
    };
    loadVenueSnapshot(newPage.venue);
    loadRuleSnapshot(newPage.rules);
    setPages([...flushed, newPage]);
    setActivePageId(nid);
  }, [activePageId, pages, venue, rules, loadVenueSnapshot, loadRuleSnapshot]);

  const handleDuplicatePage = useCallback(
    (pageId) => {
      const flushed = pages.map((p) =>
        p.id === activePageId
          ? { ...p, venue: buildVenueSnapshot(venue), rules: JSON.parse(JSON.stringify(rules)) }
          : p
      );
      const src = flushed.find((p) => p.id === pageId);
      if (!src) return;
      const nid = genPageId();
      const dup = {
        id: nid,
        title: `${src.title} copy`,
        venue: JSON.parse(JSON.stringify(src.venue)),
        rules: JSON.parse(JSON.stringify(src.rules.length ? src.rules : [createDefaultRule()])),
      };
      loadVenueSnapshot(dup.venue);
      loadRuleSnapshot(dup.rules);
      setPages([...flushed, dup]);
      setActivePageId(nid);
    },
    [activePageId, pages, venue, rules, loadVenueSnapshot, loadRuleSnapshot]
  );

  const handleDeletePage = useCallback(
    (pageId) => {
      if (pages.length <= 1) {
        window.alert("Keep at least one layer.");
        return;
      }
      const victim = pages.find((p) => p.id === pageId);
      if (
        !window.confirm(
          `Remove layer “${victim?.title || "Untitled"}”? Its plan and rules will be deleted from this project.`
        )
      ) {
        return;
      }
      const flushed = pages.map((p) =>
        p.id === activePageId
          ? { ...p, venue: buildVenueSnapshot(venue), rules: JSON.parse(JSON.stringify(rules)) }
          : p
      );
      const idx = flushed.findIndex((p) => p.id === pageId);
      if (idx < 0) return;
      const wasActive = pageId === activePageId;
      const nextPages = flushed.filter((p) => p.id !== pageId);
      setPages(nextPages);
      if (wasActive) {
        const next = nextPages[Math.max(0, idx - 1)];
        setActivePageId(next.id);
        loadVenueSnapshot(next.venue);
        loadRuleSnapshot(next.rules);
      }
    },
    [activePageId, pages, venue, rules, loadVenueSnapshot, loadRuleSnapshot]
  );

  const beginLayerRename = useCallback((p) => {
    if (!p) return;
    setLayerMenu(null);
    layerRenameTargetIdRef.current = p.id;
    layerRenameDraftRef.current = p.title;
    setRenamingLayerDraft(p.title);
    setRenamingLayerId(p.id);
  }, []);

  const cancelLayerRename = useCallback(() => {
    layerRenameTargetIdRef.current = null;
    setRenamingLayerId(null);
    setRenamingLayerDraft("");
    layerRenameDraftRef.current = "";
  }, []);

  const commitLayerRename = useCallback(() => {
    const currentId = layerRenameTargetIdRef.current;
    if (!currentId) return;
    const trimmed = layerRenameDraftRef.current.trim();
    setPages((prev) => {
      const prevTitle = prev.find((x) => x.id === currentId)?.title ?? "Layer";
      return prev.map((x) => (x.id === currentId ? { ...x, title: trimmed || prevTitle } : x));
    });
    layerRenameTargetIdRef.current = null;
    layerRenameDraftRef.current = "";
    setRenamingLayerDraft("");
    setRenamingLayerId(null);
  }, []);

  useLayoutEffect(() => {
    if (!renamingLayerId) return;
    const el = layerRenameInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [renamingLayerId]);

  useEffect(() => {
    if (!layerMenu) return undefined;
    const onPointerDownCapture = (e) => {
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      for (const node of path) {
        if (node instanceof Element) {
          if (node.classList.contains("page-tab-menu-btn") || node.classList.contains("page-tab-menu-panel")) {
            return;
          }
        }
      }
      setLayerMenu(null);
    };
    const onScroll = () => setLayerMenu(null);
    const onKey = (e) => {
      if (e.key === "Escape") setLayerMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDownCapture, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDownCapture, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [layerMenu]);

  const handleCreateProject = useCallback(async () => {
    if (!supabaseConfigured || !supabase || !session?.user?.id) return;
    const name = window.prompt("Project name?", `Activation ${new Date().toLocaleDateString()}`);
    if (!name) return;
    const initialState = buildCurrentProjectState();
    const { data, error } = await supabase
      .from(PROJECTS_TABLE)
      .insert({
        owner_id: session.user.id,
        name: name.trim(),
        state: initialState,
      })
      .select("id,name,state,updated_at")
      .single();
    if (error) {
      setAuthError(`Could not create project: ${error.message}`);
      return;
    }
    setProjects((prev) => [data, ...prev]);
    setSelectedProjectId(data.id);
  }, [buildCurrentProjectState, session?.user?.id]);

  const handleSaveProject = useCallback(async () => {
    if (!supabaseConfigured || !supabase || !session?.user?.id) return;
    setAuthError("");
    if (!selectedProjectId) {
      await handleCreateProject();
      return;
    }
    const { error } = await supabase
      .from(PROJECTS_TABLE)
      .update({ state: buildCurrentProjectState(), updated_at: new Date().toISOString() })
      .eq("id", selectedProjectId)
      .eq("owner_id", session.user.id);
    if (error) {
      setAuthError(`Save failed: ${error.message}`);
      return;
    }
    await loadProjects();
  }, [buildCurrentProjectState, handleCreateProject, loadProjects, selectedProjectId, session?.user?.id]);

  const handleRunActivation = useCallback(
    async (mode) => {
      // Stub deploy: flip project status to "deployed" and log timestamp. When the Aetherfield
      // Cloud API is wired up this is where the POST happens.
      const now = new Date().toISOString();
      setDeployStatus({ status: "deployed", deployedAt: now });
      const effectiveActive =
        activePageId && pages.some((p) => p.id === activePageId) ? activePageId : pages[0]?.id;
      const pagesForRun =
        pages.length > 0 && effectiveActive
          ? pages.map((p) =>
              p.id === effectiveActive
                ? { ...p, venue: buildVenueSnapshot(venue), rules: JSON.parse(JSON.stringify(rules)) }
                : p
            )
          : pages;
      const pageLabel = pagesForRun.find((p) => p.id === activePageId)?.title || "active layer";
      const baseLog = `Activation pushed to Aetherfield Cloud (stub) · ${pagesForRun.length} layer${
        pagesForRun.length === 1 ? "" : "s"
      } · active “${pageLabel}” · ${gateways?.length || 0} gateways · ${
        rules.length
      } rules`;

      if (mode === "live") {
        pushLog(`${baseLog} · Live path — registration check (stub).`);
        setSimDashboardOpen(false);
        setSimSnapshot(null);
        const unregisteredNodes = [];
        const unregisteredGateways = [];
        let activeNodesTotal = 0;
        let gatewaysTotal = 0;
        for (const p of pagesForRun) {
          const v = p.venue || {};
          for (const poi of v.pois || []) {
            if (poi.active === false) continue;
            activeNodesTotal += 1;
            if (!poi.deviceId) {
              unregisteredNodes.push({
                pageTitle: p.title || "Layer",
                name: poi.name || poi.id,
                id: poi.id,
              });
            }
          }
          for (const g of v.gateways || []) {
            gatewaysTotal += 1;
            if (!g.deviceId) {
              unregisteredGateways.push({
                pageTitle: p.title || "Layer",
                name: g.name || g.id,
                id: g.id,
              });
            }
          }
        }
        const rulesTotal = pagesForRun.reduce((acc, p) => acc + (p.rules?.length || 0), 0);
        const activePageForMap = pagesForRun.find((p) => p.id === activePageId);
        const vMap = activePageForMap?.venue || {};
        let mapSnapshot = null;
        if (vMap.viewBox) {
          const flatForMap = buildFlatSamplesForVenue(vMap).map((s) => ({ ...s }));
          mapSnapshot = {
            viewBox: vMap.viewBox,
            layers: (vMap.layers || []).map((l) => ({ ...l })),
            defs: vMap.defs || "",
            pois: (vMap.pois || []).map((x) => ({
              ...x,
              position: Array.isArray(x.position) ? [...x.position] : x.position,
            })),
            gateways: (vMap.gateways || []).map((g) => ({
              ...g,
              position: Array.isArray(g.position) ? [...g.position] : g.position,
            })),
            metersPerSvgUserUnit: vMap.world?.metersPerSvgUserUnit ?? 0.05,
            flatSamples: flatForMap,
          };
        }
        setLivePostDeployData({
          deployedAt: now,
          pagesCount: pagesForRun.length,
          activeLayerTitle: pageLabel,
          rulesTotal,
          activeNodesTotal,
          gatewaysTotal,
          unregisteredNodes,
          unregisteredGateways,
          mapSnapshot,
        });
      } else {
        pushLog(`${baseLog} · Simulated — opening activity simulation.`);
        const simPages = pagesForRun.map((p) => {
          const v = p.venue || {};
          const flat = buildFlatSamplesForVenue(v).map((s) => ({ ...s }));
          return {
            id: p.id,
            title: p.title,
            viewBox: v.viewBox,
            layers: (v.layers || []).map((l) => ({ ...l })),
            defs: v.defs || "",
            pois: (v.pois || []).map((x) => ({
              ...x,
              position: Array.isArray(x.position) ? [...x.position] : x.position,
            })),
            gateways: (v.gateways || []).map((g) => ({
              ...g,
              position: Array.isArray(g.position) ? [...g.position] : g.position,
            })),
            rules: JSON.parse(JSON.stringify(p.rules || [])),
            metersPerSvgUserUnit: v.world?.metersPerSvgUserUnit ?? 0.05,
            flatSamples: flat,
          };
        });
        setSimSnapshot({
          meta: {
            pageTitle: pagesForRun.find((p) => p.id === activePageId)?.title || "",
            pagesCount: pagesForRun.length,
            pushedAt: now,
            initialPageId: activePageId,
          },
          pages: simPages,
          viewBox: venue.viewBox,
          layers: venue.layers.map((l) => ({ ...l })),
          defs: venue.defs || "",
          pois: venue.pois.map((p) => ({
            ...p,
            position: Array.isArray(p.position) ? [...p.position] : p.position,
          })),
          gateways: (venue.gateways || []).map((g) => ({
            ...g,
            position: Array.isArray(g.position) ? [...g.position] : g.position,
          })),
          rules: JSON.parse(JSON.stringify(rules)),
          metersPerSvgUserUnit: venue.world?.metersPerSvgUserUnit ?? 0.05,
          flatSamples: flatSamples.map((s) => ({ ...s })),
        });
        setSimDashboardOpen(true);
      }
      setRunModalOpen(false);
    },
    [activePageId, flatSamples, gateways, pages, pushLog, rules, venue]
  );

  const handleCloseLivePostDeploy = useCallback(() => {
    setLivePostDeployData(null);
  }, []);

  const handleLoadProject = useCallback(async () => {
    if (!supabaseConfigured || !supabase || !session?.user?.id) return;
    const list = (await loadProjects()) || [];
    if (list.length === 0) {
      setAuthError("No projects found. Create one first.");
      return;
    }
    const optionsText = list.map((p, idx) => `${idx + 1}. ${p.name}`).join("\n");
    const choice = window.prompt(`Load project (enter number):\n\n${optionsText}`, "1");
    const index = parseInt(choice || "", 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
    const selected = list[index];
    setSelectedProjectId(selected.id);
    loadProjectState(selected);
  }, [loadProjectState, loadProjects, session?.user?.id]);

  useEffect(() => {
    const onMouseMove = (event) => {
      if (!sidebarResizeActiveRef.current) return;
      const next = Math.min(520, Math.max(280, event.clientX));
      setSidebarWidth(next);
    };
    const onMouseUp = () => {
      sidebarResizeActiveRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (flashResetTimerRef.current != null) {
        clearTimeout(flashResetTimerRef.current);
        flashResetTimerRef.current = null;
      }
    };
  }, []);

  const runEval = useCallback(() => {
    if (!viewBox) return;
    const scene = contentToScene(avatar.x, avatar.y, viewBox);
    const layerId =
      flatSamples.length > 0 ? resolveAudienceLayerId(flatSamples, scene.x, scene.y) : null;

    setCurrentClusterId(layerId);

    const clusterOccupancy = layerId
      ? { [layerId]: 1 + Math.max(0, simulatedOthersInCluster) }
      : {};

    const { hits } = evaluateRules({
      avatarContent: avatar,
      currentLayerId: layerId,
      // Gateways are the detection targets now — the separate activation node
      // was removed when the gateway became the listener (WHITEPAPER 3.2).
      gateways,
      rules,
      metersPerSvgUserUnit,
      lastFiredAt: lastFiredAt.current,
      nowMs: Date.now(),
      clusterOccupancy,
    });

    if (hits.length === 0) {
      lastLedSig.current = "";
      if (flashResetTimerRef.current != null) {
        clearTimeout(flashResetTimerRef.current);
        flashResetTimerRef.current = null;
        const wb = wristRef.current;
        if (wb.wristbandReady) void wb.sendLed(IDLE_BAND_LED);
        setPreview((p) => ({ ...p, ledRgb: { r: IDLE_BAND_LED.r, g: IDLE_BAND_LED.g, b: IDLE_BAND_LED.b } }));
      }
      return;
    }

    let title = "";
    let body = "";
    let ledRgb = { r: 52, g: 54, b: 62 };
    let ledFlashCaptured = false;

    for (const h of hits) {
      lastFiredAt.current[h.rule.id] = Date.now();
      const action = h.rule.action || {};
      const t = action.type;

      if (t === "api_hook") {
        const api = action.api || {};
        pushLog(
          `External API (preview only, not sent): ${api.provider || "?"} · ${api.operation || "?"}`
        );
        if (!title) {
          title = "External API (placeholder)";
          body = "No request sent in this build — configure mapping later.";
        }
        continue;
      }

      if (t === "message" || t === "message_and_led") {
        if (!title) {
          title = action.title || h.rule.name || "Message";
          body = action.body || "";
        }
      }

      if ((t === "message_and_led" || t === "led_pulse") && !ledFlashCaptured) {
        ledFlashCaptured = true;
        const led = action.led || {};
        ledRgb = { r: led.r ?? 255, g: led.g ?? 180, b: led.b ?? 40 };
        const sig = `${led.mode}-${led.rate}-${ledRgb.r}-${ledRgb.g}-${ledRgb.b}`;
        const wb = wristRef.current;
        if (wb.wristbandReady && sig !== lastLedSig.current) {
          lastLedSig.current = sig;
          void wb.sendLed({
            mode: led.mode ?? 2,
            rate: led.rate ?? 120,
            r: ledRgb.r,
            g: ledRgb.g,
            b: ledRgb.b,
          });
        }
        if (flashResetTimerRef.current != null) {
          clearTimeout(flashResetTimerRef.current);
        }
        const flashDurationMs = getLedFlashDurationMs(led);
        flashResetTimerRef.current = window.setTimeout(() => {
          flashResetTimerRef.current = null;
          lastLedSig.current = "";
          const wb2 = wristRef.current;
          if (wb2.wristbandReady) void wb2.sendLed(IDLE_BAND_LED);
          setPreview((p) => ({ ...p, ledRgb: { r: IDLE_BAND_LED.r, g: IDLE_BAND_LED.g, b: IDLE_BAND_LED.b } }));
        }, flashDurationMs);
      }

      if (h.triggerType === "cluster") {
        pushLog(
          `Rule “${h.rule.name}” @ cluster ${h.clusterId || "?"} (${h.clusterCount ?? "?"} detected)`
        );
      } else if (h.triggerType === "time") {
        pushLog(`Rule “${h.rule.name}” @ time window`);
      } else {
        pushLog(`Rule “${h.rule.name}” @ ${h.poiId}`);
      }
    }

    setPreview({ title, body, ledRgb });
  }, [avatar, flatSamples, gateways, metersPerSvgUserUnit, pushLog, rules, simulatedOthersInCluster, viewBox]);

  const rafRef = useRef(null);
  const scheduleEval = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      runEval();
    });
  }, [runEval]);

  useEffect(() => {
    scheduleEval();
  }, [avatar, rules, gateways, metersPerSvgUserUnit, layers, scheduleEval, flatSamples, simulatedOthersInCluster]);

  const handleAvatarMove = useCallback(
    (c) => {
      setAvatar(c);
      scheduleEval();
    },
    [scheduleEval]
  );

  const handleSidebarResizeStart = useCallback(() => {
    sidebarResizeActiveRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handlePlaceGateway = useCallback(
    (position) => {
      const id = venue.addGateway(position);
      setSelectedGatewayId(id);
      setPlacingGateway(false);
    },
    [venue]
  );

  // Readiness is now simply "are there gateways". The old model asked whether
  // every activation node fell inside a gateway's radius; with nodes gone the
  // gateway IS the point of interest, so there is nothing left to be uncovered.
  const activeGatewayCount = useMemo(
    () => (gateways || []).filter((g) => g && g.active !== false).length,
    [gateways]
  );

  const planDims = viewBox ? planDimensionsMeters(viewBox, metersPerSvgUserUnit) : null;
  const isPreviewTab = sidebarTab === "preview";
  const activePage = useMemo(
    () => pages.find((p) => p.id === activePageId),
    [pages, activePageId]
  );

  if (!supabaseConfigured) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h2>Supabase setup required</h2>
          <p>
            Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to your local env file,
            then restart the dev server.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h2>Marketing Activation Studio</h2>
          <p>Sign in with your Supabase account to load and save activation projects.</p>
          <label>
            Email
            <input
              type="email"
              value={authForm.email}
              onChange={(e) => setAuthForm((prev) => ({ ...prev, email: e.target.value }))}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={authForm.password}
              onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
            />
          </label>
          {authError ? <div className="auth-error">{authError}</div> : null}
          <div className="auth-actions">
            <button type="button" className="btn" disabled={authBusy} onClick={() => setAuthMode("sign_in")}>
              Sign in mode
            </button>
            <button type="button" className="btn" disabled={authBusy} onClick={() => setAuthMode("sign_up")}>
              Sign up mode
            </button>
          </div>
          <button type="button" className="btn btn-auth-submit" disabled={authBusy} onClick={handleAuthSubmit}>
            {authBusy ? "Please wait..." : authMode === "sign_up" ? "Create account" : "Sign in"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app" style={{ "--sidebar-width": `${sidebarWidth}px` }}>
      <div className="topbar">
        <div className="topbar-left">
          <img className="topbar-logo" src="/aura-logo.svg" alt="" />
          <div className="topbar-title">
            <h1>ÆTHERFIELD</h1>
            <p>Activation Manager</p>
          </div>
        </div>
        <div className="topbar-right">
          <button type="button" className="btn" onClick={handleCreateProject}>
            New Project
          </button>
          <button type="button" className="btn" onClick={handleLoadProject}>
            Load Project
          </button>
          <button type="button" className="btn" onClick={handleSaveProject}>
            Save Project
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!hasLayers}
            onClick={() => setRunModalOpen(true)}
          >
            {deployStatus.status === "deployed" ? "Re-run activation" : "Run activation"}
          </button>
        </div>
      </div>
      {pages.length > 0 ? (
        <div className="page-strip" role="tablist" aria-label="Activation layers">
          {pages.map((p) => (
            <div
              key={p.id}
              className={`page-tab-wrap${p.id === activePageId ? " page-tab-wrap--active" : ""}`}
            >
              {renamingLayerId === p.id ? (
                <input
                  ref={layerRenameInputRef}
                  type="text"
                  className="page-tab-input"
                  role="tab"
                  aria-label="Layer name"
                  aria-selected={p.id === activePageId}
                  value={renamingLayerDraft}
                  onChange={(e) => {
                    const v = e.target.value;
                    layerRenameDraftRef.current = v;
                    setRenamingLayerDraft(v);
                  }}
                  onBlur={commitLayerRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitLayerRename();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelLayerRename();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={p.id === activePageId}
                  title="Double-click to rename"
                  className={`page-tab${p.id === activePageId ? " page-tab--active" : ""}`}
                  onClick={() => switchToPage(p.id)}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    beginLayerRename(p);
                  }}
                >
                  {p.title}
                </button>
              )}
              <button
                type="button"
                className="page-tab-menu-btn"
                aria-label={`${p.title} — layer actions`}
                aria-haspopup="menu"
                aria-expanded={layerMenu?.id === p.id}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const btn = e.currentTarget;
                  if (!btn) return;
                  const r = btn.getBoundingClientRect();
                  setLayerMenu((cur) => {
                    if (cur?.id === p.id) return null;
                    return {
                      id: p.id,
                      top: r.bottom + 4,
                      right: window.innerWidth - r.right,
                    };
                  });
                }}
              >
                ⋯
              </button>
            </div>
          ))}
          <button type="button" className="btn page-strip-add" onClick={handleAddPage}>
            + Layer
          </button>
        </div>
      ) : null}
      {authError ? <div className="auth-inline-error">{authError}</div> : null}

      <div className="body-layout">
        <aside className="sidebar" style={{ width: `${sidebarWidth}px` }}>
          {!hasLayers ? (
            <div className="sidebar-scroll sidebar-upload-compact">
              <SvgUpload onMasterSvg={venue.applyMasterSvg} onIndividualSvg={venue.applyIndividualSvg} />
              <div className="sidebar-section">
                <p className="empty-sub" style={{ textAlign: "left" }}>
                  Upload a master SVG (layer groups with <code>id</code>) or a single plan file — same flow as Venue
                  Architect in Cloud Controller.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="sidebar-tabs">
                {SIDEBAR_TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`sidebar-tab ${sidebarTab === t.id ? "active" : ""}`}
                    onClick={() => setSidebarTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="sidebar-scroll">
                {sidebarTab === "plan" && (
                  <>
                    <div className="sidebar-section sidebar-upload-compact">
                      <h3>Replace plan</h3>
                      <SvgUpload onMasterSvg={venue.applyMasterSvg} onIndividualSvg={venue.applyIndividualSvg} />
                    </div>
                    {warnings.length > 0 && (
                      <div className="sidebar-section">
                        {warnings.slice(0, 2).map((w) => (
                          <div key={w} className="mas-warn">
                            {w}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="sidebar-section mas-plan-tools">
                      <h3>World scale</h3>
                      <div className="mas-world-row">
                        <label>
                          Metres / SVG unit
                          <input
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            spellCheck={false}
                            value={venue.metersPerUnitInput}
                            onChange={(e) => venue.setMetersPerUnit(e.target.value)}
                            onBlur={() => venue.finalizeMetersPerUnit()}
                          />
                        </label>
                        {planDims && (
                          <span className="mas-world-readout">
                            Plan ≈ {planDims.widthM.toFixed(1)} × {planDims.heightM.toFixed(1)} m
                          </span>
                        )}
                      </div>
                    </div>
                    {layers.length > 0 && (
                      <div className="sidebar-section">
                        <h3>Layers</h3>
                        <p className="rules-hint" style={{ marginBottom: 8 }}>
                          Show toggles map visibility. Active lets a layer be targeted in rules and
                          participate in presence detection — it doesn't change how the layer is drawn.
                          Annotation layers (background, text) keep their original styling regardless of
                          colour.
                        </p>
                        <div className="mas-layer-list">
                          {[...layers]
                            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                            .map((layer) => {
                              const isAnnotation = layer.type === "annotation";
                              const colorValue = /^#[0-9a-f]{6}$/i.test(layer.color || "")
                                ? layer.color
                                : "#888888";
                              const isSelected = selectedLayerId === layer.id;
                              return (
                                <div
                                  key={layer.id}
                                  className={`mas-layer-row${isSelected ? " mas-layer-row--selected" : ""}`}
                                  onClick={() =>
                                    setSelectedLayerId((cur) => (cur === layer.id ? null : layer.id))
                                  }
                                  role="button"
                                  tabIndex={0}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      setSelectedLayerId((cur) => (cur === layer.id ? null : layer.id));
                                    }
                                  }}
                                >
                                  <label
                                    className="mas-layer-toggle"
                                    title="Visible on map"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={layer.visible !== false}
                                      onChange={(e) =>
                                        venue.updateLayer(layer.id, { visible: e.target.checked })
                                      }
                                    />
                                    <span>Show</span>
                                  </label>
                                  <label
                                    className="mas-layer-toggle"
                                    title="Usable in rules & presence detection"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={layer.active !== false}
                                      onChange={(e) =>
                                        venue.updateLayer(layer.id, { active: e.target.checked })
                                      }
                                    />
                                    <span>Active</span>
                                  </label>
                                  <input
                                    type="color"
                                    className="mas-layer-color"
                                    value={colorValue}
                                    disabled={isAnnotation}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => venue.updateLayer(layer.id, { color: e.target.value })}
                                    title={
                                      isAnnotation
                                        ? "Annotation layers keep their original colours"
                                        : "Layer colour"
                                    }
                                  />
                                  <div className="mas-layer-meta">
                                    <div className="mas-layer-name">
                                      {layer.name || layer.sourceId || layer.id}
                                    </div>
                                    <div className="mas-layer-sub">
                                      {isAnnotation ? "annotation" : "zone"}
                                      {layer.active === false ? " · off" : " · on"}
                                      {layer.visible === false ? " · hidden" : ""}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {sidebarTab === "gateways" && (
                  <GatewayPanel
                    gateways={gateways}
                    selectedGatewayId={selectedGatewayId}
                    onSelect={setSelectedGatewayId}
                    onClearSelect={() => setSelectedGatewayId(null)}
                    onUpdate={venue.updateGateway}
                    onDelete={(id) => {
                      venue.deleteGateway(id);
                      setSelectedGatewayId((cur) => (cur === id ? null : cur));
                    }}
                    placingGateway={placingGateway}
                    onTogglePlace={() => setPlacingGateway((p) => !p)}
                    pairingPageId={selectedProjectId}
                  />
                )}

                {sidebarTab === "rules" && (
                  <RulesPanel
                    rules={rules}
                    pois={gateways}
                    layers={layers}
                    onAdd={addRule}
                    onUpdate={updateRule}
                    onDelete={deleteRule}
                  />
                )}

                {sidebarTab === "live" && (
                  <LiveTelemetryTest projectId={selectedProjectId} />
                )}

                {sidebarTab === "preview" && (
                  <div className="mas-preview-stack">
                    <div className="sidebar-section">
                      {activeGatewayCount === 0 ? (
                        <div className="coverage-badge coverage-badge--warn">
                          No gateways placed. Rules fire on gateway detection, so nothing will
                          trigger — add one on the Gateways tab.
                        </div>
                      ) : (
                        <div className="coverage-badge coverage-badge--ok">
                          {activeGatewayCount} active gateway{activeGatewayCount === 1 ? "" : "s"}.
                        </div>
                      )}
                    </div>
                    <div className="sidebar-section">
                      <div className="mas-preview-band-row">
                        <div className="mas-preview-msg-panel">
                          <div className="mas-preview-msg-led" style={{ backgroundColor: `rgb(${preview.ledRgb.r},${preview.ledRgb.g},${preview.ledRgb.b})` }} />
                          {preview.title ? (
                            <div className="mas-preview-msg-title">{preview.title}</div>
                          ) : (
                            <div className="mas-preview-msg-title muted">No message</div>
                          )}
                          {preview.body ? <div className="mas-preview-msg-body">{preview.body}</div> : null}
                        </div>
                        <Suspense fallback={<div className="mas-preview-wristband-loading">Loading wristband…</div>}>
                          <VirtualWristbandPreview
                            sampleAura={sampleAuraRgb}
                            disableCanvasZoom={narrowViewport}
                            className="mas-preview-wristband-3d"
                          />
                        </Suspense>
                      </div>
                    </div>
                    <div className="sidebar-section">
                      <h3>Simulate cluster crowd</h3>
                      <p className="rules-hint">
                        Avatar counts as 1. Add simulated other wristbands in the same cluster to test
                        critical-mass thresholds.
                      </p>
                      <div className="mas-world-row">
                        <label style={{ flex: 1 }}>
                          Others in cluster
                          <input
                            type="range"
                            min={0}
                            max={50}
                            step={1}
                            value={simulatedOthersInCluster}
                            onChange={(e) => setSimulatedOthersInCluster(parseInt(e.target.value, 10) || 0)}
                          />
                        </label>
                        <span className="mas-world-readout">
                          {currentClusterId ? `${1 + simulatedOthersInCluster} in “${
                            layers.find((l) => l.id === currentClusterId)?.name || currentClusterId
                          }”` : "no cluster"}
                        </span>
                      </div>
                    </div>
                    <div className="sidebar-section">
                      <WristbandSyncPanel {...wristband} />
                    </div>
                    <div className="sidebar-section mas-event-section">
                      <EventLog entries={log} />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
        <button
          type="button"
          className="sidebar-resize-handle"
          onMouseDown={handleSidebarResizeStart}
          aria-label="Resize sidebar"
        />

        <div className="center-area">
          <div className="map-toolbar">
            <div>
              <div className="map-toolbar-title">Activation map</div>
              <div className="map-toolbar-hint">
                {sidebarTab === "plan" ? (
                  <>
                    Wheel zoom · Alt-drag or middle mouse pan · Click a layer to select it ·{" "}
                    {selectedLayerId
                      ? <strong>{layers.find((l) => l.id === selectedLayerId)?.name || "layer"} selected</strong>
                      : "click empty area to deselect"}
                  </>
                ) : isPreviewTab ? (
                  <>
                    Preview — gateways are read-only. Tap the plan or drag the visitor to test rules.
                  </>
                ) : (
                  <>
                    Wheel zoom · Alt-drag or middle mouse pan ·{" "}
                    {placingGateway ? <strong>Placing gateway — click map</strong> : "drag marker to reposition"}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="map-wrapper">
            {!hasLayers ? (
              <div className="empty-canvas">
                <div className="empty-icon" aria-hidden>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M3 9h18M9 21V9" />
                  </svg>
                </div>
                <div className="empty-title">No venue loaded</div>
                <div className="empty-sub">Upload a plan from the left sidebar to begin</div>
              </div>
            ) : (
              <ActivationMap
                key={viewBox || "no-venue"}
                viewBox={viewBox}
                layers={layers}
                defs={defs}
                pois={NO_POIS}
                gateways={gateways || []}
                uncoveredPoiIds={null}
                mode={sidebarTab}
                selectedLayerId={selectedLayerId}
                onSelectLayer={(id) => {
                  setSelectedLayerId(id);
                }}
                placingGateway={placingGateway}
                onPlaceGateway={handlePlaceGateway}
                selectedGatewayId={selectedGatewayId}
                onSelectGateway={(id) => {
                  setSelectedGatewayId(id);
                  if (id) setSidebarTab("gateways");
                }}
                onMoveGateway={(id, pos) => venue.updateGateway(id, { position: pos })}
                metersPerSvgUserUnit={metersPerSvgUserUnit}
                avatarContent={avatar}
                onAvatarMove={handleAvatarMove}
                flatSamples={flatSamples}
                previewOnlyAvatar={isPreviewTab}
              />
            )}
          </div>
        </div>
      </div>

      {runModalOpen ? (
        <div className="run-modal-backdrop" onClick={() => setRunModalOpen(false)}>
          <div
            className="run-modal"
            role="dialog"
            aria-label="Run activation"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="run-modal-head">
              <h3>Run activation</h3>
              <button
                type="button"
                className="run-modal-close"
                aria-label="Close"
                onClick={() => setRunModalOpen(false)}
              >
                ×
              </button>
            </div>
            <dl className="run-modal-stats">
              <div>
                <dt>Layers</dt>
                <dd>
                  {pages.length} total
                  {activePage ? ` · editing “${activePage.title}”` : ""}
                </dd>
              </div>
              <div>
                <dt>Gateways</dt>
                <dd>
                  {activeGatewayCount}
                  {(gateways || []).some((g) => g.deviceId)
                    ? ` (${(gateways || []).filter((g) => g.deviceId).length} paired)`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Rules</dt>
                <dd>{rules.length}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {deployStatus.status === "deployed" && deployStatus.deployedAt
                    ? `Deployed ${new Date(deployStatus.deployedAt).toLocaleString()}`
                    : "Draft"}
                </dd>
              </div>
            </dl>
            {activeGatewayCount === 0 ? (
              <div className="coverage-badge coverage-badge--warn">
                No active gateways to run yet.
              </div>
            ) : (
              <div className="coverage-badge coverage-badge--ok">
                {activeGatewayCount} gateway{activeGatewayCount === 1 ? "" : "s"} · ready to deploy.
              </div>
            )}
            <fieldset className="run-modal-mode">
              <legend className="run-modal-mode-legend">Run mode</legend>
              <div className="run-mode-options">
                <label
                  className={`run-mode-option${runActivationMode === "live" ? " run-mode-option--selected" : ""}`}
                >
                  <span className="run-mode-option-head">
                    <input
                      type="radio"
                      name="runActivationMode"
                      value="live"
                      checked={runActivationMode === "live"}
                      onChange={() => setRunActivationMode("live")}
                    />
                    <span className="run-mode-option-title">Live</span>
                  </span>
                  <span className="run-mode-option-desc">
                    Push (stub) then open the live overview: dashboard with a registration warning for unpaired nodes
                    and gateways.
                  </span>
                </label>
                <label
                  className={`run-mode-option${
                    runActivationMode === "simulated" ? " run-mode-option--selected" : ""
                  }`}
                >
                  <span className="run-mode-option-head">
                    <input
                      type="radio"
                      name="runActivationMode"
                      value="simulated"
                      checked={runActivationMode === "simulated"}
                      onChange={() => setRunActivationMode("simulated")}
                    />
                    <span className="run-mode-option-title">Simulated</span>
                  </span>
                  <span className="run-mode-option-desc">
                    Push (stub) then open the activity simulation — footfall, heatmap, and rule-hit log to
                    stress-test the design.
                  </span>
                </label>
              </div>
            </fieldset>
            <p className="run-modal-hint">
              This pushes the whole project (all {pages.length} layer{pages.length === 1 ? "" : "s"}) to
              Aetherfield Cloud (stub). The editor preview reflects the active layer only.{" "}
              <strong>Live</strong> continues to a deployment screen listing unregistered devices;{" "}
              <strong>Simulated</strong> opens the footfall sandbox.
            </p>
            <div className="run-modal-actions">
              <button type="button" className="btn" onClick={() => setRunModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={activeGatewayCount === 0}
                onClick={() => void handleRunActivation(runActivationMode)}
              >
                {runActivationMode === "live" ? "Push (live path)" : "Push & simulate activity"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {simDashboardOpen && simSnapshot ? (
        <Suspense
          fallback={
            <div className="mas-sim-dash-fallback" role="status">
              Loading simulation…
            </div>
          }
        >
          <ActivationSimDashboard
            key={simSnapshot.meta?.pushedAt || "sim"}
            snapshot={simSnapshot}
            onClose={() => setSimDashboardOpen(false)}
          />
        </Suspense>
      ) : null}

      {livePostDeployData ? (
        <LiveActivationPostDeploy data={livePostDeployData} onClose={handleCloseLivePostDeploy} />
      ) : null}

      {layerMenu
        ? createPortal(
            <div
              className="page-tab-menu-panel"
              role="menu"
              style={{
                position: "fixed",
                top: layerMenu.top,
                right: layerMenu.right,
                zIndex: 5000,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="page-tab-menu-item"
                onClick={() => {
                  setLayerMenu(null);
                  handleDuplicatePage(layerMenu.id);
                }}
              >
                Duplicate layer
              </button>
              <button
                type="button"
                role="menuitem"
                className="page-tab-menu-item page-tab-menu-item--danger"
                disabled={pages.length <= 1}
                onClick={() => {
                  setLayerMenu(null);
                  handleDeletePage(layerMenu.id);
                }}
              >
                Delete layer
              </button>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
