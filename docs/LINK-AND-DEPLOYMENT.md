# Protocol

Two protocols, one hop apart.

```
device ──── Aetherfield radio v2 (802.15.4) ────► gateway ──── link protocol (TCP) ────► server
```

**`include/aura_radio.h` is the source of truth for the radio.** It is compiled into
every firmware image, so it cannot drift from what actually transmits. This document
explains and points at it. Where the two disagree, the header wins and this document
is a bug.

The **link protocol** below has no header — this document *is* its specification.

---

## 1. Radio, in brief

| | |
|---|---|
| PHY | IEEE 802.15.4, 2.4 GHz, 250 kbps |
| PAN | `0xAE7F`, hardware-filtered |
| Channels | 15, 20, 25, 26 (default 15) — chosen to sit between Wi-Fi 1/6/11 |
| FCF | `0x8841` — data, no ACK, PAN compression, 16-bit addressing |
| TX power | +8 dBm |
| Identity | the 16-bit MAC short address. It appears in no payload. |

Frames carry a fixed layout, not TLV. The header documents why: downlink airtime is
effectively free — one broadcast reaches the whole room in ~4 ms regardless of fleet
size — so TLV's extensibility wasn't worth the parse complexity across four firmware
trees, a Node bridge and a browser app. The capability bitmap does the same job:
every device receives every field, and its caps decide which ones it acts on.

### Message ids

| id | Name | Direction | Length |
|---|---|---|---|
| `0x02` | EVENT | band → gw | 5 |
| `0x03` | BEACON | band → gw | 6 |
| `0x04` | CMD | gw → bands | 13 |
| `0x05` | NODE_RELAY | node → gw | var |
| `0x06` | CONTACT | band → gw | 6 |
| `0x07` | SYNC | gw → all | 9 |

### The two orthogonal axes

`op_mode` and `anim_mode` are separate fields and must stay that way. The normal state
during a show is "listen-only **and** animating"; folding them into one enum forces a
cross-product that doubles every time either axis grows.

- **`op_mode`** — what the radio and power state are doing. `NORMAL`, `LISTEN_ONLY`,
  `ROLL_CALL`, `SOCIAL`, `LOW_POWER`, `SLEEP`, `IDENTIFY`. This is the fleet's uplink
  capacity control: uplink scales linearly with device count and is the binding
  constraint at our scale, while downlink does not.
- **`anim_mode`** — what the light is doing. `OFF`, `STEADY`, `FLASH`, `PULSE`,
  `HEARTBEAT`, `RAMP`, `STROBE`, `RAINBOW`, plus spatial modes from `0x10`. Ignored by
  devices without `AURA_CAP_RGB_LED`.

### CMD — the one downlink frame (13 bytes)

```
[0] msgid 0x04   [1] ver   [2] seq        [3] group
[4] anim_mode    [5] anim_param
[6] op_mode      [7] op_param
[8] R  [9] G  [10] B  [11] bright        [12] dev_flags
```

Broadcast, unacknowledged, repeated `AURA_CMD_REPEAT` (3) times. Devices dedupe on
`(src, seq)`. `group` of `AURA_GROUP_ALL` (0) addresses everyone.

---

## 2. The Pixel device profile

Pixel is the simplest possible device on this protocol: **one LED, no sensors**.

| | |
|---|---|
| MCU | nRF54L15 (Seeed XIAO or Holyiot 25008 module) |
| Output | single LED — colour TBC, see below |
| Capabilities | `AURA_CAP_RGB_LED` only |
| Fleet | 5,000 units |

Everything else in the capability bitmap is absent, and that is the point: a Pixel
receives the full 13-byte CMD and acts on `anim_mode`, `anim_param`, `bright` and —
if the LED is RGB — `R/G/B`. It ignores the rest. No special-casing anywhere in the
stack.

**Open question — is the LED single-colour or RGB?** If single-colour, `R/G/B` are
ignored and brightness plus animation carry everything. The protocol needs no change
either way; it only changes what a Pixel does with a frame it already receives. Worth
settling before the firmware partner starts, because it decides whether the LED driver
is one PWM channel or three.

---

## 3. Two changes this deployment requires

Both are one-line header changes with fleet-wide consequences. They are the first
things to agree with the firmware partner.

### 3.1 Beacon interval: 1 s → 10 s

`AURA_BEACON_DEFAULT_MS` is currently **1000**. That does not survive this fleet.

A v2 BEACON is 6 bytes of payload; with the 9-byte MAC header, FCS and PHY preamble
it is roughly 24 bytes on air — about **768 µs** at 250 kbps.

With 20 gateways and 5,000 devices, the *average* is 250 devices per gateway. But
gateways near an entrance or a stage hear far more than their share, so plan for
worst case, not average:

| Devices in range of one gateway | at 1 s | at 10 s |
|---|---|---|
| 250 | 19% airtime | 1.9% |
| 500 | 38% | 3.8% |
| 1000 | 77% — saturated | 7.7% |

CSMA-CA degrades badly well before nominal saturation, so the 1 s column is optimistic.
At 10 s every plausible density is comfortable, and battery life over a three-day event
improves roughly in proportion.

**Progress tracking does not need per-second presence.** A guest arriving at a
checkpoint is not a sub-second event. The compiled default is 5 s, and the fleet is
re-rated over the air with `aura op 0 <param>`, so the operating interval is chosen at
the venue from measurement rather than fixed here.

