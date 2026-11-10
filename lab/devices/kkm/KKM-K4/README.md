# KKM K4 (nRF54L15) — board support

**Schematic-backed as of 2026-09-11** (`boards/K4_nRF54L15_SCH_V1.1.pdf`).
Everything below is read off the schematic unless it says otherwise.

## Pinout

| Function | Pin | Notes |
|---|---|---|
| **LED1** (D1, red 0603) | **P1.04**/AIN0 | R1 1 kΩ → anode, cathode to GND → **active HIGH** · PWM20 OUT0 |
| **LED2** (D2, red 0603) | **P2.03** | R3 1 kΩ, same → **active HIGH** · PWM20 OUT1 |
| KEY (SW1) | **P0.04** | switch to GND, **no external pull-up** — internal one is mandatory |
| RXD / TXD | **P0.00 / P0.01** | **UART30**, not UART20 — see below |
| SCL / SDA | P1.08 / **P1.06** | LIS2DW12TR, I²C21 |
| INT1 / INT2 | **P1.13 / P1.14** | LIS2DW12 outputs |
| *OUTPUT* | P1.05/AIN1 | labelled in the signal table, nothing attached — purpose unknown |
| LFXO | P1.00/XL1, P1.01/XL2 | X1 32.768 kHz / 7 pF / ±20 ppm — **fitted** |
| HFXO | XC1 / XC2 | 32 MHz / 8 pF / ±10 ppm |
| DCDC | DCC | **L3 4.7 µH populated** — the buck is real |
| Accelerometer | LIS2DW12TR | CS→VDDS (I²C), SA0→VDDS → **address 0x19** |

**The UART is UART30, not UART20.** P0.00/P0.01 live in the nRF54L15
low-power domain, which only the "30" peripheral instances can reach. A
`uart20` on those pins builds cleanly and then does nothing. This is the
board's first real console.

**Both LEDs are red and active high**, each through 1 kΩ — roughly 1.1 mA off
a 3 V cell. Indicators, not illuminators, and the reason a whole GPIO sweep
could flash them unnoticed. The resistor sets the ceiling; more duty won't
help.

## What the schematic corrected

The original board definition was inferred from the K7 and was wrong about
**the LED port, the LED polarity, the button pin and the UART instance** —
essentially everything not on-die. The K7's RGB is common-anode on
P1.10/11/12; the K4's are common-cathode on P1.04 and P2.03.

It also corrected our own measurement: the radio probe reported the LED at
**`v=202`**, but P2.02 has nothing attached and LED2 is on **P2.03**. The
flash was matched to the log line printed two seconds earlier — an
adjacent-slot error, worth remembering when reading any timed probe by eye.

And the probe's push-pull skip list was guarding **P1.06 / P1.07**, inherited
from the K7. The real sensor interrupts are **P1.13 / P1.14**, which the sweep
therefore drove. No harm done, but that was luck rather than care. Now fixed.

Two guesses the schematic **confirmed**: HFXO internal load caps at 8000 fF
(which is why the radio worked first time), and active-high LED polarity from
the probe.


## Four applications, one project

| Build configuration | Extra Kconfig fragments | Extra devicetree overlays |
|---|---|---|
| **v2 band + LEDs** (default) | *(none)* | *(none)* |
| **Hello world: pulse one LED** | `breathe.conf` (+ `breathe-d2.conf` to pulse the other) | *(none)* |
| Radio pin probe | `probe.conf` | *(none)* |
| Offline pin sweep | `sweep.conf` | `overlays/sweep.overlay` |
| *any of the above* + crystal LF clock | `lfxo.conf` | `overlays/lfxo.overlay` |
| *any of the above* + battery build | `lowpower.conf` | *(none)* |

All share these two fields in **Add Build Configuration**:

| Field | Value |
|---|---|
| Board target | `k4beacon_nrf54l15/nrf54l15/cpuapp` |
| Board roots | `/Users/benjaminmales/aetherfield-platform/AURA/KKM/KKM-K4` |

