-- Exercise the triggers and RPCs. These only ever run on live data, so a
-- mistake in one of them surfaces to a user rather than to a build.

\set ON_ERROR_STOP on

do $$
declare
  v_user   uuid := gen_random_uuid();
  v_role   app_role;
  v_run    uuid;
  v_week   date := date '2026-09-14';
  n        int;
  v_name   text;
begin
  -- handle_new_user: a profile appears for every auth user.
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_user, 'j.vale@example.nhs.uk', '{"display_name": "J. Vale"}'::jsonb);

  select display_name into v_name from profile where id = v_user;
  if v_name is distinct from 'J. Vale' then
    raise exception 'profile trigger gave display_name %, expected J. Vale', v_name;
  end if;
  raise notice 'new auth user gets a profile';

  -- A user with no display_name falls back to the local part of the email.
  declare
    v_other uuid := gen_random_uuid();
  begin
    insert into auth.users (id, email) values (v_other, 'a.chen@example.nhs.uk');
    select display_name into v_name from profile where id = v_other;
    if v_name is distinct from 'a.chen' then
      raise exception 'fallback display_name was %, expected a.chen', v_name;
    end if;
  end;
  raise notice 'display_name falls back to the email local part';

  -- app_role(): defaults to viewer with no session, reads the profile with one.
  if app_role() <> 'viewer' then
    raise exception 'app_role() with no session gave %, expected viewer', app_role();
  end if;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  select app_role() into v_role;
  if v_role <> 'manager' then
    raise exception 'app_role() gave %, expected manager', v_role;
  end if;
  raise notice 'app_role() reads the signed-in profile';

  -- iso_week_start(): every day of the week maps to its Monday.
  for n in 0..6 loop
    if iso_week_start(v_week + n) <> v_week then
      raise exception 'iso_week_start(%) gave %, expected %',
        v_week + n, iso_week_start(v_week + n), v_week;
    end if;
  end loop;
  raise notice 'iso_week_start maps a whole week to its Monday';

  -- publish_rota(): refuses anything that is not a solved run, accepts one
  -- that is, and is idempotent.
  insert into rota_run (week_start, status, requested_by, requested_by_name)
  values (v_week, 'infeasible', v_user, 'J. Vale')
  returning id into v_run;

  begin
    perform publish_rota(v_run);
    raise exception 'publish_rota published an infeasible run';
  exception when raise_exception then
    if sqlerrm like '%publish_rota published%' then raise; end if;
  end;
  raise notice 'publish_rota refuses an unsolved run';

  update rota_run set status = 'solved' where id = v_run;
  perform publish_rota(v_run);
  perform publish_rota(v_run);

  select count(*) into n from rota_week where week_start = v_week
    and published_run_id = v_run;
  if n <> 1 then
    raise exception 'publish_rota left % rota_week rows, expected 1', n;
  end if;
  raise notice 'publish_rota records the week, and repeats cleanly';

  -- recompute_competency_from_documents(): derives the matrix from sign-off
  -- without demoting anyone a human made a trainer.
  select count(*) into n from competency where level = 'trainer';
  declare
    v_trainers_before int := n;
    v_touched int;
  begin
    select recompute_competency_from_documents() into v_touched;
    if v_touched < 1 then
      raise exception 'recompute touched % rows, expected some', v_touched;
    end if;
    select count(*) into n from competency where level = 'trainer';
    if n <> v_trainers_before then
      raise exception 'recompute changed trainer count from % to %',
        v_trainers_before, n;
    end if;
  end;
  raise notice 'recompute_competency_from_documents keeps trainers';

  -- Deleting the auth user takes the profile with it.
  delete from auth.users where id = v_user;
  select count(*) into n from profile where id = v_user;
  if n <> 0 then
    raise exception 'profile survived its auth user';
  end if;
  raise notice 'profile is removed with its auth user';
end
$$;
