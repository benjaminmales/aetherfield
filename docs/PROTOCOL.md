# Aetherfield radio protocol — v2

**`include/aura_radio.h` is the source of truth.** This document is derived from it.
If the two disagree, this document is the bug.

Physical layer: IEEE 802.15.4, 2.4 GHz, 250 kbps. PAN `0xAE7F`, hardware PAN and
address filtering on. Default channel 15; the plan is `{15, 20, 25, 26}`, chosen to
sit between Wi-Fi channels 1/6/11.

---

## 1. What v2 changed, and why

**Flat fixed-layout payloads replace v1's TLV blocks.** Downlink airtime is
effectively free — one broadcast reaches the whole room in ~4 ms regardless of fleet
size — so TLV's extensibility wasn't worth the parse complexity across four firmware
trees, a Node bridge and a browser app. The capability bitmap does the same job:
every device receives every field and its caps decide which it acts on.

The cost is that adding a field is a fleet-wide version bump. Hence `ver` in every
frame, and reserved bits throughout.

**Real MAC headers replace the v0 byte-scan.** FCF is now `0x8841`. The legacy
`0x2241` had malformed addressing-mode bits and only ever worked because receivers
ran promiscuous — it will be rejected once filtering is on.

**Device identity is the 16-bit MAC short address** and appears in no payload. It's
FICR-derived, so there's no provisioning step, and carrying it once removes the class
of bug where two copies disagree.

---

## 2. The two axes

`op_mode` and `anim_mode` are orthogonal and are separate fields. The normal state
during a performance is *listen-only **and** animating*. Folding them into one enum
forces a cross-product that doubles every time either axis grows.

| Axis | Governs | Notes |
|---|---|---|
| `op_mode` | radio + power state | **This is the uplink capacity control.** Uplink scales linearly with device count and is the binding constraint at 10k–50k units; downlink does not. |
| `anim_mode` | the light | Ignored without `CAP_RGB_LED`, and by op_modes where it's meaningless. |
| `dev_flags` | device configuration | NFC. Set at deployment, not per cue. |

---

## 3. MAC header — 9 bytes, both directions

| Off | Bytes | Value |
|---|---|---|
| 0–1 | FCF | `41 88` (0x8841 LE) |
| 2 | MAC seq | increments |
| 3–4 | dst PAN | `7F AE` (0xAE7F) |
| 5–6 | dst addr | `FF FF` broadcast, or `01 00` gateway |
| 7–8 | src addr | device short address — **this is the identity** |

Addresses: gateway `0x0001` · nodes `0x0100–0x01FF` · bands `0x1000–0xFFFD` ·
unassigned `0xFFFE` · broadcast `0xFFFF`.

---

## 4. Downlink — CMD (`0x04`), 13-byte payload

| Off | Field | Notes |
|---|---|---|
| 0 | `msgid` | `0x04` |
| 1 | `ver` | `0x02` |
| 2 | `seq` | dedupe key; echoed in `BEACON.last_cmd_seq` |
| 3 | `group` | `0x00` = all; else act if `group & my_mask` |
| 4 | `anim_mode` | §4.1 |
| 5 | `anim_param` | animation period ÷ 10 ms (`0` = 1 s) |
| 6 | `op_mode` | §4.2 |
| 7 | `op_param` | meaning depends on `op_mode` |
| 8–10 | `R G B` | base colour |
| 11 | `bright` | master scale 0–255, applied **after** the animation |
| 12 | `dev_flags` | §4.3 |

22 bytes on air. ~118 payload bytes are available — the spare is deliberate headroom.

### 4.1 anim_mode

Every device is treated as **one light source**, however many LEDs it has. Spatial
modes are reserved at `0x10+` so multi-LED chasers arrive later as new enum values,
never as a frame-layout change.

| # | Mode | Behaviour |
|---|---|---|
| `00` | OFF | dark |
| `01` | STEADY | solid RGB |
| `02` | FLASH | square, 50% duty |
| `03` | PULSE | sine breathe |
| `04` | HEARTBEAT | double pulse, 20/12/10/58 split |
| `05` | RAMP | sawtooth build-up |
| `06` | STROBE | short hard flash |
| `07` | RAINBOW | hue sweep over time |
| `08`–`0F` | — | reserved, temporal |
| `10`–`1F` | — | reserved, spatial (needs `CAP_MULTI_LED`) |

### 4.2 op_mode

| # | Mode | `op_param` | Behaviour |
|---|---|---|---|
| `00` | NORMAL | beacon period ÷ 100 ms | listen + beacon |
| `01` | LISTEN_ONLY | — | RX only, **zero TX**. Show mode. |
| `02` | ROLL_CALL | response window ÷ 100 ms | beacon once, in your slot (§7) |
| `03` | SOCIAL | RSSI threshold (dBm + 128) | proximity scan → CONTACT |
| `04` | LOW_POWER | beacon period ÷ 1 s | slow beacon, brightness capped |
| `05` | SLEEP | wake interval, seconds | radio off, then an RX window |
| `06` | IDENTIFY | — | override anim, blink white |