Keep them as *separate* build configurations so switching doesn't force a
pristine rebuild.

## The LF clock is still on RC, on purpose

X1 (32.768 kHz, 7 pF) **is fitted**, but the right
`load-capacitance-femtofarad` isn't settled. KKM's own reference says
**14000** — twice the crystal's 7 pF CL — and that matches how Nordic's boards
set this property (the nRF54L15-DK uses 15500 for a crystal nothing like that
spec), so it reads as the *internal capacitor* value rather than the crystal's.
**Our K7 board uses 7000 for a 7 pF crystal, which by that reading is wrong and
is worth re-checking there.**

Calibrated RC (~250 ppm) runs today and is fine for beaconing. Switch with
`lfxo.conf` + `overlays/lfxo.overlay` when SYNC accuracy starts to matter —
one change, one test. If the board goes dark after that, the cap value is
wrong for the fitted part; revert to RC and try 7000.

## Hello world — pulse one LED

`breathe.conf`, no overlay. What you should see, in order:

| | |
|---|---|
| **1 flash** | D1 — P1.04 — **the TOP LED** (confirmed 2026-09-13) |
| **2 flashes** | D2 — P2.03 — the bottom one |
| **25 % / 50 % / 100 %** | brightness ladder, 1.5 s per rung |
| then | a continuous ~3 s breathe on **D1** |

The flash count settled which LED is which — the schematic names nets, not
faces. **D1/P1.04 is the top one.** `breathe-d2.conf` alongside `breathe.conf`
pulses the bottom one instead.

The non-breathing LED is explicitly parked off, so "which one is pulsing" is
never ambiguous.

## How bright can it actually go?

**The breathe is not showing you the maximum.** It touches 100 % duty for about
6 ms at the top of each ~3.1 s cycle — far too brief to judge. That is what the
**third rung of the brightness ladder** is for: 100 % duty, held for a second
and a half.

At 100 % the firmware has nothing left to give. The ceiling is the hardware:

| Limit | Effect |
|---|---|
| **R1 = 1 kΩ** | With a ~3 V rail and a red Vf of ~1.9 V, about **1.1 mA**. This is the real ceiling. |
| **GPIO drive strength** | Standard drive droops well below 1 mA, so part of the rail is being dropped *inside the pin driver* rather than across the LED. **Free headroom — see below.** |
| **Supply** | Off the debugger's 3.3 V rather than a sagging CR2032, the same circuit gives noticeably more. Worth a comparison. |

### The free improvement: high drive

Add `overlays/led-high-drive.overlay` as an extra devicetree overlay. It puts
the LED pins in **H0H1**, which holds the pin much closer to VDD under a 1 mA
load, so more of the voltage lands across the LED instead of the driver.

Expect a clear step, not a transformation — it does not change R1. Costs
nothing but slightly faster edges, and it A/B tests cleanly: flash with and
without, compare the ladder's top rung.

### Beyond that, it is a rework

Dropping R1/R3 to ~330 Ω would give roughly 3.5 mA. **Check the cell before
doing it**: see [the Holyiot power analysis](../../holyiot) — a CR2032 is
3.0 V with rising ESR, the nRF54L15 browns out below 1.71 V, and LED current
comes straight off both the runtime and the voltage headroom. Both LEDs lit at
3.5 mA is 7 mA continuous, which a coin cell will not enjoy.

Brightness is what it is: 1 kΩ from a 3 V cell through a red Vf of ~1.9 V is
about 1.1 mA. A gamma curve (duty squared) keeps the fade looking even, but
the resistor sets the ceiling — more duty will not make it brighter.

Radio is off in this build. The default build (no fragment) keeps the radio and
drives both LEDs from the gateway with `aura color` / `aura anim` instead.

Doubling the light is also an option the firmware already has: the default band
build drives **both** LEDs from one render callback. They are on opposite
faces, so it does not help a single viewing angle — but it doubles what the
device puts out.

## The beacon — the real hello world

