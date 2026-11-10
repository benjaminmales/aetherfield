# Wristband protocol (matches AURA-ONE firmware)

This document describes how the **real wristbands** are controlled and what they report, so the simulator and control UI stay aligned with hardware.

## Downlink: command payload (gateway → wristband)

Commands are sent over the radio. The wristband accepts any message with **payload ID = 4** and interprets the next bytes as:

| Byte index | Name  | Type    | Description |
|------------|--------|--------|--------------|
| 0          | id    | uint8  | Packet identifier, always **4** |
| 1          | mode  | uint8  | LED mode 0–7 |
| 2          | rate  | uint8  | 0–255: animation interval = `rate * 10` ms (or in mode 7: mic sensitivity/gain) |
| 3          | r     | uint8  | Red 0–255 |
| 4          | g     | uint8  | Green 0–255 |
| 5          | b     | uint8  | Blue 0–255 |

The control interface sends the same shape: `{ mode, rate, r, g, b }`. The simulator’s **POST /api/zone-led** and **POST /api/led** use this format.

## LED modes (firmware behavior)

| Mode | Name      | Behavior |
|------|-----------|----------|
| 0    | Static    | All 4 LEDs set to (r, g, b), no animation. |
| 1    | Heartbeat | Double pulse: full → off → half → off; timing from `rate` (interval = rate×10 ms). |
| 2    | Flash     | On (r,g,b) for interval, off for interval, repeat. |
| 3    | Ramp      | Build up from black to (r,g,b) in 10 steps over the interval. |
| 4    | Chase     | Chaser over 4 LEDs (order 0→1→3→2), fade in/out; neighbors at 1/3 brightness. |
| 5    | Rainbow   | Hue cycle across LEDs; interval sets speed. |
| 6    | Clap      | ML gesture: show (r,g,b) only when clap detected at 100% probability; otherwise LEDs off. |
| 7    | Mic       | Mic drives global brightness; (r,g,b) from command scaled by mic level. Rate 0 = gain 4.0; 1–255 = gain 0.5–8.0 (sensitivity). |

**Hardware:** LP5012, 4× RGB LEDs. All four LEDs receive the same (r,g,b) or animation state.

## Uplink: what wristbands report

- **Broadcast:** Wristband broadcasts a frame including message ID, device ID, and **gesture code**.
- **Gesture codes (ML):** 0 = IDLE, 1 = UNKNOWN, 2 = CLAP (only when clap at 100% probability).
- The controller/interface parses lines like: `UUID: 0x... RSSI: -85 Gesture: idle (0)` and maps gesture code to label.

The simulator uses gesture strings **idle**, **wave**, **clap**, **hands_in_air** for richer demo behavior; real hardware today reports **idle** (0) or **clap** (2). Reports to the server can include `gesture` and `rssi` as in **GET /api/reports**.

## Alignment with this repo

- **Control UI** (`/viewer/control`): Zone toggles, color picker, mode 0–7, rate 0–255 → **POST /api/zone-led** with `{ zones, mode, rate, r, g, b }`.
- **Simulator:** Stores per-fan and per-zone `mode, r, g, b` (and applies zone overrides after the behavior tick). Does not run the actual LED animations (heartbeat, chase, etc.); the **viewer** shows the chosen color. To better match hardware, the viewer could animate mode 1/2/3/4/5 in the future (e.g. pulse for heartbeat, flash for mode 2).
- **AURA-ONE interface** (`POST /api/led`): Same `{ mode, rate, r, g, b }` over serial to a single device; gateway sim would send the same payload over radio to many wristbands (e.g. per zone).
