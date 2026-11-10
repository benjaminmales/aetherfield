# Scale rehearsal — 3,000 devices on three gateways

Twenty nRF54L15-TAG boards each run the **shipping Pixel firmware** and, on
top of it, beacon as 150 more addresses. Three real gateways. One room.

```
stress/
  loadgen/   nRF54L15-TAG — real aura_band + a virtual fleet
  server/    dedupe, delivery measurement, RSSI positioning, live map
```

---

## This is the real firmware

`loadgen` is not a simulator. It links `firmware/common/aura_band.c` — the
same file the K4, the Holyiot and the XIAO Pixels run — and adds exactly one
thing: after beaconing as itself, the board beacons as 150 other addresses
through the same radio, using the same frame writers.

So all of this is the production code path, because it *is* the production
code path:

- CMD receive, sequence dedupe, group matching
- the op_mode state machine
- the shared-clock animation engine at 50 Hz
- SYNC and the channel-loss fallback

**The LED obeys real commands.** The TAG's RGB LED is wired to `aura_band`'s
render callback, so sending a colour from the dashboard turns twenty boards
together. That is not a proxy for downlink delivery — it is downlink delivery,
visible from across the room.

Two functions were added to the shared layer for this, both inert unless
called and neither used by any shipping app: `aura_band_beacon_as()` and
`aura_band_tx_csma()`.

Server side matches: `/api/cmd` builds its line with `buildCmd()` from the
shipping server, not a string assembled locally. Both ends of the command path
are the real ones, or the test measures something else.

---

## Why three gateways is a fair floor

The reassuring version of this argument is also the true one, provided you
state the exception.

**Uplink: strictly monotonic.** Gateways are receivers. Adding them can only
add chances that a given beacon is heard by *someone* — a frame that reaches
1 of 3 would also reach 1 of 30. A delivery rate measured on three gateways is
a lower bound for thirty.

**Geography: this is the worst case.** Twenty boards in one room is a single
collision domain carrying all 3,000 frames. A venue spreads the same fleet
across ground where each patch of air carries only its local devices, which is
what makes 3,000 feasible at all. More space is strictly easier.

So: three gateways in one room is the floor, and both of the things you add
later — receivers and distance — only help.

**The exception, which must be said out loud.** Downlink is *not*
automatically better with more gateways: they are transmitters, and thirty of
them receiving the same command within milliseconds of each other used to mean
ninety frames inside 75 ms from thirty radios that can all hear each other.
They collided with each other and jammed every device beacon in the building,
at the exact moment the show wanted to change colour. That is now fixed —
`GW_CMD_STAGGER_MS` spreads them by `(index-1)×3 ms` — so the claim holds. It
holds *because of that change*, not by itself.

---

## The arithmetic you are testing against

A beacon is 23 bytes on air — 6 B PHY, 9 B MHR, 6 B payload, 2 B FCS — which
at 250 kbps is **736 µs**.

| Fleet | Interval | Offered | Raw channel |
|---|---|---|---|
| 3,000 | 1 s | 3,000/s | **221%** — impossible |
| 3,000 | 10 s | 300/s | 22% |
| 1,000 | 10 s | 100/s | 7% |

The ceiling is lower than 100%. The shipping firmware transmits with
`IEEE802154_TX_MODE_DIRECT` — it does **not listen before it talks** — so the
uplink is unslotted ALOHA, which peaks near 18% and then degrades: past the
peak, adding devices delivers *fewer* beacons, not more.

`sim csma 1` switches the real firmware to CSMA/CA at identical offered load.
Running the same sweep both ways produces the most valuable number here: what
carrier sense is worth to this design. That is a product decision with
evidence attached rather than an argument.

---

## Running it

### Boards

`nrf54l15tag` ships with the SDK, so unlike the Holyiot and XIAO boards this
one needs **no `boardRoots` setting** — the picker will just list it.

**Twenty boards, from the terminal (recommended):**

```sh
cd stress/loadgen
./build-all.sh          # all twenty images, once, unattended
./flash.sh 3            # then per board: plug in, run, unplug
```

**One board, in the VS Code GUI:** *Add Build Configuration* →
Board target `nrf54l15tag/nrf54l15/cpuapp` → expand the optional settings and
put `tag01.conf` in **Extra Kconfig fragments** → Build Configuration. Set the
build directory name to `build-tag01` so configurations do not overwrite each
other; each one you add appears separately in the Applications panel and you
switch between them there.

The GUI is fine for one or two. It is the wrong tool for twenty: the fragment
is the *only* difference between the images, and twenty passes through a
dialog is twenty chances to flash board 7 with board 6's block.

`tag01.conf` .. `tag20.conf` set `CONFIG_SIM_BLOCK`, the one thing that must be
unique per board. Two boards sharing a block emit the same addresses, the
server merges them, and the fleet looks half its true size — indistinguishable
from 50% packet loss. **After flashing, `sim stats` reports the block**; if it
is not the one you meant, you have just flashed the wrong image, and that is
the only moment it is cheap to notice.

Virtual addresses are `0x1000 + block*150 + i`, so twenty boards cover
`0x1000`–`0x1BB7` contiguously. Each board *also* beacons as itself on its
FICR-derived address, so expect 20 devices outside that range; the dashboard
counts them separately. Those twenty are the interesting ones — they are the
LEDs you can see.

#### The console is RTT, because this board has none

The nRF54L15 TAG defines no UART and no `zephyr,console` — its entire
defconfig is `CONFIG_GPIO` and `CONFIG_ARM_MPU`. It is a tag, not a
development kit, and there is nowhere to plug a serial cable.

