import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { contentToScene, sceneToContent } from "../lib/geo";
import { targetRadiusM } from "../lib/ruleEval";
import {
  CANVAS_H,
  CANVAS_W,
  clientToSceneCoords,
  parseViewBox,
  resolveAudienceLayerId,
} from "../lib/venueSampling";
import "./ActivationMap.css";

// Rewrite an active layer's SVG markup so every shape is tinted with the layer colour.
// Preserves explicit "none"/"transparent" paints, adds fill for closed shapes, and adds a
// stroke (with fill="none") for <line>/<polyline> so stroke-based layers render properly.
function colorizeLayerMarkup(svgContent, color) {
  let out = String(svgContent || "").replace(/\s?class="[^"]*"/g, "");
  out = out.replace(/fill="(?!none\b)(?!transparent\b)[^"]*"/gi, `fill="${color}"`);
  out = out.replace(/stroke="(?!none\b)(?!transparent\b)[^"]*"/gi, `stroke="${color}"`);
  out = out.replace(/<(polyline|line)\b([^>]*)>/gi, (_m, tag, attrs) => {
    let extra = "";
    if (!/\bstroke=/.test(attrs)) extra += ` stroke="${color}"`;
    if (!/\bfill=/.test(attrs)) extra += ` fill="none"`;
    if (!/\bstroke-width=/.test(attrs)) extra += ` stroke-width="2"`;
    return `<${tag}${attrs}${extra}>`;
  });
  out = out.replace(/<(polygon|rect|circle|ellipse|path)\b([^>]*)>/gi, (match, tag, attrs) => {
    if (/\bfill=/.test(attrs)) return match;
    if (/\bstroke=/.test(attrs)) return match;
    return `<${tag}${attrs} fill="${color}">`;
  });
  return out;
}

