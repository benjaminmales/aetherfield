---
title: Aura Link
---

# Aura Link

The venue gateway. An Aura Link talks to every Aura device in range by radio
and to Aura Server over Ethernet. Each Link defines a **zone**: a device
belongs to the zone of the Link that hears it most strongly.

## Specifications

<div className="spec">

| | |
|---|---|
| Radio | IEEE 802.15.4, 2.4 GHz, Aetherfield protocol v2 |
| Processor | Nordic nRF54LM20A (Seeed XIAO) |
| Antenna | External, u.FL. **Required** |
| Network | 10/100 Ethernet (WIZnet W5500), static IP |
| Power | USB-C or PoE through the Ethernet adapter |
| Status | RGB LED (see below) |
| Configuration | Over USB, saved in the Link |
| Radio range | Not yet measured in a venue. Will be published after site tests |
| Firmware | `aura-link-1.2.0` |

</div>

## Fit the antenna

The Link has **no built-in antenna**. Without one it still boots, connects
and looks healthy, but it can only hear devices a few centimetres away. Fit
the antenna before powering up, and keep it away from the Ethernet socket.

## Status light

| LED | Meaning | What to check |
|---|---|---|
| Solid blue | Starting up | Should last under a second |
| Red, fast blink | Network chip not responding | Board seating on the adapter |
| Red, one pulse per second | No Ethernet link | Cable, switch port, PoE |
| Amber, blinking | Can't reach Aura Server | `link config` shows the right server? Server running and allowed through the firewall? |
| Solid green | Connected | |
| Green + blue flicker | Connected and hearing devices | |
| White flash on green | Sending a command to the devices | |
| Fast white flashing | *Locate* was requested | Lets you find a Link in a ceiling |

## Setup

See [Network setup](/getting-started/network-setup).

## How many Links?

One Link per zone you want to tell apart. For anything beyond a demo, plan
**two Links per area**: a spare that keeps the zone working if one fails,
and two radio channels sharing the load of a large crowd.

## Updating firmware

Today: over USB-C, using the nRF Connect tools. The Link has an onboard programmer, so no extra hardware is needed. Updating Links
over the network from Aura Server is planned.
