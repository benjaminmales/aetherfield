import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import SimScenarioPopoutShell from "./SimScenarioPopoutShell.jsx";
import PairDevice from "./PairDevice.jsx";
import ConsoleView from "./components/ConsoleView.jsx";
import DemoOverlay from "./components/DemoOverlay.jsx";

/*
 * Consolidated entry point.
 *
 * Merged 2026-08-17 from two divergent Activation Studio forks:
 *   - CLOUD/EventBuilder      -> /pair (PairDevice), live telemetry
 *   - Aetherfield-coachella-sim -> ?view=console (ConsoleView), ?demo (DemoOverlay)
 *
 * See docs/CONSOLIDATION.md. The other two copies
 * (aetherfield-cloud-demo/marketing-activation-studio and
 * AURA-ONE-DEMO-2026/apps/activation-studio) were strict subsets and are retired.
 *
 * Routes:
 *   /pair                  device pairing flow
 *   ?view=console          operator console (full-screen, presentation)
 *   ?insights=sim-scenario  scenario simulation pop-out
 *   (default)              the studio, plus DemoOverlay when ?demo or VITE_DEMO_MODE=1
 */

const hasWindow = typeof window !== "undefined";
const path = hasWindow ? window.location.pathname : "";
const params = hasWindow
  ? new URLSearchParams(window.location.search)
  : new URLSearchParams();

const insight = params.get("insights");
const view = params.get("view");
const demoMode = params.has("demo") || import.meta.env.VITE_DEMO_MODE === "1";

function Root() {
  if (path === "/pair") return <PairDevice />;
  if (view === "console") return <ConsoleView />;
  if (insight === "sim-scenario") return <SimScenarioPopoutShell />;
  return (
    <>
      <App />
      {demoMode ? <DemoOverlay /> : null}
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
