# pixel-led-test

Bring-up for the high-brightness blue LED modification on HOLYIOT-25008 V1.0.

Minimal on purpose — no radio, no IMU, no Edge AI. If the LED doesn't light
here, it's the hardware or the overlay, and nothing else is in the way.

## Hardware this expects

- S1 removed; P1.11 (old KEY net) drives Q2's gate
- **R2 re-routed from pull-up-to-VDD to pull-down-to-GND** — without this the
  gate floats high through reset and the LED sits on
- LED2 anode to VBAT, cathode to Q2 drain, Q2 source to GND
- C19 (100 µF) VBAT to GND, close to LED2 — optional for a first test

## ⚠ There is no series resistor

Current is limited only by C19's ESR and the cell's internal resistance. With
C19 absent and a stiff bench supply, nothing limits it at all.

**Use the coin cell** (its 10–40 Ω holds you to ~10 mA — dim, but it proves the
circuit), **or a bench supply at 3.0 V with the limit set to 100 mA.**

Firmware caps duty at 10% and starts with the LED off.

## Build

```sh
west build -b holyiot_25008_nrf54l15/nrf54l15/cpuapp .
west flash
```

The board definition is not copied here — `CMakeLists.txt` points `BOARD_ROOT`
at `../holyiot`, so there is one copy of the board files for every app.

## Console

RTT, over the SWD connection you're already using. No extra wiring.

```sh
JLinkRTTViewer          # or the nRF Connect "Connect to RTT" action in VS Code
```

## Use

On boot the **RGB green blinks three times**. That's the untouched, 1 kΩ-limited
LED — if it blinks, firmware is running and pwm20 works, which separates "bad
solder joint" from "never booted" before you start hunting.

The blue stays off until you ask:

```
led info        what the PWM is set to, and whether it's ready
led duty 5      0.5% — 100 µs on, 50 Hz
led sweep       ramp 0.1% -> 2%, watch brightness track
led off
```

Start at `led duty 1` and work up.

## If the blue never lights

1. `led info` — does it say ready, channel 1?
2. `grep led_hb build/zephyr/zephyr.dts` — overlay applied?
3. `grep -A2 'buttons' build/zephyr/zephyr.dts` — should be `disabled`
4. Meter Q2's gate while `led duty 50` — should be switching
5. Check LED2 polarity. Blue LEDs give no clue when reversed; they just don't light.

## Measure this while you're here

Peak LED current on a fresh cell. Everything in the modification spec hangs off
C19's ESR, which is estimated rather than read from a datasheet. A shunt in Q2's
source leg and a scope will tell you the real figure — and that decides whether
R13 needs to be anything other than a 0 Ω link.
