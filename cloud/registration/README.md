# aura-registration

Guest registration + messaging for the Aura Tag demo kit. Lives at
**https://aetherfield.cloud/aura-registration**.

Forked from `traitors-registration` (same Supabase/Twilio pattern), stripped
to the demo-kit essentials and locked down.

## What it does

- A guest scans the QR on an Aura Tag → `/register?d=<id>` → enters name +
  mobile number. They get a welcome SMS.
- **All data is hard-deleted 30 minutes after registration.** Lazily on every
  API call, with a daily Vercel cron as a backstop. No history, no soft delete.
- The Demo Server (on the client's laptop) polls `/api/registrations` to show
  names next to Tags, and posts `/api/action` to text a Tag's owner — e.g.
  from a behaviour rule ("when Tag 4C51 moves, text its owner").

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/register` | none (public form) | create/refresh a registration |
| `GET /api/registrations` | Bearer `CLOUD_API_TOKEN` | roster incl. phone numbers (PII) |
| `POST /api/action` | Bearer `CLOUD_API_TOKEN` | send one guest an SMS (rate-capped) |
| `POST /api/reset` | Bearer `CLOUD_API_TOKEN` | wipe everything between demo runs |
| `GET /api/purge` | none | delete expired rows (cron) |
| `/qr` | none | printable QR sheet, one per Tag id |

`CLOUD_API_TOKEN` must match `CLOUD_TOKEN` in the Demo Server's `.env`.
**Fail-closed:** on Vercel, the token-locked endpoints refuse if the env var
is missing — a misconfigured deployment never becomes an open SMS gateway.

## Deploy

1. Supabase: run `schema.sql` in the SQL editor.
2. Vercel: new project from `cloud/registration`, set env per `.env.example`.
3. Point `aetherfield.cloud` at the project (the app lives under
   `/aura-registration`; `/` redirects there).

## Local dev

```sh
npm install
npm run dev
```

Without Twilio env it runs in dry-run mode (messages logged, not sent); the
token check is skipped off-Vercel.