Joins the fleet through the shared `AURA/common/aura_band.c`, the same code the
wristband and pixel module run. The K4 supplies **no render callback**, so it
takes commands and lights nothing — the documented lanyard case, not a
workaround.

**This is the better first test, because it needs nothing from the schematic.**
The radio is on-die, the crystal and antenna are on-module, and *the gateway is
the console this board doesn't have*. One `<BCN` line proves, in a single step:

- the CPU boots and runs
- the 32 MHz crystal starts, on frequency
- the radio transmits
- the antenna is connected
- the board definition is sound

Watch the gateway console for:

```
<BCN a=3F0C n=0 r=-54 caps=00 batt=FF fl=00 cseq=00
```

The address is FICR-derived, so yours will differ — that *is* the K4 the first
time an unfamiliar address appears. Then `aura fleet` lists it alongside the
others, and `aura group 04` addresses it on its own (wristband is `0x01`,
pixel `0x02`).

**`caps=00` is deliberate.** The obvious choice is `AURA_CAPS_LANYARD`
(`AURA_CAP_NFC`), but the K4's NFC antenna is exactly as unverified as its LED,
and `caps` is how the gateway distinguishes "correctly ignoring a field" from
"dead". Claiming an unproven capability poisons that signal. Zero is honest,
and it makes the K4 unmistakable next to `caps=97` and `caps=01`. Add a real
`AURA_CAPS_K4` to `include/aura_radio.h` once the schematic says what's fitted.

### If the gateway hears nothing

1. **Add `overlays/hfxo-external.overlay` and reflash.** This is the first and
   most likely fix. The 32 MHz crystal must start within about ±40 ppm or the
   link simply doesn't work, and total load capacitance decides that. The board
   DTS assumes the K7's arrangement — a CL 8 pF crystal with *no* discrete load
   caps, using the SoC's internal ones. If the K4 fits its own caps instead,
   the internal ones are additive, the crystal runs over-loaded and
   off-frequency, and the radio goes **deaf and mute with no other symptom** —
   which looks exactly like a protocol bug and is not one.
2. **Check the gateway is on channel 15** (`chan` / `info`) — the K4 uses
   `AURA_CHANNEL_DEFAULT`, and if the gateway has hopped, nobody is wrong and
   nothing is heard.
3. **Try `promisc 1` on the gateway.** Rules out address/PAN filtering and
   shows raw frames, so you learn whether the K4 is transmitting *anything*.
4. Only then suspect the board definition or a dead board — and at that point
   the LED triage below applies.

**Two config lines here are load-bearing, not tuning knobs.**
`CONFIG_MAIN_STACK_SIZE=3584` — `main()` runs all of `aura_band_init()` with
MPSL and the 802.15.4 stack coming up underneath it. Our board defconfig
doesn't supply the Seeed board's 3584, so `prj.conf` must. Lowering it does not
fault cleanly; it scribbles into low RAM where `.data` lives, and both
`_sw_isr_table` and the net_buf pools were seen corrupted that way on the pixel
module. And `CONFIG_PWM=n` — so the PWM driver never applies its pinctrl and
never drives P1.10, a pin we have not confirmed is the LED.

## Finding the LED pin — the radio tells you

`probe.conf`, no overlay. Keeps beaconing **and** walks every GPIO, announcing
each pin over the radio *just before* driving it. You watch the LED; the
gateway log names the pin.

```
<EVT a=4C51 n=0 r=-55 t=? v=110 s=0
                            │     └── what happened
                            └──────── v = port*100 + pin, so 110 = P1.10
```

`v`: `0`–`4` = P0.00–04 · `100`–`115` = P1.00–15 · `200`–`210` = P2.00–10 ·
`254` = pass marker · `255` = cycle marker.

| `s` | Meaning |
|---|---|
| `0` | sweep: driven **open-drain, sinking** → active-**low** LED |
| `1` | sweep: driven **push-pull, sourcing** → active-**high** LED |
| `2` | sweep: skipped, push-pull skip list (P1.06 / P1.07) |
| `3` | `gpio_pin_configure` refused it |
| `4` / `5` / `6` | **held** sinking / sourcing / sourcing at high drive |
| `7` | released, sweep resumed |
| `8` | unknown pin code in the command |

