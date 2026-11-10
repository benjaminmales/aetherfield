import { deriveSampleCounts, sampleLayerPoints } from "./layerSampling";

/** Scene size for map canvas (matches cloud-controller-simulator). */
export const CANVAS_W = 1000;
export const CANVAS_H = 800;

export const MAX_SAMPLE_SNAP_SCENE = 160;
export const SAMPLE_TIE_SLACK_SCENE2 = 64;

export function parseViewBox(vb) {
  const parts = String(vb || "0 0 1000 800")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return {
    x: Number.isFinite(parts[0]) ? parts[0] : 0,
    y: Number.isFinite(parts[1]) ? parts[1] : 0,
    w: Number.isFinite(parts[2]) && parts[2] > 0 ? parts[2] : 1000,
    h: Number.isFinite(parts[3]) && parts[3] > 0 ? parts[3] : 800,
  };
}

export function sceneOffsets(viewBox) {
  const vb = parseViewBox(viewBox);
  return {
    offsetX: (CANVAS_W - vb.w) / 2 - vb.x,
    offsetY: (CANVAS_H - vb.h) / 2 - vb.y,
  };
}

export function clientToSceneCoords(svgEl, clientX, clientY) {
  if (!svgEl?.createSVGPoint) return null;
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return null;
  try {
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  } catch {
    return null;
  }
}

/**
 * Same sampling as {@link useActivationSampling} + {@link buildFlatSamples}, for offline snapshots (e.g. sim pages).
 * @param {{ layers?: object[]; viewBox?: string | null }} venue
 */
export function buildFlatSamplesForVenue(venue) {
  const layers = venue?.layers || [];
  const viewBox = venue?.viewBox;
  if (!viewBox || layers.length === 0) return [];
  const activeSections = layers.filter((l) => l.visible && l.active !== false);
  if (activeSections.length === 0) return [];
  const counts = deriveSampleCounts(activeSections);
  const sampledByLayer = {};
  activeSections.forEach((layer) => {
    const target = counts.find((c) => c.layerId === layer.id)?.count || 0;
    if (target <= 0) {
      sampledByLayer[layer.id] = { points: [], groups: [[], [], [], [], []] };
      return;
    }
    const { points, groups } = sampleLayerPoints(layer, target, viewBox);
    sampledByLayer[layer.id] = { points, groups };
  });
  const { offsetX, offsetY } = sceneOffsets(viewBox);
  return buildFlatSamples({
    controllableSections: activeSections,
    sampledByLayer,
    offsetX,
    offsetY,
  });
}

export function buildFlatSamples({ controllableSections, sampledByLayer, offsetX, offsetY }) {
  const out = [];
  controllableSections.forEach((layer, layerOrder) => {
    const sampled = sampledByLayer[layer.id];
    const groups = sampled?.groups || [];
    groups.forEach((groupPoints, groupIndex) => {
      const sectionSize = Math.max(1, groupPoints.length);
      groupPoints.forEach((p, idx) => {
        out.push({
          gx: p[0] + offsetX,
          gy: p[1] + offsetY,
          layerId: layer.id,
          layerName: layer.name,
          groupIndex,
          pixelIndex: idx,
          sectionSize,
          layerOrder,
        });
      });
    });
  });
  return out;
}

export function findNearestLayerSample(flatSamples, sceneX, sceneY, maxSnapScene = MAX_SAMPLE_SNAP_SCENE) {
  if (!flatSamples?.length) return null;

  const dist2At = (s) => {
    const dx = s.gx - sceneX;
    const dy = s.gy - sceneY;
    return dx * dx + dy * dy;
  };

  let dMin2 = Infinity;
  for (let i = 0; i < flatSamples.length; i++) {
    const d2 = dist2At(flatSamples[i]);
    if (d2 < dMin2) dMin2 = d2;
  }

  const maxSnap = Math.max(1, Number(maxSnapScene) || MAX_SAMPLE_SNAP_SCENE);
  const maxD2 = maxSnap * maxSnap;
  if (dMin2 > maxD2) return null;

  const slack = Math.max(dMin2 * 0.02, SAMPLE_TIE_SLACK_SCENE2);
  const near = flatSamples.filter((s) => dist2At(s) <= dMin2 + slack);
  near.sort((a, b) => {
    const da = dist2At(a);
    const db = dist2At(b);
    if (Math.abs(da - db) > 1e-6) return da - db;
    return b.layerOrder - a.layerOrder;
  });

  const best = near[0];
  return {
    layerId: best.layerId,
    layerName: best.layerName,
    groupIndex: best.groupIndex,
    pixelIndex: best.pixelIndex,
    sectionSize: best.sectionSize,
  };
}

export const AUDIENCE_LAYER_SNAP_SCENE = 280;

export function resolveAudienceLayerId(
  flatSamples,
  sceneX,
  sceneY,
  maxSnapScene = AUDIENCE_LAYER_SNAP_SCENE,
  bboxPad = 28
) {
  if (!flatSamples?.length) return null;

  const byLayer = new Map();
  for (const s of flatSamples) {
    if (!byLayer.has(s.layerId)) {
      byLayer.set(s.layerId, { samples: [], layerOrder: s.layerOrder });
    }
    const L = byLayer.get(s.layerId);
    L.samples.push(s);
    L.layerOrder = Math.max(L.layerOrder, s.layerOrder);
  }

  const candidates = [];
  const pad = bboxPad;
  for (const [layerId, { samples, layerOrder }] of byLayer) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of samples) {
      minX = Math.min(minX, s.gx);
      minY = Math.min(minY, s.gy);
      maxX = Math.max(maxX, s.gx);
      maxY = Math.max(maxY, s.gy);
    }
    if (sceneX >= minX - pad && sceneX <= maxX + pad && sceneY >= minY - pad && sceneY <= maxY + pad) {
      let bestD2 = Infinity;
      for (const s of samples) {
        const dx = s.gx - sceneX;
        const dy = s.gy - sceneY;
        bestD2 = Math.min(bestD2, dx * dx + dy * dy);
      }
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      candidates.push({ layerId, layerOrder, area: w * h, bestD2 });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (Math.abs(a.bestD2 - b.bestD2) > 1e-6) return a.bestD2 - b.bestD2;
      if (a.area !== b.area) return a.area - b.area;
      return b.layerOrder - a.layerOrder;
    });
    return candidates[0].layerId;
  }

  const near = findNearestLayerSample(flatSamples, sceneX, sceneY, maxSnapScene);
  return near?.layerId ?? null;
}
