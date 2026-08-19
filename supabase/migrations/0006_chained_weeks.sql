-- =====================================================================
-- RotaSorter — 0006_chained_weeks.sql
--
-- Planning several weeks ahead. A rota can be generated against last
-- week's rota before last week is published, so runs of days are counted
-- across the boundary while both weeks are still drafts. That makes the
-- later week a stack of assumptions, so:
--
--   rota_run.history_run_id     records which prior-week run a run was
--                               planned against, at solve time.
--   publish_rota()              refuses to publish such a run until the
--                               prior week is published as that same
--                               run, unless the override setting is on.
--
-- Two settings drive it, both off by default:
--
--   history_from_unpublished    when last week has no published rota,
--                               count its latest solved run instead.
--   allow_publish_out_of_order  publish anyway, in whatever order.
--
-- Not wrapped in a transaction: every statement here is idempotent and
-- the file re-runs cleanly.
-- =====================================================================

alter table rota_run
  add column if not exists history_run_id uuid references rota_run (id) on delete set null;

insert into solver_setting (key, value, label, description, sort_order) values
  ('history_from_unpublished', '0', 'Plan against unpublished weeks',
   'When last week has no published rota, count its latest solved run instead. Runs planned this way cannot be published until that week is.', 100),
  ('allow_publish_out_of_order', '0', 'Allow out-of-order publishing',
   'Publish a week even though the rota it was planned against has not been published. The runs it counted may no longer be what that week gets.', 101)
on conflict (key) do nothing;

-- Publish a solved run as the rota for its week.
--
-- Replaces the 0003 version to add the ordering check. A run planned
-- against another week's rota leans on assumptions about that week; if
-- that week has since published a different rota — or none at all — the
-- assumptions are stale, and publishing would lock the wrong week first.
create or replace function publish_rota(p_run_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_week            date;
  v_status          run_status;
  v_history         uuid;
  v_history_week    date;
  v_prior_published uuid;
  v_override        int;
begin
  select week_start, status, history_run_id
    into v_week, v_status, v_history
    from rota_run where id = p_run_id;

  if v_week is null then
    raise exception 'Run % does not exist', p_run_id;
  end if;

  if v_status not in ('solved', 'solved_with_breaches') then
    raise exception 'Run % is %, only a solved run can be published', p_run_id, v_status;
  end if;

  if v_history is not null then
    select (value #>> '{}')::numeric::int into v_override
      from solver_setting where key = 'allow_publish_out_of_order';

    if coalesce(v_override, 0) = 0 then
      select week_start into v_history_week from rota_run where id = v_history;
      select published_run_id into v_prior_published
        from rota_week where week_start = v_history_week;

      if v_prior_published is distinct from v_history then
        raise exception
          'This rota was planned against a rota for the week of % that is not published. Publish that week first, or turn on "Allow out-of-order publishing" in Settings.',
          v_history_week;
      end if;
    end if;
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
