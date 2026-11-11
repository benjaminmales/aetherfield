---
slug: /
title: Aetherfield Wiki
sidebar_label: Welcome
---

# Aetherfield Wiki

Aetherfield puts a small radio device on every guest (a wristband, a lanyard tag,
a pin) and connects the whole crowd to your venue's systems. Each device is three
things at once:

- **a light** your show can control, one device or ten thousand at a time
- **a sensor** that reports movement
- **an identity** that knows which part of the venue a guest is in

This wiki covers the hardware, how to set up a demo kit, and how to connect
your own software through the Aura Server API.

## The range

<div className="cards">
  <div className="card-link soon"><b>Aura One</b><span>Show wristband. Four RGB LEDs, motion sensor, rechargeable.</span><div className="tag">Coming soon!</div></div>
  <div className="card-link soon"><b>Aura Lite</b><span>Low-cost wearable. One RGB LED, accelerometer, coin cell.</span><div className="tag">Coming soon!</div></div>
  <a className="card-link" href="./products/aura-tag"><b>Aura Tag</b><span>Test device. Takes commands, senses motion, reports its id and status.</span><div className="tag">Demo</div></a>
  <a className="card-link" href="./products/aura-link"><b>Aura Link</b><span>Venue gateway. Talks to the devices by radio, to the server by Ethernet.</span><div className="tag">Infrastructure</div></a>
  <a className="card-link" href="./products/aura-server"><b>Aura Server</b><span>Runs on your laptop: console, REST API, live feed, behaviours.</span><div className="tag">Software</div></a>
</div>

## Start here

1. **[Demo kit quick start](/getting-started/demo-kit)**: from box to a lit, responding fleet in about 15 minutes.
2. **[Network setup](/getting-started/network-setup)**: putting Aura Links on your network.
3. **[REST API](/aura-server/rest-api)**: read the fleet and control it from your own software.

Already running Aura Server on this laptop? <a href="/wiki/open-server">**Open the console →**</a>

## How the pieces fit

```
  Aura devices  ──radio──▶  Aura Link  ──Ethernet──▶  Aura Server  ──REST / WebSocket / webhooks──▶  your software
  (on guests)              (one per zone)            (a laptop or small PC on your network)
```

Everything on that line runs on your local network. **The venue's internet
connection can go down and the show keeps running.**
