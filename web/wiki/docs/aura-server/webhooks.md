---
title: Webhooks
---

# Webhooks

A webhook sends **every event that matches a filter** to your URL as it
happens. Use it when your software wants a raw event stream without holding
a WebSocket open. To send only on specific conditions, or to light devices
too, use [behaviours](/aura-server/behaviours).

```bash
curl -X POST http://192.168.1.50:3000/api/v1/hooks \
  -H "content-type: application/json" -d '{
  "id": "movement",
  "url": "http://192.168.1.20:8080/aura-events",
  "on": "event",
  "match": { "event": "motion" }
}'
```

| Field | |
|---|---|
| `url` | Where to POST |
| `on` | `event`, `zone` or `presence` (omit for all) |
| `match` | Only send events whose fields equal these values, e.g. `{ "event": "motion", "value": 1 }` for "started moving" only |
| `body` | Optional template if your endpoint expects its own shape: `{{field}}` placeholders are filled from the event |
| `headers` | Extra headers, e.g. an auth token for your endpoint |
| `cooldownMs` | Minimum gap per device (default 1000) |

Each POST carries the event plus `gateway` (the server id), `at` and `hook`.
`GET /api/v1/hooks` shows how many have been sent, suppressed and failed.
`DELETE /api/v1/hooks/{id}` removes one.
