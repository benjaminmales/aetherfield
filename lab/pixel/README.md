# Pixels

Device firmware. Two test boards today; production is 5,000 of one of them.

| | board | product light | group |
|---|---|---|---|
| `xiao_nRF54L15_pixel/` | Seeed XIAO nRF54L15 | LP5012, 4× RGB | `0x02` |
| `holyiot_25008_nrf54l15_pixel/` | HOLYIOT-25008, modified | single HB blue | `0x04` |

Groups are a bitmask, so from the gateway:

```
aura cmd 02 ...   just the XIAO
aura cmd 04 ...   just the Holyiot
aura cmd 06 ...   both
aura cmd 00 ...   everyone
```

---

## The seam

Neither of these files contains a radio.

Everything that makes a device an Aetherfield v2 device — radio bring-up,
CMD/SYNC receive, command dedupe, group filtering, the `op_mode` state machine,
beacon/event/contact transmit, the shared-clock animation engine, channel-loss
fallback — lives once in [`../common/aura_band.c`](../common/aura_band.c) and is
byte-identical on every board.

What each Pixel implements is a single callback:

```c
static void pixel_render(uint8_t r, uint8_t g, uint8_t b);
```

called at ~50 Hz with the colour already resolved — animation and master
brightness applied. v2 treats every device as **one light source** however many
LEDs it physically has, which is what lets one command drive a four-LED
wristband, a single-colour module and a lanyard with no light at all.

**If you are adding a board, that callback is the whole job.** You should not be
touching the radio. If you find yourself needing to, the seam is in the wrong
place and that is worth a conversation rather than a workaround.

---

## What a Pixel deliberately is not

`docs/PROTOCOL.md` defines a Pixel as **one LED and no sensors**. These firmwares
hold that line: no Edge AI, no microphone, no IMU, no sensor subsystem. The
gesture and ML work still exists in `aetherfield-platform` and is untouched —
it just has no business in a device that ships 5,000 times with a single light.

That is why both of these are around 200 lines.

---

## Blue-only, and why the Holyiot board also mirrors colour

The Holyiot module's product light is a single blue HB LED, so it is driven from
the **blue channel alone**. Send it red and it goes dark. That is correct
behaviour — and it is indistinguishable from a dead device, which is the trap
this board sets on a bench.

So the module's onboard RGB mirrors the **full** commanded colour alongside it.
A red command visibly does something: the indicator turns red while the product
light stays off. You can see at a glance that the command arrived and that the
blue-only mapping is what darkened the HB LED. Without the mirror you would be
debugging the radio.

---

## Identity

Both use the FICR device id as their 16-bit short address, so a dev board needs
no provisioning step.

**This is not how production works.** 5,000 devices in the 61,438-address band
range gives ~203 expected collisions, and a collision means one guest's progress
lands on another guest's record — unrecoverable, because the radio identity is
genuinely ambiguous. Production assigns sequential addresses at flash time and
prints the address into the QR label in the same step. See `docs/PROTOCOL.md`
§3.2.

---

## Building

Both need `BOARD_ROOT` pointing at `firmware/` — the directory containing
`boards/`, not `boards/` itself. The workspace `.vscode/settings.json` already
sets it.

```sh
cd firmware/pixels/xiao_nRF54L15_pixel
west build -b xiao_nrf54l15/nrf54l15/cpuapp . -p always -- -DBOARD_ROOT=$(cd ../.. && pwd)

cd firmware/pixels/holyiot_25008_nrf54l15_pixel
west build -b holyiot_25008_nrf54l15/nrf54l15/cpuapp . -p always -- -DBOARD_ROOT=$(cd ../.. && pwd)
```

**Consoles differ by board, on purpose.** The XIAO has a SAMD11 bridging uart20
to USB-C with no DTR line, so a UART console cannot stall boot on battery and is
left enabled. The Holyiot module has no bridge, so its console rides RTT over the
SWD you already have connected — which also cannot stall boot. Build the XIAO
with `-DEXTRA_CONF_FILE=silent.conf` to strip the console for a current
measurement.

---

## Bring-up

1. Flash, and check the console prints `proto=2 addr=XXXX caps=.. group=..`.
2. Bring up a gateway on the same channel (default 15).
3. `<BCN a=XXXX ...` should appear at the server within one beacon interval.
4. From the gateway: `aura cmd 00 2 0 0 0 0 0 255 255` — steady blue, full
   brightness, everyone. Both boards should light.
5. `aura cmd 00 2 0 0 0 255 0 0 255` — steady red. The XIAO goes red; the
   Holyiot's product light goes dark while its indicator goes red. That is the
   blue-only mapping working, not a fault.
