---
title: Registration & messaging
---

# Registration & messaging

Each Aura Tag in the demo kit carries a QR code. A guest scans it, enters a
name and mobile number, and from that moment the Demo Server can show the
guest's name next to their Tag — and text them, from the console or from a
[behaviour](/aura-server/behaviours) rule.

**Privacy:** registrations are deleted automatically **30 minutes** after
they're made. There's no history and no soft delete; after 30 minutes the
name and number are gone. The registration page says so, and registering is
always optional — an unregistered Tag works normally, it just can't be
messaged.

## How it fits together

```
guest's phone ──scan QR──▶ aetherfield.cloud/aura-registration   (hosted)
                                      ▲
Demo Server (your laptop) ────────────┘  polls names, sends messages
```

The Demo Server never stores a phone number. It knows Tags by their id; the
hosted registration service is the only place a name and number exist, and
only for 30 minutes. If the venue's internet goes down, everything except
messaging keeps working.

## Setup

1. In the Demo Server folder, add two lines to `.env`:

   ```
   CLOUD_URL=https://aetherfield.cloud/aura-registration
   CLOUD_TOKEN=<the token Aetherfield gave you>
   ```

2. Restart the Demo Server. The console header shows messaging as available.

## Sending a message

- **Console:** click a device → *Message owner*.
- **Behaviour:** add a rule with a *text the owner* action, e.g. when a Tag
  starts moving → `Hi {name} — your Tag ({device}) just moved.`
- **API:** `POST /api/message` with `{ "device": "0x4C51", "message": "..." }`
  (same [auth](/aura-server/rest-api) as the rest of the API).

Messages arrive by SMS. Rates are capped service-side, so a runaway
integration can't send more than a handful of texts a minute.

## Printing QR codes

Each QR encodes `https://aetherfield.cloud/aura-registration/register?d=<id>`
where `<id>` is the Tag's own radio id — the same 4-character id the console
shows. Two ways to make a sheet:

- With the fleet powered on: `node tools/make-qr.js` in the Demo Server
  folder reads the live fleet and writes `qr-sheet.html` — print it, cut it
  out, stick one on each Tag.
- From a browser: open
  [the QR page](https://aetherfield.cloud/aura-registration/qr), paste the
  Tag ids, print.

The id *is* the device — there's nothing to pair or provision. A re-scanned
QR simply re-registers the Tag to whoever filled in the form last.
