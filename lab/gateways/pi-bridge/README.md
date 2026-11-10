# Gateway Pi bridge

Node.js service for the Raspberry Pi: USB serial to the gateway nRF54, `POST /api/led` for Activation Studio (`bandSync`), optional inserts into Supabase `gateway_telemetry`, and a tiny static admin page.

Recent updates:
- Telemetry project routing now prefers `device_bindings` lookup by gateway `hardware_id` (`kind='gateway'`) and falls back to `TELEMETRY_PROJECT_ID` if unbound.
- Bridge keeps a local disk queue (`telemetry-queue.json`) and replays on reconnect when cloud inserts fail.
- `physical_devices.last_seen` for the gateway is refreshed periodically from live bridge traffic for fleet heartbeat views.

## Install

```bash
cd gateway/pi-bridge
cp .env.example .env
npm install
npm start
```

## Environment

| Variable | Description |
|----------|-------------|
| `HTTP_PORT` | Listen port (default 3000). |
| `SERIAL_PORT` | Override auto-detect (`/dev/ttyACM0` on Pi). |
| `GATEWAY_HARDWARE_ID` | The gateway **serial number** — matches its pairing/registration QR. |
| `GATEWAY_MODE` | `cloud` (post telemetry to Supabase — pop-up activations) or `physical` (post to a local Server — large shows). Default `cloud`. |
| `SERVER_URL` | Physical mode: base URL of the local show Server. Telemetry is POSTed to `<SERVER_URL>/api/telemetry`. |
| `TELEMETRY_PROJECT_ID` | Optional Supabase `activation_projects.id` for RLS-scoped reads. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (Pi only; rotate after demos). |
| `LISTEN_HOST` | Bind address (default `0.0.0.0` so clients on the AP subnet can connect). |
| `FIELD_ADMIN_TOKEN` | Shared secret for **`/api/field-config`** and **`/field-setup.html`** workflow. If unset, field-config returns 503. |

**Local overrides:** when staff save from the field UI, values are merged into **`config.local.json`** in the app directory (same folder as `server.js`). That file overrides `.env` for the keys the UI edits. Add **`config.local.json`** to backups if you re-image the Pi; it is gitignored by default.

`/health` includes mode, queue and delivery status: `mode`, `serverUrl`, `queuedTelemetry`, `cloudInsertOkAt`, `cloudInsertError`, `serverPostOkAt`, `serverPostError`. Telemetry routes by `mode`; if the destination isn't configured/reachable it queues to `telemetry-queue.json` and replays.

## Setup page (`/field-setup.html`)

The admin page (token-gated by `FIELD_ADMIN_TOKEN`) now configures, end to end:

- **Deployment** — Cloud vs Physical event. Cloud shows Supabase fields; Physical shows the Server URL.
- **Identity** — the gateway **serial number** (`gatewayHardwareId`), with a Generate button.
- **Internet connection** — live status, **Wi‑Fi scan + connect**, Ethernet, and cellular/dongle, via NetworkManager.
- **Advanced** — serial device and HTTP port.

### Network control (`/api/network`)

`GET /api/network` returns connection status + a Wi‑Fi scan. `POST /api/network` applies `{kind:"wifi",ssid,password}`, `{kind:"ethernet"}`, or `{kind:"cellular"}`. These shell out to `nmcli`.

**Permissions:** read ops usually work as the service user; **connect** ops modify connections and typically need privilege. Either add a polkit rule for the service user, or a NOPASSWD sudoers entry for `/usr/bin/nmcli` (the bridge falls back to `sudo -n nmcli` automatically). On a single-radio Pi, joining Wi‑Fi reuses the same radio as the setup AP, so the setup AP drops on connect — reconnect over the venue Wi‑Fi/Ethernet (the API returns a warning to this effect).

### Plug-and-go AP fallback

`scripts/ap-fallback.sh` raises a setup hotspot **`AURA-GATEWAY-<last 6 of serial>`** whenever the gateway is offline, and drops it once online. Install it to run at boot + every 2 minutes:

```bash
sudo cp scripts/aura-ap-fallback.service scripts/aura-ap-fallback.timer /etc/systemd/system/
# edit ExecStart path and AP_PASSWORD in the .service, then:
sudo systemctl enable --now aura-ap-fallback.timer
```

So a fresh gateway: power on → (no internet) → broadcasts its `AURA-GATEWAY-…` AP → operator joins, opens `/field-setup.html`, picks mode + serial + Wi‑Fi → gateway joins the network and the AP drops automatically.

## Field setup (phone on gateway Wi‑Fi)

1. Set **`FIELD_ADMIN_TOKEN`** in `.env` (and in **`EnvironmentFile=`** if you use systemd). Restart the service.
2. On the Pi, enable a hotspot (example: NetworkManager):  
   `chmod +x scripts/enable-ap-nmcli.sh && sudo ./scripts/enable-ap-nmcli.sh`  
   Join the AP from a phone; the gateway IP is often **`10.42.0.1`** with NM hotspots (or your fixed AP IP, e.g. `192.168.4.1`).
3. Open **`http://<gateway-ip>:3000/field-setup.html`** (or your **`HTTP_PORT`**). Paste the token, **Load current**, edit serial / gateway ID / telemetry project / Supabase / HTTP port, then **Save & apply**.
4. If you change **HTTP port**, the API response includes **`httpPortRestartRequired`**. Run `sudo systemctl restart aura-pi-bridge` (or reboot) so the process listens on the new port.
5. USB serial: ensure the service user is in **`dialout`** (`sudo usermod -aG dialout pi` then re-login).

## Outbound triggers (webhooks)

