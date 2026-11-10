-- ============================================================
-- Aetherfield Platform — Supabase Schema
-- Run this in the Supabase SQL editor (safe to re-run)
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- activation_projects
-- Cloud-persisted event projects, owned per user.
-- ------------------------------------------------------------
create table if not exists public.activation_projects (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    uuid        not null references auth.users(id) on delete cascade,
  name        text        not null check (char_length(name) > 0),
  state       jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists activation_projects_owner_id_idx
  on public.activation_projects (owner_id);

alter table public.activation_projects enable row level security;

drop policy if exists "activation projects select own" on public.activation_projects;
create policy "activation projects select own"
  on public.activation_projects for select
  using (auth.uid() = owner_id);

drop policy if exists "activation projects insert own" on public.activation_projects;
create policy "activation projects insert own"
  on public.activation_projects for insert
  with check (auth.uid() = owner_id);

drop policy if exists "activation projects update own" on public.activation_projects;
create policy "activation projects update own"
  on public.activation_projects for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "activation projects delete own" on public.activation_projects;
create policy "activation projects delete own"
  on public.activation_projects for delete
  using (auth.uid() = owner_id);


-- ------------------------------------------------------------
-- physical_devices
-- One row per physical device (gateway or node).
-- Written by pi-bridge via service role (upsert on boot + heartbeat).
-- ------------------------------------------------------------
create table if not exists public.physical_devices (
  hardware_id  text        primary key,
  kind         text        not null check (kind in ('gateway', 'node')),
  label        text,
  last_seen    timestamptz,
  created_at   timestamptz not null default now()
);

alter table public.physical_devices enable row level security;

-- Authenticated users can read all physical devices (needed for pairing UI)
drop policy if exists "physical devices select authenticated" on public.physical_devices;
create policy "physical devices select authenticated"
  on public.physical_devices for select
  using (auth.role() = 'authenticated');

-- pi-bridge writes presence/heartbeat via the service role key (bypasses RLS).
-- The pairing page (authenticated user) also needs to register a physical device
-- before writing its binding, so allow authenticated insert/update here too.
drop policy if exists "physical devices insert authenticated" on public.physical_devices;
create policy "physical devices insert authenticated"
  on public.physical_devices for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "physical devices update authenticated" on public.physical_devices;
create policy "physical devices update authenticated"
  on public.physical_devices for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');


-- ------------------------------------------------------------
-- device_bindings
-- Links a physical device (hardware_id) to a virtual placeholder
-- in an activation_project (virtual_id = gateway/node UUID on the map).
-- Read by pi-bridge to route telemetry to the correct project.
-- Written by the /pair registration page (authenticated user).
-- ------------------------------------------------------------
create table if not exists public.device_bindings (
  id          uuid        primary key default gen_random_uuid(),
  hardware_id text        not null references public.physical_devices(hardware_id) on delete cascade,
  kind        text        not null check (kind in ('gateway', 'node')),
  project_id  uuid        not null references public.activation_projects(id) on delete cascade,
  virtual_id  text        not null,   -- UUID of the gateway/node placeholder in the venue map
  created_at  timestamptz not null default now(),

  -- One physical device can only be bound to one project at a time
  unique (hardware_id)
);

create index if not exists device_bindings_hardware_id_idx
  on public.device_bindings (hardware_id);

create index if not exists device_bindings_project_id_idx
  on public.device_bindings (project_id);

alter table public.device_bindings enable row level security;

-- Project owner can read their bindings
drop policy if exists "device bindings select own" on public.device_bindings;
create policy "device bindings select own"
  on public.device_bindings for select
  using (
    exists (
      select 1 from public.activation_projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );

-- Project owner can create bindings for their projects
drop policy if exists "device bindings insert own" on public.device_bindings;
create policy "device bindings insert own"
  on public.device_bindings for insert
  with check (
    exists (
      select 1 from public.activation_projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );

-- Project owner can re-pair (upsert onConflict hardware_id → UPDATE) bindings
drop policy if exists "device bindings update own" on public.device_bindings;
create policy "device bindings update own"
  on public.device_bindings for update
  using (
    exists (
      select 1 from public.activation_projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.activation_projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );

-- Project owner can delete (unpair) bindings
drop policy if exists "device bindings delete own" on public.device_bindings;
create policy "device bindings delete own"
  on public.device_bindings for delete
  using (
    exists (
      select 1 from public.activation_projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );

-- Service role can read bindings (pi-bridge looks up project_id by hardware_id)
-- Covered by service role bypassing RLS.


-- ------------------------------------------------------------
-- gateway_telemetry
-- Written by pi-bridge (service role). Read by EventBuilder (authenticated).
-- ------------------------------------------------------------
create table if not exists public.gateway_telemetry (
  id                  uuid        primary key default gen_random_uuid(),
  gateway_hardware_id text        not null,
  project_id          uuid        references public.activation_projects(id) on delete set null,
  node_id             integer,
  node_uuid           text,
  rssi                integer,
  gesture             text,
  raw                 text,
  received_at         timestamptz not null default now()
);

create index if not exists gateway_telemetry_project_id_idx
  on public.gateway_telemetry (project_id);

create index if not exists gateway_telemetry_received_at_idx
  on public.gateway_telemetry (received_at desc);

alter table public.gateway_telemetry enable row level security;

-- Project owner can read telemetry for their project
drop policy if exists "gateway telemetry select own" on public.gateway_telemetry;
create policy "gateway telemetry select own"
  on public.gateway_telemetry for select
  using (
    project_id is not null
    and exists (
      select 1 from public.activation_projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );

-- Enable Realtime for live telemetry in EventBuilder
alter publication supabase_realtime add table public.gateway_telemetry;
alter publication supabase_realtime add table public.device_bindings;
