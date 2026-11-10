export const SIM_SCENARIO_POPUP_SOURCES = /** @type {const} */ ({
  parent: "parent",
  scenario: "scenario",
});

/**
 * Stable channel ID for BroadcastChannel pairing between Activation monitor & scenario window.
 */
export function scenarioBroadcastChannelId(rawChannelIdFromQuery) {
  const id = (rawChannelIdFromQuery || "").trim();
  if (!id) return null;
  return `mas_sim_scenario_${id}`;
}
