-- ═══════════════════════════════════════════════════════════════
-- Ministering Assignment Tool — Supabase schema
-- Run this once in the Supabase SQL Editor on a fresh project.
--
-- After running: go to Authentication → Providers → Email and turn OFF
-- "Confirm email" so signup goes straight to the pending-approval screen
-- instead of requiring an email-confirmation click first (admin approval
-- is already the real access gate).
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pg_net;

-- ── profiles (auth gating) ───────────────────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  status     text not null default 'pending' check (status in ('pending','approved','denied')),
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

-- Sends a plain-text email to every admin via Resend. No-ops silently if
-- the 'resend_api_key' Vault secret hasn't been configured yet — run
-- `select vault.create_secret('YOUR_REAL_KEY', 'resend_api_key');` in the
-- SQL Editor yourself (never commit the real key to the repo).
create or replace function public.send_admin_email(p_subject text, p_body text)
returns void
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_api_key text;
  v_admin record;
begin
  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_api_key is null then
    return;
  end if;

  for v_admin in select email from public.profiles where is_admin = true loop
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_api_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'from', 'Ministering Tool <onboarding@resend.dev>',
        'to', jsonb_build_array(v_admin.email),
        'subject', p_subject,
        'text', p_body
      )
    );
  end loop;
end;
$$;

-- Auto-create a profile row on signup. The designated admin is
-- auto-approved and flagged admin so there's no bootstrap chicken-and-egg
-- problem (no admin exists yet to approve the first admin). Emails the
-- admin(s) about any other (pending) signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := case when lower(new.email) = 'micahj145@gmail.com' then 'approved' else 'pending' end;
  v_is_admin boolean := lower(new.email) = 'micahj145@gmail.com';
begin
  insert into public.profiles (id, email, status, is_admin)
  values (new.id, new.email, v_status, v_is_admin);

  if v_status = 'pending' then
    perform public.send_admin_email(
      'New signup request — Ministering Tool',
      new.email || ' has requested access and is awaiting your approval.'
    );
  end if;

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
  position   integer not null default 0,  -- display order within its list, lower first
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

-- ── Audit log ─────────────────────────────────────────────────
create table public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  table_name  text not null,
  record_id   text,
  action      text not null check (action in ('insert','update','delete')),
  summary     text,
  old_data    jsonb,
  new_data    jsonb
);
create index audit_log_occurred_at_idx on public.audit_log(occurred_at desc);

alter table public.audit_log enable row level security;
create policy "audit_log_admin_only" on public.audit_log for select using (public.is_admin());
grant select on public.audit_log to authenticated;

create or replace function public.log_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_record_id text;
  v_summary text;
  v_label text;
begin
  select email into v_actor_email from public.profiles where id = v_actor;

  v_record_id := coalesce((case when TG_OP = 'DELETE' then OLD.id else NEW.id end)::text, '');

  if TG_TABLE_NAME = 'profiles' then
    if TG_OP = 'INSERT' then
      v_summary := format('%s signed up and is awaiting approval', NEW.email);
    elsif TG_OP = 'UPDATE' then
      v_summary := format('%s set %s''s status to %s', coalesce(v_actor_email, 'unknown'), NEW.email, NEW.status);
    else
      v_summary := format('%s removed user %s', coalesce(v_actor_email, 'unknown'), OLD.email);
    end if;
  else
    if TG_TABLE_NAME = 'members' then
      v_label := coalesce((case when TG_OP = 'DELETE' then OLD.name else NEW.name end), v_record_id);
    elsif TG_TABLE_NAME = 'households' then
      v_label := coalesce((case when TG_OP = 'DELETE' then OLD.name else NEW.name end), v_record_id);
    elsif TG_TABLE_NAME = 'companionships' then
      v_label := coalesce((case when TG_OP = 'DELETE' then OLD.m1_name else NEW.m1_name end), v_record_id);
    else
      v_label := v_record_id;
    end if;

    if TG_OP = 'UPDATE' and TG_TABLE_NAME in ('members','households','companionships') then
      if jsonb_array_length(coalesce(NEW.notes,'[]'::jsonb)) > jsonb_array_length(coalesce(OLD.notes,'[]'::jsonb)) then
        v_summary := format('%s added a note on %s "%s"', coalesce(v_actor_email,'unknown'), TG_TABLE_NAME, v_label);
      elsif jsonb_array_length(coalesce(NEW.notes,'[]'::jsonb)) < jsonb_array_length(coalesce(OLD.notes,'[]'::jsonb)) then
        v_summary := format('%s deleted a note on %s "%s"', coalesce(v_actor_email,'unknown'), TG_TABLE_NAME, v_label);
      else
        v_summary := format('%s updated %s "%s"', coalesce(v_actor_email,'unknown'), TG_TABLE_NAME, v_label);
      end if;
    elsif TG_OP = 'INSERT' then
      v_summary := format('%s created %s "%s"', coalesce(v_actor_email,'unknown'), TG_TABLE_NAME, v_label);
    elsif TG_OP = 'DELETE' then
      v_summary := format('%s deleted %s "%s"', coalesce(v_actor_email,'unknown'), TG_TABLE_NAME, v_label);
    else
      v_summary := format('%s %s %s "%s"', coalesce(v_actor_email,'unknown'), lower(TG_OP), TG_TABLE_NAME, v_label);
    end if;
  end if;

  insert into public.audit_log(actor_id, actor_email, table_name, record_id, action, summary, old_data, new_data)
  values (
    v_actor, v_actor_email, TG_TABLE_NAME, v_record_id, lower(TG_OP), v_summary,
    case when TG_OP <> 'INSERT' then to_jsonb(OLD) else null end,
    case when TG_OP <> 'DELETE' then to_jsonb(NEW) else null end
  );

  return coalesce(NEW, OLD);
end;
$$;

create trigger audit_members after insert or update or delete on public.members
  for each row execute function public.log_audit();
create trigger audit_households after insert or update or delete on public.households
  for each row execute function public.log_audit();
create trigger audit_companionships after insert or update or delete on public.companionships
  for each row execute function public.log_audit();
create trigger audit_profiles after insert or update or delete on public.profiles
  for each row execute function public.log_audit();
