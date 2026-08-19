-- =====================================================================
-- RotaSorter — 0001_schema.sql
-- Core schema for the bench rota prototype.
--
-- Run order:  0001 -> 0002 -> 0003 -> 0004, then the files in
-- supabase/seed/ in numeric order. 0000_reset.sql is an optional teardown.
--
-- Synthetic data only. No real employee records at any point.
-- =====================================================================

-- Wrapped in a transaction: if any statement fails, nothing is left
-- behind and the file can be corrected and run again.
begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

-- Grades use slugs; the UI renders the labels (AP, BMS, Senior BMS, Trainee).
create type staff_grade        as enum ('ap', 'bms', 'senior_bms', 'trainee');
create type staff_status       as enum ('active', 'inactive');

-- Competency ladder. 'trainee' means placed on the bench while training,
-- 'competent' means signed off, 'trainer' means signed off and may supervise.
create type competency_level   as enum ('trainee', 'competent', 'trainer');

-- Per-document progress, which is what the paper competency file actually records.
create type doc_status         as enum ('not_started', 'in_training', 'signed_off');

create type absence_kind       as enum ('annual_leave', 'sick', 'study', 'other');

create type rule_scope         as enum ('global', 'staff', 'bench');
create type rule_action        as enum (
  'must_be_assigned',
  'cannot_be_assigned',
  'requires_at_least',
  'requires_at_most',
  'requires_supervisor',
  'same_bench_all_week',
  'max_shifts_in_period',
  'not_together'
);
create type rule_status        as enum ('active', 'paused');

create type run_status         as enum (
  'queued',                 -- row written by the UI, worker has not picked it up
  'running',                -- worker claimed it
  'solved',
  'solved_with_breaches',
  'infeasible',
  'error',
  'cancelled'
);

create type assignment_source  as enum ('solver', 'manual');
create type app_role           as enum ('admin', 'manager', 'viewer');

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------

-- One row per auth user. Defaults to 'manager' because the prototype has no
-- self-registration: every account is created deliberately in the Supabase
-- dashboard, so anyone who can log in is trusted to run a rota.
create table profile (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  role          app_role    not null default 'manager',
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Reference data: shifts, bench groups, benches, competency documents
-- ---------------------------------------------------------------------

create table shift (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  starts_at   time not null,
  ends_at     time not null,
  is_default  boolean not null default false,
  sort_order  int     not null default 0
);

create table bench_group (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  sort_order  int  not null default 0
);

create table bench (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  group_id        uuid references bench_group (id) on delete set null,
  -- Defaults for any shift this bench runs on; bench_shift_requirement overrides.
  min_staff       int  not null default 1 check (min_staff >= 0),
  max_staff       int check (max_staff is null or max_staff >= min_staff),
  required_level  competency_level not null default 'competent',
  is_active       boolean not null default true,
  sort_order      int     not null default 0,
  notes           text
);

-- The document numbers people match by eye. One bench has many documents;
-- a member of staff is signed off document by document.
create table competency_document (
  id          uuid primary key default gen_random_uuid(),
  bench_id    uuid not null references bench (id) on delete cascade,
  doc_number  text not null,
  title       text,
  is_primary  boolean not null default false,
  sort_order  int     not null default 0,
  unique (bench_id, doc_number)
);

create index competency_document_doc_number_idx on competency_document (doc_number);

-- A bench only runs on the shifts it has a row for. No row means the bench is
-- not staffed on that shift, which is how the Late shift stays small.
--
-- weekdays is ISO (1 = Monday .. 7 = Sunday) and is the set of days this bench
-- runs on this shift. Plenty of benches are not daily: Mycology is Tuesday and
-- Thursday, reference lab reports are read on a Wednesday. Without this the
-- rota asks for more benches than there are people to staff them.
-- `label` lets one bench carry more than one requirement on the same shift,
-- because a weekend service is not a weekday service at lower volume, it is a
-- different requirement. Weekday sets under one bench+shift are expected to be
-- disjoint; if they overlap the solver takes the largest min_staff and says so.
create table bench_shift_requirement (
  bench_id        uuid not null references bench (id) on delete cascade,
  shift_id        uuid not null references shift (id) on delete cascade,
  label           text not null default 'standard',
  weekdays        smallint[] not null default '{1,2,3,4,5}',
  min_staff       int  not null default 1 check (min_staff >= 0),
  max_staff       int check (max_staff is null or max_staff >= min_staff),
  required_level  competency_level,   -- null inherits bench.required_level
  primary key (bench_id, shift_id, label),
  -- Array containment rather than a scan over unnest(): a CHECK constraint
  -- cannot contain a subquery. An empty array is contained in anything, which
  -- is the right answer for a bench that runs on no days.
  check (weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])
);

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------

create table staff (
  id          uuid primary key default gen_random_uuid(),
  staff_code  text not null unique,
  full_name   text not null,
  grade       staff_grade  not null,
  status      staff_status not null default 'active',
  fte         numeric(3, 2) not null default 1.00 check (fte > 0 and fte <= 1),
  started_on  date,
  notes       text
);

