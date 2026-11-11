"use client";

/**
 * Printable QR sheet for Aura Tags.
 * Enter Tag ids (comma/space/newline separated) → grid of QR codes, each
 * pointing at /register?d=<id> on this deployment. Print, cut, stick one on
 * each Tag. The id under each code is the Tag's radio address, which is what
 * the Demo Server's console shows — no lookup table to keep in sync.
 *
 * (The Demo Server ships the same generator offline: server/tools/make-qr.js.)
 */

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

function QRTile({ url, uuid }: { url: string; uuid: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) {
      QRCode.toCanvas(ref.current, url, { width: 220, margin: 2 }).catch(console.error);
    }
  }, [url]);
  return (
    <div className="qr-tile">
      <canvas ref={ref} />
      <div className="qr-label">{uuid}</div>
    </div>
  );
}

export default function QRPage() {
  const [input, setInput] = useState("A1B2, C3D4");
  const [base, setBase] = useState("");

  useEffect(() => {
    // Works wherever this app is mounted: origin + basePath, derived from the
    // page's own URL rather than configured twice.
    const appRoot =
      window.location.origin + window.location.pathname.replace(/\/qr\/?$/, "");
    setBase(process.env.NEXT_PUBLIC_BASE_URL || appRoot);
  }, []);

  const uuids = Array.from(
    new Set(
      input
        .split(/[\s,;]+/)
        .map((s) => s.trim().replace(/^0x/i, "").toUpperCase())
        .filter((s) => /^[0-9A-F]{1,4}$/.test(s))
        .map((s) => s.padStart(4, "0"))
    )
  );

  return (
    <main className="card" style={{ maxWidth: "48rem" }}>
      <style>{`
        .qr-grid { display: flex; flex-wrap: wrap; gap: 1.5rem; justify-content: center; margin-top: 2rem; }
        .qr-tile { background: #fff; border-radius: 10px; padding: 0.75rem; text-align: center; }
        .qr-label { color: #111; font-family: monospace; font-weight: 700; font-size: 1.1rem; margin-top: 0.25rem; }
        textarea { width: 100%; min-height: 4rem; padding: 0.7rem 0.8rem; border-radius: 5px;
          border: 1px solid var(--gold-border); background: var(--input-bg); color: var(--gold); font-family: monospace; }
        @media print {
          h1, .lede, textarea, .no-print { display: none !important; }
          body { background: #fff !important; }
          .qr-grid { gap: 2.5rem; }
        }
      `}</style>
      <h1>Aura Tag QR codes</h1>
      <p className="disclaimer" style={{ maxWidth: "100%", marginBottom: "1rem" }}>
        Enter Tag ids (the 4-hex ids shown in the Demo Server console). Each QR
        opens <code>{base}/register?d=&lt;id&gt;</code>. Print this page and
        stick one on each Tag.
      </p>
      <textarea value={input} onChange={(e) => setInput(e.target.value)} className="no-print" />
      <div className="qr-grid">
        {uuids.map((u) => (
          <QRTile key={u} uuid={u} url={`${base}/register?d=${u}`} />
        ))}
      </div>
    </main>
  );
}
