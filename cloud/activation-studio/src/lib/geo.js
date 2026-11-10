import { sceneOffsets } from "./venueSampling";

/** Distance in meters between two points in venue content coordinates. */
export function distanceMeters(ax, ay, bx, by, metersPerSvgUserUnit) {
  const m = Number(metersPerSvgUserUnit) || 0.05;
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy) * m;
}

export function contentToScene(x, y, viewBox) {
  const { offsetX, offsetY } = sceneOffsets(viewBox);
  return { x: x + offsetX, y: y + offsetY };
}

export function sceneToContent(x, y, viewBox) {
  const { offsetX, offsetY } = sceneOffsets(viewBox);
  return { x: x - offsetX, y: y - offsetY };
}

export function planDimensionsMeters(viewBox, metersPerSvgUserUnit) {
  const vb = String(viewBox || "0 0 800 600")
    .trim()
    .split(/\s+/)
    .map(Number);
  const w = vb[2] || 800;
  const h = vb[3] || 600;
  const m = Number(metersPerSvgUserUnit) || 0.05;
  return {
    widthM: w * m,
    heightM: h * m,
  };
}