### Manual hold — drive one pin from the gateway

A 2 s sweep slot is not long enough to get a multimeter onto a pad, and a dim
LED the eye misses is an obvious voltage step on a meter. So one pin can be
held indefinitely, commanded from the gateway:

```
aura color <pincode> <mode> 0
```

| `<mode>` | Effect |
|---|---|
| `0` | hold **sinking** (open-drain low) — lights an active-low LED |
| `1` | hold **sourcing** (push-pull high) — lights an active-high LED |
| `2` | **release**, resume the automatic sweep |
| `3` | hold sourcing at **high drive strength** |

`aura color 110 1 0` holds P1.10 high until you say otherwise. Manual hold
**will** drive P1.06 / P1.07 — the skip list only guards the *automatic* sweep,
because forcing them is a deliberate act, not something a sweep should do on
its own.

This doubles as the downlink test: `cseq` in the next BEACON should change to
the command's seq. If it does, the K4 receives as well as transmits.

### P1.02 / P1.03 are freed

`probe.conf` sets `CONFIG_NFCT_PINS_AS_GPIOS=y`, because NFC1 / NFC2 belong to
NFCT by default and refuse `gpio_pin_configure` — they showed up as `s=3` and
were never actually driven. **UICR is written at boot and takes effect after a
reset, so power-cycle once after flashing.** If they still report `s=3`, the
UICR write did not stick and `make flash-erase` is the fix. Reversible: clear
the symbol and mass-erase.

### Hunting the top LED

The bottom LED is done. For the second one, two things make it quicker:

- **The sourcing pass now runs first.** Since the bottom LED is active high,
  this board's LEDs almost certainly are — so the `s=1` lines are the ones to
  watch and the sinking pass is the unlikely one. Watch the **top face** this
  time; the first run was spent watching the bottom.
- **Four pins are still under-tested.** P1.02 / P1.03 were NFC-owned and
  refused (`s=3`) until `CONFIG_NFCT_PINS_AS_GPIOS=y`; P1.06 / P1.07 are
  skipped in the automatic sourcing pass. Force each with manual hold:

  ```
  aura color 102 1 0     aura color 103 1 0
  aura color 106 1 0     aura color 107 1 0
  aura color 0   0 2     (release, resume sweeping)
  ```

### If a whole sweep lights nothing

That is a result — it rules out most of the board. What is left:

1. **The LED may be lighting and you cannot see it.** This project has the
   precedent: the Holyiot 25008's RGB runs through 1 kΩ series resistors at
   roughly **0.2 mA per channel** — the designers had already conceded the coin
   cell can't drive an LED properly. At that current an LED is nearly invisible
   in a lit room. **Use manual hold with a meter across the pads, or a phone
   camera in a dark room.**
2. **Voltage headroom.** A blue or white emitter has Vf ≈ 2.9–3.2 V and a
   CR2032 is 3.0 V open-circuit and sags under load — there may be no headroom
   to forward-bias it at all. Powering the board from the debugger's 3.3 V
   instead of the cell is a five-second test of this.
3. **Not GPIO-driven at all** — behind a load switch, a FET whose gate needs a
   pull-down fitted, or an I²C LED driver. See the R2 gate-pullup trap in the
   Holyiot notes.
4. **Not fitted on this sample.**

**Don't run `aura show` while probing.** LISTEN_ONLY suppresses all uplink by
design, so the probe goes silent and looks broken. `aura live` restores it.

**The event is sent before the pin is driven, on purpose.** If a pin drives an
RF switch or a power rail, the radio goes quiet the moment it is touched — and
the last `<EVT` line names the pin that did it. Silence in the log is a result,
not a lost run.

## Pin sweep — the offline fallback

*(Superseded by the radio probe above, which needs no stopwatch. Kept for the
case where the radio is unavailable — it runs with `CONFIG_IEEE802154=n`, so a
silent sweep has a shorter list of suspects.)*

