/** Evaluate a condition tree in the browser, for the builder's impact preview.
 *
 * This mirrors rules.py in the solver. It exists so the builder can say "in
 * last week's rota this would have moved 2 assignments" without a round trip,
 * which is what makes the live preview worth having.
 */

import { isGroup, type Competency, type RuleGroup, type RuleNode } from "./types";
import type { Bench, Staff } from "./types";
import { dayName, isoWeekday } from "./week";

export interface MatchSlot {
  staff: Staff;
  bench: Bench;
  date: string;
  shiftCode: string;
  groupName?: string | null;
  competency?: Competency;
}

const LEVEL_RANK: Record<string, number> = { trainee: 0, competent: 1, trainer: 2 };

function asList(values: unknown): string[] {
  if (values == null) return [];
  return (Array.isArray(values) ? values : [values]).map(String);
}

function dayMatches(values: string[], date: string): boolean {
  const iso = isoWeekday(date);
  const name = dayName(date).toLowerCase();
  return values.some((value) => {
    const v = value.trim().toLowerCase();
    if (/^\d+$/.test(v)) return Number(v) === iso;
    return v === name || v === name.slice(0, 3);
  });
}

function matchesCondition(node: Exclude<RuleNode, RuleGroup>, slot: MatchSlot): boolean {
  const values = asList(node.values);
  const operator = (node.operator ?? "is").toLowerCase();
  const positive = (hit: boolean) => (operator === "is not" ? !hit : hit);

  switch (node.subject) {
    case "person":
      return positive(values.includes(slot.staff.staff_code));
    case "grade":
      return positive(values.includes(slot.staff.grade));
    case "shift":
      return positive(values.includes(slot.shiftCode));
    case "day":
      return positive(dayMatches(values, slot.date));
    case "bench":
      if (operator === "is in group") return values.includes(slot.groupName ?? "");
      return positive(values.includes(slot.bench.name));
    case "bench_group":
      return positive(values.includes(slot.groupName ?? ""));
    case "date": {
      if (!values.length) return true;
      if (operator === "before") return slot.date < values[0];
      if (operator === "after") return slot.date > values[0];
      if (operator === "between" && values.length >= 2) {
        const [lo, hi] = [values[0], values[1]].sort();
        return slot.date >= lo && slot.date <= hi;
      }
      return true;
    }
    case "competency_level": {
      const level = slot.competency?.level;
      if (!level) return operator === "is not";
      if (operator === "is at least") {
        const wanted = Math.min(...values.map((v) => LEVEL_RANK[v] ?? 0));
        return LEVEL_RANK[level] >= wanted;
      }
      return positive(values.includes(level));
    }
    default:
      return true;
  }
}

export function matchesSlot(node: RuleNode | null | undefined, slot: MatchSlot): boolean {
  if (!node) return true;
  if (isGroup(node)) {
    const children = node.children ?? [];
    if (children.length === 0) return true;
    return node.op === "all"
      ? children.every((child) => matchesSlot(child, slot))
      : children.some((child) => matchesSlot(child, slot));
  }
  return matchesCondition(node, slot);
}

/** Staff the rule could ever pick out, ignoring bench, day and shift. */
export function peopleAffected(conditions: RuleGroup | null, staff: Staff[]): Staff[] {
  if (!conditions) return staff;
  const stub = (person: Staff): MatchSlot => ({
    staff: person,
    bench: { name: "" } as Bench,
    date: "2000-01-03",
    shiftCode: "",
  });
  return staff.filter((person) => {
    const relevant = onlyStaffConditions(conditions);
    return relevant ? matchesSlot(relevant, stub(person)) : true;
  });
}

const STAFF_SUBJECTS = new Set(["person", "grade"]);

/** The mirror of strip_staff_conditions: keep only who, drop where and when. */
function onlyStaffConditions(node: RuleNode | null): RuleNode | null {
  if (!node) return null;
  if (isGroup(node)) {
    const children = (node.children ?? [])
      .map(onlyStaffConditions)
      .filter((child): child is RuleNode => child !== null);
    return children.length ? { op: node.op, children } : null;
  }
  return STAFF_SUBJECTS.has(node.subject) ? node : null;
}
