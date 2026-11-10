import { useEffect, useMemo, useState } from "react";
import ActivationSimScenarioControls from "./components/ActivationSimScenarioControls.jsx";
import {
  SIM_SCENARIO_POPUP_SOURCES,
  scenarioBroadcastChannelId,
} from "./lib/simScenarioBroadcast.js";
import "./App.css";
import "./components/ActivationSimDashboard.css";
import "./SimScenarioPopoutShell.css";

export default function SimScenarioPopoutShell() {
  const channelToken = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("channel") || "";
    } catch {
      return "";
    }
  }, []);

  const bcName = scenarioBroadcastChannelId(channelToken);
  const [bc, setBc] = useState(/** @type {BroadcastChannel | null} */ (null));
  const [scenarioState, setScenarioState] = useState(null);

  useEffect(() => {
    if (!bcName) return undefined;
    const ch = new BroadcastChannel(bcName);
    setBc(ch);
    return () => {
      ch.close();
      setBc(null);
    };
  }, [bcName]);

  useEffect(() => {
    if (!bc) return undefined;
    const onMsg = (e) => {
      if (e.data?.source !== SIM_SCENARIO_POPUP_SOURCES.parent) return;
      if (e.data?.type === "scenarioState") setScenarioState(e.data.state);
    };
    bc.addEventListener("message", onMsg);
    bc.postMessage({ source: SIM_SCENARIO_POPUP_SOURCES.scenario, type: "HELLO" });
    return () => bc.removeEventListener("message", onMsg);
  }, [bc]);

  if (!bcName) {
    return (
      <div className="mas-sim-scenario-popout mas-sim-scenario-popout--error" role="alert">
        <p>Missing scenario link. Open Scenario from the Activation monitor window.</p>
      </div>
    );
  }

  return (
    <div className="mas-sim-scenario-popout">
      <header className="mas-sim-scenario-popout-head">
        <h2>Scenario · rehearsal</h2>
        <p className="mas-sim-scenario-popout-lead">
          Crowd level, time compression, pacing, and playback. The monitor window shows live-style readouts.
        </p>
      </header>
      <main className="mas-sim-scenario-popout-main">
        <ActivationSimScenarioControls
          broadcastChannel={bc}
          state={scenarioState}
          connected={scenarioState != null}
        />
      </main>
      <footer className="mas-sim-scenario-popout-foot">
        <button type="button" className="btn mas-sim-dash-close" onClick={() => window.close()}>
          Close window
        </button>
      </footer>
    </div>
  );
}
