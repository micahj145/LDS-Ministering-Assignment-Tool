-- ═══════════════════════════════════════════════════════════════
-- Ministering Assignment Tool — Supabase schema
-- Run this once in the Supabase SQL Editor on a fresh project.
--
-- After running: go to Authentication → Providers → Email and turn OFF
-- "Confirm email" so signup goes straight to the pending-approval screen
-- instead of requiring an email-confirmation click first (admin approval
-- is already the real access gate).
-- ═══════════════════════════════════════════════════════════════

-- ── profiles (auth gating) ───────────────────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  status     text not null default 'pending' check (status in ('pending','approved','denied')),
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row on signup. The designated admin is
-- auto-approved and flagged admin so there's no bootstrap chicken-and-egg
-- problem (no admin exists yet to approve the first admin).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, status, is_admin)
  values (
    new.id,
    new.email,
    case when lower(new.email) = 'micahj145@gmail.com' then 'approved' else 'pending' end,
    lower(new.email) = 'micahj145@gmail.com'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Security-definer helpers so profiles' own RLS policies don't
-- self-recursively query profiles under RLS (infinite recursion).
create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and status = 'approved'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ── App data tables ──────────────────────────────────────────────
-- text primary keys match the app's existing client-generated uid()
-- scheme (not uuid), so no id-remapping layer is needed between the
-- client and the database.
create table public.members (
  id           text primary key,
  name         text not null,
  gender       text,
  age          integer default 0,
  phone        text,
  is_brother   boolean not null default true,
  household_id text,              -- deliberately unconstrained: may reference households.id
  in_pool      jsonb,             -- true | 'maybe' | false | null
  notes        jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

create table public.households (
  id         text primary key,
  name       text not null,
  members    jsonb not null default '[]'::jsonb,  -- raw CSV name strings, NOT foreign keys
  head       text,
  address    text,
  phone      text,
  email      text,
  notes      jsonb not null default '[]'::jsonb,
  lat        double precision,
  lng        double precision,
  in_pool    jsonb,
  updated_at timestamptz not null default now()
);

create table public.companionships (
  id         text primary key,
  list       text not null check (list in ('current','proposed')),
  m1_id      text,
  m1_name    text,
  m2_id      text,               -- may be the sentinel '__spouse__'
  m2_name    text,
  households jsonb not null default '[]'::jsonb,  -- ids OR bare name strings, mixed
  notes      jsonb not null default '[]'::jsonb,
  district   text,               -- only ever populated by CSV import
  updated_at timestamptz not null default now()
);

create index companionships_list_idx on public.companionships(list);

-- ── RLS ───────────────────────────────────────────────────────────
alter table public.profiles       enable row level security;
alter table public.members        enable row level security;
alter table public.households     enable row level security;
alter table public.companionships enable row level security;

-- profiles: users can see their own row; admins can see/update everyone's.
-- No insert policy needed — the trigger runs as security definer (owner),
-- bypassing RLS, so normal clients never insert into profiles directly.
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

create policy "profiles_update_admin_only" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- Shared single-tenant dataset: any approved user has full CRUD on all
-- rows (no ownership/row-level restriction, per the "single shared ward
-- dataset, last-write-wins" decision).
create policy "members_all_approved" on public.members
  for all using (public.is_approved()) with check (public.is_approved());

create policy "households_all_approved" on public.households
  for all using (public.is_approved()) with check (public.is_approved());

create policy "companionships_all_approved" on public.companionships
  for all using (public.is_approved()) with check (public.is_approved());

-- ── Table-level grants ───────────────────────────────────────────
-- RLS policies above only take effect once the base GRANT allows access
-- at all — Postgres checks table-level privileges before row-level
-- policies. Signed-in requests run as the `authenticated` role (the
-- anon key's `anon` role is only used pre-login), so that's the role
-- that needs these grants.
grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.members, public.households, public.companionships to authenticated;