export default function ActivationMap({
  viewBox,
  layers,
  defs = "",
  pois,
  gateways = [],
  uncoveredPoiIds = null,
  metersPerSvgUserUnit,
  placingPoi,
  onPlacePoi,
  selectedPoiId,
  onSelectPoi,
  onMovePoi,
  placingGateway = false,
  onPlaceGateway,
  selectedGatewayId = null,
  onSelectGateway,
  onMoveGateway,
  avatarContent,
  onAvatarMove,
  flatSamples,
  previewOnlyAvatar = false,
  mode = "preview",
  selectedLayerId = null,
  onSelectLayer,
  /** Simulation dashboard: faint crowd dots (content coordinates); optional / future */
  simGhostDots = null,
  /** Rehearsal monitor: per-POI numerical intensity for radial shading (e.g. cumulative dwellMs). */
  simPoiHeat = null,
  /** When true, draw rehearsal intensity as blurred radial gradients (“heatmap” look). */
  simHeatClassic = false,
  /** Optional SVG canvas backdrop; default matches app map area (white, no slate tint). */
  mapBackdropFill = null,
  /** When true, do not render the “You” avatar */
  hideAvatar = false,
}) {
  const isPlanMode = mode === "plan";
  const showAvatar = mode === "preview" && !hideAvatar;
  const avatarInteractive = showAvatar;
  const svgRef = useRef(null);
  const [cameraVb, setCameraVb] = useState({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, vb: null });
  const dragPoiId = useRef(null);
  const avatarDrag = useRef(false);

  const parts = (viewBox || "0 0 800 600").split(/\s+/).map(Number);
  const ox = (CANVAS_W - parts[2]) / 2 - parts[0];
  const oy = (CANVAS_H - parts[3]) / 2 - parts[1];
  const vb = parseViewBox(viewBox);

  const toContentCoords = useCallback(
    (clientX, clientY) => {
      const svg = svgRef.current;
      if (!svg) return null;
      const scene = clientToSceneCoords(svg, clientX, clientY);
      if (!scene) return null;
      return sceneToContent(scene.x, scene.y, viewBox);
    },
    [viewBox]
  );

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = -e.deltaY;
    const scaleFactor = 1 + delta * 0.001;
    setCameraVb((prev) => {
      const svg = svgRef.current;
      if (!svg) return prev;
      const mouse = clientToSceneCoords(svg, e.clientX, e.clientY);
      if (!mouse) return prev;
      const newW = Math.max(150, Math.min(CANVAS_W * 3, prev.w / scaleFactor));
      const newH = Math.max(120, Math.min(CANVAS_H * 3, prev.h / scaleFactor));
      return {
        x: mouse.x - (newW * (mouse.x - prev.x)) / prev.w,
        y: mouse.y - (newH * (mouse.y - prev.y)) / prev.h,
        w: newW,
        h: newH,
      };
    });
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (ev) => handleWheel(ev);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [handleWheel]);

  const handleMapPointerDown = useCallback(
    (e) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        isPanning.current = true;
        panStart.current = { x: e.clientX, y: e.clientY, vb: { ...cameraVb } };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    },
    [cameraVb]
  );

  const handleMapPointerMove = useCallback((e) => {
    if (!isPanning.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const vb0 = panStart.current.vb;
    const start = clientToSceneCoords(svg, panStart.current.x, panStart.current.y);
    const now = clientToSceneCoords(svg, e.clientX, e.clientY);
    if (!start || !now) return;
    setCameraVb({
      ...vb0,
      x: vb0.x - (now.x - start.x),
      y: vb0.y - (now.y - start.y),
    });
  }, []);

  const handleMapPointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const handleHitPointerDown = useCallback(
    (e) => {
      if (e.button !== 0 || e.altKey) return;
      const c = toContentCoords(e.clientX, e.clientY);
      if (!c) return;
      if (placingGateway && !previewOnlyAvatar) {
        onPlaceGateway?.([c.x, c.y]);
        return;
      }
      if (placingPoi && !previewOnlyAvatar) {
        const scene = contentToScene(c.x, c.y, viewBox);
        const layerId = flatSamples?.length
          ? resolveAudienceLayerId(flatSamples, scene.x, scene.y)
          : null;
        onPlacePoi?.([c.x, c.y], layerId);
        return;
      }
      if (isPlanMode) {
        // Click on bare map (no layer under pointer) deselects the current layer.
        onSelectPoi?.(null);
        onSelectLayer?.(null);
        return;
      }
      if (!avatarInteractive) {
        onSelectPoi?.(null);
        return;
      }
      onSelectPoi?.(null);
      onAvatarMove?.(c);
    },
    [
      avatarInteractive,
      flatSamples,
      isPlanMode,
      onAvatarMove,
      onPlaceGateway,
      onPlacePoi,
      onSelectLayer,
      onSelectPoi,
      placingGateway,
      placingPoi,
      previewOnlyAvatar,
      toContentCoords,
      viewBox,
    ]
  );

  const handleLayerPointerDown = useCallback(
    (e, layerId) => {
      if (!isPlanMode) return;
      if (e.button !== 0 || e.altKey) return;
      e.stopPropagation();
      onSelectLayer?.(layerId);
    },
    [isPlanMode, onSelectLayer]
  );

  const onPoiPointerDown = useCallback(
    (ev, poi) => {
      if (placingPoi) return;
      ev.stopPropagation();
      onSelectPoi?.(poi.id);
      if (previewOnlyAvatar) return;
      dragPoiId.current = poi.id;
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
    },
    [onSelectPoi, placingPoi, previewOnlyAvatar]
  );

  const onPoiPointerMove = useCallback(
    (ev) => {
      const id = dragPoiId.current;
      if (!id) return;
      const c = toContentCoords(ev.clientX, ev.clientY);
      if (c) onMovePoi?.(id, [c.x, c.y]);
    },
    [onMovePoi, toContentCoords]
  );

  const onPoiPointerUp = useCallback(() => {
    dragPoiId.current = null;
  }, []);

  const onAvatarPointerDown = useCallback((ev) => {
    ev.stopPropagation();
    avatarDrag.current = true;
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
  }, []);

  const onAvatarPointerMove = useCallback(
    (ev) => {
      if (!avatarDrag.current) return;
      const c = toContentCoords(ev.clientX, ev.clientY);
      if (c) onAvatarMove?.(c);
    },
    [onAvatarMove, toContentCoords]
  );

  const onAvatarPointerUp = useCallback(() => {
    avatarDrag.current = false;
  }, []);

  const dragGatewayId = useRef(null);
  const onGatewayPointerDown = useCallback(
    (ev, gateway) => {
      if (placingGateway || placingPoi) return;
      ev.stopPropagation();
      onSelectGateway?.(gateway.id);
      if (previewOnlyAvatar) return;
      dragGatewayId.current = gateway.id;
      ev.currentTarget.setPointerCapture?.(ev.pointerId);
    },
    [onSelectGateway, placingGateway, placingPoi, previewOnlyAvatar]
  );
  const onGatewayPointerMove = useCallback(
    (ev) => {
      const id = dragGatewayId.current;
      if (!id) return;
      const c = toContentCoords(ev.clientX, ev.clientY);
      if (c) onMoveGateway?.(id, [c.x, c.y]);
    },
    [onMoveGateway, toContentCoords]
  );
  const onGatewayPointerUp = useCallback(() => {
    dragGatewayId.current = null;
  }, []);

  const m = Number(metersPerSvgUserUnit) || 0.05;
  const heatMax = useMemo(() => {
    if (!simPoiHeat) return 0;
    let mx = 0;
    for (const v of Object.values(simPoiHeat)) mx = Math.max(mx, Number(v) || 0);
    return mx || 1;
  }, [simPoiHeat]);
  const heatUid = useId().replace(/:/g, "");
  const simHeatBlurId = `mas-sim-heat-blur-${heatUid}`;
  const backdropFill = mapBackdropFill ?? "#ffffff";
  const currentViewBox = `${cameraVb.x} ${cameraVb.y} ${cameraVb.w} ${cameraVb.h}`;
  const previewReadOnly = previewOnlyAvatar;
  const canInteractPois = mode === "points" && !previewReadOnly;
  const canInteractGateways = mode === "gateways" && !previewReadOnly;
  /** Nodes tab is POI-only; gateway rings would clutter placement and are edited on Gateways. */
  const showGatewayGraphics = mode !== "points";

  if (!viewBox) {
    return <div className="activation-map-empty">Import an SVG plan to begin.</div>;
  }

  return (
    <svg
      ref={svgRef}
      className="activation-map-svg"
      viewBox={currentViewBox}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={handleMapPointerDown}
      onPointerMove={handleMapPointerMove}
      onPointerUp={handleMapPointerUp}
      onPointerLeave={handleMapPointerUp}
    >
      <rect x={cameraVb.x} y={cameraVb.y} width={cameraVb.w} height={cameraVb.h} fill={backdropFill} />
      {defs ? <defs dangerouslySetInnerHTML={{ __html: defs }} /> : null}
      <g transform={`translate(${ox}, ${oy})`}>
        {layers
          .filter((l) => l.visible)
          .map((layer) => {
            // Appearance is driven by layer type only — Active is purely a rules/sampling flag.
            // Annotation layers (background, text, etc.) always render with their original markup
            // (gradients, native colours). Zone layers always render in their layer.color.
            const preserve = layer.type === "annotation";
            const html = preserve ? layer.svgContent : colorizeLayerMarkup(layer.svgContent, layer.color);
            const isSelected = selectedLayerId === layer.id;
            const classes = ["mas-layer-group"];
            if (isPlanMode) classes.push("mas-layer-group--selectable");
            if (isSelected) classes.push("mas-layer-group--selected");
            return (
              <g
                key={layer.id}
                className={classes.join(" ")}
                style={{
                  opacity: layer.opacity ?? 1,
                  pointerEvents: isPlanMode ? "auto" : "none",
                  cursor: isPlanMode ? "pointer" : "default",
                }}
                onPointerDown={isPlanMode ? (e) => handleLayerPointerDown(e, layer.id) : undefined}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          })}

        <rect
          x={vb.x}
          y={vb.y}
          width={vb.w}
          height={vb.h}
          fill="transparent"
          style={{ cursor: placingPoi || placingGateway ? "crosshair" : "pointer" }}
          onPointerDown={handleHitPointerDown}
        />

        {simPoiHeat && heatMax > 0 ? (
          simHeatClassic ? (
            <g className="mas-sim-heat-classic" style={{ pointerEvents: "none" }}>
              <defs>
                <filter
                  id={simHeatBlurId}
                  x="-50%"
                  y="-50%"
                  width="200%"
                  height="200%"
                  colorInterpolationFilters="sRGB"
                >
                  <feGaussianBlur in="SourceGraphic" stdDeviation="18" result="blur" />
                </filter>
                {pois.map((p) => {
                  if (p.active === false) return null;
                  const raw = Number(simPoiHeat[p.id]) || 0;
                  if (raw <= 0) return null;
                  const [x, y] = p.position || [0, 0];
                  const t = Math.min(1, raw / heatMax);
                  const baseR = ((Number(p.activationRadiusM) || 5) / m) * (1.15 + 2.35 * t);
                  const gid = `mas-hg-${heatUid}-${String(p.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                  return (
                    <radialGradient key={`hgdef-${p.id}`} id={gid} gradientUnits="userSpaceOnUse" cx={x} cy={y} r={baseR}>
                      <stop offset="0%" stopColor={`rgba(255,40,0,${0.38 + 0.42 * t})`} />
                      <stop offset="38%" stopColor={`rgba(255,130,30,${0.22 + 0.22 * t})`} />
                      <stop offset="72%" stopColor={`rgba(255,210,80,${0.1 + 0.1 * t})`} />
                      <stop offset="100%" stopColor="rgba(255,255,255,0)" />
                    </radialGradient>
                  );
                })}
              </defs>
              <g filter={`url(#${simHeatBlurId})`} opacity={0.94}>
                {pois.map((p) => {
                  if (p.active === false) return null;
                  const raw = Number(simPoiHeat[p.id]) || 0;
                  if (raw <= 0) return null;
                  const [x, y] = p.position || [0, 0];
                  const t = Math.min(1, raw / heatMax);
                  const baseR = ((Number(p.activationRadiusM) || 5) / m) * (1.15 + 2.35 * t);
                  const gid = `mas-hg-${heatUid}-${String(p.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                  return <circle key={`hgc-${p.id}`} cx={x} cy={y} r={baseR} fill={`url(#${gid})`} />;
                })}
              </g>
            </g>
          ) : (
            <g style={{ pointerEvents: "none" }} className="mas-sim-heat-layer">
              {pois.map((p) => {
                if (p.active === false) return null;
                const raw = Number(simPoiHeat[p.id]) || 0;
                if (raw <= 0) return null;
                const [x, y] = p.position || [0, 0];
                const t = Math.min(1, raw / heatMax);
                const r = ((Number(p.activationRadiusM) || 5) / m) * (0.55 + 0.55 * t);
                return (
                  <circle
                    key={`heat-${p.id}`}
                    cx={x}
                    cy={y}
                    r={r}
                    fill={`rgba(239, 68, 68, ${0.12 + 0.55 * t})`}
                    stroke={`rgba(220, 38, 38, ${0.25 + 0.45 * t})`}
                    strokeWidth={1.5}
                  />
                );
              })}
            </g>
          )
        ) : null}

        {showGatewayGraphics
          ? gateways.map((g) => {
              if (g.visible === false) return null;
              const [gx, gy] = g.position || [0, 0];
              const r = targetRadiusM(g) / m;
              const sel = selectedGatewayId === g.id;
              const isActive = g.active !== false;
              const ringFill = isActive
                ? sel
                  ? "rgba(168, 85, 247, 0.22)"
                  : "rgba(168, 85, 247, 0.12)"
                : "rgba(148, 163, 184, 0.08)";
              const ringStroke = isActive ? "#a855f7" : "#94a3b8";
              const ringW = sel ? 2 : 1;
              return (
                <g
                  key={g.id}
                  onPointerDown={canInteractGateways ? (ev) => onGatewayPointerDown(ev, g) : undefined}
                  onPointerMove={canInteractGateways ? onGatewayPointerMove : undefined}
                  onPointerUp={canInteractGateways ? onGatewayPointerUp : undefined}
                  onPointerCancel={canInteractGateways ? onGatewayPointerUp : undefined}
                  style={{
                    cursor:
                      canInteractGateways && !placingPoi && !placingGateway ? "grab" : "default",
                    pointerEvents: canInteractGateways ? "auto" : "none",
                  }}
                >
                  <circle
                    cx={gx}
                    cy={gy}
                    r={r}
                    fill={ringFill}
                    stroke={ringStroke}
                    strokeWidth={ringW}
                    strokeDasharray={isActive ? undefined : "6 4"}
                    style={{ pointerEvents: "none" }}
                  />
                  <rect
                    x={gx - 9}
                    y={gy - 9}
                    width={18}
                    height={18}
                    rx={4}
                    fill={isActive ? "#7e22ce" : "#cbd5e1"}
                    stroke="#fff"
                    strokeWidth={2}
                  />
                  <text
                    x={gx}
                    y={gy + 4}
                    textAnchor="middle"
                    fill="#fff"
                    fontSize="10"
                    fontWeight="700"
                    style={{ pointerEvents: "none" }}
                  >
                    G
                  </text>
                  {sel ? (
                    <text
                      x={gx}
                      y={gy + 22}
                      textAnchor="middle"
                      fill="#7e22ce"
                      fontSize="11"
                      fontWeight="600"
                      style={{ pointerEvents: "none" }}
                    >
                      {g.name || "Gateway"}
                    </text>
                  ) : null}
                </g>
              );
            })
          : null}

        {pois.map((p) => {
          if (p.active === false) return null;
          const [x, y] = p.position || [0, 0];
          const r = (Number(p.activationRadiusM) || 5) / m;
          const sel = selectedPoiId === p.id;
          const uncovered = uncoveredPoiIds && uncoveredPoiIds.has && uncoveredPoiIds.has(p.id);
          const ringFill = previewReadOnly ? "rgba(148, 163, 184, 0.14)" : "rgba(14,165,233,0.12)";
          const ringStroke = previewReadOnly ? "#94a3b8" : "#0ea5e9";
          const ringW = previewReadOnly ? 1 : sel ? 2 : 1;
          const hubR = previewReadOnly ? 8 : sel ? 11 : 8;
          const hubFill = previewReadOnly ? "#e2e8f0" : "#0f172a";
          const hubStroke = previewReadOnly ? "#94a3b8" : "#fff";
          const labelFill = previewReadOnly ? "#64748b" : "#fff";
          return (
            <g
              key={p.id}
              onPointerDown={canInteractPois ? (ev) => onPoiPointerDown(ev, p) : undefined}
              onPointerMove={canInteractPois ? onPoiPointerMove : undefined}
              onPointerUp={canInteractPois ? onPoiPointerUp : undefined}
              onPointerCancel={canInteractPois ? onPoiPointerUp : undefined}
              style={{
                cursor: canInteractPois && !placingPoi ? "grab" : "default",
                pointerEvents: canInteractPois ? "auto" : "none",
              }}
            >
              <circle cx={x} cy={y} r={r} fill={ringFill} stroke={ringStroke} strokeWidth={ringW} />
              {uncovered ? (
                <circle
                  cx={x}
                  cy={y}
                  r={hubR + 5}
                  fill="none"
                  stroke="#dc2626"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  style={{ pointerEvents: "none" }}
                />
              ) : null}
              <circle cx={x} cy={y} r={hubR} fill={hubFill} stroke={hubStroke} strokeWidth={2} />
              <text
                x={x}
                y={y + 4}
                textAnchor="middle"
                fill={labelFill}
                fontSize="10"
                fontWeight="700"
                style={{ pointerEvents: "none" }}
              >
                {(p.name || "?").slice(0, 1).toUpperCase()}
              </text>
            </g>
          );
        })}

        {simGhostDots?.length ? (
          <g style={{ pointerEvents: "none" }} opacity={0.4}>
            {simGhostDots.map((pt, i) => (
              <circle key={i} cx={pt.x} cy={pt.y} r={2.5} fill="#38bdf8" />
            ))}
          </g>
        ) : null}

        {showAvatar ? (
          <g
            transform={`translate(${avatarContent.x}, ${avatarContent.y})`}
            onPointerDown={avatarInteractive ? onAvatarPointerDown : undefined}
            onPointerMove={avatarInteractive ? onAvatarPointerMove : undefined}
            onPointerUp={avatarInteractive ? onAvatarPointerUp : undefined}
            onPointerCancel={avatarInteractive ? onAvatarPointerUp : undefined}
            style={{
              cursor: avatarInteractive ? "grab" : "default",
              pointerEvents: avatarInteractive ? "auto" : "none",
              touchAction: "none",
            }}
          >
            <circle
              r={16}
              fill="#f97316"
              stroke="#fff"
              strokeWidth={2}
              style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.35))" }}
            />
            <text y={5} textAnchor="middle" fill="#0f172a" fontSize="11" fontWeight="700" style={{ pointerEvents: "none" }}>
              You
            </text>
          </g>
        ) : null}
      </g>
    </svg>
  );
}
