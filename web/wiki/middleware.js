/**
 * Login gate for the Aetherfield wiki: one login per client.
 *
 * Vercel Routing Middleware (all plans, any framework) runs before every
 * request to this project. Visitors without a valid cookie get a branded
 * login page; a correct username + password sets a 30-day cookie.
 *
 * Environment (Vercel → Project → Settings → Environment Variables):
 *
 *   WIKI_USERS      one login per client, "name:password", separated by
 *                   commas or new lines:
 *                       acme:blue-kettle-41, pixelworks:quiet-harbour-7
 *                   Names: letters, digits, - and _ (not case-sensitive).
 *                   Passwords: anything except a comma or a new line.
 *   WIKI_PASSWORD   optional fallback: a single shared password with no
 *                   username. Leave unset once WIKI_USERS is in use.
 *   WIKI_BASE_URL   path prefix, default "/wiki/". Must match the build.
 *
 * Neither set = the wiki refuses to serve, so a misconfigured deploy fails
 * closed, not open. Environment changes take effect on the next deploy.
 *
 * Managing access:
 *   add a client      add a line to WIKI_USERS, redeploy
 *   remove a client   delete their line, redeploy: their cookie stops
 *                     working at once, nobody else is affected
 *   change a password edit their line: only that client is signed out
 *
 * Each sign-in is written to the project's logs ("wiki login: acme"), which
 * is the record of who has been in. This is a login per client, not per
 * person: people at one client share it.
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

/** "name:pw, name:pw" -> Map(name -> pw). Bad entries are skipped. */
function parseUsers(raw) {
  const users = new Map();
  for (const entry of String(raw || "").split(/[,\n]/)) {
    const line = entry.trim();
    const i = line.indexOf(":");
    if (i < 1) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const pw = line.slice(i + 1).trim();
    if (/^[a-z0-9_-]{1,32}$/.test(name) && pw) users.set(name, pw);
  }
  return users;
}

/** Cookie proof for a login. Tied to both name and password, so changing
 *  or removing either makes existing cookies worthless. */
async function token(name, password) {
  const data = new TextEncoder().encode(`aura-wiki:v2:${name}:${password}`);
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

function loginPage({ action, nextPath, error, status = 401, withUser = true, user = "" }) {
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
  ${withUser ? `<label for="u">Username</label>
  <input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(user)}" autofocus required>
  <label for="p" style="margin-top:14px">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>`
  : `<label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" autofocus required>`}
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

const SHARED = "_shared"; // cookie name part for WIKI_PASSWORD mode

/** Is this cookie ("name.proof") valid for the current configuration? */
async function cookieOk(value, users, shared) {
  if (typeof value !== "string") return false;
  const i = value.indexOf(".");
  if (i < 1) return false;
  const name = value.slice(0, i);
  const proof = value.slice(i + 1);
  const pw = name === SHARED ? shared : users.get(name);
  if (!pw) return false;
  return same(proof, await token(name, pw));
}

export default async function middleware(req) {
  const users = parseUsers(process.env.WIKI_USERS);
  const shared = users.size ? "" : process.env.WIKI_PASSWORD || "";
  if (!users.size && !shared) {
    return new Response("Wiki is not configured: set WIKI_USERS.", { status: 503, headers: { "cache-control": "no-store" } });
  }

  const url = new URL(req.url);
  const b = base();
  const loginPath = `${b}/_login`;
  const withUser = users.size > 0;
  const cookiePath = b || "/";

  if (url.pathname === `${b}/_logout`) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `${b}/`,
        "set-cookie": `${COOKIE}=; Path=${cookiePath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        "cache-control": "no-store",
      },
    });
  }

  if (url.pathname === loginPath && req.method === "POST") {
    let form;
    try { form = await req.formData(); } catch { form = new FormData(); }
    const dest = safeNext(form.get("next"), b);
    const name = withUser ? String(form.get("username") || "").trim().toLowerCase() : SHARED;
    const given = String(form.get("password") || "");
    const real = withUser ? users.get(name) : shared;
    // Always hash and compare, even for an unknown name, so a wrong username
    // and a wrong password are indistinguishable from outside.
    const ok = same(await token(name, given), await token(name, real || "\u0000no-such-user"));
    if (ok && real) {
      console.log(`wiki login: ${withUser ? name : "(shared password)"}`);
      return new Response(null, {
        status: 303,
        headers: {
          location: dest,
          "set-cookie": `${COOKIE}=${name}.${await token(name, real)}; Path=${cookiePath}; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      });
    }
    console.log(`wiki login FAILED: ${withUser ? name || "(blank)" : "(shared password)"}`);
    return loginPage({
      action: loginPath, nextPath: dest, withUser, user: withUser ? name : "",
      error: withUser ? "That username and password didn't match." : "That password didn't work.",
    });
  }

  if (await cookieOk(readCookie(req, COOKIE), users, shared)) {
    return next();
  }

  return loginPage({ action: loginPath, nextPath: safeNext(url.pathname + url.search, b), withUser });
}
