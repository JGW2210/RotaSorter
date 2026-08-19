/** Rule matching: which slots a rule selects, and which bench-days it governs.
 *
 * A rule is a condition tree plus an action. The tree selects a set of
 * candidate slots and the action says what must be true of that set. Keeping
 * selection and action separate is what lets one small vocabulary of conditions
 * cover every rule in the preset library.
 */

import { isGroup, type RuleCondition, type RuleGroup, type RuleNode } from "../lib/types";
import { WEEKDAY_NAMES, isoWeekday } from "../lib/week";
import type { ProblemIndex } from "./problem";
import { LEVEL_RANK, type Slot, type SolverRule } from "./types";

const DAY_LOOKUP = new Map<string, number>();
WEEKDAY_NAMES.forEach((name, index) => {
  DAY_LOOKUP.set(name.toLowerCase(), index + 1);
  DAY_LOOKUP.set(name.toLowerCase().slice(0, 3), index + 1);
});

function asList(values: unknown): string[] {
  if (values == null) return [];
  return (Array.isArray(values) ? values : [values]).map(String);
}

function parseDay(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (/^\d+$/.test(v)) {
    const iso = Number(v);
    return iso >= 1 && iso <= 7 ? iso : null;
  }
  return DAY_LOOKUP.get(v) ?? null;
}

function matchesCondition(
  index: ProblemIndex,
  condition: RuleCondition,
  slot: Slot,
): boolean {
  const values = asList(condition.values);
  const operator = (condition.operator ?? "is").trim().toLowerCase();

  switch (condition.subject) {
    case "person": {
      const hit = values.includes(index.staff(slot.staffId).code);
      if (operator === "is not") return !hit;
      if (operator === "is" || operator === "is one of") return hit;
      break;
    }
    case "grade": {
      const hit = values.includes(index.staff(slot.staffId).grade);
      if (operator === "is not") return !hit;
      if (operator === "is" || operator === "is one of") return hit;
      break;
    }
    case "shift": {
      const hit = values.includes(index.shiftById.get(slot.shiftId)?.code ?? "");
      if (operator === "is not") return !hit;
      if (operator === "is" || operator === "is one of") return hit;
      break;
    }
    case "day": {
      const wanted = new Set(values.map(parseDay).filter((d): d is number => d !== null));
      const hit = wanted.has(isoWeekday(slot.workDate));
      if (operator === "is not") return !hit;
      if (operator === "is" || operator === "is one of") return hit;
      throw new Error(`Operator "${operator}" is not valid for a day condition`);
    }
    case "bench": {
      if (operator === "is in group") {
        return values.includes(index.bench(slot.benchId).groupName ?? "");
      }
      const hit = values.includes(index.bench(slot.benchId).name);
      if (operator === "is not") return !hit;
      if (operator === "is" || operator === "is one of") return hit;
      break;
    }
    case "bench_group": {
      const hit = values.includes(index.bench(slot.benchId).groupName ?? "");
      if (operator === "is not") return !hit;
      return hit;
    }
    case "date": {
      if (!values.length) return true;
      if (operator === "before") return slot.workDate < values[0];
      if (operator === "after") return slot.workDate > values[0];
      if (operator === "between") {
        if (values.length < 2) return true;
        const [lo, hi] = [values[0], values[1]].sort();
        return slot.workDate >= lo && slot.workDate <= hi;
      }
      throw new Error(`Operator "${operator}" is not valid for a date condition`);
    }
    case "competency_level": {
      const level = index.competency(slot.staffId, slot.benchId)?.level;
      if (!level) return operator === "is not";
      if (operator === "is at least") {
        const wanted = Math.min(
          ...values.map((v) => LEVEL_RANK[v as never] ?? 0),
        );
        return LEVEL_RANK[level] >= wanted;
      }
      const hit = values.includes(level);
      if (operator === "is not") return !hit;
      if (operator === "is" || operator === "is one of") return hit;
      throw new Error(`Operator "${operator}" is not valid for a competency condition`);
    }
  }

  throw new Error(
    `Operator "${operator}" is not valid for subject "${condition.subject}"`,
  );
}

/** Evaluate a condition tree against one slot. An empty tree matches all. */
export function matches(
  index: ProblemIndex,
  node: RuleNode | null | undefined,
  slot: Slot,
): boolean {
  if (!node) return true;
  if (isGroup(node)) {
    const children = node.children ?? [];
    if (children.length === 0) return true;
    return node.op === "all"
      ? children.every((child) => matches(index, child, slot))
      : children.some((child) => matches(index, child, slot));
  }
  return matchesCondition(index, node, slot);
}

export function scopeSlots(
  index: ProblemIndex,
  rule: SolverRule,
  slots: Slot[],
): Slot[] {
  return slots.filter((slot) => matches(index, rule.conditions, slot));
}

/** The same selection, as positions into `slots`.
 *
 * The builder needs indices to reach its variables. Recovering them with
 * indexOf turns every rule into a quadratic scan of the slot list.
 */
export function scopeIndices(
  index: ProblemIndex,
  rule: SolverRule,
  slots: Slot[],
): number[] {
  const out: number[] = [];
  slots.forEach((slot, i) => {
    if (matches(index, rule.conditions, slot)) out.push(i);
  });
  return out;
}

const STAFF_SUBJECTS = new Set(["person", "grade", "competency_level"]);

/**
 * Drop the conditions that talk about a person, keeping where and when.
 *
 * Rules like "Reporting Ref Lab Reports must have at least 1 Senior BMS" mix
 * two jobs in one tree: the bench and day conditions say *where the rule
 * applies*, the grade condition says *who counts towards it*. Without this
 * split, a bench-day on which nobody matches produces no slots, no constraint,
 * and a hard rule that quietly does nothing on precisely the day it mattered.
 */
export function stripStaffConditions(node: RuleNode | null | undefined): RuleNode | null {
  if (!node) return null;
  if (isGroup(node)) {
    const children = (node.children ?? [])
      .map(stripStaffConditions)
      .filter((child): child is RuleNode => child !== null);
    return children.length ? ({ op: node.op, children } as RuleGroup) : null;
  }
  return STAFF_SUBJECTS.has(node.subject) ? null : node;
}

/** Does this rule apply to this bench-day at all, whoever is standing on it? */
export function groupInScope(
  index: ProblemIndex,
  rule: SolverRule,
  groupSlots: Slot[],
): boolean {
  const where = stripStaffConditions(rule.conditions);
  if (where === null) return true;
  return groupSlots.some((slot) => matches(index, where, slot));
}

/** Staff ids named directly by a `person` condition anywhere in the tree. */
export function conditionPeople(index: ProblemIndex, rule: SolverRule): string[] {
  const codes: string[] = [];
  const walk = (node: RuleNode | null | undefined): void => {
    if (!node) return;
    if (isGroup(node)) {
      for (const child of node.children ?? []) walk(child);
      return;
    }
    if (node.subject === "person") codes.push(...asList(node.values));
  };
  walk(rule.conditions);

  const byCode = new Map(index.problem.staff.map((s) => [s.code, s.id]));
  return codes.map((code) => byCode.get(code)).filter((id): id is string => Boolean(id));
}
