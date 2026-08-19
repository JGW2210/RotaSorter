/** Both Rota Board views render from one assignments array.
 *
 * The toggle changes the pivot and nothing else, so these two functions are the
 * entire difference between "is anything uncovered" and "is anyone overloaded".
 */

import type { Assignment } from "./types";

export type CellKey = string;

export function benchDayKey(benchId: string, date: string): CellKey {
  return `${benchId}|${date}`;
}

export function staffDayKey(staffId: string, date: string): CellKey {
  return `${staffId}|${date}`;
}

export function pivotByBenchDay(assignments: Assignment[]): Map<CellKey, Assignment[]> {
  const out = new Map<CellKey, Assignment[]>();
  for (const a of assignments) {
    const key = benchDayKey(a.bench_id, a.work_date);
    const bucket = out.get(key);
    if (bucket) bucket.push(a);
    else out.set(key, [a]);
  }
  return out;
}

export function pivotByStaffDay(assignments: Assignment[]): Map<CellKey, Assignment[]> {
  const out = new Map<CellKey, Assignment[]>();
  for (const a of assignments) {
    const key = staffDayKey(a.staff_id, a.work_date);
    const bucket = out.get(key);
    if (bucket) bucket.push(a);
    else out.set(key, [a]);
  }
  return out;
}

/** Days worked per person across the week, for the overload read. */
export function loadByStaff(assignments: Assignment[]): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  for (const a of assignments) {
    const key = staffDayKey(a.staff_id, a.work_date);
    if (seen.has(key)) continue;
    seen.add(key);
    out.set(a.staff_id, (out.get(a.staff_id) ?? 0) + 1);
  }
  return out;
}

/** Distinct benches per person, which is what rotation actually means here. */
export function benchesByStaff(assignments: Assignment[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const a of assignments) {
    const bucket = out.get(a.staff_id);
    if (bucket) bucket.add(a.bench_id);
    else out.set(a.staff_id, new Set([a.bench_id]));
  }
  return out;
}

/** The same assignment, found from the other view, so selection survives a toggle. */
export function equivalentAssignment(
  assignments: Assignment[],
  selected: { staffId: string; date: string; benchId: string } | null,
): Assignment | null {
  if (!selected) return null;
  return (
    assignments.find(
      (a) =>
        a.staff_id === selected.staffId &&
        a.work_date === selected.date &&
        a.bench_id === selected.benchId,
    ) ?? null
  );
}