The gateway can POST to machines on the venue LAN when something happens on the
radio — a TouchDesigner box, a media server, a lighting controller. This is the
opposite direction to directDMX (which takes Art-Net *in* and drives bands).

It fires from the gateway rather than the cloud because the receiving machine is
behind the venue's NAT: no tunnel needed, lower latency, and the physical
reaction keeps working when the internet does not.

Configure in `config.local.json`:

```json
"webhooks": [
  { "id": "td-clap",
    "on": "event",
    "match": { "event": "gesture", "value": 2 },
    "url": "http://192.168.1.50:9980/aura/clap",
    "cooldownMs": 1500 },
  { "id": "td-enter", "on": "presence", "url": "http://192.168.1.50:9980/aura/enter" }
]
```

| Field | Meaning |
|---|---|
| `id` | Required. Names the hook in `/api/webhooks` and in the payload. |
| `url` | Required. Any HTTP endpoint reachable from the Pi. |
| `on` | `event`, `contact` or `presence`. Omit to match all kinds. |
| `match` | Every key must equal the event's field; absent keys are wildcards. |
| `cooldownMs` | Minimum gap between fires (default 1000). |
| `perDevice` | `false` shares one cooldown across the fleet (default per band). |
| `timeoutMs` | Request timeout (default 2000). |
| `enabled` | `false` to keep the config but stop firing. |
| `body` | Post a custom shape instead of the native payload. `{{field}}` placeholders are filled from the event; a whole-string placeholder keeps its type. |

`body` is what lets the gateway call an endpoint that already exists rather
than one written for it. To drive `aura-registration`'s `/api/action` (which
looks up the registered guest and sends the SMS):

```json
{ "id": "welcome-sms",
  "on": "presence",
  "url": "https://<app>.vercel.app/api/action",
  "body": {
    "device_id": "{{device}}",
    "command": "audience_sample",
    "message": "Welcome to Aetherfield — your band {{device}} just checked in."
  } }
```

An unregistered band comes back `404 No registration for this device`, which is
counted as a failure and otherwise ignored — a room of unregistered bands is
normal, not an error.

Event kinds and their fields:

- `event` — `device`, `event` (`gesture`/`button`/`nfc`), `value`, `strength`, `rssi`
- `contact` — `device`, `peer`, `event` (`open`/`close`), `rssi`
- `presence` — `device`, `event` (`enter`), `rssi`. Fires once per device; a
  device pruned after 10 minutes of silence will fire again if it returns.
  There is no `leave` yet.

**One attempt, no retry.** A trigger that lands late because a laptop was asleep
is worse than one that never lands — the show has moved on. Failures are counted
and the last error kept; nothing is queued. `GET /api/webhooks` shows what is
configured, what fired, what was suppressed by cooldown and what failed.

**No personal data.** Payloads carry a device address only. Names and phone
numbers live in the cloud tier and never reach the gateway.

## systemd

```ini
[Unit]
Description=AURA gateway Pi bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/pi/AURA-ONE-DEMO-2026/gateway/pi-bridge
EnvironmentFile=/home/pi/AURA-ONE-DEMO-2026/gateway/pi-bridge/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=pi

[Install]
WantedBy=multi-user.target
```

Install: `sudo cp deploy/aura-pi-bridge.service /etc/systemd/system/`, edit paths, `sudo systemctl enable --now aura-pi-bridge`.

## How you reach the Pi

### Development (desk / lab)

**SSH** is the practical default: fast iteration, `journalctl -u aura-pi-bridge -f`, `curl` checks, editing `.env`.

1. Enable SSH in Raspberry Pi Imager (OS customization).
2. Connect: `ssh pi@raspberrypi.local` or `pi@<lan-ip>`; optional **Tailscale** for `pi@100.x.y.z`.
3. Prefer **SSH keys** (`ssh-copy-id`, then disable password login in `sshd_config` when you are ready).
4. Quick checks: `hostname -I`, `ls -la /dev/ttyACM*`, `curl -s http://127.0.0.1:3000/health`.

### Field (deployed gateway)

**Wi‑Fi “router style” admin** should be the main operator path: no laptop SSH required for routine status.

- Put WAN on **USB 4G** (or Ethernet) and run the Pi’s **onboard Wi‑Fi as an AP** (e.g. SSID `AURA-GW-<suffix>`, WPA2 passphrase on the enclosure).
- Use **hostapd** + **dnsmasq** (or NetworkManager AP on Bookworm); give the AP interface a fixed IP (e.g. `192.168.4.1`).
- Staff join that Wi‑Fi and open **`http://192.168.4.1:3000/`** (or whatever port you set) for the bridge’s static page, **`/field-setup.html`** (with **`FIELD_ADMIN_TOKEN`** set), **`/health`** / **`/api/status`**.
- Firewall so admin HTTP (and optional SSH) is reachable **from the AP subnet only**, not from the raw cellular side.

SSH in the field stays optional—for your own support or imaging—not the primary workflow for venue staff.

## Gateway QR label recommendation

Print the gateway sticker QR as:

`http://<gateway-ip>:3000/?device=<gateway-firmware-uuid>&kind=gateway`

- Opening it in browser lands on the local admin status page.
- Scanning the same QR inside pairing is supported (`device` is treated as `hardware_id`).
- Keep `device` equal to the UUID/hardware ID flashed in firmware and configured as `GATEWAY_HARDWARE_ID`.

## UART format

Expects lines from gateway firmware such as:

`NODE: id=2 UUID: 0x00000007 RSSI: -48 Gesture: idle (0)`

Legacy lines without `NODE:` are still parsed for bench use.
