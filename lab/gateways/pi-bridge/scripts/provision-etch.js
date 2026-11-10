#!/usr/bin/env node
/**
 * provision-etch.js
 *
 * Generates the per-unit laser-etch artwork for a gateway: a centre-logo QR
 * (encoding the gateway's short code) plus the short code as text, laid out for
 * the case. Outputs a normal SVG (dark ink on light) and an inverted SVG
 * (light ink on dark material). Vector only — exactly what a laser cutter wants.
 *
 * The QR uses error-correction level H so the centre Aura mark doesn't stop it
 * scanning, and a deliberately short payload so it stays a low-version (chunky)
 * code that etches and scans reliably at small sizes.
 *
 * Usage:
 *   node scripts/provision-etch.js                 # derive THIS Pi's code
 *   node scripts/provision-etch.js GWD98M0CDR      # explicit code
 *   node scripts/provision-etch.js --from-pi http://gateway.local:3000
 *   node scripts/provision-etch.js GWD98M0CDR --out ./etch --qr 28 --plate 44
 *
 * Payload options:
 *   default: the bare short code (smallest QR; resolve to hardware in the app)
 *   --url https://aef.example/p/   -> encodes <url><code> (opens on generic scan)
 *
 * Requires: qrcode  (npm i qrcode)
 */

"use strict";

const fs = require("fs");
const path = require("path");

let QRCode;
try {
  QRCode = require("qrcode");
} catch {
  console.error("Missing dependency 'qrcode'. Run:  npm install  (in pi-bridge)");
  process.exit(1);
}

// --- Aura mark: single-path logo, embedded so this tool has no file deps. ---
const LOGO_VIEWBOX = { w: 1275.6, h: 850.4 };
const LOGO_PATH =
  "M854.4,0c2.2,87.8,27.4,172.2,77.9,244.1,70.5,100.2,182.9,165.4,305.8," +
  "177.5,8.5.8,21.4,2.2,37.5,2.4v426.4c-57.4-2.3-113.6-6.4-169.9-17.6C753.7," +
  "763.2,478.3,465.7,433.6,111.7l-7.6-70.7v807H0V0h854.4Z";

const BRAND = "AETHERFIELD";
const MODEL = "GATEWAY";

// --- args ---
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const positional = argv.find((a) => !a.startsWith("--") && !/^https?:/.test(a) &&
  argv[argv.indexOf(a) - 1] !== "--out" &&
  argv[argv.indexOf(a) - 1] !== "--qr" &&
  argv[argv.indexOf(a) - 1] !== "--plate" &&
  argv[argv.indexOf(a) - 1] !== "--url" &&
  argv[argv.indexOf(a) - 1] !== "--from-pi");

const OUT_DIR = String(flag("--out", "."));
const QR_MM = parseFloat(flag("--qr", "28"));         // QR side length, mm
const PLATE_MM = parseFloat(flag("--plate", String(QR_MM + 16))); // plate width, mm
const URL_PREFIX = flag("--url", "");                 // optional URL wrapper
const FROM_PI = flag("--from-pi", "");
const KNOCK = 0.2;                                     // logo box = 20% of QR (safe at ECC H)
const QUIET = 4;                                        // quiet-zone modules

async function resolveCode() {
  if (positional) return String(positional).toUpperCase();
  if (FROM_PI && FROM_PI !== true) {
    const res = await fetch(String(FROM_PI).replace(/\/+$/, "") + "/health");
    const j = await res.json();
    if (!j.gatewayShortCode) throw new Error("Pi /health returned no gatewayShortCode");
    return String(j.gatewayShortCode).toUpperCase();
  }
  // derive locally (running on the Pi)
  const { deriveShortCode } = require("./gen-hardware-id");
  const c = deriveShortCode();
  if (!c) throw new Error("Could not derive short code (not on a Pi?). Pass a code, e.g. GWD98M0CDR");
  return c;
}

