/**
 * PairDevice.jsx
 * Route: /pair?kind=gateway&...
 *
 * Bidirectional pairing — scan either QR first:
 *   • In-app placeholder QR  → ?kind&virtualId&projectId   (have a PLACEMENT, need a DEVICE)
 *   • Physical device QR     → ?kind&device=<hardware_id>   (have a DEVICE, need a PLACEMENT)
 *   • Both present           → bind immediately
 *
 * To bind we need a hardware_id + (project_id + virtual_id). Whichever half the
 * URL supplies, we collect the other half here, then write device_bindings.
 */

import { useEffect, useRef, useState } from "react";
import { supabase, supabaseConfigured } from "./lib/supabaseClient";
import { normalizeProjectState } from "./lib/activationPages";
import "./PairDevice.css";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Extract hardware_id from a physical device QR URL or raw string. */
function extractHardwareId(raw) {
  try {
    const url = new URL(raw.trim());
    const d = url.searchParams.get("device");
    if (d) return d.trim();
  } catch {
    /* not a URL — treat as raw hardware_id */
  }
  return raw.trim() || null;
}

function useQrParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    kind:      params.get("kind")      || "gateway",
    virtualId: params.get("virtualId") || "",
    projectId: params.get("projectId") || "",
    device:    (params.get("device")   || "").trim(),
  };
}

/** Placements of a given kind live in venue.gateways (gateway) or venue.pois (node). */
function placementsForKind(state, kind) {
  const { pages } = normalizeProjectState(state || {});
  const out = [];
  for (const page of pages) {
    const venue = page.venue || {};
    const list = kind === "node" ? venue.pois : venue.gateways;
    for (const item of list || []) {
      if (!item || !item.id) continue;
      out.push({
        virtualId: item.id,
        label: (item.name && item.name.trim()) || item.id,
        pageTitle: page.title,
      });
    }
  }
  return out;
}

// ─── component ──────────────────────────────────────────────────────────────

