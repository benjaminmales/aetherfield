# Demo run sheet

Everything here was verified end to end on 15 Sep. Read the ports section
first; it is the only thing that bites silently.

---

## Ports

| What | Port | Notes |
|---|---|---|
| Gateways → server (TCP) | **9000** | The gateways dial this. Not negotiable — it is compiled in. |
| Pixel event server console | **3000** | `http://localhost:3000/` |
| Registration app (Next.js) | **3100** | Only if run locally. Pinned in `package.json`; it defaulted to 3000 and collided. |

If `npm start` dies with `EADDRINUSE`, an earlier instance is still holding the
port. `lsof -nP -iTCP:9000 -sTCP:LISTEN`, kill the pid, start again.

---

## Start order

**1. Registration app** — already deployed, nothing to start:

    https://traitors-registration.vercel.app

It is `~/Consultancy/Traitors/Demo/registration` (Supabase + Twilio,
WhatsApp with SMS fallback, 30-minute PII purge). Set `NEXT_PUBLIC_EVENT=aetherfield`
in Vercel and redeploy to dress it as Aetherfield rather than The Traitors.

Guests scan with their own phones, so this must be the public deployment — a
copy running on your laptop is not reachable from a phone on mobile data.

**2. Pixel event server**, pointed at whichever of those you are using:

```sh
cd ~/aetherfield-pixel/server
CLOUD_URL=https://traitors-registration.vercel.app npm start
```

`CLOUD_URL` is already set in `server/.env`, so `npm start` on its own is
enough. With it unset everything still works except the Message buttons, which
grey out and say so.

**3. Power the gateways.** They appear within a few seconds of link-up.
**4. Power the devices.** Beacons are 1/s, so the roster fills immediately.

---

## The demo itself

1. **Fleet is alive.** Gateways listed with IPs; devices listed with signal and
   battery. Say the number out loud — it is the only slide that matters.
2. **Colour the room.** Control → any colour. All three hardware types change
   together, because they run the same firmware and answer group `00`.
3. **Identify one.** Devices → Identify. That device alone flashes. This is the
   moment people understand it is individually addressable.
4. **Register.** Scan a device's QR → name + mobile → the Guest column on the
   dashboard changes from *unregistered* to their name within a second.
5. **Message them.** Devices → Message, or Messaging → Send to all registered.
   Their phone buzzes.

Steps 4 and 5 are the ones worth rehearsing, because they are the only ones
that need the internet.

---

## QR codes

Identity **is** the radio address. The device reports `0x4C51`, the roster keys
on it, the registration app stores `4C51` as `device_id`, and the QR is
`/register?d=4C51`. Nothing to provision, nothing to keep in sync.

```sh
cd ~/aetherfield-pixel/server
node tools/make-qr.js --base https://traitors-registration.vercel.app          # live fleet
node tools/make-qr.js --base https://traitors-registration.vercel.app --addr 4C51,1A2B
```

Writes `qr-sheet.html`. Every code is inline SVG, so it prints with no
internet. Get the addresses off any gateway console with `aura fleet`.

---

## Vercel environment

| Variable | Why |
|---|---|
| `NEXT_PUBLIC_EVENT=aetherfield` | Aetherfield name, mark and black/white/orange palette instead of The Traitors. Inlined at build time — needs a redeploy, not just a restart. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Already set. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Set these and messages actually send. Leave unset to rehearse — see below. |

One deployment carries one brand. If the Traitors client needs that site
looking like The Traitors at the same time, make a second Vercel project from
the same repo with `NEXT_PUBLIC_EVENT=aetherfield` set only on that one; you
get two URLs off one codebase and neither disturbs the other.

## Rehearsing without sending texts

If the registration app has no `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
`TWILIO_PHONE_NUMBER` set, `/api/action` resolves the contact, does everything
except the send, and returns `{dryRun:true, preview}`. The console reports that
as **DRY RUN** in orange rather than as a send — so a rehearsal cannot be
mistaken for the real thing, in either direction.

---

## Where the personal data is

Names and phone numbers live in the registration app's Postgres and nowhere
else. The local server posts an **address** and a **message** to `/api/action`
and that app resolves the contact and calls Twilio. No number is ever returned
to the local server, its API, its logs, or the operator's browser — there are
tests asserting exactly that (`lib/cloud.test.js`, `lib/webhooks.test.js`).

---

## Known, and fine for tomorrow

- **gw-01 has a PoE fault** and does not power up. Two gateways is plenty.
- **Group masks differ per board**: K4 `0x01`, XIAO nRF54L15 `0x02`, Holyiot
  `0x04`. Fleet-wide commands use group `00` and hit everything, so this only
  shows up if you start addressing groups.
- **The server has no authentication.** Fine on a closed event LAN, not fine on
  anything routable.
