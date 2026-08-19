/**
 * The consecutive-day, minimum-day and together actions, on the TS solver.
 *
 * Tiny purpose-built weeks rather than the seeded fixture: each rule's
 * behaviour is then forced, not found by accident among twenty staff. The
 * same cases run against the reference solver in solver/tests/test_rules.py.
 */

import { describe, expect, it } from "vitest";
import { solveWeek } from "./solve";
import {
  DEFAULT_SETTINGS,
  type PastAssignment,
  type SolverAbsence,
  type SolverProblem,
  type SolverRule,
} from "./types";
import type { RuleGroup } from "../lib/types";

const MON = "2026-09-14";

function datePlus(days: number): string {
  const d = new Date(`${MON}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One DAY shift, every person competent on every bench, Mon-Fri cover. */
function tiny(
  staffCodes: string[],
  benchNames: string[],
  opts: {
    minStaff?: number;
    maxStaff?: number;
    rules?: SolverRule[];
    absences?: SolverAbsence[];
    history?: PastAssignment[];
  } = {},
): SolverProblem {
  return {
    weekStart: MON,
    shifts: [{ id: "DAY", code: "DAY", name: "Day" }],
    benches: benchNames.map((b, i) => ({
      id: b,
      name: b,
      groupName: null,
      requiredLevel: "competent",
      sortOrder: i,
    })),
    requirements: benchNames.map((b) => ({
      benchId: b,
      shiftId: "DAY",
      label: "Mon-Fri",
      weekdays: [1, 2, 3, 4, 5],
      minStaff: opts.minStaff ?? 1,
      maxStaff: opts.maxStaff ?? 1,
      requiredLevel: null,
    })),
    staff: staffCodes.map((c) => ({
      id: c,
      code: c,
      fullName: c,
      grade: "bms",
      status: "active",
    })),
    competencies: staffCodes.flatMap((c) =>
      benchNames.map((b) => ({
        staffId: c,
        benchId: b,
        level: "competent" as const,
        expiresOn: null,
      })),
    ),
    absences: opts.absences ?? [],
    availability: staffCodes.flatMap((c) =>
      [1, 2, 3, 4, 5].map((weekday) => ({ staffId: c, weekday, shiftId: "DAY" })),
    ),
    rules: opts.rules ?? [],
    pins: [],
    history: opts.history ?? [],
    settings: DEFAULT_SETTINGS,
  };
}

function rule(
  action: SolverRule["action"],
  overrides: Partial<SolverRule> & { conditions?: RuleGroup } = {},
): SolverRule {
  return {
    id: "under-test",
    name: "under test",
    action,
    params: {},
    conditions: { op: "all", children: [] },
    isHard: true,
    weight: 50,
    plainEnglish: null,
    ...overrides,
  };
}

const personIs = (...codes: string[]): RuleGroup => ({
  op: "all",
  children: [
    {
      subject: "person",
      operator: codes.length > 1 ? "is one of" : "is",
      values: codes,
    },
  ],
});

describe("max_consecutive_days", () => {
  it("forces alternation when nobody may repeat a bench", async () => {
    const result = await solveWeek(
      tiny(["A", "B"], ["X"], {
        rules: [rule("max_consecutive_days", { params: { n: 1, same_bench: true } })],
      }),
    );
    expect(result.status, result.log).toBe("solved");
    for (const person of ["A", "B"]) {
      const days = result.assignments
        .filter((a) => a.staffId === person)
        .map((a) => a.workDate)
        .sort();
      for (let i = 1; i < days.length; i++) {
        const gap =
          (Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)) /
          86_400_000;
        expect(gap, `${person} works X on ${days[i - 1]} and ${days[i]}`).toBeGreaterThan(1);
      }
    }
  });

  it("counts last week's published rota across the boundary", async () => {
    // A worked X on the Sunday, so the Monday must go to B.
    const result = await solveWeek(
      tiny(["A", "B"], ["X"], {
        rules: [rule("max_consecutive_days", { params: { n: 1, same_bench: true } })],
        history: [
          { staffId: "A", workDate: datePlus(-1), shiftId: "DAY", benchId: "X" },
        ],
      }),
    );
    expect(result.status, result.log).toBe("solved");
    const monday = result.assignments.find((a) => a.workDate === MON);
    expect(monday?.staffId).toBe("B");
    expect(result.log).toContain("look back");
  });

  it("is infeasible when the only person must repeat", async () => {
    const result = await solveWeek(
      tiny(["A"], ["X"], { rules: [rule("max_consecutive_days", { params: { n: 2 } })] }),
    );
    expect(result.status).toBe("infeasible");
  });

  it("reports the run as a breach when soft", async () => {
    const result = await solveWeek(
      tiny(["A"], ["X"], {
        rules: [rule("max_consecutive_days", { params: { n: 2 }, isHard: false })],
      }),
    );
    expect(result.status).toBe("solved_with_breaches");
    const breach = result.breaches.find((b) => b.ruleName === "under test");
    expect(breach?.detail).toContain("in a row");
    expect(breach?.staffId).toBe("A");
  });
});

describe("min_days_in_period", () => {
  it("guarantees the floor", async () => {
    const result = await solveWeek(
      tiny(["A", "B"], ["X"], {
        rules: [rule("min_days_in_period", { params: { n: 3 }, conditions: personIs("A") })],
      }),
    );
    expect(result.status, result.log).toBe("solved");
    expect(result.assignments.filter((a) => a.staffId === "A").length).toBeGreaterThanOrEqual(3);
  });

  it("is infeasible for a person absent all week", async () => {
    const result = await solveWeek(
      tiny(["A", "B"], ["X"], {
        absences: [{ staffId: "A", startsOn: MON, endsOn: datePlus(6), kind: "annual_leave" }],
        rules: [rule("min_days_in_period", { params: { n: 2 }, conditions: personIs("A") })],
      }),
    );
    expect(result.status).toBe("infeasible");
  });
});

describe("must_be_together", () => {
  it("keeps the pair on one bench", async () => {
    const result = await solveWeek(
      tiny(["A", "B", "C"], ["X", "Y"], {
        maxStaff: 2,
        rules: [rule("must_be_together", { conditions: personIs("A", "B") })],
      }),
    );
    expect(result.status, result.log).toBe("solved");
    const where = new Map(
      result.assignments.map((a) => [`${a.staffId}|${a.workDate}`, a.benchId]),
    );
    for (let i = 0; i < 5; i++) {
      const day = datePlus(i);
      const benchA = where.get(`A|${day}`);
      const benchB = where.get(`B|${day}`);
      if (benchA && benchB) {
        expect(benchA, `A and B are apart on ${day}`).toBe(benchB);
      }
    }
  });

  it("is infeasible when coverage would split the pair", async () => {
    const result = await solveWeek(
      tiny(["A", "B"], ["X", "Y"], {
        rules: [rule("must_be_together", { conditions: personIs("A", "B") })],
      }),
    );
    expect(result.status).toBe("infeasible");
  });

  it("reports each day apart when soft", async () => {
    const result = await solveWeek(
      tiny(["A", "B"], ["X", "Y"], {
        rules: [
          rule("must_be_together", {
            conditions: personIs("A", "B"),
            isHard: false,
            weight: 40,
          }),
        ],
      }),
    );
    expect(result.status).toBe("solved_with_breaches");
    const apart = result.breaches.filter((b) => b.ruleName === "under test");
    expect(apart.length).toBe(5);
    for (const b of apart) expect(b.detail).toContain("different benches");
  });
});
