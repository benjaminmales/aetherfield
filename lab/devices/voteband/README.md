# voteband — minimal 802.15.4 voting beacon (XIAO nRF52840)

The cheapest Aetherfield band: an nRF52840 + one button, no IMU/mic/EdgeAI.
It broadcasts a v1 `BEACON` (`aura_radio.h`) ~1×/sec whose **gesture byte**
carries the vote, sourced from a momentary button on **D0 → GND**.

This is the "prove the link" build — same `nrf_802154` radio path as the
nRF54L firmware, so once this shows up on the sniffer the rest of the port is
incremental.

## Hardware

- Seeed XIAO nRF52840 (plain or Sense — board target `xiao_ble`).
- Momentary button between **D0 (P0.02)** and **GND**. Uses the internal
  pull-up; no resistor needed. Hold = vote.
- Onboard user LED = TX heartbeat (solid while voting, brief blink otherwise).

## Build & flash

```sh
# from AURA/voteband
west build -b xiao_ble .
# XIAO ships with the UF2 bootloader: double-tap RESET, then
west flash            # or copy build/zephyr/zephyr.uf2 to the XIAO-SENSE drive
```

With an SWD probe you can get RTT logs:

```sh
west build -b xiao_ble . -- -DEXTRA_CONF_FILE=debug.conf
```

## Verify on the sniffer

Flash `AURA/sniffer` to an nRF52840-DK / dongle, open its shell, then:

```
channel 15
receive
```

You should see a 16-byte frame about once a second:

```
received: 4188057faeffff3c8ba7110520ff0100 power: -42 lqi: 255 ...
          └FCF─┘│ └PAN┘└dst─┘└src─┘ │ │ │ └caps,batt,gesture,flags
                seq                 a7 11 seq
```

The **15th byte (gesture)** flips `00 → 01` while you hold D0 low. `src`
(bytes 8–9, little-endian) is this band's FICR-derived identity.

## Frame layout (16 bytes)

| Off | Bytes | Meaning |
|----:|-------|---------|
| 0   | `41 88` | FCF `0x8841` (data, no-ACK, PAN-compressed, 16-bit addrs) |
| 2   | `ss` | MAC seq |
| 3   | `7f ae` | PAN `0xAE7F` |
| 5   | `ff ff` | dst = broadcast |
| 7   | `ll hh` | src = band addr (LE) |
| 9   | `a7` | app magic |
| 10  | `11` | ver 1 \| msg BEACON |
| 11  | `ss` | app seq (dedupe) |
| 12  | `20` | caps = BUTTON |
| 13  | `ff` | battery = unknown |
| 14  | `00/01` | **gesture / vote** |
| 15  | `00` | flags |

## Notes / next steps

- **HW filtering:** the sniffer runs promiscuous, so it sees everything. The
  real gateway filters on PAN `0xAE7F` + address — this frame's FCF/PAN are
  already correct for that.
- **Lower latency:** beacons are 1 s. For snappier voting, drop the interval
  or also emit an `AURA_MSG_EVENT` on the button press edge.
- **Accel vote instead of button:** on a XIAO Sense, drop in the accel-only
  `hand_raise` detector and feed its output into `read_vote_gesture()`;
  remove the button node from the overlay.
- **Power:** console/USB/log are off so it runs on coin/LiPo. The 1 s wake +
  brief TX is already low-duty; add `CONFIG_PM` + deep sleep for production.
