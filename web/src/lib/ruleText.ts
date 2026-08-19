/** Render a rule as the sentence a lab manager would have written.
 *
 * The Rules table shows this as its primary column and the builder regenerates
 * it on every change, because a visual rule builder without a plain reading
 * produces rules nobody can verify. Nobody scans a list of
 * "availability_restriction" and recognises their own rota.
 */

import { GRADE_LABELS, LEVEL_LABELS, listPhrase, pluralise } from "./format";
import { isGroup, type RuleAction, type RuleCondition, type RuleGroup, type RuleNode } from "./types";
import type { CompetencyLevel, StaffGrade } from "./types";
import { formatDate } from "./week";

export interface RuleTextContext {
  /** Staff code to full name. Falls back to the code if unknown. */
  staffName?: (code: string) => string;
  /** Shift code to name. Falls back to the code. */
  shiftName?: (code: string) => string;
}

interface Clause {
  operator: string;
  values: string[];
}

interface Parsed {
  people: Clause[];
  grades: Clause[];
  levels: Clause[];
  benches: Clause[];
  groups: Clause[];
  days: Clause[];
  shifts: Clause[];
  dates: Clause[];
  /** Nested "any" blocks, already rendered, appended as free clauses. */
  eithers: string[];
}

const EMPTY = (): Parsed => ({
  people: [], grades: [], levels: [], benches: [],
  groups: [], days: [], shifts: [], dates: [], eithers: [],
});

function values(condition: RuleCondition): string[] {
  return (condition.values ?? []).map(String);
}

function parse(node: RuleNode | null | undefined, into: Parsed, ctx: RuleTextContext): void {
  if (!node) return;

  if (isGroup(node)) {
    if (node.op === "any" && (node.children ?? []).length > 1) {
      const rendered = (node.children ?? [])
        .map((child) => renderLoose(child, ctx))
        .filter(Boolean);
      if (rendered.length) into.eithers.push(`either ${rendered.join(" or ")}`);
      return;
    }
    for (const child of node.children ?? []) parse(child, into, ctx);
    return;
  }

  const clause: Clause = { operator: node.operator ?? "is", values: values(node) };
  switch (node.subject) {
    case "person":
      into.people.push({
        ...clause,
        values: clause.values.map((c) => ctx.staffName?.(c) ?? c),
      });
      break;
    case "grade":
      into.grades.push({
        ...clause,
        values: clause.values.map((g) => GRADE_LABELS[g as StaffGrade] ?? g),
      });
      break;
    case "competency_level":
      into.levels.push({
        ...clause,
        values: clause.values.map((l) => (LEVEL_LABELS[l as CompetencyLevel] ?? l).toLowerCase()),
      });
      break;
    case "bench":
      if (clause.operator === "is in group") into.groups.push(clause);
      else into.benches.push(clause);
      break;
    case "bench_group":
      into.groups.push(clause);
      break;
    case "day":
      into.days.push(clause);
      break;
    case "shift":
      into.shifts.push({
        ...clause,
        values: clause.values.map((s) => ctx.shiftName?.(s) ?? s),
      });
      break;
    case "date":
      into.dates.push({ ...clause, values: clause.values.map(formatDate) });
      break;
  }
}

/** One condition rendered on its own, used inside "either ... or ...". */
function renderLoose(node: RuleNode, ctx: RuleTextContext): string {
  const parsed = EMPTY();
  parse(node, parsed, ctx);
  return [
    who(parsed, ""),
    benchPhrase(parsed, "on"),
    whenPhrase(parsed),
  ].filter(Boolean).join(" ").trim();
}

function negated(clause: Clause): boolean {
  return clause.operator === "is not";
}

function who(parsed: Parsed, fallback: string): string {
  const parts: string[] = [];

  for (const clause of parsed.people) {
    if (!clause.values.length) continue;
    parts.push(
      negated(clause)
        ? `anyone other than ${listPhrase(clause.values)}`
        : listPhrase(clause.values),
    );
  }
  for (const clause of parsed.grades) {
    if (!clause.values.length) continue;
    parts.push(
      negated(clause)
        ? `anyone not at ${listPhrase(clause.values)} grade`
        : `anyone at ${listPhrase(clause.values)} grade`,
    );
  }
  for (const clause of parsed.levels) {
    if (!clause.values.length) continue;
    parts.push(
      clause.operator === "is at least"
        ? `anyone at least ${listPhrase(clause.values)} on it`
        : `anyone who is ${listPhrase(clause.values)} on it`,
    );
  }

  return parts.length ? listPhrase(parts) : fallback;
}

/** "on Urines", "to CSF", or the bare subject for a sentence that leads with it. */
function benchPhrase(parsed: Parsed, preposition: "on" | "to" | ""): string {
  const parts: string[] = [];

  for (const clause of parsed.benches) {
    if (!clause.values.length) continue;
    parts.push(
      negated(clause)
        ? `any bench other than ${listPhrase(clause.values)}`
        : clause.values.join(" or "),
    );
  }
  for (const clause of parsed.groups) {
    if (!clause.values.length) continue;
    parts.push(
      negated(clause)
        ? `any bench outside ${listPhrase(clause.values)}`
        : `any bench in ${listPhrase(clause.values)}`,
    );
  }

  if (!parts.length) return "";
  const subject = listPhrase(parts);
  return preposition ? `${preposition} ${subject}` : subject;
}

