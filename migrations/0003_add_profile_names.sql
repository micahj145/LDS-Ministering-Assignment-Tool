-- ═══════════════════════════════════════════════════════════════
-- Migration: collect first/last name at signup
--
-- Run this once in the Supabase SQL Editor for a project already set
-- up from an earlier version of supabase_schema.sql.
--
-- Notes are now authored under the signed-in user's name instead of
-- their email. New signups provide a first/last name that the client
-- passes as signup metadata; handle_new_user() copies it onto the
-- profiles row. update_my_name() lets an already-existing account
-- (created before this migration, so it has no name yet) set its own
-- name — deliberately narrow: it can only ever touch that one row's
-- first_name/last_name, never status or is_admin, so it can't be used
-- for privilege escalation.
-- ═══════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := case when lower(new.email) = 'micahj145@gmail.com' then 'approved' else 'pending' end;
  v_is_admin boolean := lower(new.email) = 'micahj145@gmail.com';
  v_first text := nullif(trim(new.raw_user_meta_data->>'first_name'), '');
  v_last  text := nullif(trim(new.raw_user_meta_data->>'last_name'), '');
begin
  insert into public.profiles (id, email, status, is_admin, first_name, last_name)
  values (new.id, new.email, v_status, v_is_admin, v_first, v_last);

  if v_status = 'pending' then
    perform public.send_admin_email(
      'New signup request — Ministering Tool',
      coalesce(nullif(trim(concat_ws(' ', v_first, v_last)), ''), new.email)
        || ' (' || new.email || ') has requested access and is awaiting your approval.'
    );
  end if;

  return new;
end;
$$;

create or replace function public.update_my_name(p_first_name text, p_last_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  update public.profiles
  set first_name = nullif(trim(p_first_name), ''), last_name = nullif(trim(p_last_name), '')
  where id = auth.uid();
end;
$$;

revoke all on function public.update_my_name(text, text) from public;
grant execute on function public.update_my_name(text, text) to authenticated;
