import { useState, useCallback } from "react";
import { supabase, supabaseConfigured } from "../lib/supabaseClient";
import "./DemoOverlay.css";

// Shared-code gate + intro for the YC / public demo. Activated by ?demo in the URL
// (or VITE_DEMO_MODE=1). On the correct code it optionally signs in a shared demo
// Supabase account so the studio loads behind the intro, then reveals the app.
const DEMO_CODE = import.meta.env.VITE_DEMO_CODE || "coachella";
const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL || "";
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || "";
const SS_KEY = "af_demo_entered";

export default function DemoOverlay() {
  const [phase, setPhase] = useState(() =>
    typeof window !== "undefined" && window.sessionStorage.getItem(SS_KEY) === "1" ? "done" : "gate"
  );
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const enter = useCallback(async () => {
    if (code.trim().toLowerCase() !== DEMO_CODE.toLowerCase()) {
      setErr("Incorrect code.");
      return;
    }
    setErr("");
    setBusy(true);
    // Auto sign-in a shared demo account so the studio is live behind the intro.
    if (supabaseConfigured && supabase && DEMO_EMAIL && DEMO_PASSWORD) {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data?.session) {
          const { error } = await supabase.auth.signInWithPassword({
            email: DEMO_EMAIL,
            password: DEMO_PASSWORD,
          });
          if (error) {
            setErr("Demo sign-in failed: " + error.message);
            setBusy(false);
            return;
          }
        }
      } catch (e) {
        setErr("Demo sign-in error.");
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    setPhase("intro");
  }, [code]);

  const finish = useCallback(() => {
    try {
      window.sessionStorage.setItem(SS_KEY, "1");
    } catch {
      /* ignore */
    }
    setPhase("done");
  }, []);

  if (phase === "done") return null;

  return (
    <div className="afd-root" role="dialog" aria-modal="true">
      {phase === "gate" && (
        <div className="afd-card afd-gate">
          <img className="afd-logo" src="/aura-logo.svg" alt="" />
          <div className="afd-kicker">Aetherfield · private demo</div>
          <h2>Enter access code</h2>
          <input
            autoFocus
            type="password"
            placeholder="Access code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") enter();
            }}
          />
          {err ? <div className="afd-err">{err}</div> : null}
          <button className="afd-btn afd-btn-primary" disabled={busy} onClick={enter}>
            {busy ? "…" : "Enter"}
          </button>
        </div>
      )}

      {phase === "intro" && (
        <div className="afd-card afd-intro">
          <div className="afd-pill">
            <span className="afd-dot" /> Live demo
          </div>
          <h2>It’s real. The crowd is simulated.</h2>
          <p>
            This is the <b>actual Aetherfield activation software</b> — the same tool that runs live
            events. For this demo it’s driven by <b>simulated fan data</b>: a looping 12-hour
            Coachella cycle.
          </p>
          <p className="afd-muted">
            Everything you see — the live heatmap, the concierge, the messaging — is genuinely
            running. On a real site it’s driven by our wearables instead of the simulator.
          </p>
          <div className="afd-actions">
            <button className="afd-btn" onClick={() => setPhase("aura")}>
              Learn about AURA →
            </button>
            <button className="afd-btn afd-btn-primary" onClick={finish}>
              Enter the activation →
            </button>
          </div>
        </div>
      )}

      {phase === "aura" && (
        <div className="afd-card afd-aura">
          <div className="afd-kicker">The physical intelligence layer</div>
          <h2>AURA — the wearable that makes venues sentient</h2>
          <div className="afd-aura-grid">
            <div className="afd-aura-item">
              <div className="afd-aura-h">Aura One wristband</div>
              <p>
                A low-power wearable each guest wears. It broadcasts presence and gestures over a
                custom 2.4GHz radio — no phones, no apps, no friction.
              </p>
            </div>
            <div className="afd-aura-item">
              <div className="afd-aura-h">Gateways</div>
              <p>
                Nodes across the site pick up every band by signal strength, building a live spatial
                map of the whole crowd in real time.
              </p>
            </div>
            <div className="afd-aura-item">
              <div className="afd-aura-h">Cloud + Aurea</div>
              <p>
                Presence flows to the cloud, where Aurea — the AI concierge — turns it into
                personalised messages, light cues, and operator intelligence.
              </p>
            </div>
            <div className="afd-aura-item">
              <div className="afd-aura-h">Two-way light</div>
              <p>
                The same link drives the LEDs on every band — synchronised shows, wayfinding, and
                moments, controlled from the cloud or live DMX.
              </p>
            </div>
          </div>
          <p className="afd-muted">
            In this demo the wearables are simulated in software — but the pipeline, the concierge,
            and the control are the real thing.
          </p>
          <div className="afd-actions">
            <button className="afd-btn" onClick={() => setPhase("intro")}>
              ← Back
            </button>
            <button className="afd-btn afd-btn-primary" onClick={finish}>
              Enter the activation →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
