/** Explaining an impossible week.
 *
 * "No solution found" is useless to the person holding the rota, so this
 * re-solves with one class of constraint relaxed at a time until something
 * gives, then reports what gave and who was missing, in the order a human
 * would check:
 *
 *     1. coverage  a bench nobody could staff
 *     2. rules     a hard rule that cannot hold alongside the rest
 *     3. pins      the manual overrides themselves conflict
 *
 * Each conflict carries enough identifiers for the UI to turn its suggested
 * resolutions into working links.
 */

import type { InfeasibleConflict, InfeasibleReport } from "../lib/types";
import { WEEKDAY_NAMES, formatDate, isoWeekday } from "../lib/week";
import type { BuiltModel } from "./build";
import { placementMap, runModel } from "./solve";
import { groupKey, type SolverProblem } from "./types";

const SOFTENED_RULE_WEIGHT = 10_000;

export async function diagnose(
  problem: SolverProblem,
  original: BuiltModel,
): Promise<InfeasibleReport> {
  const summary = `No valid rota for the week of ${formatDate(problem.weekStart)}.`;

  const coverage = await coverageConflicts(problem, summary);
  if (coverage.conflicts.length) return coverage;

  const rules = await ruleConflicts(problem, summary);
  if (rules.conflicts.length) return rules;

  const pins = await pinConflicts(problem, summary);
  if (pins.conflicts.length) return pins;

  return {
    summary,
    conflicts: [],
    suggestions: [
      { label: "Review this week's rules", action: "rules" },
      { label: "Review absences for this week", action: "absences", date: problem.weekStart },
    ],
    note:
      original.model.trivallyInfeasible ??
      "The constraints conflict in a way that relaxing coverage, rules and pins " +
        "individually did not isolate. Try pausing rules one at a time.",
  };
}

/** Which bench-days could not be staffed, and who was missing. */
async function coverageConflicts(
  problem: SolverProblem,
  summary: string,
): Promise<InfeasibleReport> {
  const { built, values, status } = await runModel(problem, { relaxCoverage: true });
  const report: InfeasibleReport = { summary, conflicts: [], suggestions: [] };
  if (status !== "Optimal" && status !== "Time limit reached") return report;

  const placed = placementMap(built, values);

  for (const [key, variable] of built.shortfall) {
    const shortBy = Math.round(values[variable] ?? 0);
    if (shortBy <= 0) continue;

    const [date, shiftId, benchId] = key.split("|");
    const bench = built.index.bench(benchId);
    const shift = built.index.shiftById.get(shiftId);
    const req = built.index
      .requirementsOn(date)
      .find((r) => r.benchId === benchId && r.shiftId === shiftId);
    if (!req) continue;

    const achieved = req.minStaff - shortBy;
    report.conflicts.push({
      kind: "coverage",
      bench_id: benchId,
      bench_name: bench.name,
      shift_name: shift?.name ?? null,
      work_date: date,
      day_name: WEEKDAY_NAMES[isoWeekday(date) - 1],
      required: req.minStaff,
      achieved,
      short_by: shortBy,
      detail:
        `${bench.name} needs ${req.minStaff} ` +
        `${req.minStaff === 1 ? "person" : "people"} on ` +
        `${WEEKDAY_NAMES[isoWeekday(date) - 1]} ${(shift?.name ?? "day").toLowerCase()}. ` +
        (achieved ? `Only ${achieved} could be placed.` : "Nobody could be placed."),
      pool: benchPool(built, benchId, date, placed),
    });
  }

  report.conflicts.sort(
    (a, b) =>
      (b.short_by ?? 0) - (a.short_by ?? 0) ||
      (a.work_date ?? "").localeCompare(b.work_date ?? ""),
  );

  if (report.conflicts.length) {
    const first = report.conflicts[0];
    report.suggestions = [
      {
        label: `Relax the minimum on ${first.bench_name} to ${Math.max((first.required ?? 1) - (first.short_by ?? 0), 0)}`,
        action: "edit_bench",
        bench_id: first.bench_id ?? undefined,
      },
      { label: `Check ${first.day_name} absences`, action: "absences", date: first.work_date ?? undefined },
      { label: `Sign off more staff on ${first.bench_name}`, action: "matrix", bench_id: first.bench_id ?? undefined },
    ];
  }
  return report;
}

