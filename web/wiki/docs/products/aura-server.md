---
title: Aetherfield Demo Server
sidebar_label: Demo Server
---

# Aetherfield Demo Server

The software that runs your Aetherfield system. It runs **on your own laptop**,
on the same network as your Aura Links, and works with the internet unplugged.

<a className="local-server-cta" href="/wiki/open-server">Open Demo Server on this laptop →</a>

That button opens the console at `http://localhost:3000` if Demo Server is
running on this laptop, and shows how to start it if it isn't. Anyone else
on the network uses `http://<laptop-ip>:3000`.

## Keep it running

```bash
npm run service:install
```

Run once. Demo Server then starts whenever you log in and restarts if it
stops, on macOS, Windows and Linux, with no admin rights. Check it with
`npm run service:status`; remove it with `npm run service:uninstall`. Your
names, behaviours and settings are kept either way.

| | |
|---|---|
| Runs on | macOS, Windows, Linux. Node.js 20 or later |
| Download | [aetherfield-demo-server-1.0.0.zip](pathname:///wiki/downloads/aetherfield-demo-server-1.0.0.zip) (1.2 MB, everything included) |
| Start | Double-click `Start Demo Server` (macOS `.command`, Windows `.bat`), or `npm start` |
| Try without hardware | `npm run simulate` adds eight simulated Aura Tags |
| Console | `http://<server>:3000/` |
| REST API | `http://<server>:3000/api/v1` · [docs](/aura-server/rest-api) |
| Live feed | `ws://<server>:3000/ws` · [docs](/aura-server/live-feed) |
| Links connect on | TCP 9000 |
| Stores | Device and zone names, behaviours, webhooks, calibration, in `server/data/` |

## What it does

- Keeps the live state of every device: online, zone, signal, battery, last command
- Turns radio traffic into **events**: movement, arrivals, zone changes, devices going quiet
- Sends light commands to everyone, a group, a zone or a single device
- Runs [behaviours](/aura-server/behaviours): *when this happens, do that*
- Pushes events to your software by [webhook](/aura-server/webhooks) or [WebSocket](/aura-server/live-feed)

## Settings

Environment variables, or a `.env` file next to `server.js`:

| Variable | Default | |
|---|---|---|
| `HTTP_PORT` | `3000` | Console and API |
| `GATEWAY_PORT` | `9000` | Where Links connect |
| `API_KEY` | (unset) | If set, every change through the API needs `Authorization: Bearer <key>` |
| `API_KEY_READS` | (unset) | Set to `1` to require the key for reads too |
| `SERVER_ID` | `srv-1` | Name of this server in the API |
| `DATA_DIR` | `server/data` | Where names, behaviours and settings are kept |
| `ONLINE_MS` | `20000` | How long without hearing a device before it counts as offline |
