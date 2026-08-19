/** Coverage state for a bench on a day.
 *
 * Under-minimum is the only place the alert colour appears anywhere in the
 * product, so this is the function that decides whether a gap is visible.
 */

import type { BenchShiftRequirement } from "./types";
import { isoWeekday } from "./week";

export type CoverageState = "unstaffed" | "under" | "met" | "full" | "over";

export interface Coverage {
  state: CoverageState;
  filled: number;
  min: number;
  max: number | null;
  /** Portion of the minimum that is filled, 0..1, for the coverage rail. */
  ratio: number;
  /** Bench does not run on this day at all. */
  running: boolean;
  label: string;
}

export const NOT_RUNNING: Coverage = {
  state: "unstaffed",
  filled: 0,
  min: 0,
  max: null,
  ratio: 1,
  running: false,
  label: "Not run",
};

/** The requirement in force for a bench on a given date, if any. */
export function requirementFor(
  requirements: BenchShiftRequirement[],
  benchId: string,
  shiftId: string,
  date: string,
): BenchShiftRequirement | null {
  const weekday = isoWeekday(date);
  const matching = requirements.filter(
    (r) =>
      r.bench_id === benchId &&
      r.shift_id === shiftId &&
      (r.weekdays ?? []).includes(weekday),
  );
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];

  // Overlapping weekday sets are a data mistake rather than a feature. Take the
  // strictest reading, the same way the solver does, so the grid and the rota
  // never disagree about what a bench needed.
  const maxes = matching.map((r) => r.max_staff).filter((m): m is number => m != null);
  return {
    ...matching[0],
    label: matching.map((r) => r.label).sort().join("+"),
    min_staff: Math.max(...matching.map((r) => r.min_staff)),
    max_staff: maxes.length ? Math.min(...maxes) : null,
  };
}

export function coverageFor(
  requirement: BenchShiftRequirement | null,
  filled: number,
): Coverage {
  if (!requirement) {
    return filled > 0
      ? { ...NOT_RUNNING, filled, state: "over", label: `${filled} on a bench not run today` }
      : NOT_RUNNING;
  }

  const min = requirement.min_staff;
  const max = requirement.max_staff;
  const ratio = min === 0 ? 1 : Math.min(filled / min, 1);

  let state: CoverageState;
  if (filled < min) state = filled === 0 ? "unstaffed" : "under";
  else if (max != null && filled > max) state = "over";
  else if (max != null && filled === max) state = "full";
  else state = "met";

  return {
    state,
    filled,
    min,
    max,
    ratio,
    running: true,
    label: `${filled}/${min}${max != null && max !== min ? `–${max}` : ""}`,
  };
}

/** Whether this cell should draw the alert colour. Nothing else may. */
export function isGap(coverage: Coverage): boolean {
  return coverage.running && (coverage.state === "under" || coverage.state === "unstaffed");
}

export interface WeekCoverageSummary {
  cells: number;
  gaps: number;
  filled: number;
  required: number;
}

export function summariseWeek(coverages: Coverage[]): WeekCoverageSummary {
  const running = coverages.filter((c) => c.running);
  return {
    cells: running.length,
    gaps: running.filter(isGap).length,
    filled: running.reduce((sum, c) => sum + c.filled, 0),
    required: running.reduce((sum, c) => sum + c.min, 0),
  };
}
