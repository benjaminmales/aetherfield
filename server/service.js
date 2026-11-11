#!/usr/bin/env node
/**
 * Demo Server as a background service: starts when you log in, restarts if
 * it stops. After `npm run service:install` the console is always at
 * http://localhost:3000 and nobody has to remember to start anything.
 *
 *   npm run service:install     set it up and start it now
 *   npm run service:status      is it running?
 *   npm run service:uninstall   stop it and remove it
 *
 * No admin rights needed on any platform; everything is per-user.
 *
 *   macOS    a LaunchAgent  (~/Library/LaunchAgents/ai.aetherfield.aura-server.plist)
 *   Windows  a hidden launcher in the user's Startup folder
 *   Linux    a systemd user unit (~/.config/systemd/user/aura-server.service)
 *
 * On every platform the thing that actually runs is `node service.js run`:
 * a tiny supervisor that starts server.js and restarts it if it exits. One
 * code path to keep the server up, instead of three OS-specific ones.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DIR = __dirname;
const NODE = process.execPath;
const SELF = path.join(DIR, "service.js");
const DATA = process.env.DATA_DIR || path.join(DIR, "data");
const LOG = path.join(DATA, "aura-server.log");
const PID = path.join(DATA, "aura-server.pid");
const LABEL = "ai.aetherfield.aura-server";
const PORT = Number(readEnvFile().HTTP_PORT || process.env.HTTP_PORT || 3000);

function readEnvFile() {
  try {
    return Object.fromEntries(
      fs.readFileSync(path.join(DIR, ".env"), "utf8").split("\n")
        .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]),
    );
  } catch { return {}; }
}

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const xml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

async function healthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function waitHealthy(ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await healthy()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/* ------------------------------------------------------------ supervisor -- */

function run() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(PID, String(process.pid));
  let child = null;
  let stopping = false;
  let fastFails = 0;

  const start = () => {
    const out = fs.openSync(LOG, "a");
    const startedAt = Date.now();
    child = spawn(NODE, [path.join(DIR, "server.js")], { cwd: DIR, stdio: ["ignore", out, out], windowsHide: true });
    child.on("exit", (code) => {
      fs.closeSync(out);
      if (stopping) return;
      // Back off if it keeps dying at once (port in use, broken install),
      // so a hard failure doesn't spin the CPU or flood the log.
      fastFails = Date.now() - startedAt < 5000 ? fastFails + 1 : 0;
      const delay = Math.min(1000 * 2 ** fastFails, 60000);
      fs.appendFileSync(LOG, `\n[service] server exited (${code}); restarting in ${delay / 1000}s\n`);
      setTimeout(start, delay);
    });
  };

  const stop = () => {
    stopping = true;
    try { fs.unlinkSync(PID); } catch {}
    if (child) child.kill();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  start();
}

function stopSupervisor() {
  try {
    const pid = Number(fs.readFileSync(PID, "utf8"));
    if (pid) process.kill(pid);
  } catch {}
}

/* ---------------------------------------------------------------- macOS -- */

const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(NODE)}</string><string>${xml(SELF)}</string><string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict></plist>
`;
}

const mac = {
  install() {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    const target = `gui/${process.getuid()}`;
    sh("launchctl", ["bootout", `${target}/${LABEL}`]); // replace an older install; fine if absent
    fs.writeFileSync(PLIST, plist());
    const r = sh("launchctl", ["bootstrap", target, PLIST]);
    if (r.status !== 0) throw new Error(`launchctl: ${(r.stderr || r.stdout).trim()}`);
  },
  uninstall() {
    sh("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
    try { fs.unlinkSync(PLIST); } catch {}
  },
  where: PLIST,
};

/* -------------------------------------------------------------- Windows -- */

const STARTUP = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Demo Server.vbs");

const win = {
  install() {
    // A .vbs launcher is the standard way to start a console program with no
    // window. Doubled quotes are VBScript's escape for a quote in a string.
    const q = (s) => `""${s}""`;
    const vbs = `' Demo Server: starts at login. Remove with: npm run service:uninstall\r\n` +
      `Set sh = CreateObject("WScript.Shell")\r\n` +
      `sh.CurrentDirectory = "${DIR}"\r\n` +
      `sh.Run "${q(NODE)} ${q(SELF)} run", 0, False\r\n`;
    fs.mkdirSync(path.dirname(STARTUP), { recursive: true });
    stopSupervisor();
    fs.writeFileSync(STARTUP, vbs);
    spawn("wscript.exe", [STARTUP], { detached: true, stdio: "ignore" }).unref();
  },
  uninstall() {
    stopSupervisor();
    try { fs.unlinkSync(STARTUP); } catch {}
  },
  where: STARTUP,
};

/* ---------------------------------------------------------------- Linux -- */

const UNIT = path.join(os.homedir(), ".config", "systemd", "user", "aura-server.service");

const linux = {
  install() {
    fs.mkdirSync(path.dirname(UNIT), { recursive: true });
    fs.writeFileSync(UNIT, `[Unit]
Description=Demo Server
After=network.target

[Service]
WorkingDirectory=${DIR}
ExecStart="${NODE}" "${SELF}" run
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`);
    sh("systemctl", ["--user", "daemon-reload"]);
    const r = sh("systemctl", ["--user", "enable", "--now", "aura-server.service"]);
    if (r.status !== 0) throw new Error(`systemctl: ${(r.stderr || r.stdout).trim()}`);
  },
  uninstall() {
    sh("systemctl", ["--user", "disable", "--now", "aura-server.service"]);
    try { fs.unlinkSync(UNIT); } catch {}
    sh("systemctl", ["--user", "daemon-reload"]);
  },
  where: UNIT,
};

const platform = { darwin: mac, win32: win, linux }[process.platform];

/* ------------------------------------------------------------------ CLI -- */

async function main() {
  const cmd = process.argv[2];
  if (cmd === "run") return run();

  if (!platform) {
    console.error(`Background service isn't supported on ${process.platform}. Use: npm start`);
    process.exit(1);
  }

  if (cmd === "install") {
    if (!fs.existsSync(path.join(DIR, "node_modules"))) {
      console.error("Run `npm install` first, then `npm run service:install`.");
      process.exit(1);
    }
    fs.mkdirSync(DATA, { recursive: true });
    platform.install();
    process.stdout.write("Starting Demo Server");
    const ok = await waitHealthy();
    console.log(ok ? `\n\nDemo Server is running and will start whenever you log in.\n  Console:  http://localhost:${PORT}\n  Log:      ${LOG}\n  Remove:   npm run service:uninstall`
                   : `\n\nInstalled, but the server didn't answer on port ${PORT} yet.\nCheck the log: ${LOG}\n(If another copy is already running with \`npm start\`, stop it first.)`);
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "uninstall") {
    platform.uninstall();
    console.log("Demo Server background service removed. Your names, behaviours and settings in data/ are untouched.");
    return;
  }

  if (cmd === "status") {
    const up = await healthy();
    const installed = fs.existsSync(platform.where);
    console.log(`Background service: ${installed ? "installed" : "not installed"}`);
    console.log(`Demo Server:        ${up ? `running at http://localhost:${PORT}` : "not running"}`);
    process.exit(up ? 0 : 1);
  }

  console.log("Usage: node service.js install | uninstall | status");
  process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { plist, PORT };
