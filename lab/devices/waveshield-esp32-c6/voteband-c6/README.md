# voteband-c6 — 4-option touch voting band

Aetherfield-compliant 802.15.4 voting device for the **Waveshare
ESP32-C6-Touch-LCD-1.69** (and the non-touch ESP32-C6-LCD-1.69). Shows four
answer buttons (A/B/C/D) on screen; a tap broadcasts the vote through the
existing nRF54 gateway to the pi-bridge `/votes.html` visualiser.

Speaks **protocol v1** from [`PROTOCOL.md`](../../PROTOCOL.md) /
[`include/aura_radio.h`](../../include/aura_radio.h) — same frames as the
xiao `voteband`, so the gateway needs **no changes**.

```
voteband-c6 ──802.15.4──> nRF54 gateway ──serial──> pi-bridge ──SSE──> votes.html
   (BEACON 1 Hz + EVENT on tap)      "EVENT: band=0x.. button action=N"
```

## Behaviour

- **BEACON** 1×/s: caps `0x34` (BUTTON|IMU|MIC), battery `0xFF` (not wired
  up yet), gesture byte = current vote (0 none, 1–4 = A–D). Beacons re-sync
  the visualiser if EVENT frames are missed.
- **EVENT** on tap: `type=BUTTON, value=1..4`, repeated 3× with one app seq
  (gateway dedupes on `(src, seq)`).
- **Downlink** (broadcast CMD/NET, hardware PAN+addr filtered):
  - `LED` TLV → coloured accent bar under the header
  - `HAPTIC` TLV → pulses the selected button (no motor on this board)
  - `VOTE_CTRL` TLV (new, `0x04`): action 0 = clear vote / open round,
    1 = close round
  - `CHANNEL_HOP` / `TX_POWER` NET TLVs honoured (channel shown in header)
- Identity: 16-bit short address hashed from the efuse MAC via
  `aura_band_addr_from_deviceid()` — no provisioning, same scheme as Nordic
  FICR bands.

## Board variants

`main/board.h` carries the pin map (verified against Waveshare's BSP:
SCLK 1, MOSI 2, DC 3, RST 4, CS 5, BL 6; I2C SDA 8 / SCL 7; touch INT 11;
BOOT 9; PWR key 18; BAT_EN 15).

- **Touch-LCD-1.69** (default): tap an answer to vote.
- **LCD-1.69 (no touch)**: build with `-DBOARD_HAS_TOUCH=0` appended to
  `idf.py` (or edit `board.h`). BOOT button short-press cycles the
  highlight, long-press (≥600 ms) casts the vote. BOOT/long-press also
  works on the touch variant as a fallback.

## Build & flash

Requires **ESP-IDF ≥ 5.3** (Waveshare recommends 5.5 for this board). No
managed components — the LCD uses IDF's built-in ST7789 driver and the
CST816T touch is a raw I2C driver, so the build works offline.

```sh
cd AURA/voteband-c6
idf.py set-target esp32c6
idf.py build flash monitor
```

Expected log: `aura-radio: up: addr=0x1A2B pan=0xAE7F ch=15`.

## Verify on air

AURA sniffer (promiscuous hex dump) should show a 16-byte beacon ~1×/s:

```
41 88 <seq> 7f ae ff ff <src_lo> <src_hi> a7 11 <seq> 34 ff <vote> 00
```

and on tap, 3 EVENT frames: `... a7 12 <seq> 02 <1..4> 00`.

`test/host_frame_test.c` builds the same frames on the host and asserts
these bytes: `cd test && make` (or see the file header).

## Visualiser

On the Pi (`GATEWAY/pi-bridge`): open **`http://<pi>:<port>/votes.html`**.
Live tally over SSE, latest-vote-per-band, "New round" button
(`POST /api/votes/reset`). Raw state at `GET /api/votes`.

## Known gaps / next steps (600 units by October)

- Battery % is reported unknown — wire the fuel-gauge/ADC path and feed the
  beacon battery byte.
- Channel-loss fallback (cycle the channel list after 10 s of downlink
  silence) is not implemented — the gateway doesn't emit periodic downlink
  yet, so it would false-trigger. Add alongside a gateway NET heartbeat.
- `VOTE_CTRL` needs a gateway TX path (nRF54 shell cmd + pi-bridge endpoint)
  so the operator's "New round" also clears the bands' screens.
- The Touch-AMOLED-2.06 watch (SH8601 AMOLED, different pins) needs its own
  `board.h` + gfx glue when the two units arrive; radio/ui/protocol code
  carries over unchanged.
