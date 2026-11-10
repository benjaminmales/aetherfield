# pixel-xiao-nRF54

Single-NeoPixel Aetherfield band, **protocol v2**. Seeed XIAO nRF54L15 (non-Sense).
Zephyr / nRF Connect SDK v3.0.1.

Design study for the Las Vegas single-pixel form factor.

## What this project is

Almost nothing. The radio, the `op_mode` state machine, the animation engine and the
beacons all live in [`AURA/common/aura_band.c`](../common/aura_band.c), shared with the
wristband. `src/main.c` is ~90 lines whose only real job is:

```c
static void pixel_render(uint8_t r, uint8_t g, uint8_t b);
```

That's the capability model working as intended: this board advertises
`AURA_CAPS_PIXEL_XIAO` (`RGB_LED` only), receives exactly the same command frame as a
fully-loaded wristband, and acts on the parts it has hardware for. No special case, no
firmware branch.

Every pixel in the chain gets the same colour — v2 treats a device as one light source
however many LEDs it carries, so a longer strip is a `chain-length` change in the
overlay and nothing else.

## Wiring

| XIAO | Pixel | Note |
|------|-------|------|
| D4 (P1.10) | DIN | via a 470R series resistor |
| BAT + | VDD | 1S LiPo, 3.5-4.2 V |
| GND | GND | must be common with the XIAO |

Put a 10 uF cap across the pixel's VDD/GND, physically at the pixel.

D5 (P1.11) is consumed as a dummy SPI clock. Leave it unconnected.

This project takes over the board's `xiao_i2c` (`i2c22`) bus, which already owned
D4/D5. You can't use board I2C and the pixel at the same time on this instance.

## Build — two profiles

Board target: `xiao_nrf54l15/nrf54l15/cpuapp`, board root
`/Users/benjaminmales/platform-seeedboards/zephyr`.

**Battery / demo** (default). Serial and logging are off: a UART console backend waits
on the port and blocks boot when the module runs from its cell with no USB attached —
the band comes up dark and looks dead.

```bash
west build -b xiao_nrf54l15/nrf54l15/cpuapp . -d build -p \
  -- -DBOARD_ROOT=/Users/benjaminmales/platform-seeedboards/zephyr
west flash
```

**Bench / bring-up**:

```bash
west build -b xiao_nrf54l15/nrf54l15/cpuapp . -d build-debug -p \
  -- -DBOARD_ROOT=/Users/benjaminmales/platform-seeedboards/zephyr \
     -DEXTRA_CONF_FILE=debug.conf
west flash -d build-debug
```

Console is uart20 → SAMD11 → USB-C. CoolTerm at 115200 8N1.
**Don't flash a debug build for a battery demo.**

## Bring-up

Two white blinks at boot mean powered-and-running rather than powered-and-hung. In the
battery build that blink is your *only* diagnostic, since there's no console — which is
exactly why it's there. After it, the pixel stays dark until the gateway says otherwise.

From the gateway shell:

```
aura anim 1 0 255 0 0 200     # steady red
aura anim 3 200 0 0 255       # blue breathe, 2s period
aura anim 4 100 255 0 0       # heartbeat red
aura fleet                    # this band should appear, caps=01
aura identify <addr>          # unicast white blink
aura show                     # listen-only: keeps animating, stops beaconing
```

If red shows as green, the `color-mapping` in the overlay is wrong for your part —
swap `LED_COLOR_ID_GREEN` / `LED_COLOR_ID_RED` there, not in the code.

## Demoing alongside the wristband

This board is group `0x02`; the wristband (`AURA/seeedFirmware`) is `0x01`. So
`aura group 02` lights only this one, `aura group 01` only the wristband, `aura group
03` both, `aura group 00` everyone. Group is a bitmask, not an index — that's why a
device can be in several groups and one broadcast can address any union of them.

In `aura fleet` this board shows `caps=01` (`RGB_LED`) against the wristband's `caps=17`
(`RGB_LED | HP_LED | IMU | MIC | MULTI_LED`), while both act on the identical command
frame.

## How it's driven

`worldsemi,ws2812-spi` on **SPIM22**: each WS2812 data bit becomes one 8-bit SPI
frame at 4 MHz (`0x70` = 1, `0x40` = 0), clocked out by EasyDMA. The waveform is
therefore immune to interrupt jitter - no bit-banging, no interrupt locking.

D4 is on port P1, which is capped at 8 MHz on the nRF54L15. Fine for 800 kHz,
but it rules out the fast P2 peripherals if you later want a long strip.

## Gotchas

- **SPIM22 on P1.10/P1.11 collides with `i2c22` (SDA-0/SCL-0).** If this gets
  merged into `seeedFirmware` alongside the LP5012, one of them has to move.
- **Brightness tracks the cell.** WS2812B's green and blue dice need ~3.5 V on
  VDD for full output. Below that the colour skews warm and it dims; below
  ~3.2 V it may not light at all while the XIAO keeps running.
- `BRIGHT` in `src/main.c` is the master level. 255 on all three channels is
  ~60 mA off the battery.
