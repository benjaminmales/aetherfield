---
title: Network setup
---

# Network setup

Aura Links connect to Demo Server over ordinary Ethernet. Each Link needs:

- **its own IP address** on your network (static)
- **the IP address of the computer running Demo Server**

Both are set over USB and saved in the Link, so you set them once per site.

## Before you start

Ask whoever runs the network for **one static IP address per Link**, or pick
addresses outside the router's DHCP range. Two devices on one address
interrupt each other in ways that are hard to diagnose.

The computer running Demo Server needs an address that doesn't change for the
duration of the event. A DHCP reservation is fine.

## Configure a Link over USB

1. Connect the Link to your computer with USB-C.
2. Open a serial terminal at **115200 baud**:
   - macOS / Linux: `screen /dev/tty.usbmodem* 115200`
   - Windows: PuTTY on the Link's COM port
   - or the terminal in VS Code's nRF Connect extension
3. Press Enter to get the `uart:~$` prompt, then:

```
link config
```

This shows what the Link is running. A new Link prints its defaults.

```
link set name bar-north
link set ip 192.168.1.60
link set server 192.168.1.50
link save
link reboot
```

| Command | What it does |
|---|---|
| `link set name <name>` | How the Link appears in Demo Server and the API (its zone id). Letters, digits, `-` and `_`, up to 20 characters |
| `link set ip <ip> [mask] [router]` | The Link's own address. With one argument, mask `255.255.255.0` and router `.1` are assumed |
| `link set server <ip> [port]` | Where Demo Server is listening. Port defaults to 9000 |
| `link set index <1-30>` | Give each Link at one site a different number. It spaces out their radio transmissions |
| `link save` | Store the settings |
| `link reboot` | Restart using them |
| `link defaults` | Forget all saved settings |
| `link locate [seconds]` | Flash this Link's LED white |

`link save` warns you if the server isn't on the Link's subnet. That's
usually a typo.

## Direct connection (no network)

For a bench demo you can cable one Link straight into a laptop. Give the
laptop's Ethernet adapter the static address `10.10.0.1` (mask
`255.255.255.0`). An unconfigured Link uses `10.10.0.11` and looks for the
server at `10.10.0.1`, so it connects with no USB setup at all.

## Ports and firewall

| From | To | Port | What |
|---|---|---|---|
| Aura Link | Demo Server | TCP 9000 | Device data and commands |
| Your software / browser | Demo Server | TCP 3000 | Console, REST API, WebSocket |
| Demo Server | your software | your choice | Webhooks and behaviours (optional) |

Links always open the connection to the server, never the other way round,
so nothing needs to reach *into* a Link.

## Naming zones

The Link `name` is a short machine id (`bar-north`). The friendly name your
team sees ("Bar, north door") is typed into the zone card in the
[console](/aura-server/console), and appears in the API as `zone.name`.