-- Contracted pattern. weekday is ISO: 1 = Monday .. 7 = Sunday.
create table availability (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid     not null references staff (id) on delete cascade,
  weekday       smallint not null check (weekday between 1 and 7),
  shift_id      uuid     not null references shift (id) on delete cascade,
  is_available  boolean  not null default true,
  unique (staff_id, weekday, shift_id)
);

create table absence (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references staff (id) on delete cascade,
  starts_on  date not null,
  ends_on    date not null,
  kind       absence_kind not null default 'annual_leave',
  notes      text,
  check (ends_on >= starts_on)
);

create index absence_staff_range_idx on absence (staff_id, starts_on, ends_on);

-- The bench-level record the Competency Matrix edits and the solver reads.
-- staff_document below is the underlying evidence trail.
create table competency (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references staff (id) on delete cascade,
  bench_id      uuid not null references bench (id) on delete cascade,
  level         competency_level not null,
  assessed_on   date,
  expires_on    date,
  assessor_id   uuid references staff (id) on delete set null,
  document_ref  text,   -- primary document number, shown on matrix cell hover
  notes         text,
  unique (staff_id, bench_id)
);

create index competency_bench_idx on competency (bench_id);

create table staff_document (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references staff (id) on delete cascade,
  document_id  uuid not null references competency_document (id) on delete cascade,
  status       doc_status not null default 'not_started',
  assessed_on  date,
  expires_on   date,
  unique (staff_id, document_id)
);

-- ---------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------

-- conditions holds a condition tree, nesting capped at two levels by the UI:
--   {"op": "all", "children": [
--      {"subject": "person", "operator": "is", "values": ["<staff uuid>"]},
--      {"op": "any", "children": [ ... ]}
--   ]}
create table rule (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  action         rule_action not null,
  params         jsonb not null default '{}'::jsonb,
  conditions     jsonb not null default '{"op":"all","children":[]}'::jsonb,
  scope          rule_scope  not null default 'global',
  is_hard        boolean not null default true,
  weight         int     not null default 50 check (weight between 1 and 100),
  status         rule_status not null default 'active',
  plain_english  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Rota: runs, assignments, pins, breaches
-- ---------------------------------------------------------------------

create table rota_run (
  id                 uuid primary key default gen_random_uuid(),
  week_start         date not null,
  status             run_status not null default 'queued',
  requested_by       uuid references auth.users (id) on delete set null,
  requested_by_name  text,
  requested_at       timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  solve_ms           int,
  pins_applied       int not null default 0,
  soft_breach_count  int not null default 0,
  objective_value    numeric,
  status_detail      text,
  infeasible_report  jsonb,   -- named conflicts + suggested resolutions
  rule_snapshot      jsonb,   -- the rule set as it stood at solve time
  solver_version     text,
  worker_ref         text,    -- GitHub Actions run URL
  log                text
);

create index rota_run_week_idx on rota_run (week_start, requested_at desc);
create index rota_run_status_idx on rota_run (status) where status in ('queued', 'running');

create table assignment (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references rota_run (id) on delete cascade,
  week_start  date not null,
  work_date   date not null,
  shift_id    uuid not null references shift (id) on delete cascade,
  bench_id    uuid not null references bench (id) on delete cascade,
  staff_id    uuid not null references staff (id) on delete cascade,
  source      assignment_source not null default 'solver',
  is_pinned   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (run_id, work_date, shift_id, bench_id, staff_id)
);

create index assignment_week_idx on assignment (week_start, work_date);
create index assignment_run_idx on assignment (run_id);

-- Pins are solver *inputs*, deliberately separate from assignments (outputs) so
-- a re-solve can wipe every assignment for the week and keep human decisions.
create table pin (
  id          uuid primary key default gen_random_uuid(),
  week_start  date not null,
  work_date   date not null,
  shift_id    uuid not null references shift (id) on delete cascade,
  bench_id    uuid not null references bench (id) on delete cascade,
  staff_id    uuid not null references staff (id) on delete cascade,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  reason      text,
  unique (work_date, shift_id, bench_id, staff_id)
);

create index pin_week_idx on pin (week_start);

create table rule_breach (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references rota_run (id) on delete cascade,
  rule_id    uuid references rule (id) on delete set null,
  rule_name  text,
  weight     int,
  work_date  date,
  shift_id   uuid references shift (id) on delete set null,
  bench_id   uuid references bench (id) on delete set null,
  staff_id   uuid references staff (id) on delete set null,
  detail     text not null
);

create index rule_breach_run_idx on rule_breach (run_id);

-- Which run is the published rota for a given week.
create table rota_week (
  week_start        date primary key,
  published_run_id  uuid references rota_run (id) on delete set null,
  published_at      timestamptz,
  published_by      uuid references auth.users (id) on delete set null,
  notes             text
);

-- Solver weights and other tunables, edited on Settings.
create table solver_setting (
  key          text primary key,
  value        jsonb not null,
  label        text,
  description  text,
  sort_order   int not null default 0
);

commit;
