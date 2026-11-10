---
title: Aura Tag
---

# Aura Tag

The test device for the Aura range. It does the three things every Aura
device does:

1. **receives behaviour commands** (colour, animation, brightness, mode)
2. **detects motion**
3. **transmits its id and status** (presence, zone, battery, moving or still)

Use it to try zones, motion, behaviours and the API before the production
wearables arrive.

## Specifications

<div className="spec">

| | |
|---|---|
| Radio | IEEE 802.15.4, 2.4 GHz, Aetherfield protocol v2 |
| Processor | Nordic nRF54L15 (HOLYIOT-25008 module) |
| Light | 1× RGB status LED. 8 colours; green is dimmable |
| Motion | 3-axis accelerometer (ST LIS2DH12), hardware motion detection |
| Power | CR2032 coin cell, replaceable, not rechargeable |
| Battery life | Not yet measured. Will be published per operating mode |
| Battery reporting | Yes: percent, plus a low-battery flag at 15% |
| Capabilities reported | `rgb_led`, `accel` |
| Product id in API | `"Aura Tag"` |

</div>

## What it does

| | |
|---|---|
| Power-up | Flashes red, green, blue, then waits dark for commands |
| Presence | Sends a short "I'm here" beacon so Aura Server knows it's present and which zone it's in |
| Light | Follows every colour and animation command for **everyone** or the **Aura Tags** group |
| Starts moving | Sends a `motion` event, value `1`, and shows `flags.moving: true` |
| Comes to rest | After 3 s without movement, sends a `motion` event, value `0`, with the peak movement (0–100) as `strength` |
| Battery | Reports its coin cell level once a minute |
| Show mode | In *listen only* mode the Tag transmits nothing on purpose, including motion, so a large crowd doesn't fill the radio channel |

## The light, honestly

The Tag's LED is a status light, not a show light. Red and blue can only be
on or off, and only green dims, so it shows eight clear colours (off, red,
green, blue, cyan, magenta, yellow, white) and brightness only changes the
green part. It also runs at very low current to protect the coin cell, so
it's best seen up close. [Aura One](/products/aura-one) is the show light.

## Identity

Each Tag has a 4-digit hex id (e.g. `0x1A2B`) derived from its chip, shown in
the console and the API. Give it a readable name in the console and that name
appears as `niceName` everywhere.
