import { describe, expect, it } from "vitest";
import { ruleToSentence } from "./ruleText";
import type { RuleGroup } from "./types";

const NAMES: Record<string, string> = {
  "BMS-0141": "Marcus Kell",
  "BMS-0155": "Sarah Patel",
  "TRN-0402": "Hannah Ng",
};
const ctx = { staffName: (code: string) => NAMES[code] ?? code };

function all(...children: RuleGroup["children"]): RuleGroup {
  return { op: "all", children };
}
const cond = (subject: string, operator: string, values: (string | number)[]) =>
  ({ subject, operator, values }) as RuleGroup["children"][number];

describe("the seeded rules read as English", () => {
  it("renders a supervisor requirement", () => {
    expect(
      ruleToSentence(
        {
          action: "requires_supervisor",
          params: { supervisor_level: "trainer" },
          conditions: all(cond("bench", "is", ["CAT-3"])),
        },
        ctx,
      ),
    ).toBe("Any day CAT-3 is staffed, at least one person on it must be a trainer.");
  });

  it("renders a grade-scoped minimum", () => {
    expect(
      ruleToSentence(
        {
          action: "requires_at_least",
          params: { n: 1 },
          conditions: all(
            cond("bench", "is", ["Reporting Ref Lab Reports"]),
            cond("grade", "is", ["senior_bms"]),
          ),
        },
        ctx,
      ),
    ).toBe(
      "Reporting Ref Lab Reports must have at least 1 person at Senior BMS grade on it.",
    );
  });

  it("renders a pair kept apart", () => {
    expect(
      ruleToSentence(
        {
          action: "not_together",
          conditions: all(cond("person", "is one of", ["BMS-0141", "BMS-0155"])),
        },
        ctx,
      ),
    ).toBe("Marcus Kell and Sarah Patel cannot be on the same bench on the same day.");
  });

  it("renders a grade kept off a bench", () => {
    expect(
      ruleToSentence(
        {
          action: "cannot_be_assigned",
          conditions: all(cond("grade", "is", ["trainee"]), cond("bench", "is", ["CSF"])),
        },
        ctx,
      ),
    ).toBe("Anyone at Trainee grade cannot be assigned to CSF.");
  });

  it("renders a continuity rule", () => {
    expect(
      ruleToSentence(
        {
          action: "same_bench_all_week",
          conditions: all(cond("person", "is", ["TRN-0402"])),
        },
        ctx,
      ),
    ).toBe("Hannah Ng must stay on the same bench all week.");
  });

  it("renders a per-week cap", () => {
    expect(
      ruleToSentence(
        {
          action: "max_shifts_in_period",
          params: { n: 3 },
          conditions: all(cond("bench", "is", ["Urines"])),
        },
        ctx,
      ),
    ).toBe("Anyone can work at most 3 days on Urines.");
  });

  it("renders a trainee cap", () => {
    expect(
      ruleToSentence(
        {
          action: "requires_at_most",
          params: { n: 1 },
          conditions: all(cond("bench", "is", ["Urines"]), cond("grade", "is", ["trainee"])),
        },
        ctx,
      ),
    ).toBe("Urines must have at most 1 person at Trainee grade on it.");
  });

  it("pluralises the countable noun", () => {
    expect(
      ruleToSentence(
        {
          action: "requires_at_least",
          params: { n: 2 },
          conditions: all(cond("bench", "is", ["CSF"]), cond("grade", "is", ["senior_bms"])),
        },
        ctx,
      ),
    ).toBe("CSF must have at least 2 people at Senior BMS grade on it.");
  });

  it("renders a plain minimum with no who", () => {
    expect(
      ruleToSentence(
        {
          action: "requires_at_least",
          params: { n: 3 },
          conditions: all(cond("bench", "is", ["Blood Cultures"])),
        },
        ctx,
      ),
    ).toBe("Blood Cultures must have at least 3 people on it.");
  });

  it("renders the no-repeat rule, saying two days rather than more than one", () => {
    expect(
      ruleToSentence(
        {
          action: "max_consecutive_days",
          params: { n: 1, same_bench: true },
          conditions: { op: "all", children: [] },
        },
        ctx,
      ),
    ).toBe("Anyone cannot work the same bench two days in a row.");
  });

  it("renders a consecutive cap on one bench", () => {
    expect(
      ruleToSentence(
        {
          action: "max_consecutive_days",
          params: { n: 2 },
          conditions: all(cond("bench", "is", ["Blood Cultures"])),
        },
        ctx,
      ),
    ).toBe("Anyone cannot work Blood Cultures more than 2 days in a row.");
  });

  it("renders a consecutive cap across a group", () => {
    expect(
      ruleToSentence(
        {
          action: "max_consecutive_days",
          params: { n: 2, same_bench: false },
          conditions: all(cond("bench", "is in group", ["Sterile Sites"])),
        },
        ctx,
      ),
    ).toBe("Anyone cannot work more than 2 days in a row on any bench in Sterile Sites.");
  });

  it("renders a guaranteed minimum of days", () => {
    expect(
      ruleToSentence(
        {
          action: "min_days_in_period",
          params: { n: 2 },
          conditions: all(cond("person", "is", ["TRN-0402"]), cond("bench", "is", ["Urines"])),
        },
        ctx,
      ),
    ).toBe("Hannah Ng must work at least 2 days on Urines.");
  });

  it("renders a pair kept together", () => {
    expect(
      ruleToSentence(
        {
          action: "must_be_together",
          conditions: all(cond("person", "is one of", ["BMS-0141", "BMS-0155"])),
        },
        ctx,
      ),
    ).toBe("Marcus Kell and Sarah Patel must be on the same bench on any day both are in.");
  });
});