function whenPhrase(parsed: Parsed): string {
  const parts: string[] = [];

  for (const clause of parsed.days) {
    if (!clause.values.length) continue;
    parts.push(
      negated(clause)
        ? `on any day other than ${listPhrase(clause.values)}`
        : `on ${clause.values.join(" or ")}`,
    );
  }
  for (const clause of parsed.shifts) {
    if (!clause.values.length) continue;
    parts.push(
      negated(clause)
        ? `outside the ${listPhrase(clause.values)} shift`
        : `on the ${listPhrase(clause.values)} shift`,
    );
  }
  for (const clause of parsed.dates) {
    if (!clause.values.length) continue;
    if (clause.operator === "between" && clause.values.length >= 2) {
      parts.push(`between ${clause.values[0]} and ${clause.values[1]}`);
    } else {
      parts.push(`${clause.operator} ${clause.values[0]}`);
    }
  }

  return parts.join(", ");
}

/** The same "who" as a countable noun phrase, for "at least 3 ...".
 *
 * `who()` renders subjects ("anyone at Senior BMS grade") which reads wrong
 * straight after a number. Counted actions need "1 person at Senior BMS grade".
 */
function whoCountable(parsed: Parsed, n: number): string {
  const noun = pluralise(n, "person", "people");
  const qualifiers: string[] = [];

  for (const clause of parsed.grades) {
    if (!clause.values.length) continue;
    qualifiers.push(
      negated(clause)
        ? `not at ${listPhrase(clause.values)} grade`
        : `at ${listPhrase(clause.values)} grade`,
    );
  }
  for (const clause of parsed.levels) {
    if (!clause.values.length) continue;
    qualifiers.push(
      clause.operator === "is at least"
        ? `at least ${listPhrase(clause.values)} on it`
        : `who ${n === 1 ? "is" : "are"} ${listPhrase(clause.values)} on it`,
    );
  }
  for (const clause of parsed.people) {
    if (!clause.values.length) continue;
    qualifiers.push(
      negated(clause)
        ? `other than ${listPhrase(clause.values)}`
        : `from ${listPhrase(clause.values)}`,
    );
  }

  return qualifiers.length ? `${noun} ${qualifiers.join(" ")}` : noun;
}

function sentence(parts: (string | undefined | false)[]): string {
  const text = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

export interface RuleLike {
  action: RuleAction;
  params?: Record<string, unknown> | null;
  conditions?: RuleGroup | null;
}

export function ruleToSentence(rule: RuleLike, ctx: RuleTextContext = {}): string {
  const parsed = EMPTY();
  parse(rule.conditions ?? null, parsed, ctx);

  const n = Number(rule.params?.["n"] ?? 1);
  const when = whenPhrase(parsed);
  const eithers = parsed.eithers.join(", ");
  const subject = benchPhrase(parsed, "") || "every bench";

  switch (rule.action) {
    case "cannot_be_assigned":
      return sentence([
        who(parsed, "anyone"),
        "cannot be assigned",
        benchPhrase(parsed, "to"),
        when,
        eithers,
      ]);

    case "must_be_assigned":
      return sentence([
        who(parsed, "anyone"),
        "must be assigned",
        benchPhrase(parsed, "to"),
        when,
        eithers,
      ]);

    case "requires_at_least":
      return sentence([
        subject,
        `must have at least ${n}`,
        whoCountable(parsed, n),
        "on it",
        when,
        eithers,
      ]);

    case "requires_at_most":
      return sentence([
        subject,
        `must have at most ${n}`,
        whoCountable(parsed, n),
        "on it",
        when,
        eithers,
      ]);

    case "requires_supervisor": {
      const level = String(rule.params?.["supervisor_level"] ?? "trainer");
      const label = (LEVEL_LABELS[level as CompetencyLevel] ?? level).toLowerCase();
      return sentence([
        `any day ${subject} is staffed, at least one person on it must be a ${label}`,
        when,
        eithers,
      ]);
    }

    case "same_bench_all_week":
      return sentence([
        who(parsed, "anyone"),
        "must stay on the same bench all week",
        eithers,
      ]);

    case "max_shifts_in_period":
      return sentence([
        who(parsed, "anyone"),
        `can work at most ${n} ${pluralise(n, "day")}`,
        benchPhrase(parsed, "on"),
        when,
        eithers,
      ]);

    case "max_consecutive_days": {
      const sameBench = rule.params?.["same_bench"] !== false;
      // "more than 1 day in a row" is just "two days in a row", so say that.
      const run = n === 1 ? "two days in a row" : `more than ${n} days in a row`;
      if (sameBench) {
        return sentence([
          who(parsed, "anyone"),
          "cannot work",
          benchPhrase(parsed, "") || "the same bench",
          run,
          when,
          eithers,
        ]);
      }
      return sentence([
        who(parsed, "anyone"),
        "cannot work",
        run,
        benchPhrase(parsed, "on"),
        when,
        eithers,
      ]);
    }

    case "min_days_in_period":
      return sentence([
        who(parsed, "anyone"),
        `must work at least ${n} ${pluralise(n, "day")}`,
        benchPhrase(parsed, "on"),
        when,
        eithers,
      ]);

    case "not_together": {
      const names = parsed.people.flatMap((c) => c.values);
      return sentence([
        names.length >= 2 ? listPhrase(names) : who(parsed, "the people named"),
        "cannot be on the same bench on the same day",
        when,
        eithers,
      ]);
    }

    case "must_be_together": {
      const names = parsed.people.flatMap((c) => c.values);
      return sentence([
        names.length >= 2 ? listPhrase(names) : who(parsed, "the people named"),
        "must be on the same bench on any day",
        names.length > 2 ? "they are all in" : "both are in",
        when,
        eithers,
      ]);
    }

    default:
      return "";
  }
}

/** Count the assignment slots a rule touches, for the builder's impact line. */
export function countConditions(node: RuleNode | null | undefined): number {
  if (!node) return 0;
  if (isGroup(node)) {
    return (node.children ?? []).reduce((sum, c) => sum + countConditions(c), 0);
  }
  return 1;
}
