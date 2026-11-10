---
title: How it works
---

# How it works

## Three jobs

Every Aura device does three things:

1. **Receives commands**: colour, animation, brightness and mode, sent to everyone, a group, a zone or one device.
2. **Detects motion** with its accelerometer, reporting when it starts moving and when it comes to rest.
3. **Transmits its id and status** (battery, moving or still) in a short beacon every few seconds.

## The path

```
Aura device ──802.15.4 radio──▶ Aura Link ──Ethernet (TCP)──▶ Aura Server ──▶ your software
            ◀── commands ───────          ◀── commands ──────
```

- **Radio**: IEEE 802.15.4 at 2.4 GHz, the low-power radio family behind Zigbee and Thread, carrying Aetherfield's own protocol. It is not Bluetooth and not Wi-Fi.
- **Commands are broadcast.** One transmission reaches every device in range at once, so changing the colour of 10 devices costs the same airtime as 10,000. That's what makes crowd-scale light possible.
- **Commands are not acknowledged one by one**, because that wouldn't scale. Each Link sends every command several times, and each device reports the last command it applied in its next beacon (`lastCmdSeq` in the API). That is how delivery is measured.
- **Beacons are short and spaced out**, so thousands of devices can share the channel. In *listen only* mode devices stop transmitting altogether, which is the setting for a packed show.

## Local first

Devices, Links and Aura Server all sit on the venue's own network. **Nothing
in the live path needs the internet.** A cloud service can mirror the server
for remote dashboards and messaging, but it is never between the lighting
desk and the crowd.

## Synchronised animation

Devices share a clock with the Links, and animations are calculated from that
shared time, so a pulse across ten thousand wrists stays in step without each
device being told every frame.

:::note
Synchronisation accuracy across a full venue has not yet been measured on
hardware. A figure will be published when it has.
:::
