function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// Layer id/name patterns that should be imported but not treated as accessible zones.
const ANNOTATION_NAME_RE =
  /^(background|bg|backdrop|backing|text|labels?|annotation|annotations|decor|decoration|pattern|overlay|notes?)$/i;

function looksLikeAnnotationName(rawName) {
  if (!rawName) return false;
  const collapsed = String(rawName).replace(/[_\-\s]+/g, "");
  return ANNOTATION_NAME_RE.test(collapsed);
}

/**
 * @param {string} svgText
 * @returns {{ viewBox: string, layers: object[], defs: string } | null}
 */
export function parseMasterSvg(svgText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svgEl = doc.querySelector("svg");
  if (!svgEl) return null;

  const viewBox = svgEl.getAttribute("viewBox") || "0 0 800 600";

  // Preserve root-level <defs>, paint servers and <style> so gradient / pattern / clip-path refs
  // resolve and class-based CSS styling still applies to annotation layers.
  const serializerRoot = new XMLSerializer();
  let defs = "";
  svgEl
    .querySelectorAll(
      ":scope > defs, :scope > linearGradient, :scope > radialGradient, :scope > pattern, :scope > clipPath, :scope > mask, :scope > filter, :scope > style"
    )
    .forEach((el) => {
      defs += serializerRoot.serializeToString(el);
    });

  // Parse every CSS rule so we can inline all presentation properties (stroke-width,
  // stroke-linecap, fill-opacity, etc.) for zone layers — stripping only the fill/stroke
  // loses styling that matters (e.g. thin roads become invisible at default stroke-width).
  const styleEls = svgEl.querySelectorAll("style");
  const classProps = {};
  const addRule = (className, body) => {
    const existing = classProps[className] || {};
    body.split(";").forEach((decl) => {
      const idx = decl.indexOf(":");
      if (idx <= 0) return;
      const key = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (key && value) existing[key] = value;
    });
    classProps[className] = existing;
  };
  styleEls.forEach((styleEl) => {
    const cssText = String(styleEl.textContent || "").replace(/\/\*[\s\S]*?\*\//g, "");
    // Match any rule with a (possibly comma-separated) selector list.
    const ruleRe = /([^{}]+)\{([^}]+)\}/g;
    let m;
    while ((m = ruleRe.exec(cssText)) !== null) {
      const selectorText = m[1];
      const body = m[2];
      selectorText.split(",").forEach((sel) => {
        const trimmed = sel.trim();
        const classMatch = trimmed.match(/^\.([\w-]+)\s*$/);
        if (classMatch) addRule(classMatch[1], body);
      });
    }
  });
  const classColors = {};
  const classStrokes = {};
  Object.entries(classProps).forEach(([name, props]) => {
    if (props.fill) classColors[name] = props.fill;
    if (props.stroke) classStrokes[name] = props.stroke;
  });

  const isRealPaint = (value) => {
    if (!value) return false;
    const v = String(value).trim().toLowerCase();
    return v !== "" && v !== "none" && v !== "transparent";
  };
  const shapeLooksSampleable = (el) => {
    const inlineFill = el.getAttribute("fill");
    const inlineStroke = el.getAttribute("stroke");
    const cls = el.getAttribute("class");
    const classList = cls ? cls.split(/\s+/) : [];
    const classFill = classList.find((c) => classColors[c]);
    const classStroke = classList.find((c) => classStrokes[c]);
    const fillExplicit = inlineFill !== null;
    // SVG default fill is black when neither attr nor class sets it.
    const hasFill =
      isRealPaint(inlineFill) ||
      (!fillExplicit && Boolean(classFill) ? isRealPaint(classColors[classFill]) : false) ||
      (!fillExplicit && !classFill);
    const hasStroke = isRealPaint(inlineStroke) || (classStroke && isRealPaint(classStrokes[classStroke]));
    return Boolean(hasFill || hasStroke);
  };

  const groups = svgEl.querySelectorAll(":scope > g[id]");
  const layers = [];

  groups.forEach((g, index) => {
    const id = genId();
    const rawName = g.getAttribute("id") || `Layer ${index + 1}`;
    const name = rawName.replace(/_/g, " ");

    const geoms = Array.from(
      g.querySelectorAll("polygon, path, rect, circle, ellipse, polyline, line")
    );
    const sampleable = geoms.filter(shapeLooksSampleable);
    const nameLooksAnnotation = looksLikeAnnotationName(rawName) || looksLikeAnnotationName(name);
    const type = nameLooksAnnotation || sampleable.length === 0 ? "annotation" : "zone";
    const firstGeom = sampleable[0] || geoms[0] || null;

    let color = "#cccccc";
    if (firstGeom) {
      const cls = firstGeom.getAttribute("class");
      const classList = cls ? cls.split(/\s+/) : [];
      const classFill = classList.find((c) => classColors[c]);
      if (classFill) color = classColors[classFill];
      const inlineFill = firstGeom.getAttribute("fill");
      if (inlineFill && inlineFill !== "none") {
        color = inlineFill;
      } else if (!isRealPaint(inlineFill) && !classFill) {
        const classStroke = classList.find((c) => classStrokes[c]);
        const inlineStroke = firstGeom.getAttribute("stroke");
        if (inlineStroke && inlineStroke !== "none") color = inlineStroke;
        else if (classStroke) color = classStrokes[classStroke];
      }
    }

    const serializer = new XMLSerializer();
    // For zone layers, resolve every CSS-class declaration as a presentation attribute so
    // downstream renderers can recolour without losing styling when classes get stripped.
    // Annotation layers keep their class attributes so preserved <style> rules continue to apply.
    const inlineClassStyles = (el) => {
      if (!el || el.nodeType !== 1) return;
      const cls = el.getAttribute("class");
      if (cls) {
        const names = cls.split(/\s+/).filter(Boolean);
        const merged = {};
        names.forEach((n) => {
          const props = classProps[n];
          if (props) Object.assign(merged, props);
        });
        Object.entries(merged).forEach(([key, value]) => {
          if (!el.hasAttribute(key)) el.setAttribute(key, value);
        });
        el.removeAttribute("class");
      }
      if (el.children) {
        Array.from(el.children).forEach(inlineClassStyles);
      }
    };

    let svgContent = "";
    const sourceChildren = Array.from(g.children);
    if (type === "zone") {
      sourceChildren.forEach((child) => {
        const clone = child.cloneNode(true);
        inlineClassStyles(clone);
        svgContent += serializer.serializeToString(clone);
      });
    } else {
      sourceChildren.forEach((child) => {
        svgContent += serializer.serializeToString(child);
      });
    }

    // Annotation layers (background, text, etc.) are imported and rendered but not accessible.
    const isAnnotation = type === "annotation";
    layers.push({
      id,
      sourceId: rawName,
      svgContent,
      name,
      color,
      originalColor: color,
      active: isAnnotation ? false : rawName !== "No_Seating",
      type,
      order: index,
      opacity: 1,
      visible: true,
      capacity: 0,
    });
  });

  layers.sort((a, b) => a.order - b.order);
  return { viewBox, layers, defs };
}

/**
 * @param {string} svgText
 * @param {string} filename
 * @returns {{ viewBox: string, layer: object, defs: string } | null}
 */
export function parseIndividualSvg(svgText, filename) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svgEl = doc.querySelector("svg");
  if (!svgEl) return null;

  const viewBox = svgEl.getAttribute("viewBox") || "0 0 800 600";
  const serializer = new XMLSerializer();
  let defs = "";
  let svgContent = "";
  for (const child of svgEl.children) {
    const tag = child.tagName;
    if (tag === "defs" || tag === "linearGradient" || tag === "radialGradient" || tag === "pattern" || tag === "clipPath" || tag === "mask" || tag === "filter") {
      defs += serializer.serializeToString(child);
      continue;
    }
    if (tag === "style") continue;
    svgContent += serializer.serializeToString(child);
  }

  const id = genId();
  const name = filename.replace(/\.svg$/i, "").replace(/[_-]/g, " ");

  const layer = {
    id,
    sourceId: filename,
    svgContent,
    name,
    color: "#94a3b8",
    originalColor: "#94a3b8",
    active: true,
    type: "zone",
    order: 0,
    opacity: 1,
    visible: true,
    capacity: 0,
  };

  return { viewBox, layer, defs };
}
