# nRF54 serial test bridge

Single-file Web Serial control surface for the Aetherfield gateway. Send v2 commands,
watch decoded telemetry come back, see the fleet build itself. No build step, no
dependencies — same convention as `DEMOS/traitors/visualiser`.

## Run it

Open `index.html` in Chrome, Edge or Brave and press **Connect**.

If `file://` blocks the Web Serial prompt on your machine:

```bash
cd GATEWAY
python3 -m http.server 8000
# then http://localhost:8000/nrf54-serialTestBridge/
```

The gateway must be running the **USB console build** (the default —
see [`../nrf54-firmware/README.md`](../nrf54-firmware/README.md)). 115200 8N1.

Web Serial is Chromium-only; there is no Safari or Firefox support.

## What it shows

**Fleet** — built passively from beacons, exactly as the gateway builds its own. Caps
and flags are decoded to names, so a wristband reads `RGB_LED HP_LED IMU MIC MULTI_LED`
and the pixel module reads `RGB_LED`. Rows grey out after 10 s without a beacon.

**Delivery rate** — the percentage of known devices whose last acted-on command
sequence matches the one just sent. On an unacknowledged broadcast protocol this is the
only delivery visibility that exists, and it comes from one byte in each beacon.

**Traffic** — every line, filterable. `RX` is inbound telemetry, `TX` is what the
gateway sent or what this page typed, `Raw/undecoded` covers `<RAW`, `<WARN` and the
legacy `NODE:` lines the Pi bridge still consumes.

## Controls

Animation modes, colour, brightness and period map onto `aura anim`. Brightness is
applied after the animation renders, so dragging it dims everything without touching
the colours.

Group is a **mask, not an index** — `03` addresses the wristband (`01`) and the pixel
module (`02`) together. That is the clearest thing to demonstrate with two boards.

Operational modes map onto the `aura` subcommands. **Listen only** is the one worth
showing: it takes fleet uplink to zero, and it exists because downlink cost is flat
regardless of crowd size while uplink scales linearly and is what actually breaks at
tens of thousands of devices.

## A note on parsing

Lines are stripped of ANSI escapes before parsing. The gateway sets
`CONFIG_SHELL_VT100_COMMANDS=n` so it shouldn't emit any, but a shell redraw around
async telemetry will otherwise inject `\x1b[8D\x1b[J` mid-line and silently corrupt a
reading. Defensive, cheap, and it means an older gateway build still works here.

The protocol tables at the top of the `<script>` mirror `include/aura_radio.h`. If they
drift, the header wins — that is the repo rule.

## Logo

`assets/` is empty. The only logo in the repo (`DEMOS/traitors/visualiser/assets/`) is a
heavily cropped fragment of a curve that doesn't read at header size and is dark-on-
transparent, so it would vanish on black. The wordmark is set in type instead. To use a
real asset, drop an SVG in `assets/` and replace the `.wordmark` div — there's a comment
in the CSS marking the spot.