So the shell and log run over **RTT**, on the same SWD connection you flash
through. Open it with the nRF Connect extension's RTT terminal, or
`JLinkRTTViewer`. No wiring.

(If you ask for `SHELL_BACKEND_SERIAL` on this board the failure is horrible:
Kconfig quietly drops `UART_CONSOLE` with one warning near the top of the log,
then `shell_uart.c` fails to compile on an undeclared
`__device_dts_ord_DT_CHOSEN_zephyr_shell_uart_ORD` several hundred lines
later.)

#### Sweep the load over the air, not board by board

The beacon interval comes from the commanded **`op_param`**, exactly as it
does on a real Pixel: `op_param × 100 ms`, 0 meaning the 1 s default. So from
the dashboard's Light panel:

| Op 0, param | Interval | 3,000 devices offer |
|---|---|---|
| 100 | 10 s | 300/s |
| 10 | 1 s | 3,000/s |
| 3 | 300 ms | 10,000/s |

One broadcast re-rates every virtual device on every board at the same
instant, through the real protocol. Twenty boards with no UART would otherwise
mean twenty RTT sessions, and a sweep where each board changes at a different
moment is a smear rather than a measurement. The dashboard updates its own
expectation to match automatically.

```
sim stats          offered load, commanded state, clock sync
sim rate 0         follow the fleet (default)
sim rate 2000      override THIS board only
sim devices 50     fewer virtual devices per board
sim csma 1         CSMA/CA instead of DIRECT
sim run 0          stop the virtual fleet (the board stays a real Pixel)
```

### Gateways

```sh
cd firmware/gateway
west build -b xiao_nrf54lm20a/nrf54lm20a/cpuapp . -p always -- -DEXTRA_CONF_FILE=gw01.conf
```

**Turn the console mirror down before measuring anything:**

```
mirror -1
```

At 115200 baud the UART carries about 90 short lines a second. A gateway
hearing 3,000 devices produces many times that, and `printk()` backpressure
stalls the radio receive thread — which presents as packet loss caused by a
serial port. The mirror is budgeted (`GW_MIRROR_MAX_LPS`, default 40/s) and
reports what it dropped, but for a clean run turn it off. The server always
receives everything regardless.

### Server

```sh
cd stress/server
npm install
npm start                    # console on :3200, gateways on :9000
```

`config.json` holds the venue size, where each gateway physically is in
metres, and the expected fleet. Put the three gateways in a **triangle, not a
line** — collinear receivers cannot resolve which side of the line a device is
on.

---

## The number this produces

```
expected/s = devices / (beaconInterval / 1000)
delivered  = distinct sightings/s, multi-gateway copies collapsed
delivery   = delivered / expected
```

Everything else is diagnosis; that ratio is the finding.

**Change the beacon rate on the boards and change it on the dashboard too**
(Devices / Interval / Set expectation). Delivery is measured against an
expectation, and a stale one makes the headline wrong in the flattering
direction.

Also worth watching:

- **Gateways per beacon** — how many hear an average transmission. With three
  gateways covering one room this is 3; it is what tells you what more
  gateways would cost the server later.
- **CMD adoption** — devices echo the last command sequence they acted on,
  which is the only delivery statistic an unacknowledged broadcast protocol
  has. Send a colour and watch it climb, while the room changes colour. Same
  fact, two ways of seeing it.

---

## Positioning

Measured against ground truth, three gateways in a triangle across a 40×30 m
space, 6 dB of noise:

```
median 3.6 m   p75 5.7 m   p90 8.4 m
inside the stated radius: 76%
```

Good enough for "which part of the room", not for "which table". Accuracy is
dominated by how many gateways hear a device and how they are arranged, not by
the maths — the same estimator with eight gateways reaches 2.6 m, and with two
falls to 23 m.

Every estimate carries a **confidence radius**, calibrated to contain the true
position roughly 80% of the time and to grow honestly as conditions worsen.
The map draws the ring, not a pinpoint, because a dot promises precision this
cannot keep.

RSSI is a bad ruler: bodies absorb 2.4 GHz, metal reflects it, and multipath
can make a nearer gateway report a weaker signal than a further one. The
honest use is aggregate — where the crowd is, which zones are filling, whether
the north side has gone dark.

**Calibrate before trusting any of it.** Put one device exactly 1 m from a
gateway and read the RSSI (`refRssi`); move it to 10 m and solve for
`pathLossExp`. Both are editable live on the dashboard. The defaults are
textbook values, not your venue, and every distance scales with them.

---

## Testing without hardware

```sh
node tools/sim-fleet.js --devices 3000 --gateways 3 --interval 10000
```

Opens one TCP connection per simulated gateway and emits the lines a real
gateway would, with RSSI from true distance plus noise. It announces its own
offered load and gateway positions to the server, and reports when it fails to
achieve its target rate — Node cannot always keep up, and simulator shortfall
must never be read as packet loss.

It simulates **no radio contention**: every beacon it generates arrives. A high
delivery rate here means the software is correct, not that the air will cope.
`--verify` scores positions against ground truth, which is the only way to
check that feature rather than eyeball it.

---

## Tests

```sh
cd stress/server && npm test
```

Covers the dedupe window and its boundary, multi-gateway versus same-gateway
duplicates, per-gateway RSSI isolation, the rate meter's settling behaviour,
and the position estimator against synthetic geometry — including collinear
gateways and a coverage check on the confidence radius at 3, 6, 10 and 14 dB
of noise.
