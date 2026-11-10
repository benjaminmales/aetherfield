import { useMemo } from "react";
import { deriveSampleCounts, sampleLayerPoints } from "../lib/layerSampling";

/**
 * @param {object[]} layers
 * @param {string|null} viewBox
 */
export default function useActivationSampling(layers, viewBox) {
  return useMemo(() => {
    const activeSections = layers.filter((l) => l.visible && l.active !== false);
    if (layers.length === 0 || !viewBox) {
      return { sampledByLayer: {}, warnings: [] };
    }
    const counts = deriveSampleCounts(activeSections);
    const warningList = [];
    const sampled = {};
    activeSections.forEach((layer) => {
      const target = counts.find((c) => c.layerId === layer.id)?.count || 0;
      if (target <= 0) {
        sampled[layer.id] = { points: [], groups: [[], [], [], [], []] };
        return;
      }
      const { points, groups, warning } = sampleLayerPoints(layer, target, viewBox);
      sampled[layer.id] = { points, groups };
      if (warning) warningList.push(warning);
    });
    return { sampledByLayer: sampled, warnings: warningList };
  }, [layers, viewBox]);
}
