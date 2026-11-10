import { useCallback, useEffect, useRef, useState } from "react";
import { defaultLedPayload, LED_SCOPES } from "../lib/ruleEval";
import { CONVERSION_ATTRIBUTION_WINDOW_SIM_MS } from "../lib/simConversion";
import "./RulesPanel.css";

function MultiSelectDropdown({ options, selected, onChange, emptyLabel = "Any", disabled = false }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const selectedIds = Array.isArray(selected) ? selected : [];
  const selectedSet = new Set(selectedIds);

  useEffect(() => {
    if (!open) return undefined;
    const onDocPointer = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (id) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  let summary;
  if (!options.length) summary = "None available";
  else if (selectedSet.size === 0) summary = emptyLabel;
  else if (selectedSet.size === options.length) summary = "All";
  else {
    const labels = options.filter((o) => selectedSet.has(o.id)).map((o) => o.label);
    summary = labels.length <= 2 ? labels.join(", ") : `${labels.length} selected`;
  }

  return (
    <div className={`ms-dropdown${open ? " ms-dropdown--open" : ""}`} ref={containerRef}>
      <button
        type="button"
        className="ms-dropdown-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled || !options.length}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ms-dropdown-summary">{summary}</span>
        <span className="ms-dropdown-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="ms-dropdown-menu" role="listbox">
          <div className="ms-dropdown-actions">
            <button
              type="button"
              className="ms-dropdown-action"
              onClick={() => onChange([])}
              disabled={selectedSet.size === 0}
            >
              Clear
            </button>
            <button
              type="button"
              className="ms-dropdown-action"
              onClick={() => onChange(options.map((o) => o.id))}
              disabled={selectedSet.size === options.length}
            >
              Select all
            </button>
          </div>
          <div className="ms-dropdown-list">
            {options.map((o) => {
              const checked = selectedSet.has(o.id);
              return (
                <label key={o.id} className={`ms-dropdown-item${checked ? " ms-dropdown-item--checked" : ""}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(o.id)} />
                  <span>{o.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const ACTION_TYPES = [
  { value: "message", label: "Message only" },
  { value: "message_and_led", label: "Message + coloured flash" },
  { value: "led_pulse", label: "LED flash only" },
  {
    value: "api_hook",
    label: "External API call (e.g. social, CRM)",
  },
];

const LED_MODES = [
  { value: 0, label: "0 Steady" },
  { value: 1, label: "1 Heartbeat" },
  { value: 2, label: "2 Flash" },
  { value: 3, label: "3 Build-up" },
  { value: 4, label: "4 Chaser" },
  { value: 5, label: "5 Rainbow" },
];

const INTERACTION_TYPES = [
  { value: "gateway", label: "Gateway based" },
  { value: "time", label: "Time based" },
  { value: "cluster", label: "Cluster based" },
  {
    value: "external_signal",
    label: "External signal (webhook / platform)",
  },
];

function clampNum(n, min, max) {
  let x = n;
  if (min !== undefined) x = Math.max(min, x);
  if (max !== undefined) x = Math.min(max, x);
  return x;
}

/** Text numeric field so users can clear and re-type; commits on blur. */
function LooseNumInput({
  inputKey,
  committedValue,
  drafts,
  setDrafts,
  onCommit,
  emptyCommit,
  min,
  max,
  int = true,
  className,
  inputMode = "numeric",
}) {
  const display = drafts[inputKey] !== undefined ? drafts[inputKey] : String(committedValue);
  return (
    <input
      type="text"
      inputMode={inputMode}
      {...(className ? { className } : {})}
      value={display}
      onChange={(e) => setDrafts((d) => ({ ...d, [inputKey]: e.target.value }))}
      onBlur={(e) => {
        const raw = e.target.value;
        setDrafts((d) => {
          const next = { ...d };
          delete next[inputKey];
          return next;
        });
        const t = raw.trim();
        if (t === "") {
          onCommit(emptyCommit);
          return;
        }
        const n = int ? parseInt(t, 10) : parseFloat(t);
        if (!Number.isFinite(n)) return;
        onCommit(clampNum(n, min, max));
      }}
    />
  );
}

export default function RulesPanel({ rules, pois, layers, onAdd, onUpdate, onDelete }) {
  const [selectedRuleId, setSelectedRuleId] = useState(rules[0]?.id ?? null);
  const [numDrafts, setNumDrafts] = useState({});

  const selectRule = useCallback((id) => {
    setNumDrafts({});
    setSelectedRuleId(id);
  }, []);

  useEffect(() => {
    if (!selectedRuleId || rules.some((rule) => rule.id === selectedRuleId)) return;
    queueMicrotask(() => {
      setNumDrafts({});
      setSelectedRuleId(null);
    });
  }, [rules, selectedRuleId]);

  const selectedRule = rules.find((rule) => rule.id === selectedRuleId) || null;
  const action = selectedRule?.action || {};
  const targeting = selectedRule?.targeting || {};
  // "node" is the legacy stored value for what is now a gateway trigger.
  const rawInteractionType = targeting.interactionType || "gateway";
  const interactionType = rawInteractionType === "node" ? "gateway" : rawInteractionType;
  const led = action.led || defaultLedPayload();

  return (
    <div className="rules-panel">
      <div className="rules-panel-head">
        <h2>Interactions</h2>
        <button type="button" className="btn btn-sm" onClick={onAdd}>
          + Rule
        </button>
      </div>
      <p className="rules-hint">
        Configure each interaction as gateway based, time based, or cluster based.
      </p>
      <div className="rules-panel-scroll rules-layout">
        <div className="rules-list" onClick={(e) => e.target === e.currentTarget && selectRule(null)}>
          {rules.map((rule) => {
            const itemAction = rule.action || {};
            const itemTargeting = rule.targeting || {};
            const itemRawType = itemTargeting.interactionType || "gateway";
            const itemInteractionType = itemRawType === "node" ? "gateway" : itemRawType;
            return (
              <div key={rule.id} className={`rule-card ${selectedRuleId === rule.id ? "rule-card--sel" : ""}`}>
                <button type="button" className="rule-card-summary" onClick={() => selectRule(rule.id)}>
                  <span className="rule-card-summary-title">{rule.name || "Unnamed rule"}</span>
                  <span className="rule-card-meta">
                    {itemInteractionType} · {itemAction.type || "message_and_led"} · priority {rule.priority ?? 1}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        {selectedRule ? (
          <>
            <button type="button" className="panel-popout-backdrop" onClick={() => selectRule(null)} />
            <div className="rules-inspector" onClick={(e) => e.stopPropagation()}>
              <div className="rule-card-top">
                <label className="rule-name">
                  Name
                  <input
                    type="text"
                    value={selectedRule.name}
                    onChange={(e) => onUpdate(selectedRule.id, { name: e.target.value })}
                  />
                </label>
                <label className="rule-active">
                  <input
                    type="checkbox"
                    checked={selectedRule.active !== false}
                    onChange={(e) => onUpdate(selectedRule.id, { active: e.target.checked })}
                  />
                  On
                </label>
              </div>

              <label className="rule-priority">
                Priority (higher wins)
                <LooseNumInput
                  inputKey={`${selectedRule.id}-priority`}
                  committedValue={selectedRule.priority ?? 1}
                  drafts={numDrafts}
                  setDrafts={setNumDrafts}
                  min={0}
                  max={999}
                  emptyCommit={1}
                  onCommit={(n) => onUpdate(selectedRule.id, { priority: Math.round(n) })}
                />
              </label>

              <div className="rule-section">
                <div className="rule-section-title">Trigger type</div>
                <select
                  className="rule-select"
                  value={interactionType}
                  onChange={(e) =>
                    onUpdate(selectedRule.id, {
                      targeting: { ...targeting, interactionType: e.target.value },
                    })
                  }
                >
                  {INTERACTION_TYPES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {interactionType === "external_signal" ? (
                  <div className="rule-external-signal-hint">
                    <p>
                      <strong>Preview only.</strong> This rule does not fire from the map or simulation yet — it is
                      meant for when an <strong>external system</strong> (webhook, social platform, partner API) sends
                      an event into Ætherfield.
                    </p>
                    <p>
                      <strong>Coming later:</strong> a configuration flow where you choose which incoming fields to use
                      and how they map into an outbound API call (e.g. trigger a post or message on a social channel).
                    </p>
                    <p className="rule-external-signal-hint-tip">
                      Pair this trigger with action <strong>External API call</strong> below to sketch the integration
                      you want; nothing is executed in this build.
                    </p>
                    <button type="button" className="btn btn-sm rule-external-config-btn" disabled title="Prototype next">
                      Configure integration…
                    </button>
                  </div>
                ) : null}
              </div>

              {interactionType === "gateway" && <div className="rule-section">
                <div className="rule-section-title">Gateways</div>
                <MultiSelectDropdown
                  options={pois.map((p) => ({ id: p.id, label: p.name || p.id }))}
                  selected={targeting.gatewayIds || targeting.poiIds || []}
                  onChange={(next) =>
                    onUpdate(selectedRule.id, { targeting: { ...targeting, gatewayIds: next } })
                  }
                  emptyLabel="Any gateway"
                />
              </div>}

              {interactionType === "cluster" && <div className="rule-section">
                <div className="rule-section-title">Critical mass (min detected users)</div>
                <LooseNumInput
                  inputKey={`${selectedRule.id}-minUsers`}
                  committedValue={targeting.minUsers ?? 1}
                  drafts={numDrafts}
                  setDrafts={setNumDrafts}
                  className="rule-cooldown"
                  min={1}
                  max={99999}
                  emptyCommit={1}
                  onCommit={(n) =>
                    onUpdate(selectedRule.id, {
                      targeting: { ...targeting, minUsers: Math.max(1, Math.round(n)) },
                    })
                  }
                />
                <div className="rules-hint" style={{ marginTop: 4 }}>
                  Cluster fires only once this many wristbands are detected in the same zone.
                </div>
              </div>}

              {(interactionType === "gateway" || interactionType === "cluster") && <div className="rule-section">
                <div className="rule-section-title">
                  {interactionType === "cluster" ? "Clusters / Zones" : "Clusters / Zones (optional)"}
                </div>
                <MultiSelectDropdown
                  options={layers
                    .filter((l) => l.active !== false)
                    .map((l) => ({ id: l.id, label: l.name || l.id }))}
                  selected={targeting.accessLayers || []}
                  onChange={(next) =>
                    onUpdate(selectedRule.id, { targeting: { ...targeting, accessLayers: next } })
                  }
                  emptyLabel={interactionType === "cluster" ? "Any active zone" : "Any zone"}
                />
              </div>}

              {(interactionType === "gateway" || interactionType === "cluster") ? (
                <div className="rule-section">
                  <div className="rule-section-title">Conversion goal (optional)</div>
                  <p className="rules-hint" style={{ marginBottom: 8 }}>
                    Gateway(s) you count as success after this interaction fires (for example the pavilion
                    after a street ping). Monitor rehearsal estimates attributed arrivals there within{" "}
                    {Math.round(CONVERSION_ATTRIBUTION_WINDOW_SIM_MS / 60000)} minutes of simulated time after a
                    trigger; omit this to leave conversion unknown.
                  </p>
                  <MultiSelectDropdown
                    options={pois.map((p) => ({ id: p.id, label: p.name || p.id }))}
                    selected={Array.isArray(targeting.conversionPoiIds) ? targeting.conversionPoiIds : []}
                    onChange={(next) =>
                      onUpdate(selectedRule.id, { targeting: { ...targeting, conversionPoiIds: next } })
                    }
                    emptyLabel="No conversion target"
                  />
                </div>
              ) : null}

              <div className="rule-section">
                <div className="rule-section-title">Cooldown (minutes)</div>
                <LooseNumInput
                  inputKey={`${selectedRule.id}-cooldown`}
                  committedValue={targeting.cooldown ?? 0}
                  drafts={numDrafts}
                  setDrafts={setNumDrafts}
                  className="rule-cooldown"
                  min={0}
                  max={1440}
                  emptyCommit={0}
                  onCommit={(n) =>
                    onUpdate(selectedRule.id, {
                      targeting: { ...targeting, cooldown: Math.max(0, Math.round(n)) },
                    })
                  }
                />
              </div>

              <div className="rule-section">
                <div className="rule-section-title">Time window (optional)</div>
                {(selectedRule.conditions || []).map((c) =>
                  c.type === "time_window" ? (
                    <div key={c.id} className="time-row">
                      <input
                        type="text"
                        placeholder="09:00"
                        value={c.from || ""}
                        onChange={(e) =>
                          onUpdate(selectedRule.id, {
                            conditions: (selectedRule.conditions || []).map((x) =>
                              x.id === c.id ? { ...x, from: e.target.value } : x
                            ),
                          })
                        }
                      />
                      <span>–</span>
                      <input
                        type="text"
                        placeholder="18:00"
                        value={c.to || ""}
                        onChange={(e) =>
                          onUpdate(selectedRule.id, {
                            conditions: (selectedRule.conditions || []).map((x) =>
                              x.id === c.id ? { ...x, to: e.target.value } : x
                            ),
                          })
                        }
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          onUpdate(selectedRule.id, {
                            conditions: (selectedRule.conditions || []).filter((x) => x.id !== c.id),
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ) : null
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    onUpdate(selectedRule.id, {
                      conditions: [
                        ...(selectedRule.conditions || []),
                        { id: `c_${Math.random().toString(36).slice(2, 8)}`, type: "time_window", from: "", to: "" },
                      ],
                    })
                  }
                >
                  + Time window
                </button>
              </div>

              <div className="rule-section">
                <div className="rule-section-title">Action</div>
                <select
                  className="rule-select"
                  value={action.type || "message_and_led"}
                  onChange={(e) => {
                    const t = e.target.value;
                    const next = { ...action, type: t };
                    if (t === "message_and_led" || t === "led_pulse") {
                      next.led = { ...defaultLedPayload(), ...(action.led || {}) };
                    }
                    if (t === "api_hook") {
                      next.api = {
                        provider: "",
                        operation: "",
                        payload: {},
                        notes: "",
                        ...(action.api || {}),
                      };
                    }
                    onUpdate(selectedRule.id, { action: next });
                  }}
                >
                  {ACTION_TYPES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>

                {(action.type === "message" || action.type === "message_and_led") && (
                  <>
                    <label>
                      Title
                      <input
                        type="text"
                        value={action.title || ""}
                        onChange={(e) => onUpdate(selectedRule.id, { action: { ...action, title: e.target.value } })}
                      />
                    </label>
                    <label>
                      Body
                      <textarea
                        rows={2}
                        value={action.body || ""}
                        onChange={(e) => onUpdate(selectedRule.id, { action: { ...action, body: e.target.value } })}
                      />
                    </label>
                  </>
                )}

                {(action.type === "message_and_led" || action.type === "led_pulse") && (
                  <div className="led-grid">
                    <label>
                      Send to
                      <select
                        value={led.scope ?? "band"}
                        onChange={(e) =>
                          onUpdate(selectedRule.id, {
                            action: { ...action, led: { ...led, scope: e.target.value } },
                          })
                        }
                      >
                        {LED_SCOPES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Mode
                      <select
                        value={led.mode ?? 2}
                        onChange={(e) =>
                          onUpdate(selectedRule.id, {
                            action: { ...action, led: { ...led, mode: parseInt(e.target.value, 10) } },
                          })
                        }
                      >
                        {LED_MODES.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Rate
                      <LooseNumInput
                        inputKey={`${selectedRule.id}-led-rate`}
                        committedValue={led.rate ?? 120}
                        drafts={numDrafts}
                        setDrafts={setNumDrafts}
                        min={1}
                        max={255}
                        emptyCommit={120}
                        onCommit={(n) =>
                          onUpdate(selectedRule.id, {
                            action: {
                              ...action,
                              led: { ...led, rate: Math.round(n) },
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Duration (ms)
                      <LooseNumInput
                        inputKey={`${selectedRule.id}-led-dur`}
                        committedValue={led.durationMs ?? 2800}
                        drafts={numDrafts}
                        setDrafts={setNumDrafts}
                        min={100}
                        max={30000}
                        emptyCommit={2800}
                        onCommit={(n) =>
                          onUpdate(selectedRule.id, {
                            action: {
                              ...action,
                              led: { ...led, durationMs: Math.round(n) },
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      R
                      <LooseNumInput
                        inputKey={`${selectedRule.id}-led-r`}
                        committedValue={led.r ?? 255}
                        drafts={numDrafts}
                        setDrafts={setNumDrafts}
                        min={0}
                        max={255}
                        emptyCommit={255}
                        onCommit={(n) =>
                          onUpdate(selectedRule.id, {
                            action: { ...action, led: { ...led, r: Math.round(n) } },
                          })
                        }
                      />
                    </label>
                    <label>
                      G
                      <LooseNumInput
                        inputKey={`${selectedRule.id}-led-g`}
                        committedValue={led.g ?? 180}
                        drafts={numDrafts}
                        setDrafts={setNumDrafts}
                        min={0}
                        max={255}
                        emptyCommit={180}
                        onCommit={(n) =>
                          onUpdate(selectedRule.id, {
                            action: { ...action, led: { ...led, g: Math.round(n) } },
                          })
                        }
                      />
                    </label>
                    <label>
                      B
                      <LooseNumInput
                        inputKey={`${selectedRule.id}-led-b`}
                        committedValue={led.b ?? 40}
                        drafts={numDrafts}
                        setDrafts={setNumDrafts}
                        min={0}
                        max={255}
                        emptyCommit={40}
                        onCommit={(n) =>
                          onUpdate(selectedRule.id, {
                            action: { ...action, led: { ...led, b: Math.round(n) } },
                          })
                        }
                      />
                    </label>
                  </div>
                )}

                {action.type === "api_hook" && (
                  <div className="api-placeholder">
                    <p>
                      <strong>Not executed here.</strong> Use this to document the integration you want — e.g. send a
                      message through a social API when the rule runs. A future <strong>configuration page</strong> will
                      let you define incoming payload fields, transforms, and the outbound request to your service.
                    </p>
                    <label>
                      Service / platform
                      <input
                        type="text"
                        placeholder="e.g. X (Twitter), Instagram, Slack, custom HTTPS…"
                        value={action.api?.provider || ""}
                        onChange={(e) =>
                          onUpdate(selectedRule.id, {
                            action: { ...action, api: { ...(action.api || {}), provider: e.target.value } },
                          })
                        }
                      />
                    </label>
                    <label>
                      Operation / intent
                      <input
                        type="text"
                        placeholder="e.g. post_status, send_dm, notify_channel"
                        value={action.api?.operation || ""}
                        onChange={(e) =>
                          onUpdate(selectedRule.id, {
                            action: { ...action, api: { ...(action.api || {}), operation: e.target.value } },
                          })
                        }
                      />
                    </label>
                    <label>
                      Notes (for your team)
                      <textarea
                        rows={3}
                        placeholder="What should happen, which credentials or env, sample payload…"
                        value={action.api?.notes || ""}
                        onChange={(e) =>
                          onUpdate(selectedRule.id, {
                            action: { ...action, api: { ...(action.api || {}), notes: e.target.value } },
                          })
                        }
                      />
                    </label>
                    <button type="button" className="btn btn-sm rule-external-config-btn" disabled title="Prototype next">
                      Open API mapping & request builder…
                    </button>
                  </div>
                )}
              </div>

              <button type="button" className="btn btn-danger" onClick={() => onDelete(selectedRule.id)}>
                Delete rule
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
