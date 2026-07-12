-- ═══════════════════════════════════════════════════════════════
-- Migration: admin email notifications + audit log
--
-- Run this once in the Supabase SQL Editor for a project already set
-- up from an earlier version of supabase_schema.sql.
--
-- Adds:
--   - An audit_log table (admin-only readable) recording every insert/
--     update/delete on members/households/companionships/profiles.
--   - Admin-only email notification (via Resend) for new signups.
--
-- BEFORE running this: you need a Resend account (resend.com) and an
-- API key. AFTER running this, store that key in Supabase Vault by
-- running (in the SQL Editor, NOT committed anywhere):
--
--   select vault.create_secret('YOUR_REAL_RESEND_API_KEY', 'resend_api_key');
--
-- Until that secret exists, send_admin_email() silently no-ops (no
-- errors, just no emails sent) so the rest of the app is unaffected.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pg_net;

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

-- ── Admin-only email notifications ──────────────────────────────
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
    return; -- not configured yet; skip silently
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

-- Extends the existing signup trigger to also email the admin(s) about
-- pending requests (the admin's own auto-approved bootstrap signup is
-- not itself emailed).
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
