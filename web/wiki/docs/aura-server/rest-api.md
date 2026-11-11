---
title: REST API
---

# REST API

Plain JSON over HTTP, served by Demo Server at `http://<server>:3000/api/v1`.
Use it to read the fleet from your own software and to control the lights.

`GET /api/v1` returns the API index, the animation and mode names, and
whether a key is required.

## Authentication

Off by default. If the server sets `API_KEY`, every request that changes
something needs:

```
Authorization: Bearer <key>
```

(or `X-API-Key: <key>`). Reads stay open unless `API_KEY_READS=1`. CORS is
enabled, so a web page on another port or host can call the API directly.

## The device object

Every endpoint that returns devices uses this shape. It's the same object the
[live feed](/aura-server/live-feed) pushes.

```json
{
  "id": "0x1A2B",
  "niceName": "Tag 07",
  "product": "Aura Tag",
  "caps": ["rgb_led", "accel"],
  "online": true,
  "lastSeen": "2026-11-10T14:03:57.776Z",
  "zone": { "id": "bar-north", "name": "Bar, north door" },
  "rssi": -54,
  "proximity": "near",
  "position": { "source": "zone", "absolute": null, "relative": null, "accuracy_m": null },
  "speed": null,
  "battery": 82,
  "flags": { "moving": false, "charging": false, "lowBattery": false, "handRaised": false, "clap": false },
  "lastCmdSeq": 14,
  "heardBy": { "bar-north": { "rssi": -54, "t": "2026-11-10T14:03:57.776Z" } }
}
```

| Field | Meaning |
|---|---|
| `id` | The device's permanent id |
| `niceName` | The name set in the console, or `null` |
| `product` | `Aura One`, `Aura Lite`, `Aura Tag`, … |
| `zone` | The Link that hears it best right now |
| `rssi` | Signal strength at that Link, in dBm (closer to 0 = stronger) |
| `proximity` | `near` / `mid` / `far`, from `rssi` and the site [calibration](/concepts/location-and-proximity) |
| `position` | `source` says how the position was worked out. Today it's `"zone"`, and `absolute` / `relative` / `accuracy_m` are `null`. They fill in as finer positioning is added, without changing the shape |
| `speed` | `null` until positions are measurable. It's derived from them |
| `battery` | Percent, or `null` if the device can't measure it |
| `flags.moving` | The device is moving right now (from its accelerometer) |
| `lastCmdSeq` | The last light command this device applied. Use it to confirm a command arrived |
| `heardBy` | Every Link that heard it recently, with signal strength |

**Fields we can't measure yet are `null`, never estimated.** Code that
handles `null` today will keep working as the fields fill in.

## Read

### `GET /api/v1/devices`

All devices heard in the last 10 minutes.

| Query | |
|---|---|
| `online=1` | Only devices heard in the last 20 s |
| `zone=bar-north` | Only devices in that zone |
| `product=Aura Tag` | Only that product |
| `q=tag` | Name or id contains |

```bash
curl "http://192.168.1.50:3000/api/v1/devices?online=1&zone=bar-north"
```

### `GET /api/v1/devices/{id}`

One device. `id` may be written `0x1A2B` or `1A2B`. Returns `404` if it
hasn't been heard recently.

### `GET /api/v1/zones`

```json
{ "zones": [ { "id": "bar-north", "name": "Bar, north door", "connected": true,
               "firmware": "aura-link-1.2.0", "devices": 41 } ] }
```

### `GET /api/v1/zones/{id}/devices`

Online devices currently in that zone.

### `GET /api/v1/events?since={seq}&limit={n}`

Everything that happened, in order, with a cursor. Poll with the `next`
value from the last response to get only new events.

```json
{ "events": [
    { "seq": 41, "t": "…", "kind": "event", "id": "0x1A2B", "niceName": "Tag 07",
      "event": "motion", "value": 1, "strength": 40, "zone": { "id": "bar-north", "name": "Bar, north door" } },
    { "seq": 42, "t": "…", "kind": "zone", "id": "0x1A2B", "from": { "id": "bar-north" }, "to": { "id": "main-door" } },
    { "seq": 43, "t": "…", "kind": "presence", "id": "0x0C4D", "state": "offline" } ],
  "next": 43, "latest": 43 }
```

| `kind` | When |
|---|---|
| `event` | A device sent an event. `event` is `motion` (value `1` started moving, `0` came to rest; `strength` 0–100) or `gesture` (Aura One) |
| `zone` | A device's strongest Link changed |
| `presence` | A device came online (`state: "online"`) or hasn't been heard for 20 s (`"offline"`) |

The server keeps the last 5,000 events in memory.

## Control

Light commands go out by radio and are **not acknowledged** by each device.
The response tells you how many Links sent it. To confirm a particular device
applied it, watch its `lastCmdSeq`.

### `POST /api/v1/light`

Everyone, a group, or one zone.

```bash
curl -X POST http://192.168.1.50:3000/api/v1/light \
  -H "content-type: application/json" \
  -d '{ "color": "#ff6b1a", "animation": "pulse", "brightness": 200 }'
```

| Field | Default | |
|---|---|---|
| `color` | `#ffffff` | `"#rrggbb"`, `[r,g,b]` or `{ "r":…, "g":…, "b":… }` |
| `animation` | `steady` | `off`, `steady`, `flash`, `pulse`, `heartbeat`, `ramp`, `strobe`, `rainbow` |
| `periodMs` | `1000` | How long one animation cycle takes, 10–2550 ms. Bigger is slower |
| `brightness` | `255` | 0–255 |
| `group` | `0` | Bitmask. `0` = everyone, `8` = Aura Tags. See [Light and groups](/concepts/light-and-groups) |
| `zone` | all | Send only through that zone's Link |
| `mode` | `normal` | Device mode. See [Light and groups](/concepts/light-and-groups#modes) |

### `POST /api/v1/devices/{id}/light`

Same body (without `group`), for a single device.

### `POST /api/v1/devices/{id}/identify`

The device flashes so someone can find it.

### `POST /api/v1/zones/{id}/locate`

`{ "seconds": 10 }`. The Link's own LED flashes white.

## Set up

| | |
|---|---|
| `PUT /api/v1/devices/{id}` | `{ "niceName": "Tag 07" }` (empty to clear) |
| `PUT /api/v1/zones/{id}` | `{ "name": "Bar, north door" }` |
| `GET/PUT /api/v1/settings` | Proximity calibration: `{ "proximity": { "nearDbm": -60, "midDbm": -75 } }` |
| `/api/v1/behaviours` | See [Behaviours](/aura-server/behaviours) |
| `/api/v1/hooks` | See [Webhooks](/aura-server/webhooks) |

## Errors

Errors return a non-2xx status and `{ "error": "message" }`. The message says
what to fix: `color must be "#rrggbb", [r,g,b] or {r,g,b}`.
`503` means no Aura Link is connected.
