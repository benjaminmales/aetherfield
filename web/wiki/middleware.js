/**
 * Password gate for the Aetherfield wiki.
 *
 * Vercel Routing Middleware (all plans, any framework) runs before every
 * request to this project. Visitors without a valid cookie get a branded
 * login page; the right password sets a 30-day cookie and sends them on.
 *
 * Why not Vercel's built-in Password Protection: it's a paid add-on per
 * project, and it doesn't sit well behind aetherfield.ai/wiki, where this
 * project is reached through a rewrite from another domain. This gate works
 * the same on the vercel.app URL and on aetherfield.ai/wiki.
 *
 * Environment (Vercel → Project → Settings → Environment Variables):
 *   WIKI_PASSWORD   the shared password. Unset = the wiki refuses to serve,
 *                   so a misconfigured deploy fails closed, not open.
 *   WIKI_BASE_URL   path prefix, default "/wiki/". Must match the build.
 *
 * Changing WIKI_PASSWORD signs everyone out: the cookie is a hash of it.
 *
 * This is a shared-password gate for client documentation, not user
 * accounts. Anyone with the password can read everything; nothing here
 * is per-person.
 */
import { next } from "@vercel/functions";

export const config = {
  // Everything, except Vercel's own internals.
  matcher: ["/((?!_vercel).*)"],
};

const COOKIE = "aura_wiki";
const MAX_AGE = 60 * 60 * 24 * 30;

function base() {
  const b = (process.env.WIKI_BASE_URL || "/wiki/").replace(/\/+$/, "");
  return b === "" ? "" : b; // "" when served from a domain root
}

async function token(password) {
  const data = new TextEncoder().encode(`aura-wiki:v1:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent comparison of two hex strings. */
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Only allow redirects back into the wiki, never to another site. */
function safeNext(value, b) {
  const home = `${b}/`;
  if (typeof value !== "string" || !value.startsWith(`${b}/`) || value.startsWith("//")) return home;
  return value;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function loginPage({ action, nextPath, error, status = 401 }) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aetherfield Wiki</title><meta name="robots" content="noindex">
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#f2f2f2;
       font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  form{width:min(340px,88vw)}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:28px}
  .brand svg{width:30px}
  .brand b{letter-spacing:.18em;font-size:.82rem;font-weight:600}
  .brand span{color:#8c8c8c;font-size:.82rem;border-left:1px solid #242424;padding-left:12px}
  label{display:block;font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:#5c5c5c;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;padding:11px 12px;font:inherit;background:#111;color:#f2f2f2;
        border:1px solid #242424;border-radius:4px}
  input:focus{outline:0;border-color:#ff6b1a}
  button{margin-top:14px;width:100%;padding:11px;font:inherit;font-weight:600;background:#ff6b1a;color:#000;
         border:0;border-radius:4px;cursor:pointer}
  .err{color:#f87171;font-size:.82rem;margin-top:10px}
  p{color:#5c5c5c;font-size:.78rem;margin-top:22px;line-height:1.5}
</style></head><body>
<form method="post" action="${esc(action)}">
  <div class="brand">
    <svg viewBox="0 0 1275.6 850.4" aria-hidden="true"><path d="M854.4,0c2.2,87.8,27.4,172.2,77.9,244.1,70.5,100.2,182.9,165.4,305.8,177.5,8.5.8,21.4,2.2,37.5,2.4v426.4c-57.4-2.3-113.6-6.4-169.9-17.6C753.7,763.2,478.3,465.7,433.6,111.7l-7.6-70.7v807H0V0h854.4Z" fill="#FF6B1A"/></svg>
    <b>AETHERFIELD</b><span>Wiki</span>
  </div>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="${esc(nextPath)}">
  <button type="submit">Open the wiki</button>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <p>Client documentation for Aura and Aura Server. Ask your Aetherfield contact for access.</p>
</form></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

export default async function middleware(req) {
  const password = process.env.WIKI_PASSWORD;
  if (!password) {
    return new Response("Wiki is not configured: set WIKI_PASSWORD.", { status: 503, headers: { "cache-control": "no-store" } });
  }

  const url = new URL(req.url);
  const b = base();
  const loginPath = `${b}/_login`;
  const good = await token(password);

  if (url.pathname === loginPath && req.method === "POST") {
    let form;
    try { form = await req.formData(); } catch { form = new FormData(); }
    const dest = safeNext(form.get("next"), b);
    if (same(await token(String(form.get("password") || "")), good)) {
      return new Response(null, {
        status: 303,
        headers: {
          location: dest,
          "set-cookie": `${COOKIE}=${good}; Path=${b || "/"}; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      });
    }
    return loginPage({ action: loginPath, nextPath: dest, error: "That password didn't work." });
  }

  if (same(readCookie(req, COOKIE), good)) {
    return next();
  }

  return loginPage({ action: loginPath, nextPath: safeNext(url.pathname + url.search, b) });
}