describe("negation and days", () => {
  it("renders the spec's own example", () => {
    expect(
      ruleToSentence(
        {
          action: "cannot_be_assigned",
          conditions: all(
            cond("person", "is", ["BMS-0155"]),
            cond("day", "is not", ["Thursday"]),
          ),
        },
        ctx,
      ),
    ).toBe("Sarah Patel cannot be assigned on any day other than Thursday.");
  });

  it("lists several days", () => {
    expect(
      ruleToSentence(
        {
          action: "cannot_be_assigned",
          conditions: all(
            cond("person", "is", ["BMS-0141"]),
            cond("day", "is one of", ["Saturday", "Sunday"]),
          ),
        },
        ctx,
      ),
    ).toBe("Marcus Kell cannot be assigned on Saturday or Sunday.");
  });

  it("renders a bench group", () => {
    expect(
      ruleToSentence(
        {
          action: "cannot_be_assigned",
          conditions: all(
            cond("grade", "is", ["ap"]),
            cond("bench", "is in group", ["Sterile Sites"]),
          ),
        },
        ctx,
      ),
    ).toBe("Anyone at AP grade cannot be assigned to any bench in Sterile Sites.");
  });

  it("renders a nested any block", () => {
    const conditions: RuleGroup = {
      op: "all",
      children: [
        cond("person", "is", ["BMS-0141"]),
        {
          op: "any",
          children: [cond("day", "is", ["Monday"]), cond("day", "is", ["Friday"])],
        },
      ],
    };
    expect(ruleToSentence({ action: "cannot_be_assigned", conditions }, ctx)).toBe(
      "Marcus Kell cannot be assigned either on Monday or on Friday.",
    );
  });
});

describe("degrades rather than breaking", () => {
  it("handles no conditions at all", () => {
    expect(
      ruleToSentence({ action: "cannot_be_assigned", conditions: { op: "all", children: [] } }),
    ).toBe("Anyone cannot be assigned.");
  });

  it("falls back to the staff code when the name is unknown", () => {
    expect(
      ruleToSentence({
        action: "same_bench_all_week",
        conditions: all(cond("person", "is", ["BMS-9999"])),
      }),
    ).toBe("BMS-9999 must stay on the same bench all week.");
  });
});
