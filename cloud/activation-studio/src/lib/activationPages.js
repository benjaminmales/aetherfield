/** @typedef {{ id: string; title: string; venue: object; rules: object[] }} ActivationPage */

export function genPageId() {
  return `page_${Math.random().toString(36).slice(2, 10)}`;
}

/** Empty venue snapshot (matches useVenueStore defaultVenue). */
export const EMPTY_VENUE_SNAPSHOT = {
  viewBox: null,
  world: { metersPerSvgUserUnit: 0.05 },
  layers: [],
  pois: [],
  gateways: [],
  defs: "",
};

/**
 * @param {object} venue - live venue store slice
 */
export function buildVenueSnapshot(venue) {
  return {
    viewBox: venue.viewBox,
    world: venue.world ? { ...venue.world } : { metersPerSvgUserUnit: 0.05 },
    layers: venue.layers || [],
    pois: venue.pois || [],
    gateways: venue.gateways || [],
    defs: venue.defs || "",
  };
}

/**
 * Normalize persisted project `state` to { pages, activePageId, deployment }.
 * Migrates legacy `{ venue, rules, deployment }`.
 */
export function normalizeProjectState(payload) {
  const deployment =
    payload?.deployment && typeof payload.deployment === "object" ? payload.deployment : null;

  if (payload && Array.isArray(payload.pages) && payload.pages.length > 0) {
    const pages = payload.pages.map((p, i) => ({
      id: typeof p.id === "string" ? p.id : genPageId(),
      title: typeof p.title === "string" && p.title.trim() ? p.title.trim() : `Layer ${i + 1}`,
      venue: p.venue != null ? p.venue : { ...EMPTY_VENUE_SNAPSHOT },
      rules: Array.isArray(p.rules) ? p.rules : [],
    }));
    const active =
      typeof payload.activePageId === "string" && pages.some((p) => p.id === payload.activePageId)
        ? payload.activePageId
        : pages[0].id;
    return { pages, activePageId: active, deployment };
  }

  if (payload && payload.venue != null) {
    const id = genPageId();
    return {
      pages: [
        {
          id,
          title: "Main",
          venue: payload.venue,
          rules: Array.isArray(payload.rules) ? payload.rules : [],
        },
      ],
      activePageId: id,
      deployment,
    };
  }

  const id = genPageId();
  return {
    pages: [{ id, title: "Layer 1", venue: { ...EMPTY_VENUE_SNAPSHOT }, rules: [] }],
    activePageId: id,
    deployment,
  };
}

/**
 * @param {ActivationPage[]} pages
 * @param {string} activePageId
 * @param {object} deployment
 */
export function serializeProjectState(pages, activePageId, deployment) {
  return { pages, activePageId, deployment };
}
