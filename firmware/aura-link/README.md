# Aura Link

Aetherfield Pixel gateway. **Seeed XIAO nRF54LM20A on the Seeed XIAO W5500 Ethernet Adapter.**

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

None. The XIAO plugs into the Seeed W5500 Ethernet Adapter and the adapter
decides everything:

| W5500 | XIAO | SoC pin |
|---|---|---|
| SCK | D8 | P1.04 |
| MISO | D9 | P1.05 |
| MOSI | D10 | P1.06 |
| CS | **D1** | P1.31 |
| INT | not routed | — |
| RST | not routed | — |

### Fit the antenna. It is not optional.

**The XIAO nRF54LM20A has no chip antenna.** Seeed's own documentation says so
plainly - *"This board uses an external Bluetooth antenna"* - and there is an
IPEX/u.FL connector and nothing else. This is a change from the XIAO nRF54L15,
which does have an onboard antenna and an RF switch to choose between the two,
and that is exactly what makes it easy to get wrong: the board looks the same,
plugs into the same header, and boots fine.

A gateway with an empty u.FL socket is not dead. It is *quiet*, which is much
harder to diagnose:

- The W5500 comes up, the link establishes, `HELLO` reaches the server, and
  the console shows a completely healthy gateway.
- The radio transmits and receives - just into ~60 dB of loss.
- Devices on the same bench read **-96 to -99 dBm**, a few dB off the noise
  floor. The nearest one or two get through; the rest are silently invisible.

The tell is a *uniform* floor across devices of different hardware types. Three
different boards with three different antenna designs all landing within 3 dB
of each other is not three device faults, it is one receiver fault.

With the antenna fitted, expect roughly **-40 to -55 dBm** across a bench. Keep
it up and away from the RJ45 shield and the Ethernet magnetics on the carrier
board, which will otherwise take back a good part of what it gains.

Two consequences worth knowing, because both look like faults if you don't
expect them:

**INT is not connected**, so an interrupt-driven driver is not an option on
this hardware. Ours polls, which was already the choice — polling costs a few
SPI reads every 5 ms and removes an interrupt path from the one part of the
system that has to survive three unattended days.

**RSTn is not connected either.** `reset-gpios` is therefore optional in the
binding, and `w5500_init()` falls back to the chip's software reset (MR bit 7),
which is sufficient on its own. Declaring the property as required — which it
was, briefly — stops the build dead on this adapter.

Power comes from the adapter: PoE stepped down by its TPS563201, or its own
USB-C. It feeds the XIAO, not the other way round.

**Hand-wired alternative.** Without the adapter, CS/INT/RST sat on D0/D1/D2
(P1.00 / P1.31 / P1.30). Add `int-gpios` and `reset-gpios` back to the overlay
and the driver picks the hard reset up automatically.

---

## Addressing

> Since 1.2 these are only the **defaults** for a Link that has never been
> configured. Set real values over USB: see "Setting a Link up over USB".

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

Requires **nRF Connect SDK 3.2.4 or later**. 3.0.x will not work: it predates the
nRF54LM20A entirely, so the SoC support - MDK, nrfx, the 802.15.4 driver - is not
there and adding board files only moves the failure later.

