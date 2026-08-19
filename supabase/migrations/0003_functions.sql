-- =====================================================================
-- RotaSorter — 0003_functions.sql
-- Triggers, derived views and the RPCs the UI and worker call.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

-- Give every new auth user a profile. No self-registration, so this only
-- fires for accounts created in the dashboard or by an admin.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profile (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger rule_set_updated_at
  before update on rule
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- Small date helper: the Monday of whatever week a date falls in.
-- ---------------------------------------------------------------------
create or replace function iso_week_start(d date)
returns date
language sql
immutable
as $$
  select (d - ((extract(isodow from d)::int - 1) || ' days')::interval)::date;
$$;

-- ---------------------------------------------------------------------
-- Views
-- security_invoker = true so RLS on the base tables still applies.
-- ---------------------------------------------------------------------

-- Per-bench resilience. The "competent_count at or below min_staff" case is the
-- one the Benches screen flags: that bench breaks the first time someone books
-- leave.
create or replace view v_bench_pool
with (security_invoker = true) as
select
  b.id                                   as bench_id,
  b.name                                 as bench_name,
  b.group_id,
  g.name                                 as group_name,
  b.min_staff,
  b.max_staff,
  b.required_level,
  b.is_active,
  b.sort_order,
  count(*) filter (
    where c.level in ('competent', 'trainer')
      and (c.expires_on is null or c.expires_on >= current_date)
      and s.status = 'active'
  )::int                                 as competent_count,
  count(*) filter (
    where c.level = 'trainer'
      and (c.expires_on is null or c.expires_on >= current_date)
      and s.status = 'active'
  )::int                                 as trainer_count,
  count(*) filter (
    where c.level = 'trainee' and s.status = 'active'
  )::int                                 as trainee_count,
  count(*) filter (
    where c.expires_on is not null
      and c.expires_on < current_date
      and s.status = 'active'
  )::int                                 as expired_count
from bench b
left join bench_group g on g.id = b.group_id
left join competency c on c.bench_id = b.id
left join staff s on s.id = c.staff_id
group by b.id, b.name, b.group_id, g.name, b.min_staff, b.max_staff,
         b.required_level, b.is_active, b.sort_order;

grant select on v_bench_pool to authenticated;

-- Per-person competency counts, for the caution glyph on the Staff table.
create or replace view v_staff_competency_summary
with (security_invoker = true) as
select
  s.id                                   as staff_id,
  count(c.id)::int                        as competency_count,
  count(*) filter (
    where c.level in ('competent', 'trainer')
      and (c.expires_on is null or c.expires_on >= current_date)
  )::int                                 as signed_off_count,
  count(*) filter (where c.level = 'trainee')::int as trainee_count,
  count(*) filter (
    where c.expires_on is not null
      and c.expires_on >= current_date
      and c.expires_on < current_date + interval '60 days'
  )::int                                 as expiring_soon_count,
  count(*) filter (
    where c.expires_on is not null and c.expires_on < current_date
  )::int                                 as expired_count
from staff s
left join competency c on c.staff_id = s.id
group by s.id;

grant select on v_staff_competency_summary to authenticated;

-- One row per matrix cell that has any record, with the display state already
-- resolved so the UI does not re-derive expiry rules.
create or replace view v_competency_matrix
with (security_invoker = true) as
select
  c.id,
  c.staff_id,
  c.bench_id,
  c.level,
  c.assessed_on,
  c.expires_on,
  c.document_ref,
  c.notes,
  a.full_name                            as assessor_name,
  case
    when c.expires_on is not null and c.expires_on < current_date then 'expired'
    when c.expires_on is not null
      and c.expires_on < current_date + interval '60 days' then 'expiring_soon'
    else c.level::text
  end                                    as display_state
from competency c
left join staff a on a.id = c.assessor_id;

grant select on v_competency_matrix to authenticated;

-- ---------------------------------------------------------------------
-- RPCs called by the UI
-- ---------------------------------------------------------------------

-- Queue a solve. Supersedes any run for the same week still sitting in the
-- queue, so double-clicking Generate cannot spawn two workers.
create or replace function queue_rota_run(p_week_start date)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run_id uuid;
  v_name   text;
  v_pins   int;
begin
  update rota_run
     set status = 'cancelled',
         status_detail = 'Superseded by a newer request',
         finished_at = now()
   where week_start = p_week_start
     and status = 'queued';

  select count(*) into v_pins from pin where week_start = p_week_start;

  select coalesce(display_name, 'Unknown') into v_name
    from profile where id = auth.uid();

  insert into rota_run (week_start, status, requested_by, requested_by_name, pins_applied)
  values (p_week_start, 'queued', auth.uid(), v_name, v_pins)
  returning id into v_run_id;

  return v_run_id;
end;
$$;

grant execute on function queue_rota_run(date) to authenticated;

-- Publish a solved run as the rota for its week.
create or replace function publish_rota(p_run_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_week   date;
  v_status run_status;
begin
  select week_start, status into v_week, v_status from rota_run where id = p_run_id;

  if v_week is null then
    raise exception 'Run % does not exist', p_run_id;
  end if;

  if v_status not in ('solved', 'solved_with_breaches') then
    raise exception 'Run % is %, only a solved run can be published', p_run_id, v_status;
  end if;

  insert into rota_week (week_start, published_run_id, published_at, published_by)
  values (v_week, p_run_id, now(), auth.uid())
  on conflict (week_start) do update
    set published_run_id = excluded.published_run_id,
        published_at     = excluded.published_at,
        published_by     = excluded.published_by;
end;
$$;

grant execute on function publish_rota(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Worker RPC: claim the oldest queued run.
-- Used by the cron fallback path in .github/workflows/solve.yml. The
-- service_role key bypasses RLS, and the row lock stops two runners
-- claiming the same job.
-- ---------------------------------------------------------------------
create or replace function claim_next_run()
returns table (run_id uuid, week_start date)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with next_run as (
    select r.id
      from rota_run r
     where r.status = 'queued'
     order by r.requested_at
     for update skip locked
     limit 1
  )
  update rota_run r
     set status = 'running', started_at = now()
    from next_run
   where r.id = next_run.id
  returning r.id, r.week_start;
end;
$$;

revoke execute on function claim_next_run() from anon, authenticated;
grant execute on function claim_next_run() to service_role;

-- ---------------------------------------------------------------------
-- Derive the bench-level competency rows from per-document sign-off.
--
-- All required documents signed off -> competent
-- any document in training         -> trainee
-- nothing started                  -> no row
--
-- The Competency Matrix writes `competency` directly, so this is a convenience
-- for bulk updates and for the seed, not an enforced invariant. Trainer level
-- is a human judgement and is never downgraded by this function.
-- ---------------------------------------------------------------------
create or replace function recompute_competency_from_documents()
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rows int;
begin
  with doc_totals as (
    select bench_id, count(*)::int as required_docs
      from competency_document
     group by bench_id
  ),
  progress as (
    select
      sd.staff_id,
      cd.bench_id,
      count(*) filter (where sd.status = 'signed_off')::int  as signed_off,
      count(*) filter (where sd.status = 'in_training')::int as in_training,
      max(sd.assessed_on)                                    as last_assessed,
      min(sd.expires_on)                                     as first_expiry
    from staff_document sd
    join competency_document cd on cd.id = sd.document_id
    where sd.status <> 'not_started'
    group by sd.staff_id, cd.bench_id
  ),
  derived as (
    select
      p.staff_id,
      p.bench_id,
      case
        when p.in_training > 0                    then 'trainee'::competency_level
        when p.signed_off >= d.required_docs      then 'competent'::competency_level
        else 'trainee'::competency_level
      end as level,
      p.last_assessed,
      p.first_expiry
    from progress p
    join doc_totals d on d.bench_id = p.bench_id
  )
  insert into competency (staff_id, bench_id, level, assessed_on, expires_on)
  select staff_id, bench_id, level, last_assessed, first_expiry from derived
  on conflict (staff_id, bench_id) do update
    set level = case
                  when competency.level = 'trainer' then 'trainer'::competency_level
                  else excluded.level
                end,
        assessed_on = coalesce(excluded.assessed_on, competency.assessed_on),
        expires_on  = coalesce(excluded.expires_on, competency.expires_on);

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

grant execute on function recompute_competency_from_documents() to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: the UI subscribes to run status so the Rota Board can move
-- through queued -> running -> solved without polling.
-- ---------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table rota_run;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table assignment;
  exception when duplicate_object then null;
  end;
end
$$;
