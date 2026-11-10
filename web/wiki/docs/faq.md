---
title: FAQ
---

# FAQ

**Does it need the internet?**
No. Devices, Aura Links and Aura Server all run on the venue's local network.

**Is it Bluetooth?**
No. Aura uses IEEE 802.15.4, a low-power radio built for large numbers of
small devices. It doesn't pair with phones, and no app is needed.

**How many devices can one system handle?**
The protocol is designed for crowds in the tens of thousands, using broadcast
commands and *listen only* mode during shows. Tested limits will be published
as they're measured. Ask us about your numbers.

**How far does the radio reach?**
Not yet published. It will be measured in real venues, with people in them,
before we quote a figure. Plan Links per area rather than by distance for now.

**How accurate is location?**
Zone level (which Aura Link a device is nearest) plus near/mid/far. See
[Location and proximity](/concepts/location-and-proximity) for why, and what's coming.

**How long do batteries last?**
Battery life is being measured on finished hardware and will be published per
device and mode. Aura One is rechargeable; Aura Lite and Aura Tag use a CR2032 coin cell.

**Can our software control the lights?**
Yes: [REST API](/aura-server/rest-api), [live feed](/aura-server/live-feed),
[webhooks](/aura-server/webhooks) and [behaviours](/aura-server/behaviours).

**What data does a device send?**
Its id, capabilities, battery level and status flags (e.g. moving), plus motion
events. No names, no personal data: those live only where your registration
system puts them.