**The board definition is vendored in this repo**, at
`firmware/boards/seeed/xiao_nrf54lm20a/`, taken from `Seeed-Studio/platform-seeedboards`.
It is not in Zephyr mainline as shipped with NCS - checked against 3.3.4, whose
`zephyr/boards/seeed/` has `xiao_nrf54l15` but no LM20A. The SoC itself is supported
(Nordic's own `nrf54lm20dk` is present), so only the board files were missing.

That means **`BOARD_ROOT` must point at `firmware/`** - the directory containing
`boards/`, not `boards/` itself. It covers the Holyiot board in the same sweep.

```sh
west build -b xiao_nrf54lm20a/nrf54lm20a/cpuapp . -p always \
  -- -DBOARD_ROOT=$(cd .. && pwd)
west flash
```

In VS Code, add the same path to `nrf-connect.boardRoots` in the workspace settings,
and make sure the build configuration's **SDK is set to 3.2.4+** - the board will not
appear in the picker while the configuration still points at an older SDK, no matter
what else is installed.

The XIAO carries a SAMD11 running CMSIS-DAP, so it flashes over its own USB-C
with no external probe.

---

## Setting a Link up over USB (Aura Link 1.2)

**One firmware image for every Link** (`prebuilt/aura-link.hex`). Each unit's
name and network addresses are set from the USB console and kept across
reboots. The `gwNN.conf` fragments still work for a build that needs a
different *default*, but nothing needs them any more.

Connect USB-C, open a serial terminal at 115200 (the nRF Connect extension's
terminal, `screen`, or PuTTY), and:

```
link config                                   show what it's running
link set name bar-north                       how it appears in Aura Server
link set ip 192.168.1.60                      this Link (mask /24, router .1 assumed)
link set ip 192.168.1.60 255.255.255.0 192.168.1.254   ...or spell them out
link set server 192.168.1.50                  the laptop running Aura Server (port 9000)
link save
link reboot
```

The status LED then goes amber (looking for the server) and green (connected).

| Setting | Default (never configured) | Rules |
|---|---|---|
| `name` | `gw-01` (from `index`) | Up to 20 of `A-Z a-z 0-9 - _`. Becomes the zone id in the API. Pretty names ("Bar — north door") go in the Aura Server console |
| `index` | 1 | 1–30. Downlink stagger slot, so give each Link at one site a different index |
| `ip` | 10.10.0.(10+index)/24, router .254 | Must be free on the client's network. Ask their IT for a few static addresses, or use addresses outside their DHCP range |
| `server` | 10.10.0.1:9000 | The laptop's address on the same network. On macOS: System Settings → Network → (adapter) → Details |

`link defaults` erases the saved config.

All `link` commands also work when sent from Aura Server, because downlink
is the shell. **Don't change `ip` or `server` remotely**: get it wrong and
the Link can only be recovered over USB.

**Laptop firewall:** the first time Aura Server runs, macOS asks whether
`node` may accept incoming connections. Say yes, or the Links sit amber.

---

## Status light (Aura Link 1.1)

The XIAO's RGB LED reports the Link's state, so a gateway in a ceiling can be
diagnosed without a USB cable:

| Light | Meaning | Look at |
|---|---|---|
| Solid blue | Booting, W5500 not up yet | Should last under a second |
| Red, fast blink | W5500 not answering on SPI | XIAO seating on the adapter |
| Red, one pulse per second | No Ethernet link | Cable, switch port, PoE |
| Amber, blinking | Ethernet up, server not answering | `link config`: is the server address the laptop? Is Aura Server running and allowed through the firewall? |
| Solid green | Online | |
| Green + blue flicker | Online and hearing devices | |
| White flash on green | Sending a command to the fleet | |
| Fast white flashing | `link locate [seconds]`, sent from the console or the server | Finding which physical Link is which |

`HELLO` reports `fw=aura-link-1.2.0`.

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

## Board facts, checked

Both open questions from the port are now settled against Seeed's board files:

- **`zephyr,ieee802154` is set** by the board (`nrf54lm20a_cpuapp_common.dtsi`),
  so `DT_CHOSEN(zephyr_ieee802154)` in `main.c` resolves. Nothing to add.
- **The XIAO SPI header is `spi23`**, aliased `xiao_spi` - not `spi00`. The
  overlay uses the alias. Its pinctrl already maps SCK/MOSI/MISO to
  P1.04/P1.06/P1.05, which is D8/D10/D9, so no pinctrl changes are needed.
- **Console is already `uart20`**, bridged to USB-C by the onboard SAMD11, and
  chosen by the board. The overlay does not override it.

Resolved:

- **Antenna switch - there is none, and that is correct.** The nRF54L15 XIAO
  aliases `rfsw-ctl`/`rfsw-pwr` because it has an onboard antenna, a u.FL, and
  a switch to pick between them. The LM20A has only the u.FL, so Seeed's board
  files define no such node, `HAVE_RFSW` compiles to 0, and `ant` correctly
  reports "antenna is fixed". Nothing to add to the overlay. See the antenna
  warning under Wiring - the failure mode this leaves is a hardware one.
