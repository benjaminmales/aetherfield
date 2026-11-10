-- ============================================================
-- Aetherfield — one-time reconcile of a DRIFTED live database
-- Safe to run repeatedly. Brings an existing DB (created from an
-- older schema) up to match supabase-schema.sql:
--   • adds missing columns to pre-existing tables
--   • ensures the device_bindings unique constraint (upsert onConflict)
--   • (re)creates all RLS policies
--   • ensures realtime publication membership
-- Run this in the Supabase SQL editor.
-- ============================================================

create extension if not exists pgcrypto;

-- ---- tables (no-op if they already exist) ------------------
create table if not exists public.activation_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.physical_devices (
  hardware_id text primary key,
  kind text not null,
  label text,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.device_bindings (
  id uuid primary key default gen_random_uuid(),
  hardware_id text not null,
  kind text not null,
  project_id uuid not null references public.activation_projects(id) on delete cascade,
  virtual_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.gateway_telemetry (
  id uuid primary key default gen_random_uuid(),
  gateway_hardware_id text not null,
  received_at timestamptz not null default now()
);

-- ---- patch columns onto pre-existing (drifted) tables ------
alter table public.physical_devices  add column if not exists label text;
alter table public.physical_devices  add column if not exists last_seen timestamptz;

alter table public.device_bindings   add column if not exists kind text;
alter table public.device_bindings   add column if not exists virtual_id text;
alter table public.device_bindings   add column if not exists project_id uuid references public.activation_projects(id) on delete cascade;

alter table public.gateway_telemetry add column if not exists project_id uuid references public.activation_projects(id) on delete set null;
alter table public.gateway_telemetry add column if not exists node_id integer;
alter table public.gateway_telemetry add column if not exists node_uuid text;
alter table public.gateway_telemetry add column if not exists rssi integer;
alter table public.gateway_telemetry add column if not exists gesture text;
alter table public.gateway_telemetry add column if not exists raw text;

-- ---- device_bindings: one binding per hardware_id (upsert) -
do $$
begin
  -- remove dupes so the unique constraint can be added
  delete from public.device_bindings a
  using public.device_bindings b
  where a.ctid < b.ctid and a.hardware_id = b.hardware_id;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.device_bindings'::regclass and contype = 'u'
      and conname = 'device_bindings_hardware_id_key'
  ) then
    alter table public.device_bindings add constraint device_bindings_hardware_id_key unique (hardware_id);
  end if;
end $$;

create index if not exists device_bindings_hardware_id_idx on public.device_bindings (hardware_id);
create index if not exists device_bindings_project_id_idx  on public.device_bindings (project_id);
create index if not exists gateway_telemetry_project_id_idx on public.gateway_telemetry (project_id);
create index if not exists gateway_telemetry_received_at_idx on public.gateway_telemetry (received_at desc);

-- ---- RLS ---------------------------------------------------
alter table public.activation_projects enable row level security;
alter table public.physical_devices    enable row level security;
alter table public.device_bindings     enable row level security;
alter table public.gateway_telemetry   enable row level security;

-- activation_projects: owner CRUD
drop policy if exists "activation projects select own" on public.activation_projects;
create policy "activation projects select own" on public.activation_projects for select using (auth.uid() = owner_id);
drop policy if exists "activation projects insert own" on public.activation_projects;
create policy "activation projects insert own" on public.activation_projects for insert with check (auth.uid() = owner_id);
drop policy if exists "activation projects update own" on public.activation_projects;
create policy "activation projects update own" on public.activation_projects for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists "activation projects delete own" on public.activation_projects;
create policy "activation projects delete own" on public.activation_projects for delete using (auth.uid() = owner_id);

-- physical_devices: authenticated read + register (insert/update)
drop policy if exists "physical devices select authenticated" on public.physical_devices;
create policy "physical devices select authenticated" on public.physical_devices for select using (auth.role() = 'authenticated');
drop policy if exists "physical devices insert authenticated" on public.physical_devices;
create policy "physical devices insert authenticated" on public.physical_devices for insert with check (auth.role() = 'authenticated');
drop policy if exists "physical devices update authenticated" on public.physical_devices;
create policy "physical devices update authenticated" on public.physical_devices for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- device_bindings: owner select/insert/update/delete (update needed for upsert)
drop policy if exists "device bindings select own" on public.device_bindings;
create policy "device bindings select own" on public.device_bindings for select
  using (exists (select 1 from public.activation_projects p where p.id = project_id and p.owner_id = auth.uid()));
drop policy if exists "device bindings insert own" on public.device_bindings;
create policy "device bindings insert own" on public.device_bindings for insert
  with check (exists (select 1 from public.activation_projects p where p.id = project_id and p.owner_id = auth.uid()));
drop policy if exists "device bindings update own" on public.device_bindings;
create policy "device bindings update own" on public.device_bindings for update
  using (exists (select 1 from public.activation_projects p where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.activation_projects p where p.id = project_id and p.owner_id = auth.uid()));
drop policy if exists "device bindings delete own" on public.device_bindings;
create policy "device bindings delete own" on public.device_bindings for delete
  using (exists (select 1 from public.activation_projects p where p.id = project_id and p.owner_id = auth.uid()));

-- gateway_telemetry: owner read
drop policy if exists "gateway telemetry select own" on public.gateway_telemetry;
create policy "gateway telemetry select own" on public.gateway_telemetry for select
  using (project_id is not null and exists (select 1 from public.activation_projects p where p.id = project_id and p.owner_id = auth.uid()));

-- ---- realtime publication (guarded so re-runs don't error) -
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='gateway_telemetry') then
    alter publication supabase_realtime add table public.gateway_telemetry;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='device_bindings') then
    alter publication supabase_realtime add table public.device_bindings;
  end if;
end $$;
