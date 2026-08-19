/** Write a locally-computed solve into Supabase.
 *
 * The run row is written after the solve rather than before it. Solving happens
 * in the browser now, so a tab closed mid-solve simply produces no run, instead
 * of leaving a row stuck at "running" that nothing will ever finish.
 */

import { SOLVER_VERSION, type SolveResult, type SolverProblem } from "../solver";
import { supabase } from "./supabase";
import type { RotaRun } from "./types";

export async function persistRun(
  problem: SolverProblem,
  result: SolveResult,
  meta: {
    requestedBy: string | null;
    requestedByName: string | null;
    /** The prior-week run whose assignments fed problem.history, if any. */
    historyRunId?: string | null;
  },
): Promise<RotaRun> {
  // Provenance is only worth recording when the history could actually bind:
  // an inert history must not hold this week's publication hostage.
  const historyMattered =
    (problem.history ?? []).length > 0 &&
    problem.rules.some((rule) => rule.action === "max_consecutive_days");

  const { data: run, error } = await supabase
    .from("rota_run")
    .insert({
      week_start: problem.weekStart,
      status: result.status,
      requested_by: meta.requestedBy,
      requested_by_name: meta.requestedByName,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      solve_ms: result.solveMs,
      pins_applied: problem.pins.length,
      soft_breach_count: result.breaches.length,
      objective_value: result.objectiveValue,
      status_detail: statusDetail(result),
      infeasible_report: result.infeasibleReport,
      rule_snapshot: problem.rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        action: rule.action,
        params: rule.params,
        conditions: rule.conditions,
        is_hard: rule.isHard,
        weight: rule.weight,
        plain_english: rule.plainEnglish,
      })),
      solver_version: SOLVER_VERSION,
      log: result.log || null,
      history_run_id: historyMattered ? (meta.historyRunId ?? null) : null,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  const created = run as RotaRun;

  if (result.assignments.length) {
    const { error: assignmentError } = await supabase.from("assignment").insert(
      result.assignments.map((a) => ({
        run_id: created.id,
        week_start: problem.weekStart,
        work_date: a.workDate,
        shift_id: a.shiftId,
        bench_id: a.benchId,
        staff_id: a.staffId,
        source: a.isPinned ? "manual" : "solver",
        is_pinned: a.isPinned,
      })),
    );
    if (assignmentError) throw new Error(assignmentError.message);
  }

  if (result.breaches.length) {
    const { error: breachError } = await supabase.from("rule_breach").insert(
      result.breaches.map((b) => ({
        run_id: created.id,
        rule_id: b.ruleId,
        rule_name: b.ruleName,
        weight: b.weight,
        work_date: b.workDate,
        shift_id: b.shiftId,
        bench_id: b.benchId,
        staff_id: b.staffId,
        detail: b.detail,
      })),
    );
    if (breachError) throw new Error(breachError.message);
  }

  return created;
}

function statusDetail(result: SolveResult): string {
  const seconds = (result.solveMs / 1000).toFixed(1);
  switch (result.status) {
    case "solved":
      return `Solved in ${seconds}s. All coverage met.`;
    case "solved_with_breaches": {
      const n = result.breaches.length;
      return `Solved in ${seconds}s with ${n} soft ${n === 1 ? "breach" : "breaches"}.`;
    }
    case "infeasible":
      return (
        result.infeasibleReport?.conflicts?.[0]?.detail ??
        "No valid rota for this week."
      );
    default:
      return result.log.slice(0, 200) || "The solver did not finish.";
  }
}
