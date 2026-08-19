import { describe, expect, it } from "vitest";
import { checkDrop, isSignedOff } from "./eligibility";
import type { Absence, Availability, Bench, BenchShiftRequirement, Competency, Staff } from "./types";

const person: Staff = {
  id: "s1", staff_code: "BMS-0141", full_name: "Marcus Kell", grade: "bms",
  status: "active", fte: 1, started_on: null, notes: null,
};
const trainee: Staff = { ...person, id: "s2", staff_code: "TRN-0402", full_name: "Hannah Ng", grade: "trainee" };
const senior: Staff = { ...person, id: "s3", staff_code: "SBMS-0041", full_name: "Alison Ferreira", grade: "senior_bms" };

const bench: Bench = {
  id: "b1", name: "Blood Cultures", group_id: null, min_staff: 1, max_staff: 2,
  required_level: "competent", is_active: true, sort_order: 0, notes: null,
};

const requirement: BenchShiftRequirement = {
  bench_id: "b1", shift_id: "sh1", label: "standard",
  weekdays: [1, 2, 3, 4, 5], min_staff: 1, max_staff: 2, required_level: null,
};

const worksWeekdays = (staffId: string): Availability[] =>
  [1, 2, 3, 4, 5].map((weekday) => ({
    id: `${staffId}-${weekday}`, staff_id: staffId, weekday, shift_id: "sh1", is_available: true,
  }));

const competent: Competency = {
  id: "c1", staff_id: "s1", bench_id: "b1", level: "competent",
  assessed_on: "2025-01-06", expires_on: "2028-01-06", assessor_id: null,
  document_ref: "266", notes: null,
};

const base = {
  bench, date: "2026-09-14", shiftId: "sh1", requirement,
  availability: worksWeekdays("s1"), absences: [] as Absence[],
};

describe("a refused drop says exactly why", () => {
  it("accepts a competent person on a day they work", () => {
    const result = checkDrop({ ...base, person, competency: competent, benchStaff: [] });
    expect(result.verdict).toBe("valid");
  });

  it("names the bench when the person is not competent on it", () => {
    const result = checkDrop({ ...base, person, competency: undefined, benchStaff: [] });
    expect(result.verdict).toBe("hard");
    expect(result.reason).toBe("Marcus Kell is not competent on Blood Cultures.");
  });

  it("names the expiry date when a signoff has lapsed", () => {
    const result = checkDrop({
      ...base,
      person,
      competency: { ...competent, expires_on: "2026-08-05" },
      benchStaff: [],
    });
    expect(result.verdict).toBe("hard");
    expect(result.reason).toContain("expired on 5 Aug 2026");
  });

  it("refuses a day the person does not work", () => {
    const result = checkDrop({
      ...base, date: "2026-09-19", person, competency: competent,
      availability: worksWeekdays("s1"), benchStaff: [],
    });
    expect(result.verdict).toBe("hard");
    expect(result.reason).toBe("Marcus Kell is not contracted on a Saturday.");
  });

  it("refuses someone on leave, and says which kind", () => {
    const absences: Absence[] = [{
      id: "a1", staff_id: "s1", starts_on: "2026-09-14", ends_on: "2026-09-16",
      kind: "annual_leave", notes: null,
    }];
    const result = checkDrop({ ...base, person, competency: competent, absences, benchStaff: [] });
    expect(result.verdict).toBe("hard");
    expect(result.reason).toBe("Marcus Kell is on annual leave on 14 Sep 2026.");
  });

  it("refuses a bench that does not run that day", () => {
    const result = checkDrop({ ...base, person, competency: competent, requirement: null, benchStaff: [] });
    expect(result.verdict).toBe("hard");
    expect(result.reason).toBe("Blood Cultures does not run on a Monday.");
  });
});

describe("trainees go on the bench, but never alone", () => {
  const inTraining: Competency = { ...competent, id: "c2", staff_id: "s2", level: "trainee", expires_on: null };
  const seniorSignoff: Competency = { ...competent, id: "c3", staff_id: "s3", level: "trainer" };

  it("warns rather than refuses when no signed-off colleague is there", () => {
    const result = checkDrop({
      ...base, person: trainee, competency: inTraining,
      availability: worksWeekdays("s2"), benchStaff: [],
    });
    expect(result.verdict).toBe("soft");
    expect(result.reason).toContain("still in training");
  });

  it("accepts once a signed-off colleague is on the same bench", () => {
    const result = checkDrop({
      ...base, person: trainee, competency: inTraining,
      availability: worksWeekdays("s2"),
      benchStaff: [{ staff: senior, competency: seniorSignoff }],
    });
    expect(result.verdict).toBe("valid");
  });

  it("does not count another trainee as supervision", () => {
    const other = { ...trainee, id: "s4", full_name: "Josef Kaminski" };
    const result = checkDrop({
      ...base, person: trainee, competency: inTraining,
      availability: worksWeekdays("s2"),
      benchStaff: [{ staff: other, competency: { ...inTraining, staff_id: "s4" } }],
    });
    expect(result.verdict).toBe("soft");
  });

  it("does not count an expired signoff as supervision", () => {
    expect(isSignedOff({ ...seniorSignoff, expires_on: "2026-08-01" }, "2026-09-14")).toBe(false);
    expect(isSignedOff(seniorSignoff, "2026-09-14")).toBe(true);
  });
});

describe("bench maximum", () => {
  it("warns when the bench is already full", () => {
    const other = { staff: senior, competency: { ...competent, staff_id: "s3" } };
    const result = checkDrop({
      ...base, person, competency: competent, benchStaff: [other, other],
    });
    expect(result.verdict).toBe("soft");
    expect(result.reason).toContain("maximum of 2");
  });
});
