import React, { useEffect, useState } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";

/*
 * "Open Aura Server": checks whether Aura Server is running on THIS computer
 * and opens its console if so. If not, explains how to start it.
 *
 * A web page cannot start a program, so this can only detect and guide. The
 * probe is a no-cors request to http://localhost:3000/health; any answer
 * means the server is there. Some browsers refuse a secure page any contact
 * with localhost, in which case the probe fails even though the server is
 * up. That's why "Open it anyway" is always offered.
 */
const CONSOLE = "http://localhost:3000";

async function probe() {
  try {
    await fetch(`${CONSOLE}/health`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}

export default function OpenServer() {
  const [state, setState] = useState("checking"); // checking | up | down

  const check = async () => {
    setState("checking");
    if (await probe()) {
      setState("up");
      window.location.href = CONSOLE;
    } else {
      setState("down");
    }
  };

  useEffect(() => { check(); }, []);

  return (
    <Layout title="Open Aura Server">
      <main className="container margin-vert--xl" style={{ maxWidth: 720 }}>
        {state === "checking" && (<><h1>Looking for Aura Server…</h1><p>Checking this computer on port 3000.</p></>)}

        {state === "up" && (<><h1>Opening Aura Server…</h1><p>If nothing happens, <a href={CONSOLE}>open the console</a>.</p></>)}

        {state === "down" && (
          <>
            <h1>Aura Server isn't running on this computer</h1>
            <p>
              The console lives on the computer that runs Aura Server. Start it there, then try again.
            </p>

            <h2>Start it now</h2>
            <p>In a terminal, in the <code>aura-server</code> folder:</p>
            <pre><code>npm start</code></pre>

            <h2>Or have it start by itself</h2>
            <p>
              Run this once. Aura Server then starts whenever you log in to this computer, and restarts if it
              stops. Works on macOS, Windows and Linux.
            </p>
            <pre><code>npm run service:install</code></pre>
            <p>
              First time here? Follow the <Link to="/getting-started/demo-kit">demo kit quick start</Link>.
            </p>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 28 }}>
              <button className="button button--primary" onClick={check}>Check again</button>
              <a className="button button--secondary" href={CONSOLE}>Open it anyway</a>
            </div>
            <p style={{ marginTop: 16, opacity: 0.6, fontSize: ".85rem" }}>
              Some browsers (Safari in particular) don't let a web page check for programs on your computer. If
              you know the server is running, "Open it anyway" will work.
            </p>
            <p style={{ opacity: 0.6, fontSize: ".85rem" }}>
              On a different computer from the server? Use <code>http://&lt;server-ip&gt;:3000</code> instead.
            </p>
          </>
        )}
      </main>
    </Layout>
  );
}
