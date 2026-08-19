import { describe, expect, it } from "vitest";
import { coverageFor, isGap, requirementFor, summariseWeek } from "./coverage";
import { loadByStaff, pivotByBenchDay, pivotByStaffDay } from "./pivot";
import type { Assignment, BenchShiftRequirement } from "./types";
import { addWeeks, dayShort, isoWeekday, mondayOf, weekDates } from "./week";

describe("week maths", () => {
  it("finds the Monday of a week from any day in it", () => {
    expect(mondayOf("2026-09-14")).toBe("2026-09-14");
    expect(mondayOf("2026-09-20")).toBe("2026-09-14");
    expect(mondayOf("2026-09-17")).toBe("2026-09-14");
  });

  it("numbers weekdays the ISO way", () => {
    expect(isoWeekday("2026-09-14")).toBe(1);
    expect(isoWeekday("2026-09-20")).toBe(7);
  });

  it("returns seven days starting Monday", () => {
    const days = weekDates("2026-09-14");
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-09-14");
    expect(days[6]).toBe("2026-09-20");
    expect(days.map(dayShort)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("steps across a month boundary and a DST change", () => {
    expect(addWeeks("2026-09-28", 1)).toBe("2026-10-05");
    // UK clocks go back on 25 October 2026; the rota day must not shift.
    expect(addWeeks("2026-10-19", 1)).toBe("2026-10-26");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
  });
});

const req = (over: Partial<BenchShiftRequirement> = {}): BenchShiftRequirement => ({
  bench_id: "b1",
  shift_id: "s1",
  label: "standard",
  weekdays: [1, 2, 3, 4, 5],
  min_staff: 2,
  max_staff: 3,
  required_level: null,
  ...over,
});

describe("coverage", () => {
  it("marks a bench under its minimum as a gap", () => {
    const c = coverageFor(req(), 1);
    expect(c.state).toBe("under");
    expect(isGap(c)).toBe(true);
    expect(c.label).toBe("1/2–3");
  });

  it("marks an empty running bench as a gap", () => {
    expect(isGap(coverageFor(req(), 0))).toBe(true);
  });

  it("does not mark a met bench as a gap", () => {
    expect(isGap(coverageFor(req(), 2))).toBe(false);
    expect(coverageFor(req(), 3).state).toBe("full");
  });

  it("never shows a gap on a day the bench does not run", () => {
    const c = coverageFor(null, 0);
    expect(c.running).toBe(false);
    expect(isGap(c)).toBe(false);
  });

  it("picks the requirement whose weekdays contain the date", () => {
    const rows = [
      req({ label: "standard", weekdays: [1, 2, 3, 4, 5], min_staff: 2, max_staff: 3 }),
      req({ label: "weekend", weekdays: [6, 7], min_staff: 1, max_staff: 2 }),
    ];
    expect(requirementFor(rows, "b1", "s1", "2026-09-14")?.label).toBe("standard");
    expect(requirementFor(rows, "b1", "s1", "2026-09-19")?.min_staff).toBe(1);
    expect(requirementFor(rows, "b1", "s1", "2026-09-19")?.label).toBe("weekend");
  });

  it("returns nothing for a bench that does not run that day", () => {
    const rows = [req({ weekdays: [2, 4] })];
    expect(requirementFor(rows, "b1", "s1", "2026-09-14")).toBeNull();
  });

  it("reads overlapping requirements the same way the solver does", () => {
    const rows = [
      req({ label: "a", weekdays: [1], min_staff: 1, max_staff: 4 }),
      req({ label: "b", weekdays: [1], min_staff: 3, max_staff: 3 }),
    ];
    const merged = requirementFor(rows, "b1", "s1", "2026-09-14")!;
    expect(merged.min_staff).toBe(3);
    expect(merged.max_staff).toBe(3);
  });

  it("summarises a week's gaps", () => {
    const summary = summariseWeek([
      coverageFor(req(), 2),
      coverageFor(req(), 1),
      coverageFor(null, 0),
    ]);
    expect(summary).toEqual({ cells: 2, gaps: 1, filled: 3, required: 4 });
  });
});

const assignment = (staff: string, bench: string, date: string): Assignment => ({
  id: `${staff}-${bench}-${date}`,
  run_id: "run",
  week_start: "2026-09-14",
  work_date: date,
  shift_id: "s1",
  bench_id: bench,
  staff_id: staff,
  source: "solver",
  is_pinned: false,
});

describe("both views come from one assignments array", () => {
  const assignments = [
    assignment("alice", "Urines", "2026-09-14"),
    assignment("bob", "Urines", "2026-09-14"),
    assignment("alice", "CSF", "2026-09-15"),
  ];

  it("pivots by bench and day", () => {
    const grid = pivotByBenchDay(assignments);
    expect(grid.get("Urines|2026-09-14")).toHaveLength(2);
    expect(grid.get("CSF|2026-09-15")).toHaveLength(1);
    expect(grid.get("CSF|2026-09-14")).toBeUndefined();
  });

  it("pivots by staff and day over the same data", () => {
    const grid = pivotByStaffDay(assignments);
    expect(grid.get("alice|2026-09-14")?.[0].bench_id).toBe("Urines");
    expect(grid.get("alice|2026-09-15")?.[0].bench_id).toBe("CSF");
  });

  it("counts days worked, not assignments", () => {
    const doubled = [...assignments, assignment("alice", "Urines", "2026-09-14")];
    expect(loadByStaff(doubled).get("alice")).toBe(2);
  });
});
