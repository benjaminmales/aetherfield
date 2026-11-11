-- aura-registration schema (Supabase / Postgres)
-- Run once in the Supabase SQL editor.
--
-- PRIVACY: rows are hard-deleted 30 minutes after registration (expires_at),
-- lazily on every API call, with a daily Vercel cron at /api/purge as a backstop. There is no
-- history table and no soft delete — expired means gone.

CREATE TABLE IF NOT EXISTS aura_registrations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  cell        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aura_registrations_device_id
  ON aura_registrations(device_id);
CREATE INDEX IF NOT EXISTS idx_aura_registrations_expires_at
  ON aura_registrations(expires_at);
