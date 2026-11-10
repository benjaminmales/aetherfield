# Aura Tag

Firmware for **Aura Tag**: the stock HOLYIOT-25008 module (nRF54L15, CR2032,
RGB LED, LIS2DH12 accelerometer) on Aetherfield protocol v2.

Aura Tag is the test vehicle for the Aura product line, so it does exactly
the three things every Aura device does:

1. **Receives behaviour commands**: colour, animation, brightness, mode
2. **Detects motion**: the accelerometer reports when it starts moving and when it comes to rest
3. **Transmits its ID and status**: 16-bit id, capabilities, battery, flags

The module's button is deliberately unused. Aura products have no button.

> For the **modified** 25008 (button removed, high-power blue LED fitted) use
> `lab/pixel/holyiot_25008_nrf54l15_pixel` instead.

---

## What it does

| | Behaviour |
|---|---|
| Boot | Red → green → blue, 100 ms each, then dark until a Link commands it |
| Light | Follows every v2 CMD to group `0x08` (Tags) or everyone |
| Starts moving | `EVENT` type motion, value `1`, strength = movement at that moment. Beacon flag `MOVING` set |
| Comes to rest (3 s without movement) | `EVENT` type motion, value `0`, strength = peak movement over the episode (0–100). Flag cleared |
| Battery | Chip reads its own supply (= the coin cell, no regulator) once a minute. % in every beacon; `LOW_BATTERY` flag at ≤15% |
| Identity | 16-bit address from the chip id (fine for a demo handful; fleets get assigned addresses) |
| Capabilities | `caps=0x09` (RGB LED + accelerometer, `AURA_CAPS_HOLYIOT`) |

### Motion

The LIS2DH12's own any-motion detector watches at 10 Hz and interrupts the
MCU (INT1, P2.00). Nothing polls, which matters on a coin cell. Motion is
reported as **transitions**, not a stream, and the `MOVING` flag rides every
beacon, so the server always knows the current state even if one event is lost.

The interrupt path is **high-pass filtered** (`CONFIG_LIS2DH_ACCEL_HP_FILTERS`
plus CTRL_REG2.HPIS1). Without that, the comparator sees gravity (1 g, far
above the threshold) and a Tag lying on a table reports "moving" forever.

Tuning, at the top of `src/main.c`:

| | Default | |
|---|---|---|
| `MOTION_THRESH_MS2` | 0.5 m/s² | Change in acceleration that counts as movement. Raise to ignore small knocks |
| `STILL_AFTER_MS` | 3000 | Quiet time before "came to rest" |
| `MOTION_ODR_HZ` | 10 | Accelerometer sample rate |

### Battery

The percentage comes from a CR2032 discharge table (3.0 V = 100%, 2.5 V = 15%,
2.2 V = 0%). A coin cell's voltage sags under radio load and recovers, so read
the figure as a trend, not a gauge.

### The light

Red and blue are on pins no PWM can reach (on/off only); green dims. Eight
clean colours. It's a status light at ~0.2 mA per channel. Aura One is the
show light.

---

## Build in VS Code (nRF Connect extension)

| Field | Value |
|---|---|
| SDK | nRF Connect SDK v3.3.4 |
| Board target | `holyiot_25008_nrf54l15/nrf54l15/cpuapp` |
| Board root | set by the workspace `.vscode/settings.json` |
| Base configuration files | `prj.conf` |
| Extra devicetree overlays | none (the app's `boards/` overlay is picked up automatically) |

Flash over SWD. Logs come out over **RTT**.
Prebuilt: `prebuilt/aura-tag.hex`.

---

## Bench test

1. RTT prints `proto=2 addr=XXXX caps=09 group=08 motion=ok battery=ok`, then `VDD ~3000 mV -> ~100%`.
2. With an Aura Link on channel 15, the server shows `<BCN a=XXXX ... caps=09 batt=NN ...`.
3. `aura cmd 08 1 0 0 0 0 255 0 255`: steady green, Tags only.
4. Lift the Tag: `<EVT a=XXXX ... t=motion v=1`. Put it down: about 3 s later `t=motion v=0 s=<peak>`.
5. Leave it on the table for a minute: **no** motion events. If it keeps reporting
   `v=1`, the high-pass filter isn't on. Check the RTT log for the warning.

---

## Gaps

- **⚠ GAP: battery life is unmeasured.** Measure each op_mode on a current meter before quoting any figure.
- **⚠ GAP: none of this has run on hardware yet.** Motion thresholds in particular need a bench session.
