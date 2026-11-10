---
title: Demo kit quick start
sidebar_label: Demo kit quick start
---

# Demo kit quick start

About 15 minutes from opening the box to moving a Tag and seeing it in your
own software.

## In the box

| Item | Qty | Notes |
|---|---|---|
| Aura Link | 1–4 | XIAO nRF54LM20A on an Ethernet adapter, with an external antenna |
| Aura Tag | 10+ | Runs on a CR2032 coin cell |
| Antenna | 1 per Link | **Must be fitted before power-on.** See [Aura Link](/products/aura-link#fit-the-antenna) |
| USB-C cable | 1 | For setting each Link's network address |

You provide: a laptop (macOS, Windows or Linux) with [Node.js 20+](https://nodejs.org),
an Ethernet switch or router, and an Ethernet cable per Link.

## 1. Start Aura Server on your laptop

```bash
cd aura-server
npm install
npm start
```

<a className="local-server-cta" href="http://localhost:3000" target="_blank" rel="noopener">Open Aura Server →</a>

That opens **http://localhost:3000**. You'll see the console with no Links yet. On
macOS, allow `node` to accept incoming connections when asked. If you miss the
prompt, the Links can't connect.

Note your laptop's IP address on the network the Links will join (e.g.
`192.168.1.50`). On macOS: **System Settings → Network → (your adapter) → Details**.

## 2. Point each Link at your laptop

Each Link needs its own address on your network and the address of the
laptop. Plug the Link into USB, open a serial terminal at 115200 baud, and
type:

```
link set name bar-north
link set ip 192.168.1.60
link set server 192.168.1.50
link save
link reboot
```

Use a different `name` and `ip` for each Link. Full detail is in
[Network setup](/getting-started/network-setup).

## 3. Connect the Links

Fit the antenna, connect Ethernet, and power the Link (USB-C or PoE). Watch
its LED:

| LED | Meaning |
|---|---|
| Solid blue | Starting up |
| Red pulse | No Ethernet. Check the cable |
| Amber blink | On the network but can't reach Aura Server. Check the server address and the firewall |
| **Solid green** | **Connected** |

The Link appears in the console under **Zones** within a few seconds.

## 4. Wake the Tags

Fit each Tag's coin cell. It flashes red, green, blue, then goes dark and
waits for commands. Within a few seconds it appears under **Devices**.

## 5. Try it

- Pick a colour under **Fleet control** and press **Send**. Every Tag lights.
- Pick up a Tag. *started moving* appears under **Live events** and its row shows **moving**.
  Put it down: about 3 seconds later, *came to rest*.
- Type a name into a Tag's row ("Tag 01"). It now appears with that name in the API.
- Under **Behaviours**, add *When a device starts moving → light that device green for 5 s*.
  Pick up a Tag.

## 6. Connect your software

```bash
curl http://192.168.1.50:3000/api/v1/devices
```

Then see the [REST API](/aura-server/rest-api) and [Live feed](/aura-server/live-feed).
