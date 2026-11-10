---
title: Live feed (WebSocket)
---

# Live feed

For software that wants changes pushed rather than polling: connect a
WebSocket to

```
ws://<server>:3000/ws
```

Every message is one JSON object with a `type`.

| `type` | When | Contents |
|---|---|---|
| `hello` | On connect | `schema` (`aura.live/1`), `server` |
| `snapshot` | On connect | `devices` (all), `gateways` (Links) |
| `device` | A device changed (checked once a second) | `device`: the [device object](/aura-server/rest-api#the-device-object) |
| `event` | Immediately | The same event objects as [`/api/v1/events`](/aura-server/rest-api#get-apiv1eventssinceseqlimitn) |
| `gateway` | A Link connected, dropped or was renamed | `gateway` |

A `device` message is only sent when something meaningful changes (zone,
proximity, battery, moving/still, online state), not on every radio beacon.

## Example (JavaScript)

```js
const ws = new WebSocket("ws://192.168.1.50:3000/ws");
const fleet = new Map();

ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.type === "snapshot") msg.devices.forEach((d) => fleet.set(d.id, d));
  if (msg.type === "device") fleet.set(msg.device.id, msg.device);
  if (msg.type === "event" && msg.event === "motion" && msg.value === 1) {
    console.log(`${msg.niceName || msg.id} started moving in ${msg.zone?.name}`);
  }
};
ws.onclose = () => setTimeout(() => location.reload(), 2000); // reconnect
```

## Example (Python)

```python
import asyncio, json, websockets

async def main():
    async with websockets.connect("ws://192.168.1.50:3000/ws") as ws:
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "event":
                print(msg["kind"], msg.get("id"), msg.get("event"), msg.get("zone"))

asyncio.run(main())
```

Always handle reconnection: the server may restart, and the snapshot on
reconnect brings you back up to date.
