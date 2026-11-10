---
title: Location and proximity
---

# Location and proximity

## What you get today

| | How | Good for |
|---|---|---|
| **Zone** | The Aura Link that hears the device most strongly | "Which area is this guest in?", arrivals and departures |
| **Proximity** | `near` / `mid` / `far` from the signal strength at that Link | "Is this guest right at the bar, or across the room?" |
| **Signal** | `rssi` in dBm, and every Link that heard it (`heardBy`) | Your own analysis |

In the API, `position.source` is `"zone"`, and `position.absolute`,
`position.relative` and `speed` are `null`.

## Why not exact coordinates?

Radio signal strength is a poor ruler. A person's body absorbs 2.4 GHz
signals, so a guest turning around can change the reading by 10 dB, which
looks like several metres of movement. Metal, walls and reflections make it
worse. Turning signal strength into x,y coordinates produces confident-looking
dots that are often wrong, so the API doesn't pretend.

What signal strength **does** carry reliably is ordering: the Link that hears
a device loudest is almost always the nearest. Zones are built on that.

## Calibrating proximity

The near/mid/far thresholds default to textbook values. To tune them for a site:

1. Stand a device where "near" should end (e.g. one step back from the bar).
2. Read its signal in the console's device table.
3. Enter that number as **Near ≥ dBm** under **Calibration**. Repeat for *mid*.

Expect the bands to be bands, not lines.

## What's coming

- **Aura Marker**: a small fixed device placed on a point of interest (a
  stage, an exhibit, a bar). Proximity to a known object is far more reliable
  than a coordinate, and will fill `position.relative`.
- **Ranging**: the radios in Aura devices support Bluetooth Channel Sounding,
  which measures distance directly. Published accuracy is around half a
  metre in good conditions. It will be tested before anything is promised.

When either arrives, the same API fields fill in. Code written against the
API today keeps working.
