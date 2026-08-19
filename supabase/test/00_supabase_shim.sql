-- =====================================================================
-- A minimum Supabase-shaped environment, for running the migrations
-- against a plain PostgreSQL server.
--
-- Supabase provides these; a bare cluster does not. This is only enough to
-- let the migrations and seeds execute and be checked — it is not an
-- emulation of Supabase, and nothing here is ever run against a real project.
--
-- See supabase/test/run.sh.
-- =====================================================================

create extension if not exists pgcrypto;

-- The roles the RLS policies grant to.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- auth.users, and the trigger target the profile trigger hangs off.
create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- auth.uid() reads the signed-in user from the request. Here it reads a
-- session setting, so a test can say who it is with:
--   select set_config('request.jwt.claim.sub', '<uuid>', true);
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- The publication 0003 adds tables to.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;
