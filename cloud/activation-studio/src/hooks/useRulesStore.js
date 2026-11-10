import { useCallback, useEffect, useState } from "react";
import { defaultLedPayload } from "../lib/ruleEval";

const STORAGE_KEY = "mas_rules_v1";

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

export function createDefaultRule() {
  return {
    id: `rule_${genId()}`,
    name: "New interaction",
    active: true,
    priority: 1,
    conditions: [],
    targeting: {
      interactionType: "node",
      poiIds: [],
      conversionPoiIds: [],
      accessLayers: [],
      cooldown: 2,
      minUsers: 1,
    },
    action: {
      type: "message_and_led",
      title: "",
      body: "",
      led: defaultLedPayload(),
    },
  };
}

function loadRules() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.rules)) return { rules: d.rules };
    }
  } catch {
    /* ignore */
  }
  return { rules: [createDefaultRule()] };
}

function normalizeRules(rawRules) {
  if (!Array.isArray(rawRules)) return [createDefaultRule()];
  return rawRules.map((rule) => ({
    ...createDefaultRule(),
    ...rule,
    targeting: { ...createDefaultRule().targeting, ...(rule?.targeting || {}) },
    action: { ...createDefaultRule().action, ...(rule?.action || {}) },
  }));
}

export default function useRulesStore() {
  const [rules, setRules] = useState(() => normalizeRules(loadRules().rules));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ rules }));
    } catch {
      /* ignore */
    }
  }, [rules]);

  const addRule = useCallback(() => {
    setRules((r) => [...r, createDefaultRule()]);
  }, []);

  const updateRule = useCallback((id, patch) => {
    setRules((r) =>
      r.map((x) => {
        if (x.id !== id) return x;
        const next = { ...x, ...patch };
        if (patch.targeting) next.targeting = { ...x.targeting, ...patch.targeting };
        if (patch.action) next.action = { ...(x.action || {}), ...patch.action };
        if (patch.conditions) next.conditions = patch.conditions;
        return next;
      })
    );
  }, []);

  const deleteRule = useCallback((id) => {
    setRules((r) => r.filter((x) => x.id !== id));
  }, []);

  const loadSnapshot = useCallback((nextRules) => {
    setRules(normalizeRules(nextRules));
  }, []);

  return { rules, addRule, updateRule, deleteRule, setRules, loadSnapshot };
}
