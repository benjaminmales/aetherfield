---
title: Console
---

# The console

Open `http://<server>:3000/` in any browser on the same network.

| Area | What it's for |
|---|---|
| **Fleet control** | Colour, animation, brightness, who (everyone or a group), where (all zones or one), mode. **Send** applies it; the coloured dots send a colour in one click |
| **Zones** | One card per Aura Link: live device count, a near / mid / far signal bar, a **Locate** button, and a box to give the zone a friendly name |
| **Devices** | Every device heard recently, with zone, signal, moving/still and battery. Click a name to rename it. **Identify** makes a device flash so you can find it; **Paint** sends the current colour to just that device |
| **Live events** | Movement, arrivals, zone changes and devices going quiet, as they happen |
| **Calibration** | The signal thresholds for *near* and *mid*. See [Location and proximity](/concepts/location-and-proximity) |
| **Behaviours** | *When this happens, do that* rules. See [Behaviours](/aura-server/behaviours) |

Names, behaviours and calibration are saved on the server and survive restarts.

If the server has an `API_KEY`, the console asks for it the first time you
change something.
