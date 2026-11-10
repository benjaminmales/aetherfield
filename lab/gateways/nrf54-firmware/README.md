# Gateway nRF54 firmware — protocol v2

Seeed XIAO nRF54L15. Hardware PAN/address filtering (PAN `0xAE7F`, addr `0x0001`).
RX `BEACON` / `EVENT` / `CONTACT` / `NODE_RELAY`; TX `CMD` and `SYNC`.

Protocol: [`PROTOCOL.md`](../../PROTOCOL.md). Constants: [`include/aura_radio.h`](../../include/aura_radio.h) — the source of truth.

## Host line protocol

Two formats come out of the console, deliberately.

**v2 structured lines** — split on spaces, then on `=`. Readable in CoolTerm, parseable by the test bridge. `<` is received, `>` is sent.

```
>READY proto=2 pan=AE7F addr=0001 ch=15 txpwr=8
<BCN a=1A2C n=0 r=-62 caps=01 batt=87 fl=00 cseq=01
<EVT a=1A2C n=0 r=-55 t=gesture v=2 s=100
<CON a=1A2C n=0 r=-58 peer=2B41 pr=-62 ev=open
<V0  a=1A2C n=0 r=-60 fl=04
<RAW len=21 r=-70 41880...
>CMD seq=01 grp=00 anim=01/00 op=00/0 rgb=FF0000 br=128 df=00 dst=FFFF
>SYNC epoch=1234567 hop=0/0 wave=0
```

`n=` is the relay node id, `0` meaning heard directly.

**Legacy `NODE:` lines** are still emitted for `pi-bridge`'s `parseTelemetryLine()`.
Migration order is gateway first, so the Pi has to keep working while the bands are
still on v0. Delete these once the bridge speaks `<`.

## Shell

```
aura anim <mode> <param> <r> <g> <b> [bright]   set the look
aura op <mode> [param]                          set the radio/power state
aura color <r> <g> <b> | aura bright <0-255> | aura group <mask>
aura show                                       LISTEN_ONLY — zero uplink
aura live                                       back to NORMAL
aura rollcall [window/100ms]                    slotted census
aura social <rssi_dbm>                          proximity detection
aura sleep <seconds>                            duty-cycled sleep
aura identify <addr>                            unicast locate
aura fleet                                      devices + delivery rate
aura cmd <grp> <anim> <animp> <op> <opp> <r> <g> <b> <br> [df] [dst]

sync [wave_step] · autosync <0|1> · hop <ch> · chan <ch>
promisc <0|1> · ant <onboard|ext> · stats · info
```

`aura <mode> <rate> <r> <g> <b>` (five numeric args) still works — it's the legacy
v0 syntax `pi-bridge/server.js` writes, mapped onto v2 animation modes.

### The two commands worth knowing

**`aura show`** puts the fleet in listen-only. Downlink cost is fixed regardless of
crowd size but uplink scales linearly and is the binding constraint at 10k–50k
devices, so this is the gateway's main capacity control. `aura live` brings telemetry
back.

**`aura fleet`** prints the delivery rate. Every beacon echoes the last command
sequence that device acted on, so comparing against the current sequence tells you
what fraction of the fleet is actually current. On an unacknowledged broadcast
protocol this is the only visibility available.

## Unicast

`CMD` is normally broadcast, but the MAC header carries a destination and devices run
hardware address filtering — so targeting one device costs nothing and needed no
protocol change. That's how `aura identify` reaches a single band.

## Build

```bash
west build -b xiao_nrf54l15/nrf54l15/cpuapp . -d build
west flash
```

### Where the serial output goes

**Default build → the XIAO's USB-C port.** Console and shell sit on `uart20`, which
the onboard SAMD11 bridges to USB. 115200 8N1. You should see `>READY proto=2 ...`
at boot.

`uart21` is P2.07/P2.08 — the **D6/D7 header pins** that go to the Pi. Nothing appears
on USB when that's selected, which is what the old default did. For the Pi link:

```bash
west build -b xiao_nrf54l15/nrf54l15/cpuapp . -d build-pi -p \
  -- -DBOARD_ROOT=/Users/benjaminmales/platform-seeedboards/zephyr \
     -DEXTRA_DTC_OVERLAY_FILE=pi.overlay
```

`bench.conf` and `bench.overlay` are no-op leftovers from when USB was the opt-in;
they can be deleted.

## Antenna

`rfsw_pwr` (P2.03) powers the switch IC, `rfsw_ctl` (P2.05) selects the antenna.
Default is external (u.FL/IPEX). If range is poor, try `ant onboard` live before
changing the default.

## Migration

`AURA_ACCEPT_V0_AT_GATEWAY` keeps v0 decoding compiled in. v0 frames use PAN `0x1234`
and a malformed FCF, so they're only visible with `promisc 1` — that's exactly the
fragility v2 removes, but during migration you still want to see them.

The previous v1 firmware is kept at `src/main_v1.c.bak`.