`IDENTIFY` is an op_mode rather than an anim_mode because it deliberately overrides
whatever the show is doing. It answers "which physical device is `0x1A2C`?" — an
operational action, not a look.

**SLEEP is always duty-cycled. There is no unbounded sleep in this protocol.** A
device that cannot hear the wake command is a brick, and 50k bricked lanyards in a
crate is not a recoverable situation. `op_param` is the off-interval; the device then
opens a 250 ms RX window, long enough to catch a repeated CMD.

### 4.3 dev_flags

| Bit | Flag | Meaning |
|---|---|---|
| 0 | `NFC_EN` | NFC tag emulation enabled |
| 1 | `NFC_WAKE` | NFC field-detect wakes the device from SLEEP |
| 2–7 | — | reserved |

NFC is configuration, not show state, and is orthogonal to `op_mode` — a lanyard can
sit in `LISTEN_ONLY` with its tag live.

**NFC is also the recovery path.** On nRF5x, NFCT field-detect can wake the SoC with
the radio completely off, so a phone tap is an out-of-band way back into any device.
That's the belt to duty-cycled SLEEP's braces: a lanyard that somehow never hears
another CMD is still physically recoverable. Worth wiring on every NFC-capable board
for that reason alone.

### 4.4 Group addressing

A device holds an 8-bit group mask. A CMD with `group = 0x00` applies to everyone;
otherwise it applies if `cmd.group & my_mask` is non-zero. A mask rather than an index
so a device can belong to several groups and one broadcast can address a union of them
— "all traitors" and "everyone" both work.

---

## 4A. Downlink — SYNC (`0x07`), 9-byte payload

| Off | Field | Notes |
|---|---|---|
| 0–1 | `0x07`, `ver` | |
| 2–5 | `epoch_ms` | LE32, the gateway's master clock |
| 6 | `hop_channel` | `0` = no hop pending |
| 7 | `hop_countdown` | SYNC frames remaining before the hop |
| 8 | `wave_step` | per-group phase offset ÷ 10 ms; `0` = unison |

**Why this is a separate message and not a field in CMD.** Phase-coherent animation
across a crowd needs a shared *clock*, not a phase byte on every command. Given a
common epoch, every device computes

```
frame = f(epoch_ms + local_elapsed, anim_mode, anim_param)
```

and two devices that agree on the time agree on the frame by construction. That keeps
CMD at 13 bytes and means a lighting cue never has to carry timing.

Unison is `wave_step = 0`. A wave is the same code path with a per-group offset added,
so an operator morphs between a crowd-wide strobe and a rolling wave by changing one
number. Group index is the lowest set bit of the device's mask.

**Broadcast every 5 s.** Downlink cost is flat regardless of crowd size, so a brisk
heartbeat is nearly free — and SYNC is the only *guaranteed* periodic downlink, which
makes it the fleet's liveness signal as well as its clock.

That ties four timings together as a set, not independent knobs:

```
SYNC_INTERVAL (5s)  <  CHANNEL_LOST (20s)  <  SHOW_LOST (60s)
CHANNEL_DWELL (7s)  >  SYNC_INTERVAL
```

A band decides the gateway is gone by not hearing downlink, so the loss timeout must
span several heartbeats or it declares the gateway missing between every pair of them.
And while hunting the channel list it must dwell longer than one SYNC interval, or it
hops straight past the heartbeat every time and can never re-acquire. Getting this
wrong produced a band that hopped channels four times a second, indefinitely, one
metre from a healthy gateway.

**Channel agility.** The gateway energy-scans `{15, 20, 25, 26}` at boot. To move
mid-show it sets `hop_channel` and counts `hop_countdown` down over ~10 SYNC frames,
then hops. Devices that missed the announcement fall back via rule 3 in §6.

---

## 5. Uplink

Split by message id rather than a shared payload field, so each has a fixed layout and
no receiver ever has to guess what it's holding.

### BEACON `0x03` — 6 bytes

| Off | Field |
|---|---|
| 0–1 | `0x03`, `ver` |
| 2 | `caps` bitmap |
| 3 | `battery_pct` (`0xFF` unknown) |
| 4 | `flags` |
| 5 | `last_cmd_seq` |

`last_cmd_seq` is the **only delivery statistic available on an unacknowledged
broadcast protocol**. One byte, no extra traffic, and it turns "the show looked wrong"
into "40% loss in the north stand".

`caps` in the beacon is what lets the gateway learn the fleet. Without it there's no
way to tell "lanyard correctly ignoring the LED fields" from "device dead".

### CONTACT `0x06` — 6 bytes

| Off | Field |
|---|---|
| 0–1 | `0x06`, `ver` |
| 2–3 | `peer_id` LE16 |
| 4 | `rssi_enc` (dBm + 128) |
| 5 | `event` — `0` open, `1` close |

Emitted on a **contact transition, not continuously**. A lanyard in a busy room sees
dozens of peers; sampling one per beacon would be a slow, biased trickle. What a venue
wants is "A met B, for how long" — so report once when a peer crosses the threshold
and stays (6 dB hysteresis, 2 s hold), and again when it drops. Uplink stays tiny and
the gateway reconstructs the graph.

