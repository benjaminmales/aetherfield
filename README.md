# Aetherfield

Real-time orchestration for crowds of wearable light-and-sensor devices:
synchronised light out, presence, identity and gesture back.

## The product range

| Product | What it is | Hardware | Firmware | State |
|---|---|---|---|---|
| **Aura One** | Show wristband: 4× RGB, 6-axis IMU, rechargeable | `hardware/aura-one` (nRF54L05, LP5012, LSM6DSRX, LiPo charger) | `firmware/aura-one` | ⚠ GAP: boards in fabrication, firmware not started |
| **Aura Lite** | Low-cost wearable: 1× RGB, accelerometer, CR2032 | `hardware/aura-lite` (nRF54L05, MC3630) | `firmware/aura-lite` | ⚠ GAP: board designed, firmware not started |
| **Aura Tag** | Test vehicle for Aura: receives commands, detects motion, reports id + status | HOLYIOT-25008 module | `firmware/aura-tag` | Builds; not yet run on hardware |
| **Aura Marker** | Fixed point-of-interest anchor | XIAO nRF54L15 + external antenna | `firmware/aura-marker` | ⚠ GAP: specified, not built |
| **Aura Link** | Venue gateway: 802.15.4 ↔ Ethernet/PoE | XIAO nRF54LM20A on XIAO W5500 adapter | `firmware/aura-link` | Working; v1.1 adds status LED |
| **Aura Server** | On-site show brain + operator console | Any Linux/macOS box (Beelink in the field) | `server/` | Working (TCP gateway link, roster, console) |
| **aetherfield.cloud** | Hosted mirror: remote dashboard, messaging | — | `cloud/` | ⚠ GAP |

## Layout

```
include/aura_radio.h   protocol source of truth — every device, gateway and server shares it
firmware/              production firmware. BOARD_ROOT = firmware/
  common/              shared v2 band layer (aura_band) — radio, CMD/SYNC, animation, beacons
  boards/              out-of-tree boards: holyiot 25008, XIAO nRF54LM20A
  aura-*/              one app per product
server/                Aura Server (Node). Works with the internet unplugged
cloud/                 aetherfield.cloud + the earlier Activation Studio
web/wiki, web/site     aetherfield.ai docs and the client area
hardware/              KiCad: Aura One, Aura Lite, shared library
tools/                 sim-gateway, stress rig, provisioning
deploy/                server install (Debian + systemd)
docs/                  protocol, whitepaper, demo run sheet, history
lab/                   experiments — cordoned off, see below
```

## Production vs lab

`lab/` holds every device and gateway we tried on the way here: K7, K4,
voteband, Waveshield, Halo, the Pixel apps, the Pi bridge, the sniffer, the
Traitors demo. It is kept, and it is encouraged: try things there.

**One rule: production never depends on lab.** Lab may include the protocol
header and the band layer, so experiments stay current. Nothing outside
`lab/` may reach into it. `scripts/check-cordon.sh` enforces this in the
pre-commit hook and in CI, and CI only builds production.

To promote something from lab, move it into production and get it reviewed.

## First-time setup

```sh
git config core.hooksPath .githooks     # embedded-repo guard, secret scan, cordon
cd server && npm install && npm test
```

Firmware builds with **nRF Connect SDK v3.3.4** in VS Code. The workspace
`.vscode/settings.json` sets the board roots, so every app's README only has
to give the board target and any extra Kconfig fragment.