**Jitter is re-drawn on every beacon, not derived from the address.** It is zero-mean
about the period, spread over a quarter of it. An address-derived offset is constant
for a device, which spreads the fleet once at power-on and then locks it: two devices
sharing an offset have identical periods, so once they drift into phase they stay
there and collide on every beacon. That failure hides inside an average — most of the
fleet is fine while a few devices are never heard — and it breaks the assumption that
a device's successive beacons fail independently, which is what detection maths rests
on.

### 3.2 Addresses assigned at flash time, not derived from FICR

The header says identity is *"FICR-derived, so no provisioning step"*. That is right
at a hundred devices and wrong at five thousand.

The band range `0x1000–0xFFFD` holds **61,438** addresses. With 5,000 devices the
expected number of collisions is `n²/2N = 5000² / 122,876 ≈ **203**`, and the
probability of at least one is indistinguishable from 1. Even 500 devices gives ~2.

A collision is not a cosmetic problem: two devices sharing an address means one
guest's progress lands on another guest's record, and no amount of cloud logic can
separate them, because the radio identity is genuinely ambiguous.

**Assign sequentially at flash time** — `0x1000` upward, 5,000 units fitting in
`0x1000–0x2387` — and print the address into the QR label in the same production step.
Collision-free by construction, and the sticker and the radio identity become the same
fact. FICR derivation stays as the fallback for dev boards, where it is genuinely
convenient. See `PROVISIONING.md`.

---

## 4. Power: local by default, commanded when needed

The agreed behaviour is that a Pixel reacts locally *and* can be commanded. The
mechanism already exists in the header: `AURA_SLEEP_RX_WINDOW_MS` (250 ms) plus
`AURA_SYNC_INTERVAL_MS` (5 s).

The device sleeps, wakes aligned to the shared clock, listens for a bounded window,
acts on anything it hears, and sleeps again. **The same clock that keeps animation in
sync is what makes the RX window schedulable** — one mechanism, two payoffs.

This is the hardest part of the firmware and the reason to settle the spec before your
partner starts. Over three days, battery life is decided almost entirely by the RX duty
cycle: always-on receive costs several milliamps continuously and will dominate
everything else on a coin cell.

`AURA_OP_LOW_POWER` and `AURA_OP_SLEEP` are the fleet-wide levers, and
`AURA_OP_LISTEN_ONLY` lets a show run with **zero uplink traffic** — worth remembering
when the room is dense and you want the airtime back.

---

## 5. Gateway ↔ server link protocol

Newline-delimited UTF-8 over a long-lived TCP connection. The gateway dials the
server; the server never dials out. This is the same text the gateway used to print to
UART, so the migration from the Pi bridge was a transport swap, not a protocol change.

Debuggable with `telnet`, trivial to emit from C with `snprintf`, and greppable in a
log — all deliberate. At a few hundred bytes per second per gateway there is no
argument for a binary framing.

### Gateway → server

```
HELLO gw=gw-01 fw=1.0.0 proto=2
<BCN a=1A2B n=3 r=-52 caps=97 batt=88 fl=02 cseq=7
<EVT a=1A2B n=3 r=-52 t=button v=2 s=100
<CON a=1A2B n=3 r=-52 peer=0C4D pr=-71 ev=open
<V0  a=1A2B n=0 r=-52 fl=02
PING
```

`HELLO` names the gateway and may be re-sent at any time — a gateway that reboots
mid-stream re-identifies cleanly without dropping the socket. Every other line is
attributed to whichever gateway sent it, which is what turns "device 1A2B is alive"
into "device 1A2B is at the north checkpoint".

| Field | Meaning |
|---|---|
| `a` | device short address, hex |
| `n` | relaying node id, 0 when heard directly |
| `r` | RSSI at the gateway, dBm |
| `caps` | capability bitmap, hex |
| `batt` | battery %, `255` = unknown |
| `fl` | device flags, hex |
| `cseq` | last CMD seq the device applied — how you confirm a command landed |
| `peer`/`pr`/`ev` | contact: peer address, peer RSSI, `open`/`close` |

### Server → gateway

Gateway shell syntax, passed through to the radio:

```
aura cmd <group> <anim> <animp> <op> <opp> <r> <g> <b> <bright> [devFlags] [dst]
aura op <mode> [param]
aura identify <addr>
PONG
```

`dst` makes a command unicast to one device; omit it for the group. `group` of `0` is
everyone.

### Rules for the gateway implementation

1. **Reconnect forever**, exponential backoff capped around 15 s. The server never
   dials out, so a gateway that gives up is gone until someone power-cycles it.
2. **`PING` when idle** (~25 s). The server replies `PONG`. This keeps NAT and switch
   state alive and gives both ends a liveness signal.
3. **Buffer while disconnected** if you can. A gateway that drops beacons during a
   30-second server restart loses presence data that cannot be recovered.
4. **One line per frame, `\n` terminated.** No line may exceed 4096 bytes; the server
   drops a connection that sends one, on the assumption it isn't a gateway.
5. **Send `HELLO` first** on every connect. Until it arrives the server can only
   identify you by IP, and the console shows `(no HELLO)`.

### Testing without hardware

`tools/sim-gateway.js` speaks exactly this protocol, including reconnect and jittered
beacons. Anything that works against the simulator works against the metal.

```sh
node tools/sim-gateway.js --host 10.10.0.1 --id gw-01 --devices 250 --interval 10000
```

That is also the load test: one laptop can present a gateway's worth of event traffic.
