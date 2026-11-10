/**
 * hook-store.js — persisted webhook definitions for lib/webhooks.js.
 *
 * A hook: { id, url, on?, match?, body?, headers?, cooldownMs?, perDevice? }
 *   on     "event" | "zone" | "presence"   (omit = everything)
 *   match  equality filter on payload fields, e.g. {"event":"button","value":2}
 *   body   optional template, {{field}} substituted from the payload
 *
 * Stored in data/hooks.json beside names.json. Same write-temp-then-rename as
 * names.js, so a power cut leaves the previous file intact.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ON = new Set(["event", "zone", "presence"]);

function createHookStore(file) {
  let hooks = [];
  try { hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks || []; } catch (e) {
    if (e.code !== "ENOENT") console.warn(`hooks: ignoring unreadable ${file}: ${e.message}`);
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ hooks }, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
  function add(h) {
    let u;
    try { u = new URL(h.url); } catch { throw new Error("url must be an absolute http(s) URL"); }
    if (!/^https?:$/.test(u.protocol)) throw new Error("url must be http or https");
    if (h.on !== undefined && !ON.has(h.on)) throw new Error(`on must be one of: ${[...ON].join(", ")}`);
    const hook = {
      id: h.id && /^[\w-]{1,32}$/.test(h.id) ? h.id : crypto.randomBytes(4).toString("hex"),
      url: u.toString(),
      ...(h.on ? { on: h.on } : {}),
      ...(h.match && typeof h.match === "object" ? { match: h.match } : {}),
      ...(h.body !== undefined ? { body: h.body } : {}),
      ...(h.headers && typeof h.headers === "object" ? { headers: h.headers } : {}),
      ...(Number.isFinite(h.cooldownMs) ? { cooldownMs: h.cooldownMs } : {}),
      ...(h.perDevice === false ? { perDevice: false } : {}),
    };
    hooks = hooks.filter((x) => x.id !== hook.id).concat(hook);
    save();
    return hook;
  }
  function remove(id) {
    const n = hooks.length;
    hooks = hooks.filter((x) => x.id !== id);
    if (hooks.length !== n) { save(); return true; }
    return false;
  }
  return { list: () => hooks, add, remove };
}
module.exports = { createHookStore };
