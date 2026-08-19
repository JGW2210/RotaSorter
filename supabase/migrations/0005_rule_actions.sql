-- =====================================================================
-- RotaSorter — 0005_rule_actions.sql
--
-- Three rule actions the builder could not express before:
--
--   max_consecutive_days   caps how many days in a row someone works,
--                          either on the same bench (params.same_bench,
--                          the default) or across every bench the rule's
--                          conditions match. n = 1 with same_bench reads
--                          "never the same bench two days running".
--   min_days_in_period     the floor to max_shifts_in_period's ceiling:
--                          someone must get at least n matching days in
--                          the week, e.g. guaranteed training days.
--   must_be_together       the complement of not_together: on any day
--                          the named people all work, they share a bench.
--                          Keeps a trainee with their named trainer.
--
-- Deliberately not wrapped in a transaction: a value added to an enum by
-- ALTER TYPE cannot be used inside the same transaction that added it,
-- and there is nothing here to roll back — ADD VALUE IF NOT EXISTS is
-- already safe to re-run.
-- =====================================================================

alter type rule_action add value if not exists 'max_consecutive_days';
alter type rule_action add value if not exists 'min_days_in_period';
alter type rule_action add value if not exists 'must_be_together';