/** No coverage gap, so a hard rule is the thing that cannot hold. */
async function ruleConflicts(
  problem: SolverProblem,
  summary: string,
): Promise<InfeasibleReport> {
  const { built, values, status } = await runModel(problem, {
    relaxCoverage: true,
    softenRules: true,
  });
  const report: InfeasibleReport = { summary, conflicts: [], suggestions: [] };
  if (status !== "Optimal" && status !== "Time limit reached") return report;

  const placed = placementMap(built, values);
  const seen = new Set<string>();

  for (const term of built.soft) {
    if (!term.rule || Math.round(values[term.v] ?? 0) <= 0) continue;
    // A soft rule breaking is normal, not a conflict. Only the ones that were
    // hard until this pass softened them count.
    if (term.weight < SOFTENED_RULE_WEIGHT) continue;
    if (seen.has(term.rule.id)) continue;
    seen.add(term.rule.id);

    const benchName = term.benchId ? built.index.bench(term.benchId).name : null;
    const dayName = term.workDate ? WEEKDAY_NAMES[isoWeekday(term.workDate) - 1] : null;
    const place = [benchName, dayName ? `on ${dayName}` : null].filter(Boolean).join(" ");

    report.conflicts.push({
      kind: "rule",
      rule_id: term.rule.id,
      rule_name: term.rule.name,
      work_date: term.workDate,
      day_name: dayName,
      bench_id: term.benchId,
      bench_name: benchName,
      detail:
        `${term.rule.plainEnglish ?? term.rule.name} ` +
        (place ? `This cannot hold on ${place}, ` : "This cannot hold, ") +
        "alongside everything else the week has to satisfy.",
      first_failure: term.describe(Math.round(values[term.v] ?? 0)),
    });
  }

  if (report.conflicts.length) {
    const first = report.conflicts[0];
    if (first.bench_id && first.work_date) {
      first.pool = benchPool(built, first.bench_id, first.work_date, placed);
    }
    report.suggestions = [
      { label: `Make "${first.rule_name}" soft`, action: "edit_rule", rule_id: first.rule_id },
      { label: `Pause "${first.rule_name}"`, action: "pause_rule", rule_id: first.rule_id },
      { label: "Review absences for this week", action: "absences", date: problem.weekStart },
    ];
  }
  return report;
}

/** Coverage and rules both relax cleanly, so the pins are the problem. */
async function pinConflicts(
  problem: SolverProblem,
  summary: string,
): Promise<InfeasibleReport> {
  const report: InfeasibleReport = { summary, conflicts: [], suggestions: [] };
  if (!problem.pins.length) return report;

  const { built, status } = await runModel(problem, { dropPins: true });
  if (status !== "Optimal" && status !== "Time limit reached") return report;

  report.conflicts.push({
    kind: "pin",
    detail:
      `The week solves once the ${problem.pins.length} pinned ` +
      `${problem.pins.length === 1 ? "assignment is" : "assignments are"} released. ` +
      "Two or more pins are asking for the same person, or for someone a rule " +
      "cannot place there.",
    pins: problem.pins.map((pin) => ({
      staff_id: pin.staffId,
      name: built.index.staff(pin.staffId).fullName,
      bench_id: pin.benchId,
      bench_name: built.index.bench(pin.benchId).name,
      work_date: pin.workDate,
      day_name: WEEKDAY_NAMES[isoWeekday(pin.workDate) - 1],
    })),
  });
  report.suggestions = [
    { label: "Open the pins panel", action: "pins" },
    { label: "Clear all pins and re-solve", action: "clear_pins" },
    { label: "Review absences for this week", action: "absences", date: problem.weekStart },
  ];
  return report;
}

/**
 * Everyone with any competency on a bench, and where they stood on the day.
 *
 * "Available" on its own is not an answer when the week is impossible. If the
 * relaxed solve put someone on another bench, say which one: that is the trade
 * the user is actually being asked to unpick.
 */
function benchPool(
  built: BuiltModel,
  benchId: string,
  date: string,
  placed: Map<string, string>,
): NonNullable<InfeasibleConflict["pool"]> {
  const req = built.index.requirementsOn(date).find((r) => r.benchId === benchId);
  const pool: NonNullable<InfeasibleConflict["pool"]> = [];

  for (const person of built.index.problem.staff) {
    const competency = built.index.competency(person.id, benchId);
    if (!competency) continue;

    let { ok, reason } = req
      ? built.index.eligibility(person.id, req, date)
      : { ok: true, reason: "" };

    if (ok) {
      const elsewhere = placed.get(`${person.id}|${date}`);
      if (elsewhere && elsewhere !== benchId) {
        reason = `${person.fullName} is on ${built.index.bench(elsewhere).name}`;
      } else if (elsewhere === benchId) {
        reason = `${person.fullName} is already on this bench`;
      } else {
        reason = `${person.fullName} is free but a rule blocks this bench`;
      }
    }

    pool.push({
      staff_id: person.id,
      staff_code: person.code,
      name: person.fullName,
      level: competency.level,
      reason,
      available: ok,
    });
  }
  return pool;
}

export { groupKey };
