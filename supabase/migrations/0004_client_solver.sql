-- =====================================================================
-- RotaSorter — 0004_client_solver.sql
--
-- The solver moved into the browser, so the two RPCs that existed only to
-- hand work to a background worker have nothing left to talk to.
--
--   queue_rota_run()  inserted a run as 'queued' for a runner to claim. The
--                     browser now solves first and records the finished run,
--                     so there is no queued state to represent.
--   claim_next_run()  let a runner take the oldest queued job. There are no
--                     runners.
--
-- rota_run keeps 'queued' and 'running' in its status enum: rows written by
-- the old pipeline are still valid history and the Runs screen still renders
-- them.
-- =====================================================================

-- Wrapped in a transaction: if any statement fails, nothing is left
-- behind and the file can be corrected and run again.
begin;

drop function if exists queue_rota_run(date);
drop function if exists claim_next_run();

commit;
