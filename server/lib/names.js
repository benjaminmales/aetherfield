/**
 * names.js — human names for devices and Links, kept on disk.
 *
 * The radio identity is a 16-bit address (0x1A2B) and a Link identifies as
 * gw-01. Neither means anything to a client walking a venue. This holds the
 * mapping an operator types into the console: "Tag 07", "Bar entrance".
 *
 * One small JSON file, rewritten whole on every change via a temp file and
 * rename, so a power cut mid-write leaves the previous version rather than a
 * truncated file. Local only: names are part of the show setup, and the show
 * must run with the internet unplugged.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hexAddr } = require("./aura-v2");

const MAX_LEN = 48;

function clean(name) {
  if (name === null || name === undefined) return null;
  const s = String(name).replace(/[\u0000-\u001f]/g, "").trim().slice(0, MAX_LEN);
  return s || null;
}

function createNames(file) {
  let data = { devices: {}, gateways: {} };

  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    data = { devices: raw.devices || {}, gateways: raw.gateways || {} };
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`names: ignoring unreadable ${file}: ${e.message}`);
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Set or clear (null/empty) a device's name. Returns the stored name. */
  function setDevice(addr, name) {
    const id = hexAddr(addr);
    if (!id) throw new Error("Invalid device address");
    const n = clean(name);
    if (n) data.devices[id] = n;
    else delete data.devices[id];
    save();
    return n;
  }

  function setGateway(id, name) {
    const gid = String(id || "").trim();
    if (!/^[\w.-]{1,32}$/.test(gid)) throw new Error("Invalid gateway id");
    const n = clean(name);
    if (n) data.gateways[gid] = n;
    else delete data.gateways[gid];
    save();
    return n;
  }

  return {
    device: (addr) => data.devices[hexAddr(addr)] ?? null,
    gateway: (id) => (id ? data.gateways[id] ?? null : null),
    setDevice,
    setGateway,
    all: () => JSON.parse(JSON.stringify(data)),
  };
}

module.exports = { createNames, clean };
