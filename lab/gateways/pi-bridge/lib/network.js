"use strict";

// Network provisioning for the gateway via NetworkManager (nmcli).
// Read ops (status, scan) usually work as the service user; write ops (connect)
// often need privileges, so write ops try plain nmcli then fall back to `sudo -n nmcli`.
// Grant the service user permission with a polkit rule or a NOPASSWD sudoers entry
// for /usr/bin/nmcli (see README › Headless networking).

const { execFile } = require("child_process");

const TIMEOUT = 45_000;

function runRaw(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || "");
        return reject(err);
      }
      resolve(String(stdout || ""));
    });
  });
}

// Read-only nmcli call.
function nmcli(args) {
  return runRaw("nmcli", args);
}

// Privileged nmcli call: plain first, then `sudo -n nmcli`.
async function nmcliPriv(args) {
  try {
    return await runRaw("nmcli", args);
  } catch (e) {
    const msg = `${e.message || ""} ${e.stderr || ""}`.toLowerCase();
    if (msg.includes("permission") || msg.includes("not authorized") || msg.includes("access denied")) {
      return await runRaw("sudo", ["-n", "nmcli", ...args]);
    }
    throw e;
  }
}

// nmcli -t escapes ':' inside fields as '\:'. Split on unescaped ':'.
function splitTerse(line) {
  return line.split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ":"));
}

async function getStatus() {
  const out = { online: null, primaryType: null, ssid: null, ips: [], devices: [] };

  try {
    const dev = await nmcli(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]);
    out.devices = dev.trim().split("\n").filter(Boolean).map((l) => {
      const [device, type, state, connection] = splitTerse(l);
      return { device, type, state, connection };
    });
    // Primary WAN: first connected non-loopback, non-AP device.
    const connected = out.devices.find(
      (d) => /connected/i.test(d.state) && d.type !== "loopback" && !/hotspot/i.test(d.connection || "")
    );
    if (connected) out.primaryType = connected.type;
  } catch { /* leave defaults */ }

  try {
    const conn = (await nmcli(["networking", "connectivity"])).trim();
    out.online = conn === "full";
    out.connectivity = conn;
  } catch { /* leave null */ }

  try {
    const wifi = await nmcli(["-t", "-f", "ACTIVE,SSID", "device", "wifi"]);
    const active = wifi.trim().split("\n").map(splitTerse).find((r) => r[0] === "yes");
    if (active) out.ssid = active[1];
  } catch { /* ignore */ }

  try {
    const ip = await runRaw("hostname", ["-I"]);
    out.ips = ip.trim().split(/\s+/).filter(Boolean);
  } catch { /* ignore */ }

  return out;
}

async function scanWifi() {
  let out = "";
  try {
    out = await nmcli(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto"]);
  } catch (e) {
    throw new Error(`Wi-Fi scan failed: ${e.stderr || e.message}`);
  }
  const bySsid = new Map();
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const [inUse, ssid, signalStr, security] = splitTerse(line);
    if (!ssid) continue; // hidden / blank
    const signal = parseInt(signalStr, 10) || 0;
    const prev = bySsid.get(ssid);
    if (!prev || signal > prev.signal) {
      bySsid.set(ssid, { ssid, signal, security: security || "open", inUse: inUse === "*" });
    } else if (inUse === "*") {
      prev.inUse = true;
    }
  }
  return [...bySsid.values()].sort((a, b) => b.signal - a.signal);
}

function ethernetDevice(devices) {
  const d = devices.find((x) => x.type === "ethernet");
  return d ? d.device : null;
}
function wifiDevice(devices) {
  const d = devices.find((x) => x.type === "wifi");
  return d ? d.device : "wlan0";
}
function cellularDevice(devices) {
  const d = devices.find((x) => x.type === "gsm" || x.type === "cdma" || x.type === "wwan");
  return d ? d.device : null;
}

async function connectWifi(ssid, password, iface) {
  if (!ssid) throw new Error("SSID required");
  const args = ["device", "wifi", "connect", ssid];
  if (password) args.push("password", password);
  if (iface) args.push("ifname", iface);
  await nmcliPriv(args);
  return { ok: true };
}

async function connectEthernet() {
  const { devices } = await getStatus();
  const dev = ethernetDevice(devices);
  if (!dev) throw new Error("No ethernet device found — plug in the cable.");
  await nmcliPriv(["device", "connect", dev]);
  return { ok: true, device: dev };
}

// Configure the Ethernet link for admin + Art-Net. Ethernet carries LOCAL traffic
// (the setup page on :3000 and Art-Net on UDP 6454); Wi-Fi stays the internet
// uplink — so we set ipv4.never-default on eth so it can't hijack the route.
//   shared  — Pi hands out DHCP at 10.42.0.1. Plug a laptop/console straight in
//             (single unit). Admin at http://10.42.0.1:3000, Art-Net to 10.42.0.1.
//   dhcp    — Pi is a DHCP client on a venue/lighting LAN (many units share it;
//             reach a specific one via aura-gw-<sn>.local).
//   static  — fixed IP to match a console's Art-Net subnet (e.g. 2.0.0.10/8).
async function setEthernet(mode, opts = {}) {
  const { devices } = await getStatus();
  const dev = ethernetDevice(devices) || "eth0";
  const CON = "eth-admin";

  await nmcliPriv(["connection", "delete", CON]).catch(() => {});

  if (mode === "shared") {
    await nmcliPriv([
      "connection", "add", "type", "ethernet", "ifname", dev, "con-name", CON,
      "ipv4.method", "shared",
    ]);
  } else if (mode === "static") {
    const addr = String(opts.address || "").trim(); // "10.0.0.10/24"
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(addr)) {
      throw new Error('static mode needs an address like "10.0.0.10/24"');
    }
    const args = [
      "connection", "add", "type", "ethernet", "ifname", dev, "con-name", CON,
      "ipv4.method", "manual", "ipv4.addresses", addr, "ipv4.never-default", "yes",
    ];
    if (opts.gateway) args.push("ipv4.gateway", String(opts.gateway).trim());
    await nmcliPriv(args);
  } else {
    // dhcp client (default) — local only, never the internet default route
    await nmcliPriv([
      "connection", "add", "type", "ethernet", "ifname", dev, "con-name", CON,
      "ipv4.method", "auto", "ipv4.never-default", "yes",
    ]);
  }

  await nmcliPriv(["connection", "up", CON]);
  return { ok: true, device: dev, mode: mode || "dhcp" };
}

async function connectCellular() {
  const { devices } = await getStatus();
  const dev = cellularDevice(devices);
  if (!dev) throw new Error("No cellular/dongle device detected. Plug in the modem and try again.");
  await nmcliPriv(["device", "connect", dev]);
  return { ok: true, device: dev };
}

module.exports = {
  getStatus, scanWifi, connectWifi, connectEthernet, setEthernet, connectCellular,
  ethernetDevice, wifiDevice, cellularDevice,
};
