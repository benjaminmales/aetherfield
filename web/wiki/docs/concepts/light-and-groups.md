---
title: Light and groups
---

# Light and groups

## One light per device

Every Aura device is treated as **one light source**, however many LEDs it
has. The same command drives Aura One's four LEDs, Aura Lite's one and Aura
Tag's status light. Each device shows what it physically can.

## Animations

| Name | |
|---|---|
| `off` | Dark |
| `steady` | Solid colour |
| `flash` | On/off |
| `pulse` | Smooth breathing |
| `heartbeat` | Double beat |
| `ramp` | Builds up, then drops (sawtooth) |
| `strobe` | Fast flash |
| `rainbow` | Cycles the colour wheel (ignores `color`) |

`periodMs` (10–2550, default 1000) sets how long one cycle takes. `brightness` (0–255) scales everything.

## Groups

A group is a **bitmask**, so a device can belong to several and one command
can target several.

| Value | Who |
|---|---|
| `0` | Everyone |
| `8` | Aura Tags |
| `2`, `4` | Development boards |

Product groups for Aura One and Aura Lite will be listed here when their
firmware ships. Custom groups (e.g. "team red") are planned.

## Modes

| Mode | What devices do |
|---|---|
| `normal` | Follow commands, send beacons and motion events |
| `listen_only` | Follow commands, transmit **nothing**. Use for packed shows to keep the radio channel clear |
| `low_power` | Beacon less often and cap brightness, to stretch the battery |
| `sleep` | Mostly asleep, waking briefly on a schedule. Devices always wake to check in; there is no way to switch one off for good by radio |
| `identify` | Flash so the device can be found |