Drives all 32 GPIOs in turn and lets the board tell you which one the LED is
on. This is the tool for "the K4 is just wired differently", and it does not
need the schematic.

**Build configuration:**

| Field | Value |
|---|---|
| Extra Kconfig fragments | `sweep.conf` |
| Extra devicetree overlays | `overlays/sweep.overlay` |

(The overlay disables `pwm20` so the sweep can drive P1.10 as a plain GPIO —
the Zephyr nRF PWM driver claims its pinctrl pins at init otherwise.)

**How to read it — a stopwatch, nothing else.**

Start timing **at reset**. Note the second at which the LED lights. That single
number gives you both the pin and its polarity:

- **5 – 101 s** → **Pass A**, so the LED is **active-low** (common anode, like the K7)
- **109 – 205 s** → **Pass B**, so the LED is **active-high** (common cathode)
- `slot = (t − pass start) ÷ 3`

Every slot is exactly 3 s — 2.5 s lit, 0.5 s dark guard so the edge is clean. Skipped or
unconfigurable pins stay dark for their whole slot rather than shifting the
ones after them, so a time only ever maps to one pin. The cycle is 215 s and
repeats identically — **measure it twice** before believing it.

### Time → pin

| Slot | Pin | Pass A window (active-low) | Pass B window (active-high) |
|---:|---|---|---|
| 0 | **P0.00** | 5 – 8 s | 109 – 112 s |
| 1 | **P0.01** | 8 – 11 s | 112 – 115 s |
| 2 | **P0.02** | 11 – 14 s | 115 – 118 s |
| 3 | **P0.03** | 14 – 17 s | 118 – 121 s |
| 4 | **P0.04** | 17 – 20 s | 121 – 124 s |
| 5 | **P1.00** | 20 – 23 s | 124 – 127 s |
| 6 | **P1.01** | 23 – 26 s | 127 – 130 s |
| 7 | **P1.02** | 26 – 29 s | 130 – 133 s |
| 8 | **P1.03** | 29 – 32 s | 133 – 136 s |
| 9 | **P1.04** | 32 – 35 s | 136 – 139 s |
| 10 | **P1.05** | 35 – 38 s | 139 – 142 s |
| 11 | **P1.06** | 38 – 41 s | 142 – 145 s |
| 12 | **P1.07** | 41 – 44 s | 145 – 148 s |
| 13 | **P1.08** | 44 – 47 s | 148 – 151 s |
| 14 | **P1.09** | 47 – 50 s | 151 – 154 s |
| 15 | **P1.10** | 50 – 53 s | 154 – 157 s |
| 16 | **P1.11** | 53 – 56 s | 157 – 160 s |
| 17 | **P1.12** | 56 – 59 s | 160 – 163 s |
| 18 | **P1.13** | 59 – 62 s | 163 – 166 s |
| 19 | **P1.14** | 62 – 65 s | 166 – 169 s |
| 20 | **P1.15** | 65 – 68 s | 169 – 172 s |
| 21 | **P2.00** | 68 – 71 s | 172 – 175 s |
| 22 | **P2.01** | 71 – 74 s | 175 – 178 s |
| 23 | **P2.02** | 74 – 77 s | 178 – 181 s |
| 24 | **P2.03** | 77 – 80 s | 181 – 184 s |
| 25 | **P2.04** | 80 – 83 s | 184 – 187 s |
| 26 | **P2.05** | 83 – 86 s | 187 – 190 s |
| 27 | **P2.06** | 86 – 89 s | 190 – 193 s |
| 28 | **P2.07** | 89 – 92 s | 193 – 196 s |
| 29 | **P2.08** | 92 – 95 s | 196 – 199 s |
| 30 | **P2.09** | 95 – 98 s | 199 – 202 s |
| 31 | **P2.10** | 98 – 101 s | 202 – 205 s |

