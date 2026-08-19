-- =====================================================================
-- RotaSorter — 0000_reset.sql
--
-- OPTIONAL, AND DESTRUCTIVE. Run this only to start over.
--
-- It removes everything the RotaSorter migrations create — every table, view,
-- function, type and all the data in them. It does not touch auth.users, so
-- your login survives.
--
-- You want this if a migration failed halfway on an older version of these
-- files and left a partial schema behind. The migrations are transactional
-- now, so a failure should leave nothing to clean up.
-- =====================================================================

begin;

drop view if exists v_competency_matrix cascade;
drop view if exists v_staff_competency_summary cascade;
drop view if exists v_bench_pool cascade;

drop table if exists rule_breach cascade;
drop table if exists assignment cascade;
drop table if exists pin cascade;
drop table if exists rota_week cascade;
drop table if exists rota_run cascade;
drop table if exists staff_document cascade;
drop table if exists competency cascade;
drop table if exists availability cascade;
drop table if exists absence cascade;
drop table if exists bench_shift_requirement cascade;
drop table if exists competency_document cascade;
drop table if exists rule cascade;
drop table if exists solver_setting cascade;
drop table if exists staff cascade;
drop table if exists bench cascade;
drop table if exists bench_group cascade;
drop table if exists shift cascade;
drop table if exists profile cascade;

drop trigger if exists on_auth_user_created on auth.users;

drop function if exists handle_new_user() cascade;
drop function if exists set_updated_at() cascade;
drop function if exists iso_week_start(date) cascade;
drop function if exists app_role() cascade;
drop function if exists queue_rota_run(date) cascade;
drop function if exists publish_rota(uuid) cascade;
drop function if exists claim_next_run() cascade;
drop function if exists recompute_competency_from_documents() cascade;

drop type if exists staff_grade cascade;
drop type if exists staff_status cascade;
drop type if exists competency_level cascade;
drop type if exists doc_status cascade;
drop type if exists absence_kind cascade;
drop type if exists rule_scope cascade;
drop type if exists rule_action cascade;
drop type if exists rule_status cascade;
drop type if exists run_status cascade;
drop type if exists assignment_source cascade;
drop type if exists app_role cascade;

commit;