export default function PairDevice() {
  const { kind, virtualId, projectId, device } = useQrParams();

  const havesPlacement = Boolean(virtualId && projectId);
  const havesDevice = Boolean(device);

  // mode: deeplink | virtual | physical | invalid
  const mode = havesPlacement && havesDevice
    ? "deeplink"
    : havesPlacement
      ? "virtual"
      : havesDevice
        ? "physical"
        : "invalid";

  const [step, setStep] = useState("init"); // init|confirm|scan|pickProject|pickPlacement|needAuth|binding|done|error
  const [hardwareId, setHardwareId] = useState(device || "");
  const [manualInput, setManualInput] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [scanSupported, setScanSupported] = useState(false);

  // physical-first state
  const [session, setSession] = useState(null);
  const [projects, setProjects] = useState([]);
  const [chosenProject, setChosenProject] = useState(null); // { id, name, state }
  const [placements, setPlacements] = useState([]);
  const [boundVirtualIds, setBoundVirtualIds] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    setScanSupported(typeof window !== "undefined" && "BarcodeDetector" in window);
  }, []);

  // Track auth session (needed for physical-first to list the user's projects).
  useEffect(() => {
    if (!supabaseConfigured || !supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_e, s) => setSession(s ?? null)
    );
    return () => subscription.unsubscribe();
  }, []);

  // Initial routing once we know the mode (and, for physical-first, the session).
  useEffect(() => {
    if (step !== "init") return;
    if (mode === "invalid") { setStep("error"); setErrorMsg(""); return; }
    if (mode === "deeplink") { writeBinding(device, projectId, virtualId); return; }
    if (mode === "virtual") { setStep("confirm"); return; }
    if (mode === "physical") {
      if (session === null) return; // wait for session resolution
      if (!session) { setStep("needAuth"); return; }
      loadProjects();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, mode, session]);

  // ── physical-first: project + placement pickers ───────────────────────────

  async function loadProjects() {
    setLoading(true);
    setErrorMsg("");
    const { data, error } = await supabase
      .from("activation_projects")
      .select("id,name,state")
      .order("updated_at", { ascending: false });
    setLoading(false);
    if (error) { setErrorMsg(error.message); setStep("error"); return; }
    setProjects(data || []);
    setStep("pickProject");
  }

  async function chooseProject(project) {
    setChosenProject(project);
    setPlacements(placementsForKind(project.state, kind));
    // Mark placements already bound in this project (informational).
    const { data } = await supabase
      .from("device_bindings")
      .select("virtual_id")
      .eq("project_id", project.id);
    setBoundVirtualIds(new Set((data || []).map((r) => r.virtual_id)));
    setStep("pickPlacement");
  }

  // ── camera / scanning (virtual-first) ──────────────────────────────────────

  async function startCamera() {
    setStep("scan");
    setErrorMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      if (scanSupported) {
        detectorRef.current = new window.BarcodeDetector({ formats: ["qr_code"] });
        rafRef.current = requestAnimationFrame(scanFrame);
      }
    } catch {
      setErrorMsg("Camera access denied. Use manual entry below.");
    }
  }

  function scanFrame() {
    if (!videoRef.current || !detectorRef.current) return;
    detectorRef.current.detect(videoRef.current)
      .then((results) => {
        if (results.length > 0) { stopCamera(); handleScannedValue(results[0].rawValue); }
        else { rafRef.current = requestAnimationFrame(scanFrame); }
      })
      .catch(() => { rafRef.current = requestAnimationFrame(scanFrame); });
  }

  function stopCamera() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
  }

  useEffect(() => () => stopCamera(), []);

  function handleScannedValue(raw) {
    const hid = extractHardwareId(raw);
    if (!hid) { setErrorMsg("Couldn't read a device ID from that QR. Try manual entry."); return; }
    setHardwareId(hid);
    writeBinding(hid, projectId, virtualId);
  }

  function handleManualSubmit(e) {
    e.preventDefault();
    stopCamera();
    handleScannedValue(manualInput);
  }

  // ── binding (shared) ───────────────────────────────────────────────────────

  async function writeBinding(hid, pid, vid) {
    setStep("binding");
    setErrorMsg("");
    if (!supabaseConfigured || !supabase) { setErrorMsg("Supabase not configured."); setStep("error"); return; }
    if (!hid || !pid || !vid) { setErrorMsg("Missing device, project, or placement."); setStep("error"); return; }
    try {
      const { error: devErr } = await supabase
        .from("physical_devices")
        .upsert({ hardware_id: hid, kind, label: hid }, { onConflict: "hardware_id" });
      if (devErr) throw devErr;

      const { error: bindErr } = await supabase
        .from("device_bindings")
        .upsert(
          { hardware_id: hid, kind, project_id: pid, virtual_id: vid },
          { onConflict: "hardware_id" }
        );
      if (bindErr) throw bindErr;

      setHardwareId(hid);
      setStep("done");
    } catch (err) {
      setErrorMsg(err.message || "Failed to save binding.");
      setStep("error");
    }
  }

  function resetToStart() {
    setErrorMsg("");
    setChosenProject(null);
    if (mode === "virtual") setStep("confirm");
    else if (mode === "physical") (session ? loadProjects() : setStep("needAuth"));
    else setStep("error");
  }

  // ── render ───────────────────────────────────────────────────────────────

  const stepLabels = mode === "physical"
    ? [`Physical ${kind}`, "Placement", "Linked"]
    : [`Virtual ${kind}`, "Physical device", "Linked"];

  // step 1 done once we've moved past the first collection step
  const firstDone = !["init", "confirm", "scan", "pickProject"].includes(step);
  const secondActive = ["scan", "pickPlacement", "binding"].includes(step);

  if (mode === "invalid") {
    return (
      <div className="pair-shell">
        <div className="pair-card pair-card--error">
          <div className="pair-icon">⚠️</div>
          <h1>Invalid pairing link</h1>
          <p>Scan either the QR on the device or the placeholder QR inside the Activation Studio to begin.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pair-shell">
      <div className="pair-card">
        <div className="pair-logo">AETHERFIELD</div>

        <div className="pair-steps">
          <div className={`pair-step ${firstDone ? "pair-step--done" : "pair-step--active"}`}>
            <span className="pair-step-num">{firstDone ? "✓" : "1"}</span>
            <span>{stepLabels[0]}</span>
          </div>
          <div className="pair-step-line" />
          <div className={`pair-step ${step === "done" ? "pair-step--done" : secondActive ? "pair-step--active" : ""}`}>
            <span className="pair-step-num">{step === "done" ? "✓" : "2"}</span>
            <span>{stepLabels[1]}</span>
          </div>
          <div className="pair-step-line" />
          <div className={`pair-step ${step === "done" ? "pair-step--done" : ""}`}>
            <span className="pair-step-num">{step === "done" ? "✓" : "3"}</span>
            <span>{stepLabels[2]}</span>
          </div>
        </div>

        {/* ── virtual-first: confirm placement, then capture device ── */}
        {step === "confirm" && (
          <div className="pair-body">
            <h1>Pair {kind}</h1>
            <p>You're linking a physical <strong>{kind}</strong> to your event layout.</p>
            <div className="pair-meta">
              <div><span>Kind</span><code>{kind}</code></div>
              <div><span>Virtual ID</span><code>{virtualId}</code></div>
              <div><span>Project</span><code>{projectId}</code></div>
            </div>
            <button className="pair-btn pair-btn--primary" onClick={startCamera}>
              {scanSupported ? "Scan device QR" : "Enter device ID"}
            </button>
          </div>
        )}

        {step === "scan" && (
          <div className="pair-body">
            <h1>Scan the device QR</h1>
            <p>Point your camera at the QR code on the physical {kind}.</p>
            <div className="pair-viewfinder">
              <video ref={videoRef} className="pair-video" playsInline muted />
              <div className="pair-viewfinder-corners" />
            </div>
            {!scanSupported && (
              <p className="pair-hint">Camera scanning not supported in this browser. Use manual entry below.</p>
            )}
            {errorMsg && <p className="pair-error">{errorMsg}</p>}
            <form className="pair-manual" onSubmit={handleManualSubmit}>
              <input
                type="text"
                placeholder="Or paste hardware ID / URL manually"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
              />
              <button type="submit" className="pair-btn pair-btn--secondary" disabled={!manualInput.trim()}>
                Use this ID
              </button>
            </form>
          </div>
        )}

        {/* ── physical-first: needs sign-in to list projects ── */}
        {step === "needAuth" && (
          <div className="pair-body pair-body--center">
            <div className="pair-icon">🔒</div>
            <h1>Sign in to continue</h1>
            <p>
              This {kind} (<code>{device}</code>) needs to be placed in one of your events.
              Sign in to the Activation Studio in this browser, then reopen this link.
            </p>
            <a className="pair-btn pair-btn--primary" href="/">Open Activation Studio</a>
          </div>
        )}

        {step === "pickProject" && (
          <div className="pair-body">
            <h1>Choose an event</h1>
            <p>Which event should this {kind} (<code>{device}</code>) belong to?</p>
            {loading && <p>Loading events…</p>}
            {!loading && projects.length === 0 && <p className="pair-hint">No events found for your account.</p>}
            <div className="pair-list">
              {projects.map((p) => (
                <button key={p.id} className="pair-list-item" onClick={() => chooseProject(p)}>
                  <span className="pair-list-title">{p.name}</span>
                  <span className="pair-list-sub">
                    {placementsForKind(p.state, kind).length} {kind} placement(s)
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "pickPlacement" && (
          <div className="pair-body">
            <h1>Choose a placement</h1>
            <p>Pick the {kind} spot in <strong>{chosenProject?.name}</strong> to link <code>{device}</code> to.</p>
            {placements.length === 0 && (
              <p className="pair-hint">
                No {kind} placements in this event yet. Add one on the map in the Activation Studio, then reopen this link.
              </p>
            )}
            <div className="pair-list">
              {placements.map((pl) => {
                const bound = boundVirtualIds.has(pl.virtualId);
                return (
                  <button
                    key={pl.virtualId}
                    className="pair-list-item"
                    onClick={() => writeBinding(device, chosenProject.id, pl.virtualId)}
                  >
                    <span className="pair-list-title">
                      {pl.label}{bound ? " · already linked" : ""}
                    </span>
                    <span className="pair-list-sub">{pl.pageTitle}</span>
                  </button>
                );
              })}
            </div>
            <button className="pair-btn pair-btn--secondary" onClick={() => setStep("pickProject")}>
              ← Back to events
            </button>
          </div>
        )}

        {step === "binding" && (
          <div className="pair-body pair-body--center">
            <div className="pair-spinner" />
            <p>Saving binding…</p>
          </div>
        )}

        {step === "done" && (
          <div className="pair-body pair-body--center">
            <div className="pair-success-icon">✓</div>
            <h1>Paired!</h1>
            <p>
              <code>{hardwareId}</code> is now linked to this {kind} in your event layout.
              The Activation Studio will update automatically.
            </p>
          </div>
        )}

        {step === "error" && (
          <div className="pair-body pair-body--center">
            <div className="pair-icon">⚠️</div>
            <h1>{errorMsg ? "Pairing failed" : "Invalid pairing link"}</h1>
            <p>{errorMsg || "Scan either the device QR or the placeholder QR inside the Activation Studio to begin."}</p>
            {errorMsg && (
              <button className="pair-btn pair-btn--primary" onClick={resetToStart}>Try again</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