*(Slots 11 and 12 — P1.06 / P1.07 — stay dark in pass B only: they are the K7's
accelerometer INT lines, i.e. possible external push-pull outputs. Slots 7 and 8
— P1.02 / P1.03 — may not respond in either pass; they are NFC1 / NFC2 and stay
locked to the NFC peripheral unless UICR `NFCPINS` says otherwise.)*

**Why two passes, and why they aren't equally risky.** Pass A drives
**open-drain** — it can only sink current, so it physically cannot fight
another chip driving the same net high. It is safe on every pin, and it finds
the active-low LED the K7 house style would predict. Pass B drives
**push-pull**, which *can* contend with an external output, so the two pins
that are outputs on the K7 sit it out. Pins are configured back to
disconnected between slots, never left latched.


---

## Still unknown

| Thing | Status |
|---|---|
| `battery_pct` | No divider on the schematic. KKM's reference reads the rail directly with **SAADC on `NRF_SAADC_VDD`**, gain 1/4, internal ref — no pin needed. This would make the K4 the **first band in the fleet to report a real percentage** instead of `0xFF`. |
| LFXO cap value | 14000 (KKM) vs 7000 (our K7). See above. |
| P1.05/AIN1 "OUTPUT" | Named in the signal table, nothing attached. |
| ~~Which LED is top vs bottom~~ | **Settled 2026-09-13: D1/P1.04 is the TOP LED**, D2/P2.03 the bottom. |
| `caps` encoding | Ships `AURA_CAP_MULTI_LED` only — see the note in `src/beacon_app.c`. Button and accelerometer are **fitted but not yet driven**, and there is no "mono LED" bit to claim. |

## Pin-domain constraint worth knowing before guessing further

On the nRF54L15 there are only **three PWM instances — PWM20, PWM21, PWM22 —
and all of them live in the peripheral power domain, which reaches P1 and P2
pins only.**

`P0.00`–`P0.04` sit in the low-power domain (GPIOTE30). **There is no PWM
instance that can reach a P0 pin.** So if the schematic lands the LED on P0,
this app cannot drive it as-is — that needs software PWM or a plain GPIO
blink. Port sizes on this SoC: P0 = 5 pins, P1 = 16, P2 = 11.

That leaves 27 PWM-capable pins if the three overlays here all miss. At that
point the cheap moves are, in order: buzz the LED pad to the SoC ball with a
meter, or read out the KKM factory image over SWD **before** the first
`--erase` and look at the `PSEL.OUT` values in it.

---

## Battery builds

Layer `lowpower.conf` as an **extra Kconfig fragment** on a second build
configuration to strip the UART console and logging. Keep it separate rather
than editing `prj.conf`, so bring-up stays one click away.

## Layout

```
KKM-K4/
├── boards/
│   ├── K4_nRF54L15_SCH_V1.1.pdf       the schematic — source of truth
│   ├── KKM_reference_nrf54l15dk.overlay   KKM's demo overlay (see caveat)
│   ├── KKM_readme.txt                 KKM's notes (LIS2DW12, LFXO caps)
│   └── kkm/k4beacon_nrf54l15/         out-of-tree board definition
├── overlays/                          lfxo, sweep, hfxo-external, _superseded
├── src/main.c                         dispatches on the K4_APP choice
├── src/beacon_app.c                   v2 band + LED render (default)
├── src/pin_probe.c                    radio-narrated GPIO walk
├── src/pin_sweep.c                    offline stopwatch version
├── prj.conf                           radio + LEDs + UART console
├── breathe.conf / probe.conf / sweep.conf / lfxo.conf / lowpower.conf
└── Makefile                           CLI equivalents
```

## Caveat on `KKM_reference_nrf54l15dk.overlay`

KKM shipped this alongside the schematic, and **it does not describe this
board.** It puts LEDs on P1.10/11/12, the button on P0.02, SDA on P1.04 and
the accelerometer interrupts on P1.06/P1.07 — none of which match the K4
schematic. It is a demo overlay for the nRF54L15-DK. Only two things in that
bundle are about the K4: the LIS2DW12 part number, and the LFXO cap value in
`KKM_readme.txt`. Read the schematic, not the overlay.
