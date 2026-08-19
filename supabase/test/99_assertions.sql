-- What a correctly migrated and seeded project looks like.
-- Every failure here raises, so run.sh stops on it.

do $$
declare
  n int;
  expected constant jsonb := '{
    "shift": 2, "bench_group": 10, "bench": 20, "competency_document": 51,
    "bench_shift_requirement": 22, "staff": 20, "absence": 8,
    "competency": 201, "rule": 8, "solver_setting": 7
  }'::jsonb;
  t text;
  want int;
begin
  for t, want in select key, value::int from jsonb_each_text(expected) loop
    execute format('select count(*) from %I', t) into n;
    if n <> want then
      raise exception 'Table % has % rows, expected %', t, n, want;
    end if;
  end loop;
  raise notice 'row counts ok';

  -- Availability: one row per contracted weekday per person, Day shift only.
  select count(*) into n from availability;
  if n <> 96 then
    raise exception 'availability has % rows, expected 96', n;
  end if;

  -- RLS must be enabled on every table in public, with no exceptions.
  select count(*) into n
    from pg_tables t
   where t.schemaname = 'public'
     and not exists (
       select 1 from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity
     );
  if n <> 0 then
    raise exception '% table(s) in public have RLS disabled', n;
  end if;
  raise notice 'row level security on every table';

  -- anon must hold no privileges on anything.
  select count(*) into n
    from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public';
  if n <> 0 then
    raise exception 'anon holds % table privileges, expected 0', n;
  end if;
  raise notice 'anon holds no privileges';

  -- The weekday check constraint must actually reject bad data.
  begin
    insert into bench_shift_requirement (bench_id, shift_id, label, weekdays)
    values ((select id from bench limit 1), (select id from shift limit 1), 'bad', '{0,9}');
    raise exception 'the weekdays check constraint did not reject {0,9}';
  exception when check_violation then
    raise notice 'weekdays check constraint rejects out-of-range days';
  end;

  -- And accept a legitimate one.
  insert into bench_shift_requirement (bench_id, shift_id, label, weekdays)
  values ((select id from bench limit 1), (select id from shift limit 1), 'probe', '{6,7}');
  delete from bench_shift_requirement where label = 'probe';

  -- The two deliberately thin benches, which the Benches screen flags.
  select count(*) into n
    from v_bench_pool
   where competent_count <= min_staff;
  if n < 2 then
    raise exception 'expected at least 2 thin benches, found %', n;
  end if;
  raise notice 'thin benches present: %', n;

  -- Trainees exist and are on benches they are not signed off for.
  select count(*) into n from competency where level = 'trainee';
  if n < 10 then
    raise exception 'expected trainees in the matrix, found %', n;
  end if;
  raise notice 'trainee competencies: %', n;

  -- The paused demo rule is paused.
  select count(*) into n from rule where status = 'paused';
  if n <> 1 then
    raise exception 'expected exactly 1 paused rule, found %', n;
  end if;
  raise notice 'one paused rule, as seeded';
end
$$;

-- The views must be queryable and shaped as the app expects.
select 'v_bench_pool' as view, count(*) as rows from v_bench_pool
union all select 'v_staff_competency_summary', count(*) from v_staff_competency_summary
union all select 'v_competency_matrix', count(*) from v_competency_matrix;
