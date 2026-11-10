#!/usr/bin/env node
/**
 * gen-hardware-id.js
 *
 * Derives a deterministic UUID v5 from this Pi's CPU serial number.
 * The same hardware always produces the same UUID.
 *
 * Usage:
 *   node scripts/gen-hardware-id.js
 *
 * To write it straight into .env:
 *   echo "GATEWAY_HARDWARE_ID=$(node scripts/gen-hardware-id.js)" >> .env
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");

// Fixed namespace UUID for Aetherfield gateway IDs (randomly generated once)
const NAMESPACE = "a3e7f210-4b2c-5d8e-9f1a-0c6b3d4e5f7a";

function getCpuSerial() {
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const match = cpuinfo.match(/^Serial\s*:\s*([0-9a-fA-F]+)/m);
    if (match) return match[1].toLowerCase();
  } catch {
    // not a Pi or no access
  }

  // Fallback: MAC address of first non-loopback interface
  try {
    const { execSync } = require("child_process");
    const mac = execSync("cat /sys/class/net/$(ls /sys/class/net | grep -v lo | head -1)/address 2>/dev/null")
      .toString()
      .trim()
      .replace(/:/g, "");
    if (mac && mac.length >= 12) return mac;
  } catch {
    // ignore
  }

  return null;
}

function uuidV5(namespace, name) {
  // Parse namespace UUID bytes
  const nsHex = namespace.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");

  // SHA-1 hash of namespace + name
  const hash = crypto.createHash("sha1")
    .update(nsBytes)
    .update(name)
    .digest();

  // Set version (5) and variant bits
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const h = hash.toString("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20, 32),
  ].join("-");
}

// Deterministic gateway serial from this Pi's immutable CPU serial.
// Returns null if it can't read the hardware (e.g. not a Pi).
function deriveHardwareId() {
  const serial = getCpuSerial();
  if (!serial) return null;
  return uuidV5(NAMESPACE, serial);
}

// Crockford Base32 alphabet — excludes I, L, O, U so codes are unambiguous
// to read off an etched case and type into the pairing screen.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32Crockford(buf, nChars) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length && out.length < nChars; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5 && out.length < nChars) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

// Short, human-typeable code derived from the SAME immutable CPU serial as the
// UUID, so it is automatic, persistent across re-imaging, and offline-derivable.
// Format: <prefix> + 8 Crockford-base32 chars, e.g. "GWQ3K7P2MV" (~1.1e12 space).
// This is the code you etch on the case and accept in the manual-pair field.
function deriveShortCode(prefix = "GW") {
  const serial = getCpuSerial();
  if (!serial) return null;
  // Domain-separate from the UUID hash so the two IDs aren't trivially linked.
  const digest = crypto
    .createHash("sha256")
    .update("aetherfield-shortcode:")
    .update(serial)
    .digest();
  return prefix + base32Crockford(digest, 8);
}

module.exports = { deriveHardwareId, deriveShortCode };

// CLI: print the derived ID when run directly.
//   node gen-hardware-id.js            -> UUID
//   node gen-hardware-id.js --short    -> short code (e.g. GWQ3K7P2MV)
//   node gen-hardware-id.js --both     -> "GWQ3K7P2MV  <uuid>"
if (require.main === module) {
  const arg = process.argv[2] || "";
  const id = deriveHardwareId();
  const short = deriveShortCode();
  if (!id) {
    console.error("ERROR: Could not read CPU serial or MAC address. Are you on the Pi?");
    process.exit(1);
  }
  if (arg === "--short") console.log(short);
  else if (arg === "--both") console.log(`${short}  ${id}`);
  else console.log(id);
}
