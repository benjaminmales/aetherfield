# AURA seeed wristband — protocol v2

XIAO nRF54L15 + LP5012 (4× RGB) + LSM6DSO IMU + PDM mic + Nordic Edge AI.

## What lives where

The radio, the `op_mode` state machine and the animation engine are **not in this
project** — they're in [`AURA/common/aura_band.c`](../common/aura_band.c), shared with
the other bands. This tree holds only what's specific to this hardware:

| | |
|---|---|
| `src/main.c` | LP5012 driver, IMU/ML/mic sensing, `render()`, gesture→radio bridge |
| `../common/aura_band.{c,h}` | radio, CMD/SYNC receive, op_modes, animation, beacons |
| `../../include/aura_radio.h` | the protocol itself — source of truth |

The seam is one callback:

```c
static void wristband_render(uint8_t r, uint8_t g, uint8_t b);
```

v2 treats every device as **one light source** however many LEDs it carries, so the
shared layer computes a single colour and this board paints it across all four LP5012
channels. Spatial modes are reserved at `anim_mode` `0x10+` for when that changes.

## What changed from v0, and why it matters

**v0 had three things fighting over the LEDs**: the animation thread, the mic thread
(mode 7), and local clap effects — arbitrated by a priority ladder inside
`led_animation_thread`. The practical result was that a band which heard a noise
stopped showing the show.

In v2 the animation layer owns the light unconditionally, and sensing reports
*upward* instead of painting. The crowd stays coherent, and the gateway decides what a
clap should look like — which is the whole point of a centrally-directed show.

Concretely:

- `imu_led_thread` is gone. It painted raw accelerometer values as colour — useful as
  a bring-up check, incompatible with a show.
- `led_animation_thread` and `handle_led_animation` are gone, replaced by the shared
  animation engine.
- The mic no longer writes LEDs. It still computes a level (`mic_brightness`) and now
  reads sensitivity from the commanded `anim_param`.
- Gestures and claps become `EVENT` uplinks plus beacon flags, via
  `sense_bridge_thread`.
- The v0 fixed-offset `psdu[15..20]` parse is gone entirely.

## Identity, capabilities, groups

The 16-bit short address is derived from the chip's factory ID at boot — no
provisioning. Capabilities are `AURA_CAPS_XIAO_BAND` (`RGB_LED | HP_LED | IMU | MIC |
MULTI_LED`), advertised in every beacon so the gateway learns the fleet passively.

Group mask defaults to `0x01`. Change it in `main()` until there's a provisioning
path.

## If the LED board isn't fitted

`app_init()` failing leaves `g_have_led` false and `render()` becomes a no-op — the
band still runs the radio and sensing normally. Useful for bare-module testing.

## Build — two profiles

**Battery / demo** (ships with serial and logging off, because a shell backend
waiting on the console blocks boot when the band runs from its cell with no USB):

```bash
west build -b xiao_nrf54l15/nrf54l15/cpuapp . -d build -p \
  -- -DBOARD_ROOT=/Users/benjaminmales/platform-seeedboards/zephyr
west flash
```

**Bench / bring-up** — every `printf()` in `main()` and `app_init()` compiles to
nothing in the demo build, so a board that fails to start tells you nothing. Use this
while getting it working:

```bash
west build -b xiao_nrf54l15/nrf54l15/cpuapp . -d build-debug -p \
  -- -DBOARD_ROOT=/Users/benjaminmales/platform-seeedboards/zephyr \
     -DEXTRA_CONF_FILE=debug.conf
west flash -d build-debug
```

Console is uart20 → SAMD11 → the XIAO's USB-C port. CoolTerm at 115200 8N1.
**Don't flash a debug build for a battery demo.**

## Demoing the two boards together

The wristband is group `0x01`, the pixel module is `0x02`, so the gateway can address
them independently — which is the clearest way to show group addressing on a bench
with two devices:

```
aura group 00                 # everyone
aura group 01                 # wristband only
aura group 02                 # pixel only
aura group 03                 # both — a mask, not an index
```

Then:

```
aura anim 1 0 255 0 0 200     # steady red
aura anim 3 200 0 0 255       # blue breathe, 2s
aura anim 4 100 255 0 0       # heartbeat red
aura bright 40                # dim the room without touching the colours
aura fleet                    # both bands, with delivery rate
aura identify <addr>          # unicast white blink — proves MAC filtering
aura show / aura live         # zero-uplink show mode, and back
```

`aura fleet` is the end-to-end test: a band only appears there if it heard a command,
acted on it, and echoed the sequence number back in its beacon.

The wristband reports `caps=17` (`RGB_LED | HP_LED | IMU | MIC | MULTI_LED`), the
pixel `caps=01` (`RGB_LED`). Both take the identical command frame — that difference
in the fleet table *is* the capability model.

Previous v0 firmware: `src/main_v0.c.bak`.
