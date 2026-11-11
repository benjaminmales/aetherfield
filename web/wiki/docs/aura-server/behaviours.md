---
title: Behaviours
---

# Behaviours

Behaviours are rules Demo Server runs for you, with no code: **when this
happens, do that**. Build them in the [console](/aura-server/console) or
through the API. They run on the server, so they keep working with the
internet down.

Examples:

- When a Tag starts moving → light that Tag green for 5 seconds, and tell my show controller
- When someone arrives at the bar → pulse the bar zone blue
- When a device comes to rest in the lounge → call my webhook

## When

| Trigger | Fires when | Filters |
|---|---|---|
| `motion` | A device starts moving | zone, product |
| `still` | A device comes to rest (3 s without movement) | zone, product |
| `any_event` | Any device event (motion, gesture) | zone, product |
| `arrive` | A device's zone changes to the filtered zone. With no zone filter, also when a device is first seen | zone, product |
| `leave` | A device's zone changes away from the filtered zone | zone, product |
| `quiet` | A device hasn't been heard for 20 s | zone, product |

## Then

A behaviour can do one or more of:

| Action | Fields |
|---|---|
| `light` | `target`: `device` (the one that triggered it), `zone` (its zone's Link) or `all`; `color`, `animation`, `brightness`; optional `durationS`, after which the target goes dark again |
| `webhook` | `url`: Demo Server POSTs `{ behaviour, name, event }` to it |
| `message` | `text`: send an SMS to whoever [registered](/aura-server/registration) the device that triggered the rule. `{name}`, `{device}` and `{zone}` are filled in |

`zone` lights every device the zone's Link reaches. Radio doesn't stop at a
wall, so devices near the boundary of a neighbouring zone may see it too.

## Cooldown

`cooldownS` (default 1) stops a rule re-firing for the same device within
that many seconds, so a device hovering at a zone boundary, or one being
picked up and put down repeatedly, doesn't flood your systems.

## API

| | |
|---|---|
| `GET /api/v1/behaviours` | List, with how often each has fired and its last error |
| `POST /api/v1/behaviours` | Create |
| `PUT /api/v1/behaviours/{id}` | Replace (e.g. `"enabled": false` to pause) |
| `DELETE /api/v1/behaviours/{id}` | Delete |

```bash
curl -X POST http://192.168.1.50:3000/api/v1/behaviours \
  -H "content-type: application/json" -d '{
  "id": "tag-moving",
  "name": "Moving Tags light green",
  "when": { "trigger": "motion", "product": "Aura Tag" },
  "then": [
    { "do": "light", "target": "device", "color": "#00ff66", "durationS": 5 },
    { "do": "webhook", "url": "http://192.168.1.20:8080/aura" }
  ],
  "cooldownS": 1
}'
```

Webhook calls get one attempt with a 2-second timeout and are not retried. A
show trigger that arrives late is worse than one that doesn't arrive. The
last error is shown on the behaviour.
