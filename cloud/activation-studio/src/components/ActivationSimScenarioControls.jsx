import {
  FOOTFALL_PRESETS,
  REGISTERED_AUDIENCE_PRESETS,
  SIM_EVENT_PRESETS,
  SIM_WALL_PRESETS,
} from "../hooks/useActivationSim";
import { SIM_SCENARIO_POPUP_SOURCES } from "../lib/simScenarioBroadcast";
import "./ActivationSimDashboard.css";

function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * @param {{
 *   broadcastChannel: BroadcastChannel | null;
 *   state: {
 *     expectedFootfall: number;
 *     eventDurationMs: number;
 *     wallPlaybackMs: number;
 *     density: number;
 *     intensityScale: number;
 *     registeredAudiencePct: number;
 *     observedRegisteredAudiencePct: number | null;
 *     status: string;
 *     progress: number;
 *     simElapsedMs: number;
 *   } | null;
 *   connected: boolean;
 * }} props
 */
export default function ActivationSimScenarioControls({ broadcastChannel, state, connected }) {
  const post = (type, value) => {
    if (!broadcastChannel) return;
    broadcastChannel.postMessage({ source: SIM_SCENARIO_POPUP_SOURCES.scenario, type, value });
  };

  const controlsLocked = state?.status === "running";
  const disabled = !connected || !state;
  const inputsLocked = disabled || controlsLocked;

  return (
    <div className="mas-sim-scenario-controls">
      {!connected ? (
        <p className="mas-sim-scenario-controls-wait" role="status">
          Waiting for Activation monitor… Keep this window open after launching it from the studio.
        </p>
      ) : null}

      <section className="mas-sim-dash-card">
        <h3>Crowd & time model</h3>
        <p className="mas-sim-dash-hint">
          These inputs shape the synthetic run. The monitor window shows live-style metrics only.
        </p>

        <div className="mas-sim-dash-field">
          <span className="mas-sim-dash-label">Expected footfall (event total)</span>
          <div className="mas-sim-dash-footfall-row">
            <input
              type="number"
              className="mas-sim-dash-footfall-input"
              min={50}
              max={50000}
              step={50}
              value={state?.expectedFootfall ?? ""}
              disabled={inputsLocked}
              onChange={(e) => post("SET_EXPECTED_FOOTFALL", e.target.value)}
            />
            <span className="mas-sim-dash-footfall-readout">
              scale {state ? state.intensityScale.toFixed(2) : "—"}×
            </span>
          </div>
          <input
            type="range"
            className="mas-sim-dash-footfall-range"
            min={50}
            max={50000}
            step={50}
            value={state?.expectedFootfall ?? 400}
            disabled={inputsLocked}
            onChange={(e) => post("SET_EXPECTED_FOOTFALL", e.target.value)}
          />
          <div className="mas-sim-dash-presets mas-sim-dash-presets--tight">
            {FOOTFALL_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`btn btn-sm ${state?.expectedFootfall === p.value ? "btn-active" : ""}`}
                disabled={inputsLocked}
                onClick={() => post("SET_EXPECTED_FOOTFALL", p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mas-sim-dash-field">
          <span className="mas-sim-dash-label">Event span (compressed)</span>
          <div className="mas-sim-dash-presets">
            {SIM_EVENT_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`btn btn-sm ${state?.eventDurationMs === p.ms ? "btn-active" : ""}`}
                disabled={inputsLocked}
                onClick={() => post("SET_EVENT_DURATION_MS", p.ms)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mas-sim-dash-field">
          <span className="mas-sim-dash-label">Wall playback length</span>
          <div className="mas-sim-dash-presets">
            {SIM_WALL_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`btn btn-sm ${state?.wallPlaybackMs === p.ms ? "btn-active" : ""}`}
                disabled={inputsLocked}
                onClick={() => post("SET_WALL_PLAYBACK_MS", p.ms)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mas-sim-dash-field">
          <span className="mas-sim-dash-label">
            Intensity fine-tune · {state?.density?.toFixed(1) ?? "—"}×
          </span>
          <input
            type="range"
            min={0.4}
            max={2}
            step={0.1}
            value={state?.density ?? 1}
            disabled={inputsLocked}
            onChange={(e) => post("SET_DENSITY", parseFloat(e.target.value) || 1)}
          />
        </div>
        <div className="mas-sim-dash-field">
          <span className="mas-sim-dash-label">
            Registered / message-eligible audience · {state?.registeredAudiencePct ?? "—"}% scenario
            {state?.observedRegisteredAudiencePct != null
              ? ` · ${state.observedRegisteredAudiencePct.toFixed(1)}% observed (rehearsal)`
              : ""}
          </span>
          <p className="mas-sim-dash-hint">
            Programmable rules and messages apply only to registered profiles. All devices still carry a UUID for
            presence and dwell. Live deployments would stream this share from telemetry; rehearsal fixes the target %.
          </p>
          <input
            type="range"
            className="mas-sim-dash-footfall-range"
            min={0}
            max={100}
            step={1}
            value={state?.registeredAudiencePct ?? 72}
            disabled={inputsLocked}
            onChange={(e) => post("SET_REGISTERED_AUDIENCE_PCT", parseInt(e.target.value, 10))}
          />
          <div className="mas-sim-dash-presets mas-sim-dash-presets--tight">
            {REGISTERED_AUDIENCE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`btn btn-sm ${state?.registeredAudiencePct === p.value ? "btn-active" : ""}`}
                disabled={inputsLocked}
                onClick={() => post("SET_REGISTERED_AUDIENCE_PCT", p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mas-sim-dash-card mas-sim-dash-card--playback">
        <h3>Playback</h3>
        <p className="mas-sim-dash-hint mas-sim-dash-hint--mono">
          {state
            ? `${formatClock(state.eventDurationMs)} event → ${formatClock(state.wallPlaybackMs)} on screen · ${formatClock(state.simElapsedMs)} elapsed`
            : "—"}
        </p>
        <div className="mas-sim-dash-progress" aria-hidden>
          <div className="mas-sim-dash-progress-fill" style={{ width: `${(state?.progress ?? 0) * 100}%` }} />
        </div>
        <div className="mas-sim-dash-actions">
          {!state || state.status === "idle" || state.status === "finished" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled}
              onClick={() => post("START")}
            >
              {state?.status === "finished" ? "Run again" : "Start"}
            </button>
          ) : state.status === "paused" ? (
            <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => post("RESUME")}>
              Resume
            </button>
          ) : (
            <button type="button" className="btn" disabled={disabled} onClick={() => post("PAUSE")}>
              Pause
            </button>
          )}
          <button type="button" className="btn" disabled={disabled} onClick={() => post("RESET")}>
            Reset
          </button>
        </div>
      </section>
    </div>
  );
}