// Render one SVG. ink = module/text colour, paper = background (or null = none).
function buildSvg(code, payload, ink, paper) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "H" });
  const n = qr.modules.size;
  const get = (r, c) => qr.modules.get(r, c);

  const total = n + QUIET * 2;          // modules incl. quiet zone
  const m = QR_MM / total;              // mm per module
  const qrPx = total * m;               // == QR_MM
  const W = PLATE_MM;
  const qrX = (W - qrPx) / 2;
  const qrY = m * 2;                    // small top margin

  // text block under the QR
  const codeFont = Math.max(3.2, QR_MM * 0.13);
  const labelFont = codeFont * 0.5;
  const codeY = qrY + qrPx + codeFont * 1.25;
  const labelY = codeY + labelFont * 1.7;
  const H = labelY + labelFont * 1.0;

  // QR modules as one path (laser-friendly: fewer entities than per-rect)
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (get(r, c)) {
        const x = (qrX + (c + QUIET) * m).toFixed(3);
        const y = (qrY + (r + QUIET) * m).toFixed(3);
        const s = m.toFixed(3);
        d += `M${x},${y}h${s}v${s}h-${s}z`;
      }
    }
  }

  // centre knockout + logo
  const box = qrPx * KNOCK;
  const bx = qrX + (qrPx - box) / 2;
  const by = qrY + (qrPx - box) / 2;
  const pad = box * 0.14;
  let lw = box - 2 * pad;
  let lh = lw * (LOGO_VIEWBOX.h / LOGO_VIEWBOX.w);
  if (lh > box - 2 * pad) { lh = box - 2 * pad; lw = lh * (LOGO_VIEWBOX.w / LOGO_VIEWBOX.h); }
  const lx = qrX + (qrPx - lw) / 2;
  const ly = qrY + (qrPx - lh) / 2;
  const sx = lw / LOGO_VIEWBOX.w;
  const sy = lh / LOGO_VIEWBOX.h;

  const bg = paper
    ? `<rect width="${W}" height="${H.toFixed(3)}" fill="${paper}"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H.toFixed(3)}mm" viewBox="0 0 ${W} ${H.toFixed(3)}">
${bg}
  <path d="${d}" fill="${ink}"/>
  <rect x="${bx.toFixed(3)}" y="${by.toFixed(3)}" width="${box.toFixed(3)}" height="${box.toFixed(3)}" rx="${(box * 0.12).toFixed(3)}" fill="${paper || "#fff"}"/>
  <g transform="translate(${lx.toFixed(3)},${ly.toFixed(3)}) scale(${sx.toFixed(6)},${sy.toFixed(6)})"><path d="${LOGO_PATH}" fill="${ink}"/></g>
  <text x="${(W / 2).toFixed(3)}" y="${codeY.toFixed(3)}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${codeFont.toFixed(2)}" letter-spacing="${(codeFont * 0.06).toFixed(2)}" text-anchor="middle" fill="${ink}">${code}</text>
  <text x="${(W / 2).toFixed(3)}" y="${labelY.toFixed(3)}" font-family="Helvetica, Arial, sans-serif" font-size="${labelFont.toFixed(2)}" letter-spacing="${(labelFont * 0.18).toFixed(2)}" text-anchor="middle" fill="${ink}">${BRAND} ${MODEL}</text>
</svg>`;
}

(async () => {
  const code = await resolveCode();
  const payload = URL_PREFIX && URL_PREFIX !== true ? String(URL_PREFIX) + code : code;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, code);

  const normal = buildSvg(code, payload, "#000000", "#ffffff");
  const inverted = buildSvg(code, payload, "#ffffff", "#111111");

  fs.writeFileSync(`${base}-etch.svg`, normal);
  fs.writeFileSync(`${base}-etch-inverted.svg`, inverted);

  console.log(`code:    ${code}`);
  console.log(`payload: ${payload}`);
  console.log(`wrote:   ${base}-etch.svg`);
  console.log(`         ${base}-etch-inverted.svg`);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
