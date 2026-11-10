# pixel-gateway

Aetherfield Pixel gateway. **Seeed XIAO nRF54LM20A + Adafruit W5500.**

Hears the fleet on 802.15.4, speaks the line protocol in `docs/PROTOCOL.md` to
the server over Ethernet, and relays the server's commands back to the fleet.
Replaces the UART-to-Raspberry-Pi link in `GATEWAY/nrf54-firmware`.

---

## The one design decision worth knowing

The existing gateway firmware **defines `net_recv_data()` itself**. That is the
standard raw-802.15.4 arrangement: `CONFIG_IEEE802154_RAW_MODE` leaves the
symbol undefined so the application can claim every frame the radio hears.

Zephyr's `wiznet,w5500` Ethernet driver delivers frames up the stack through
that same function. Enable the IP stack and you get a duplicate symbol; keep
the override and TCP receives nothing. They cannot both be in one image.

So the W5500 is driven through **its own TCP/IP stack**, which it has in
silicon - eight hardware sockets addressed by SPI register reads and writes.
Zephyr's networking subsystem is not in the build at all.

What that buys:

- The proven radio code is untouched. Not ported, not adapted - untouched.
- No DHCP client, no socket layer, no `net_pkt` pool sizing.
- Deterministic: a TCP send is a handful of SPI transactions, not a trip
  through a stack whose buffers we would have to tune.

What it costs: ~400 lines of register driver we own (`src/w5500.c`), and no
DHCP or DNS for free. Both are fine here - see addressing below.

---

## Wiring

XIAO SPI is fixed at D8/D9/D10. Everything else is our choice.

| W5500 | XIAO | SoC pin |
|---|---|---|
| SCK | D8 | P1.04 (spi23 - NOT spi00, which is the onboard flash on LM20A) |
| MISO | D9 | P1.05 |
| MOSI | D10 | P1.06 |
| CS | D0 | P1.00 |
| INT | D1 | P1.31 |
| RST | D2 | P1.30 |

**Power the breakout from 5V, not 3V3.** The W5500 pulls ~150 mA with the link
up, which is more than the XIAO's own regulator should be asked for.

INT is wired but unused - the driver polls. Polling costs a few SPI reads every
5 ms and removes an interrupt path from the one part of the system that has to
survive three unattended days. Wire it anyway; the property is already in the
overlay, so moving to interrupt-driven later needs no board change.

D6/D7 are deliberately left free so `uart21` stays available as a second
console.

---

## Addressing

Static, per gateway. On a dedicated event LAN with four gateways per server
there is no DHCP server worth depending on at 3am, and a fixed address makes
"which gateway is that" answerable from a switch port.

Set in `src/gw_config.h`:

```
GW_INDEX 1   ->  10.10.0.11, HELLO gw=gw-01, source port 50001
GW_INDEX 2   ->  10.10.0.12, HELLO gw=gw-02, source port 50002
```

Build a different unit without editing the file:

```sh
west build -b xiao_nrf54lm20a/nrf54lm20a/cpuapp . -d build-gw02 -p \
  -- -DEXTRA_CFLAGS="-DGW_INDEX=2"
```

The MAC address is derived from the SoC's factory device ID with the
locally-administered bit set, so it is unique per unit with no provisioning
step - which matters when twenty of these go into a venue.

---

## Downlink costs nothing extra

`link.c` hands every inbound line to `shell_execute_cmd()`. Every command the
server can send - `aura cmd ...`, `aura op ...`, `aura identify ...` - is
already a shell command in `main.c`, already tested from the console, and is
now reachable from the network with **no second parser to drift from the
first**. `PING`/`PONG` are the only lines handled specially.

Command output goes to the console, not back down the socket. The server learns
what happened from the next round of beacons, each of which carries the CMD seq
the device actually applied - a better acknowledgement than the gateway saying
"I sent it".

---

## Building

Requires **nRF Connect SDK 3.4.1** (verified build, 2026-10-13). Seeed's current
LM20A board files include `nordic/nrf54lm20a_cpuapp.dtsi`, which 3.2.x does not have. Check the board is visible first:

```sh
west boards | grep lm20a
```

If nothing comes back, add Seeed's board files - clone
`Seeed-Studio/platform-seeedboards` and point `BOARD_ROOT` at its `boards`
directory - for these boards that is `zephyr/nrf`, not the repo root, exactly as we did
for the Holyiot board.

```sh
west build -b xiao_nrf54lm20a/nrf54lm20a/cpuapp . -p always
west flash
```

The XIAO carries a SAMD11 running CMSIS-DAP, so it flashes over its own USB-C
with no external probe.

---

## Bring-up order

Do these in order; each one rules out everything before it.

1. **`VERSIONR`.** On boot the log prints the W5500 version or an error. It is a
   constant `0x04`. Anything else means SPI wiring or chip select, and nothing
   after this point is worth looking at.
2. **`Ethernet link up`.** Straight from `PHYCFGR`. If this never appears it is
   the cable or the switch port, not the firmware.
3. **`link established`.** Socket 0 reached ESTABLISHED and `HELLO` went out.
4. **Telemetry.** `<BCN ...` lines appear on the console *and* at the server.
   They are mirrored deliberately: a human on USB sees exactly what the server
   sees, which is what you want when the two disagree.

Test the server end without any of this hardware:

```sh
node tools/sim-gateway.js --host 10.10.0.1 --id gw-01 --devices 250
```

The simulator speaks the identical protocol, so anything that works against it
works against the metal.

---

## Board facts still to confirm

Two things about the LM20A board that we assumed from the nRF54L15 XIAO and
should verify rather than inherit:

- **Antenna switch.** The nRF54L15 board aliased `rfsw-ctl` to `pdm_imu_pwr`.
  `main.c` now compiles that out when the node is absent and `ant` reports
  "antenna is fixed", so a missing switch is no longer a build failure - but if
  the LM20A *does* have one under a different name, wire the alias up or the
  external antenna path stays unpowered and range will be poor for no visible
  reason.
- **`zephyr,ieee802154`.** `main.c` takes the radio from `DT_CHOSEN`. If the
  board files do not set it the build fails immediately and obviously; add it
  to the overlay.
