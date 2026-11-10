#!/usr/bin/env node
/**
 * make-qr.js — printable registration QR codes, one per device.
 *
 * A Pixel's identity is its 16-bit radio address. That is what the gateway
 * reports, what the roster keys on, and what aura-registration stores as
 * device_id (see lib/cloud.js). So the QR is simply:
 *
 *     <registration app>/register?d=<ADDR>
 *
 * Scan it, fill in a name and number, and the local console can text that
 * device's owner. No provisioning step, no label database, nothing to keep in
 * sync — the sticker just says what the device already calls itself.
 *
 * The sheet is SELF-CONTAINED: every QR is inline SVG, so it prints from a
 * laptop with no internet, which is the situation you will actually be in.
 *
 *   node tools/make-qr.js --base https://your-app.vercel.app
 *       ...reads the live fleet from the local server and makes one per device.
 *
 *   node tools/make-qr.js --base https://x.vercel.app --addr 4C51,1A2B,7E03
 *       ...explicit list, for devices that are not powered up right now.
 *
 * Options:
 *   --base <url>    registration app root        (default: $CLOUD_URL)
 *   --addr <list>   comma-separated addresses    (default: ask the server)
 *   --from <url>    local server                 (default: http://localhost:3000)
 *   --out  <file>   output path                  (default: qr-sheet.html)
 */

const fs = require("node:fs");
const path = require("node:path");

let QRCode;
try {
  QRCode = require("qrcode");
} catch {
  console.error("Missing dependency. Run:  npm install --save-dev qrcode");
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Same normalisation as lib/cloud.js — `0x4C51` and `4c51` are one device. */
function normalise(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const bare = /^0x/i.test(s) ? s.slice(2) : s;
  return bare ? bare.toUpperCase() : null;
}

async function addressesFromServer(from) {
  const res = await fetch(`${from.replace(/\/+$/, "")}/api/devices`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body.devices || []).map((d) => normalise(d.uuid)).filter(Boolean);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(cards, base) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Pixel registration codes</title>
<style>
  @page { margin: 12mm; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; color: #111; }
  h1 { font-size: 1.1rem; margin: 0 0 2px; }
  .sub { color: #666; font-size: .78rem; margin: 0 0 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; text-align: center; break-inside: avoid; }
  .card svg { width: 100%; height: auto; display: block; }
  .addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.15rem;
          font-weight: 600; letter-spacing: .06em; margin-top: 8px; }
  .url { color: #888; font-size: .6rem; word-break: break-all; margin-top: 3px; }
  @media print { .sub { display: none } .card { border-color: #bbb } }
</style></head>
<body>
  <h1>Aetherfield Pixel &mdash; registration</h1>
  <p class="sub">Scan to register a device. ${cards.length} code(s) &middot; ${esc(base)} &middot; generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}</p>
  <div class="grid">${cards.join("")}</div>
</body></html>
`;
}

async function main() {
  const base = (arg("base", process.env.CLOUD_URL || "") || "").replace(/\/+$/, "");
  if (!base) {
    console.error("No registration app URL. Pass --base https://your-app.vercel.app (or set CLOUD_URL).");
    process.exit(1);
  }

  const explicit = arg("addr", null);
  const from = arg("from", "http://localhost:3000");
  let addrs;

  if (explicit) {
    addrs = explicit.split(",").map(normalise).filter(Boolean);
  } else {
    try {
      addrs = await addressesFromServer(from);
    } catch (e) {
      console.error(`Could not read the fleet from ${from} (${e.message}).`);
      console.error("Start the server, or pass the addresses directly with --addr 4C51,1A2B");
      process.exit(1);
    }
  }

  addrs = [...new Set(addrs)].sort();
  if (!addrs.length) {
    console.error("No devices. The server is up but has heard nothing yet — check the gateway antenna.");
    process.exit(1);
  }

  const cards = [];
  for (const addr of addrs) {
    const url = `${base}/register?d=${addr}`;
    // Margin 0: the .card padding is the quiet zone, and a printed QR with
    // double margins is a QR that is too small to scan across a table.
    const svg = await QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
    cards.push(
      `<div class="card">${svg}<div class="addr">${esc(addr)}</div><div class="url">${esc(url)}</div></div>`
    );
  }

  const out = path.resolve(arg("out", "qr-sheet.html"));
  fs.writeFileSync(out, page(cards, base));
  console.log(`${addrs.length} code(s) -> ${out}`);
  console.log(`  ${addrs.join("  ")}`);
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
