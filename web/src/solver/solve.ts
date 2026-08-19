/** Solve one week, and explain it when it cannot be solved. */

import type { InfeasibleReport } from "../lib/types";
import { WEEKDAY_NAMES, isoWeekday } from "../lib/week";
import { buildModel, type BuildOptions, type BuiltModel } from "./build";
import { loadHighs, type HighsResult } from "./highs";
import { diagnose } from "./diagnose";
import {
  groupKey,
  type SolveResult,
  type SolvedAssignment,
  type SolvedBreach,
  type SolverProblem,
} from "./types";

export { SOLVER_VERSION } from "./build";

export interface RunOutcome {
  built: BuiltModel;
  values: number[];
  status: string;
  objective: number;
}

/** Build, solve and read back. Shared by the main solve and the diagnosis. */
export async function runModel(
  problem: SolverProblem,
  options: BuildOptions = {},
): Promise<RunOutcome> {
  const built = buildModel(problem, options);

  if (built.model.trivallyInfeasible) {
    return { built, values: [], status: "Infeasible", objective: 0 };
  }

  const highs = await loadHighs();
  const result: HighsResult = highs.solve(built.model.toLp(), {
    output_flag: false,
    log_to_console: false,
    time_limit: problem.settings?.max_solve_seconds ?? 60,
    random_seed: problem.settings?.random_seed ?? 0,
    mip_rel_gap: 0,
  });

  const feasible = result.Status === "Optimal" || result.Status === "Time limit reached";
  return {
    built,
    values: feasible ? built.model.values(result.Columns) : [],
    status: result.Status,
    objective: feasible
      ? Math.round(
          result.ObjectiveValue +
            built.model.objectiveConstant +
            built.model.fixedObjective,
        )
      : 0,
  };
}

export async function solveWeek(problem: SolverProblem): Promise<SolveResult> {
  const started = performance.now();

  let outcome: RunOutcome;
  try {
    outcome = await runModel(problem);
  } catch (error) {
    return {
      status: "error",
      assignments: [],
      breaches: [],
      objectiveValue: null,
      solveMs: Math.round(performance.now() - started),
      infeasibleReport: null,
      log: error instanceof Error ? error.message : String(error),
    };
  }

  const { built, values, status } = outcome;
  const elapsed = () => Math.round(performance.now() - started);

  if (status === "Optimal" || status === "Time limit reached") {
    const assignments = extract(problem, built, values);
    const breaches = extractBreaches(built, values);
    return {
      status: breaches.length ? "solved_with_breaches" : "solved",
      assignments,
      breaches,
      objectiveValue: outcome.objective,
      solveMs: elapsed(),
      infeasibleReport: null,
      log: built.notes.join("\n"),
    };
  }

  if (status === "Infeasible" || built.model.trivallyInfeasible) {
    const report: InfeasibleReport = await diagnose(problem, built);
    return {
      status: "infeasible",
      assignments: [],
      breaches: [],
      objectiveValue: null,
      solveMs: elapsed(),
      infeasibleReport: report,
      log: [built.model.trivallyInfeasible, ...built.notes].filter(Boolean).join("\n"),
    };
  }

  return {
    status: "error",
    assignments: [],
    breaches: [],
    objectiveValue: null,
    solveMs: elapsed(),
    infeasibleReport: null,
    log: `The solver returned "${status}".\n${built.notes.join("\n")}`,
  };
}

function extract(
  problem: SolverProblem,
  built: BuiltModel,
  values: number[],
): SolvedAssignment[] {
  const pinned = new Set(
    problem.pins.map((p) => `${p.workDate}|${p.shiftId}|${p.benchId}|${p.staffId}`),
  );
  const out: SolvedAssignment[] = [];
  built.slots.forEach((slot, i) => {
    if (values[built.slotVar[i]] < 0.5) return;
    out.push({
      workDate: slot.workDate,
      shiftId: slot.shiftId,
      benchId: slot.benchId,
      staffId: slot.staffId,
      isPinned: pinned.has(
        `${slot.workDate}|${slot.shiftId}|${slot.benchId}|${slot.staffId}`,
      ),
    });
  });
  out.sort(
    (a, b) =>
      a.workDate.localeCompare(b.workDate) ||
      a.benchId.localeCompare(b.benchId) ||
      a.staffId.localeCompare(b.staffId),
  );
  return out;
}

function extractBreaches(built: BuiltModel, values: number[]): SolvedBreach[] {
  const out: SolvedBreach[] = [];
  for (const term of built.soft) {
    const value = Math.round(values[term.v] ?? 0);
    if (value <= 0) continue;
    out.push({
      ruleId: term.rule?.id ?? null,
      ruleName: term.rule?.name ?? "Objective",
      weight: term.weight,
      detail: term.describe(value),
      workDate: term.workDate,
      shiftId: term.shiftId,
      benchId: term.benchId,
      staffId: term.staffId,
    });
  }
  return out;
}

/** Where each person ended up in a relaxed solve, for the conflict report. */
export function placementMap(built: BuiltModel, values: number[]): Map<string, string> {
  const placed = new Map<string, string>();
  built.slots.forEach((slot, i) => {
    if (values[built.slotVar[i]] >= 0.5) {
      placed.set(`${slot.staffId}|${slot.workDate}`, slot.benchId);
    }
  });
  return placed;
}

export function describeWhere(built: BuiltModel, date: string, benchId: string): string {
  return `${built.index.bench(benchId).name} on ${WEEKDAY_NAMES[isoWeekday(date) - 1]}`;
}

export { groupKey };
