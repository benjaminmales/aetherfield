/**
 * site-settings.js — per-site tuning, set from the console.
 *
 * Today that is the proximity calibration: the RSSI thresholds that turn a
 * signal strength into near / mid / far. The defaults are textbook values,
 * not this venue. Calibrate by standing a device where "near" should end and
 * reading its signal off the console.
 */
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = { proximity: { nearDbm: -60, midDbm: -75 } };

function createSiteSettings(file) {
  let s = structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    s = { ...s, ...raw, proximity: { ...s.proximity, ...(raw.proximity || {}) } };
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`settings: ignoring unreadable ${file}: ${e.message}`);
  }
  function update(patch = {}) {
    const p = { ...s.proximity, ...(patch.proximity || {}) };
    for (const k of ["nearDbm", "midDbm"]) {
      const n = Number(p[k]);
      if (!Number.isInteger(n) || n > -20 || n < -110) throw new Error(`proximity.${k} must be an integer between -110 and -20 dBm`);
      p[k] = n;
    }
    if (p.nearDbm <= p.midDbm) throw new Error("proximity.nearDbm must be stronger (closer to 0) than midDbm");
    s = { ...s, proximity: p };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    return s;
  }
  return { get: () => s, update, defaults: () => structuredClone(DEFAULTS) };
}
module.exports = { createSiteSettings };