### EVENT `0x02` — 5 bytes

| Off | Field |
|---|---|
| 0–1 | `0x02`, `ver` |
| 2 | `event_type` — `1` gesture, `2` button, `3` NFC read |
| 3 | `value` |
| 4 | `strength` — probability % or hold time, `0` if n/a |

### NODE_RELAY `0x05`

`msgid, ver, band_addr LE16, rssi_enc,` then the original uplink payload verbatim.

### Beacon flags

bit0 charging · bit1 low battery · bit2 hand raised · bit3 clap (latched since last
beacon) · bit4 button held · 5–7 reserved.

### Capabilities

bit0 `RGB_LED` · bit1 `HP_LED` · bit2 `IMU` · bit3 `ACCEL` · bit4 `MIC` ·
bit5 `BUTTON` · bit6 `NFC` · bit7 `MULTI_LED`.

---

## 6. Behaviour rules

1. The gateway repeats every CMD **3×**. Devices dedupe on `(src, seq)`. Downlink is
   broadcast and unacknowledged — never assume delivery.
2. **Silence from the fleet is not a fault.** In `LISTEN_ONLY` — which is how a show
   actually runs — uplink is deliberately zero. A gateway that treats a gap in received
   frames as a stall will tear its radio down and back up throughout the performance.
   Watch for a stall only when uplink is expected and devices are known.
3. A device acts on a field only if it has the matching capability. A lanyard receives
   a full CMD and ignores the animation fields. **That is the mechanism, not a special
   case.**
4. No valid downlink for **20 s** (four missed SYNCs) → start cycling
   `{15, 20, 25, 26}`, dwelling 7 s per channel. Keep beaconing while hunting — a band
   that has lost downlink may still be heard, and that is exactly when the gateway most
   wants to know it exists.
5. No valid downlink for **60 s** → fade to idle, so a band that has lost the gateway
   doesn't sit at full brightness draining its cell.
6. `bright` is applied *after* the animation, so the gateway can dim the whole room
   without recomputing colours and a device can cap itself on a low battery.
7. Unknown `anim_mode` or `op_mode` values → hold the last known-good state. Never
   fail dark mid-show.

---

## 7. Roll-call slotting

"Everybody beacon now" sent to 10k devices produces 10k simultaneous transmissions and
you hear almost nothing — CSMA collapses well before that. Each device instead derives
a slot from its own address:

```
n_slots = (op_param × 100) / 5          slot width = 5 ms
delay   = (src_addr % n_slots) × 5 ms
```

Deterministic, no coordination, no state.

**Scale limit, stated honestly:** a 25.5 s window gives 5100 slots. That is a clean
census for hundreds of devices and a lossy sample for tens of thousands. At Vegas
scale you roll-call **by group, in batches** — never the whole fleet at once.

---

## 8. Wire examples

All devices, steady red, half brightness, normal operation:

```
41 88 01 7F AE FF FF 01 00 04 02 01 00 01 00 00 00 FF 00 00 80 00
└FCF─┘ sq └PAN─┘ └dst─┘ └src─┘ id vr sq gp am ap om op R  G  B  br df
```

Beacon from device `0x1A2C`, 87% battery, acted on command `0x01`:

```
41 88 07 7F AE 01 00 2C 1A 03 02 01 57 00 01
                    └src = identity┘ id vr cp bt fl sq
```

Contact opened with peer `0x2B41` at −62 dBm:

```
41 88 08 7F AE 01 00 2C 1A 06 02 41 2B 42 00
```

SYNC at epoch 1 234 567 ms, no hop, wave step 150 ms:

```
41 88 0A 7F AE FF FF 01 00 07 02 87 D6 12 00 00 00 0F
                              id vr └─epoch LE32─┘ ch cd wv
```

---

## 9. Migration

The gateway must **dual-accept v0 and v2** for the whole transition or field bands go
dark mid-migration (`AURA_ACCEPT_V0_AT_GATEWAY`).

Order: **gateway → seeed band → pixel-xiao → holyiot → K7 → nodes.**

v0 for reference: PAN `0x1234`, FCF `0x2241`, payload ids `3` band broadcast /
`4` LED command / `5` node relay, parsed at fixed offset `psdu[15]`.

---

## 10. Not yet implemented

Marked per the repo's **⚠ GAP** convention — do not describe these in the present tense.

| Gap | Status |
|---|---|
| Clock sync accuracy | SYNC (§4A) carries the epoch, but the device-to-device spread has **never been measured on hardware**. Every ≤20 ms figure in this project is design intent. Measuring it is the cheapest high-value experiment available. |
| Wave mode | `wave_step` is specified and the phase maths is in the header; no device renders from the shared clock yet. |
| Channel agility | The SYNC hop fields exist; no gateway or device implements the hop. Needed before any real venue. |
| TX power control | v1 had a `TX_POWER` TLV. Not carried into v2 — add a dev_flags bit or a SYNC field if it turns out to be needed. |
| SOCIAL / CONTACT | Specified here, not yet built on any device. |
| ROLL_CALL slotting | Specified here, not yet built. |
