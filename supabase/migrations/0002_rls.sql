-- =====================================================================
-- RotaSorter — 0002_rls.sql
-- Row Level Security on every table, from the start.
--
-- Prototype posture:
--   anon           -> no access at all
--   authenticated  -> full read/write on operational tables
--   service_role   -> bypasses RLS (this is what the GitHub Actions solver uses)
--
-- There is no self-registration, so every authenticated user is an account
-- someone created on purpose. profile.role exists so you can tighten this to
-- read-only viewers later without a migration; see docs/SETUP.md.
-- =====================================================================

-- Wrapped in a transaction: if any statement fails, nothing is left
-- behind and the file can be corrected and run again.
begin;

-- ---------------------------------------------------------------------
-- Helper: current user's role, used by the tightened policies in SETUP.md
-- ---------------------------------------------------------------------
create or replace function app_role()
returns app_role
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from profile where id = auth.uid()),
    'viewer'::app_role
  );
$$;

grant execute on function app_role() to authenticated;

-- ---------------------------------------------------------------------
-- profile: you may read every profile (needed to show "who ran this"),
-- but only edit your own. Rows are created by the trigger in 0003.
-- ---------------------------------------------------------------------
alter table profile enable row level security;

create policy profile_select_authenticated
  on profile for select to authenticated using (true);

create policy profile_update_self
  on profile for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------
-- Everything else: uniform authenticated read/write.
-- Done in a loop so a new table cannot be silently left unprotected —
-- add its name to the array and it gets the same four policies.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'shift',
    'bench_group',
    'bench',
    'competency_document',
    'bench_shift_requirement',
    'staff',
    'availability',
    'absence',
    'competency',
    'staff_document',
    'rule',
    'rota_run',
    'assignment',
    'pin',
    'rule_breach',
    'rota_week',
    'solver_setting'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I enable row level security', t);

    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_select_authenticated', t
    );
    execute format(
      'create policy %I on %I for insert to authenticated with check (true)',
      t || '_insert_authenticated', t
    );
    execute format(
      'create policy %I on %I for update to authenticated using (true) with check (true)',
      t || '_update_authenticated', t
    );
    execute format(
      'create policy %I on %I for delete to authenticated using (true)',
      t || '_delete_authenticated', t
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- Belt and braces: anon holds no table privileges even before RLS runs.
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

commit;
