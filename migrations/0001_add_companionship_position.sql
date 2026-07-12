-- ═══════════════════════════════════════════════════════════════
-- Migration: add a manual display-order column to companionships
--
-- Run this once in the Supabase SQL Editor for any project that was
-- already set up from an earlier version of supabase_schema.sql
-- (i.e. one whose companionships table doesn't have a `position`
-- column yet). Safe to run even if the column already exists.
-- ═══════════════════════════════════════════════════════════════

alter table public.companionships add column if not exists position integer not null default 0;

-- Backfill a stable initial order per list (current / proposed),
-- oldest-updated first, so existing rows aren't all tied at 0.
with ordered as (
  select id, list, row_number() over (partition by list order by updated_at, id) - 1 as rn
  from public.companionships
)
update public.companionships c
set position = o.rn
from ordered o
where c.id = o.id and c.list = o.list;
