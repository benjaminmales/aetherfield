/**
 * Layer point-in-fill sampling (ported from cloud-controller-simulator useShowControlSimulator.js).
 */

const NS = "http://www.w3.org/2000/svg";
const PIXEL_GROUPS = 5;

function hashString(str = "") {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function parseViewBox(viewBox) {
  const parts = String(viewBox || "0 0 1000 800")
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

function splitPointsIntoGroups(points) {
  const groups = Array.from({ length: PIXEL_GROUPS }, () => []);
  points.forEach((p, idx) => {
    groups[idx % PIXEL_GROUPS].push(p);
  });
  return groups;
}

function createSamplingEnvironment(svgContent, samplingViewBox) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<svg xmlns="${NS}">${svgContent || ""}</svg>`, "image/svg+xml");
  const sourceChildren = Array.from(doc.documentElement.children);
  if (sourceChildren.length === 0) return null;
  const vb = parseViewBox(samplingViewBox);

  const tempSvg = document.createElementNS(NS, "svg");
  tempSvg.setAttribute("width", String(vb.w));
  tempSvg.setAttribute("height", String(vb.h));
  tempSvg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  tempSvg.style.position = "absolute";
  tempSvg.style.left = "-100000px";
  tempSvg.style.top = "-100000px";
  tempSvg.style.pointerEvents = "none";
  tempSvg.style.opacity = "0";
  document.body.appendChild(tempSvg);

  sourceChildren.forEach((child) => {
    tempSvg.appendChild(child.cloneNode(true));
  });

  const isClosedPath = (shape) => {
    if (shape.tagName !== "path") return true;
    const d = String(shape.getAttribute("d") || "");
    return /[zZ]/.test(d);
  };
  const isHelperGeometry = (shape) =>
    Boolean(shape.closest("defs,clipPath,mask,symbol,pattern,marker"));
  const hasClipOrMask = (shape) => {
    const style = String(shape.getAttribute("style") || "").toLowerCase();
    return (
      shape.hasAttribute("clip-path") ||
      shape.hasAttribute("mask") ||
      style.includes("clip-path") ||
      style.includes("mask")
    );
  };
  const hasVisibleFill = (shape) => {
    const fill = (shape.getAttribute("fill") || "").trim().toLowerCase();
    return fill !== "none" && fill !== "transparent";
  };
  const hasVisibleStroke = (shape) => {
    const stroke = (shape.getAttribute("stroke") || "").trim().toLowerCase();
    if (stroke === "" || stroke === "none" || stroke === "transparent") {
      const style = typeof window !== "undefined" ? window.getComputedStyle(shape) : null;
      const computed = String(style?.stroke || "").toLowerCase();
      return computed !== "" && computed !== "none" && computed !== "rgba(0, 0, 0, 0)" && computed !== "transparent";
    }
    return true;
  };
  const getEffectiveOpacity = (shape) => {
    const style = typeof window !== "undefined" ? window.getComputedStyle(shape) : null;
    const shapeOpacity = Number.parseFloat(style?.opacity || shape.getAttribute("opacity") || "1");
    const fillOpacity = Number.parseFloat(style?.fillOpacity || shape.getAttribute("fill-opacity") || "1");
    const value = (Number.isFinite(shapeOpacity) ? shapeOpacity : 1) * (Number.isFinite(fillOpacity) ? fillOpacity : 1);
    return Math.max(0, Math.min(1, value));
  };
  const getStrokePadding = (shape) => {
    const style = typeof window !== "undefined" ? window.getComputedStyle(shape) : null;
    const sw = Number.parseFloat(style?.strokeWidth || shape.getAttribute("stroke-width") || "1");
    return Math.max(0.5, Number.isFinite(sw) ? sw / 2 : 0.5);
  };
  // Returns null (skip), or { mode: "fill" | "stroke" } for a sampleable shape.
  const classifyShape = (shape) => {
    if (isHelperGeometry(shape)) return null;
    if (hasClipOrMask(shape)) return null;
    if (getEffectiveOpacity(shape) < 0.35) return null;
    const tag = shape.tagName;
    const openOrStrokeOnly = tag === "line" || tag === "polyline" || !isClosedPath(shape);
    if (openOrStrokeOnly) {
      if (hasVisibleStroke(shape) && typeof shape.isPointInStroke === "function") {
        return { mode: "stroke" };
      }
      return null;
    }
    if (hasVisibleFill(shape)) return { mode: "fill" };
    if (hasVisibleStroke(shape) && typeof shape.isPointInStroke === "function") {
      return { mode: "stroke" };
    }
    return null;
  };
  const candidates = Array.from(
    tempSvg.querySelectorAll("path,polygon,rect,circle,ellipse,polyline,line")
  );
  const shapes = candidates
    .map((shape) => {
      const c = classifyShape(shape);
      return c ? { shape, mode: c.mode } : null;
    })
    .filter(Boolean);
  if (shapes.length === 0) {
    tempSvg.remove();
    return { tempSvg: null, testers: [], destroy: () => {}, hadGeometry: candidates.length > 0 };
  }

  const testers = [];
  const svgPoint = tempSvg.createSVGPoint();
  const toUserSpaceBBox = (shape, ctm) => {
    const b = shape.getBBox();
    const corners = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height],
    ];
    const pts = corners.map(([x, y]) => {
      svgPoint.x = x;
      svgPoint.y = y;
      return svgPoint.matrixTransform(ctm);
    });
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };
  };

  shapes.forEach(({ shape, mode }) => {
    if (typeof shape.getCTM !== "function") return;
    const ctm = shape.getCTM();
    if (!ctm) return;
    let bbox;
    try {
      bbox = toUserSpaceBBox(shape, ctm);
    } catch {
      return;
    }
    if (mode === "stroke") {
      const pad = getStrokePadding(shape);
      bbox = {
        x: bbox.x - pad,
        y: bbox.y - pad,
        width: bbox.width + pad * 2,
        height: bbox.height + pad * 2,
      };
    }
    if (!(bbox.width > 0 && bbox.height > 0)) return;
    const area = bbox.width * bbox.height;
    testers.push({
      geom: shape,
      bbox,
      area,
      invCtm: ctm.inverse(),
      mode,
    });
  });

  return {
    tempSvg,
    testers,
    hadGeometry: candidates.length > 0,
    destroy() {
      tempSvg.remove();
    },
  };
}

/**
 * @param {object} layer
 * @param {number} count
 * @param {string|null} samplingViewBox
 */
export function sampleLayerPoints(layer, count, samplingViewBox) {
  const emptyGroups = Array.from({ length: PIXEL_GROUPS }, () => []);
  if (!layer?.svgContent || count <= 0 || typeof document === "undefined") {
    return { points: [], groups: emptyGroups, warning: null };
  }
  const env = createSamplingEnvironment(layer.svgContent, samplingViewBox);
  if (!env) {
    return { points: [], groups: emptyGroups, warning: null };
  }
  if (env.testers.length === 0) {
    env.destroy();
    // Layer has no sampleable geometry (annotation, outlined text, decorative lines without
    // strokes, etc.). Treat as non-samplable without nagging the user.
    return { points: [], groups: emptyGroups, warning: null };
  }
  const cap = Number(layer.capacity || 0);
  const rand = mulberry32(hashString(`${layer.id}:${cap}:${count}`));
  const totalArea = env.testers.reduce((sum, t) => sum + t.area, 0);
  const points = [];
  const maxAttempts = Math.max(200, count * 120);
  const point = env.tempSvg.createSVGPoint();

  const pickTester = () => {
    const r = rand() * totalArea;
    let acc = 0;
    for (const t of env.testers) {
      acc += t.area;
      if (r <= acc) return t;
    }
    return env.testers[env.testers.length - 1];
  };

  let attempts = 0;
  while (points.length < count && attempts < maxAttempts) {
    attempts++;
    const tester = pickTester();
    const ux = tester.bbox.x + rand() * tester.bbox.width;
    const uy = tester.bbox.y + rand() * tester.bbox.height;
    point.x = ux;
    point.y = uy;
    const localPoint = point.matrixTransform(tester.invCtm);
    const hit =
      tester.mode === "stroke"
        ? typeof tester.geom.isPointInStroke === "function" && tester.geom.isPointInStroke(localPoint)
        : typeof tester.geom.isPointInFill === "function" && tester.geom.isPointInFill(localPoint);
    if (hit) {
      points.push([ux, uy]);
    }
  }

  env.destroy();
  const warning =
    points.length < count * 0.35
      ? `Low sampling coverage for "${layer.name || layer.id}" (${points.length}/${count}).`
      : null;
  return { points, groups: splitPointsIntoGroups(points), warning };
}

const MAX_TOTAL = 50000;
const DEFAULT_PER_LAYER = 320;

export function deriveSampleCounts(layers = []) {
  const n = layers.length;
  if (n === 0) return [];
  let per = DEFAULT_PER_LAYER;
  if (n * per > MAX_TOTAL) {
    per = Math.max(80, Math.floor(MAX_TOTAL / n));
  }
  return layers.map((layer) => ({ layerId: layer.id, count: per }));
}
