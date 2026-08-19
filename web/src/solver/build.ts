/** Build the MIP for one week.
 *
 * Every constraint here is linear. The reference implementation used CP-SAT's
 * `OnlyEnforceIf` for readability, but nothing in the model needed constraint
 * programming, so each of those becomes an explicit indicator encoding:
 *
 *     hard    Σx ≥ n
 *     soft    Σx + n·breach ≥ n,  cost weight·breach
 *
 * The solver sets `breach` to 0 wherever it can, because it costs.
 */

import type { InfeasibleReport } from "../lib/types";
import { WEEKDAY_NAMES, isoWeekday } from "../lib/week";
import { MipModel, type Term } from "./model";
import { ProblemIndex } from "./problem";
import { conditionPeople, groupInScope, matches, scopeIndices, scopeSlots } from "./rules";
import {
  DEFAULT_SETTINGS,
  groupKey,
  type Slot,
  type SolverProblem,
  type SolverRule,
} from "./types";

export const SOLVER_VERSION = "rotasolver-ts 0.2.0";

export interface BuildOptions {
  /** Let coverage minimums fall short, at a price, to find out where. */
  relaxCoverage?: boolean;
  /** Let hard rules break, expensively, to find out which one cannot hold. */
  softenRules?: boolean;
  dropPins?: boolean;
}

export interface SoftTerm {
  v: number;
  weight: number;
  describe: (value: number) => string;
  rule: SolverRule | null;
  workDate: string | null;
  shiftId: string | null;
  benchId: string | null;
  staffId: string | null;
}

export interface BuiltModel {
  model: MipModel;
  index: ProblemIndex;
  slots: Slot[];
  slotVar: number[];
  soft: SoftTerm[];
  /** groupKey -> variable holding how far short that bench-day fell. */
  shortfall: Map<string, number>;
  notes: string[];
}

const SHORTFALL_COST = 100_000;
const SOFTENED_RULE_WEIGHT = 10_000;

function setting(problem: SolverProblem, key: keyof typeof DEFAULT_SETTINGS): number {
  const value = problem.settings?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_SETTINGS[key];
}

export function eligibleSlots(index: ProblemIndex): Slot[] {
  const slots: Slot[] = [];
  for (const date of index.dates) {
    for (const req of index.requirementsOn(date)) {
      for (const person of index.problem.staff) {
        if (index.eligibility(person.id, req, date).ok) {
          slots.push({
            staffId: person.id,
            workDate: date,
            shiftId: req.shiftId,
            benchId: req.benchId,
          });
        }
      }
    }
  }
  return slots;
}

export function buildModel(problem: SolverProblem, options: BuildOptions = {}): BuiltModel {
  const index = new ProblemIndex(problem);
  const model = new MipModel();
  const slots = eligibleSlots(index);
  const slotVar = slots.map(() => model.addBinary());
  const soft: SoftTerm[] = [];
  const shortfall = new Map<string, number>();
  const notes: string[] = [];

  // -- groupings, computed once ------------------------------------------
  const by = (key: (s: Slot) => string): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    slots.forEach((slot, i) => {
      const k = key(slot);
      const list = out.get(k);
      if (list) list.push(i);
      else out.set(k, [i]);
    });
    return out;
  };

  const byStaffDay = by((s) => `${s.staffId}|${s.workDate}`);
  const byBenchDay = by((s) => groupKey(s.workDate, s.shiftId, s.benchId));
  const byStaffBench = by((s) => `${s.staffId}|${s.benchId}`);
  const byStaff = by((s) => s.staffId);

  const vars = (indices: number[]): number[] => indices.map((i) => slotVar[i]);
  const where = (date: string, benchId: string) =>
    `${index.bench(benchId).name} on ${WEEKDAY_NAMES[isoWeekday(date) - 1]}`;

  // -- nobody is on two benches on the same day ---------------------------
  // The whole-day model. It also stops one person covering Day and Late back
  // to back if the Late shift is ever staffed.
  for (const indices of byStaffDay.values()) {
    if (indices.length > 1) model.add(MipModel.sum(vars(indices)), "<=", 1);
  }

  // -- coverage ------------------------------------------------------------
  for (const date of index.dates) {
    for (const req of index.requirementsOn(date)) {
      const key = groupKey(date, req.shiftId, req.benchId);
      const indices = byBenchDay.get(key) ?? [];
      const terms = MipModel.sum(vars(indices));

      if (options.relaxCoverage) {
        const short = model.addContinuous(0, req.minStaff);
        shortfall.set(key, short);
        model.add([...terms, { v: short, c: 1 }], ">=", req.minStaff);
      } else if (req.minStaff > 0) {
        model.add(terms, ">=", req.minStaff);
      }

      if (req.maxStaff != null && indices.length) {
        model.add(terms, "<=", req.maxStaff);
      }
    }
  }

  // -- a trainee on a bench means a signed-off colleague on it -------------
  // Trainees count towards cover, but never alone.
  for (const [key, indices] of byBenchDay) {
    const [date, , benchId] = key.split("|");
    const trainees: number[] = [];
    const supervisors: number[] = [];
    for (const i of indices) {
      if (index.isSignedOff(slots[i].staffId, benchId, date)) supervisors.push(i);
      else trainees.push(i);
    }
    if (trainees.length === 0) continue;

    for (const t of trainees) {
      if (supervisors.length === 0) {
        // No signed-off person can work this bench today, so the trainee
        // cannot be placed here at all.
        model.fix(slotVar[t], 0, `${index.staff(slots[t].staffId).fullName} on ${where(date, benchId)}`);
        continue;
      }
      // x[trainee] ≤ Σ x[signed off]
      model.add(
        [{ v: slotVar[t], c: 1 }, ...vars(supervisors).map((v) => ({ v, c: -1 }))],
        "<=",
        0,
      );
    }
  }

  // -- pins ---------------------------------------------------------------
  if (!options.dropPins) {
    const slotIndex = new Map(
      slots.map((s, i) => [`${s.staffId}|${s.workDate}|${s.shiftId}|${s.benchId}`, i]),
    );
    for (const pin of problem.pins) {
      const i = slotIndex.get(`${pin.staffId}|${pin.workDate}|${pin.shiftId}|${pin.benchId}`);
      if (i === undefined) {
        notes.push(
          `Pin ignored: ${index.staff(pin.staffId).fullName} cannot work ` +
            `${index.bench(pin.benchId).name} on ${pin.workDate}.`,
        );
        continue;
      }
      model.fix(slotVar[i], 1, `the pin for ${index.staff(pin.staffId).fullName}`);
    }
  }

  // -- rules ---------------------------------------------------------------
  const addSoft = (
    v: number,
    weight: number,
    describe: (value: number) => string,
    rule: SolverRule | null,
    at: Partial<Pick<SoftTerm, "workDate" | "shiftId" | "benchId" | "staffId">> = {},
  ) => {
    soft.push({
      v,
      weight,
      describe,
      rule,
      workDate: at.workDate ?? null,
      shiftId: at.shiftId ?? null,
      benchId: at.benchId ?? null,
      staffId: at.staffId ?? null,
    });
  };

  /** Every bench-day a rule covers, with the slots that count towards it. */
  const benchDayGroups = (rule: SolverRule) => {
    const out: { date: string; shiftId: string; benchId: string; counting: number[] }[] = [];
    for (const [key, indices] of byBenchDay) {
      const groupSlots = indices.map((i) => slots[i]);
      if (!groupInScope(index, rule, groupSlots)) continue;
      const [date, shiftId, benchId] = key.split("|");
      out.push({
        date,
        shiftId,
        benchId,
        counting: indices.filter((i) => matches(index, rule.conditions, slots[i])),
      });
    }
    return out;
  };

  for (const original of problem.rules) {
    const rule: SolverRule =
      options.softenRules && original.isHard
        ? { ...original, isHard: false, weight: SOFTENED_RULE_WEIGHT }
        : original;

    switch (rule.action) {
      case "cannot_be_assigned": {
        for (const i of scopeIndices(index, rule, slots)) {
          if (rule.isHard) {
            model.fix(slotVar[i], 0, `the rule "${rule.name}"`);
          } else {
            const slot = slots[i];
            const who = index.staff(slot.staffId).fullName;
            const place = where(slot.workDate, slot.benchId);
            addSoft(slotVar[i], rule.weight, () => `${who} is on ${place}`, rule, {
              workDate: slot.workDate,
              benchId: slot.benchId,
              staffId: slot.staffId,
            });
          }
        }
        break;
      }

      case "must_be_assigned": {
        const groups = new Map<string, number[]>();
        for (const i of scopeIndices(index, rule, slots)) {
          const k = `${slots[i].staffId}|${slots[i].workDate}`;
          const list = groups.get(k);
          if (list) list.push(i);
          else groups.set(k, [i]);
        }
        for (const [k, indices] of groups) {
          const [staffId, date] = k.split("|");
          const terms = MipModel.sum(vars(indices));
          if (rule.isHard) {
            model.add(terms, ">=", 1);
          } else {
            const breach = model.addBinary();
            model.add([...terms, { v: breach, c: 1 }], ">=", 1);
            const who = index.staff(staffId).fullName;
            const dayName = WEEKDAY_NAMES[isoWeekday(date) - 1];
            addSoft(breach, rule.weight,
              () => `${who} is not where this rule wants them on ${dayName}`,
              rule, { workDate: date, staffId });
          }
        }
        break;
      }

      case "requires_at_least": {
        const n = Number(rule.params?.n ?? 1);
        for (const group of benchDayGroups(rule)) {
          const terms = MipModel.sum(vars(group.counting));
          if (rule.isHard) {
            model.add(terms.length ? terms : [], ">=", n);
            if (!terms.length && n > 0) {
              // Nobody qualifies on a bench-day the rule governs. That is a
              // conflict, not something to skip past.
              model.trivallyInfeasible ??=
                `${where(group.date, group.benchId)} needs ${n} for "${rule.name}", ` +
                "and nobody eligible qualifies.";
            }
          } else {
            const breach = model.addBinary();
            model.add([...terms, { v: breach, c: n }], ">=", n);
            const place = where(group.date, group.benchId);
            addSoft(breach, rule.weight,
              () => `${place} has fewer than ${n} of the people this rule asks for`,
              rule, { workDate: group.date, shiftId: group.shiftId, benchId: group.benchId });
          }
        }
        break;
      }

      case "requires_at_most": {
        const n = Number(rule.params?.n ?? 1);
        for (const group of benchDayGroups(rule)) {
          if (!group.counting.length) continue;
          const terms = MipModel.sum(vars(group.counting));
          if (rule.isHard) {
            model.add(terms, "<=", n);
          } else {
            const over = model.addContinuous(0, group.counting.length);
            model.add([...terms, { v: over, c: -1 }], "<=", n);
            const place = where(group.date, group.benchId);
            addSoft(over, rule.weight,
              (value) => `${place} is ${value} over the limit of ${n}`,
              rule, { workDate: group.date, shiftId: group.shiftId, benchId: group.benchId });
          }
        }
        break;
      }

      case "requires_supervisor": {
        const wanted = String(rule.params?.supervisor_level ?? "trainer");
        for (const group of benchDayGroups(rule)) {
          const all = byBenchDay.get(groupKey(group.date, group.shiftId, group.benchId)) ?? [];
          if (!all.length) continue;
          const supervisors = all.filter((i) => {
            const c = index.competency(slots[i].staffId, group.benchId);
            if (!c || (c.expiresOn && c.expiresOn < group.date)) return false;
            return (
              ({ trainee: 0, competent: 1, trainer: 2 } as Record<string, number>)[c.level] >=
              ({ trainee: 0, competent: 1, trainer: 2 } as Record<string, number>)[wanted]
            );
          });

          // If anyone is on the bench, at least one of them is a supervisor:
          //   Σ all − M·Σ supervisors ≤ 0
          //
          // M only has to bound how many can actually stand on the bench, and
          // the requirement's maximum is usually 1 or 2 where the eligible pool
          // is 17. A loose big-M is valid but gives the LP relaxation nothing
          // to work with, and it was costing most of the solve time.
          const req = index
            .requirementsOn(group.date)
            .find((r) => r.benchId === group.benchId && r.shiftId === group.shiftId);
          const M = Math.min(all.length, req?.maxStaff ?? all.length);
          const terms: Term[] = [
            ...vars(all).map((v) => ({ v, c: 1 })),
            ...vars(supervisors).map((v) => ({ v, c: -M })),
          ];
          if (rule.isHard) {
            model.add(terms, "<=", 0);
          } else {
            const breach = model.addBinary();
            model.add([...terms, { v: breach, c: -M }], "<=", 0);
            const place = where(group.date, group.benchId);
            addSoft(breach, rule.weight,
              () => `${place} has no ${wanted} on it`,
              rule, { workDate: group.date, shiftId: group.shiftId, benchId: group.benchId });
          }
        }
        break;
      }

      case "same_bench_all_week": {
        const byPerson = new Map<string, Map<string, number[]>>();
        for (const i of scopeIndices(index, rule, slots)) {
          const slot = slots[i];
          const benches = byPerson.get(slot.staffId) ?? new Map<string, number[]>();
          benches.set(slot.benchId, [...(benches.get(slot.benchId) ?? []), i]);
          byPerson.set(slot.staffId, benches);
        }

        for (const [staffId, benches] of byPerson) {
          if (benches.size <= 1) continue;
          const used: number[] = [];
          for (const indices of benches.values()) {
            const y = model.addBinary();
            for (const v of vars(indices)) model.add([{ v, c: 1 }, { v: y, c: -1 }], "<=", 0);
            used.push(y);
          }
          const terms = MipModel.sum(used);
          const who = index.staff(staffId).fullName;
          if (rule.isHard) {
            model.add(terms, "<=", 1);
          } else {
            const extra = model.addContinuous(0, used.length);
            model.add([...terms, { v: extra, c: -1 }], "<=", 1);
            addSoft(extra, rule.weight,
              (value) => `${who} is spread across ${value + 1} benches this week`,
              rule, { staffId });
          }
        }
        break;
      }

      case "max_shifts_in_period": {
        const n = Number(rule.params?.n ?? 5);
        const scoped = new Set(scopeIndices(index, rule, slots));
        for (const [staffId, indices] of byStaff) {
          const counting = indices.filter((i) => scoped.has(i));
          if (!counting.length) continue;
          const terms = MipModel.sum(vars(counting));
          const who = index.staff(staffId).fullName;
          if (rule.isHard) {
            model.add(terms, "<=", n);
          } else {
            const over = model.addContinuous(0, counting.length);
            model.add([...terms, { v: over, c: -1 }], "<=", n);
            addSoft(over, rule.weight,
              (value) => `${who} is ${value} day(s) over the limit of ${n}`,
              rule, { staffId });
          }
        }
        break;
      }

      case "not_together": {
        const people = new Set(conditionPeople(index, rule));
        if (people.size < 2) {
          notes.push(`Rule "${rule.name}" names fewer than two people, so it does nothing.`);
          break;
        }
        for (const [key, indices] of byBenchDay) {
          const counting = indices.filter((i) => people.has(slots[i].staffId));
          if (counting.length < 2) continue;
          const [date, shiftId, benchId] = key.split("|");
          const terms = MipModel.sum(vars(counting));
          if (rule.isHard) {
            model.add(terms, "<=", 1);
          } else {
            const over = model.addContinuous(0, counting.length);
            model.add([...terms, { v: over, c: -1 }], "<=", 1);
            const place = where(date, benchId);
            addSoft(over, rule.weight,
              () => `people this rule keeps apart are together on ${place}`,
              rule, { workDate: date, shiftId, benchId });
          }
        }
        break;
      }

      default:
        notes.push(`Rule "${rule.name}" has no handler for ${rule.action}.`);
    }
  }

  // -- objective -----------------------------------------------------------
  const scale = setting(problem, "weight_soft_breach_scale");
  for (const term of soft) model.cost(term.v, term.weight * scale);

  // Utilisation: an available person left off the rota is waste, and a trainee
  // left off is a week of training lost. This has to outweigh repetition, or
  // the solver buys variety by benching people.
  const wIdle = setting(problem, "weight_idle_staff");
  const wTrainee = setting(problem, "weight_trainee_placement");
  for (const [key, indices] of byStaffDay) {
    const staffId = key.split("|")[0];
    const weight = wIdle + (index.staff(staffId).grade === "trainee" ? wTrainee : 0);
    model.objectiveConstant += weight;
    for (const v of vars(indices)) model.cost(v, -weight);
  }

  // Rotation: doing the same bench again this week is the thing people
  // complain about, so each repeat costs.
  const wRepeat = setting(problem, "weight_rotation_repeat");
  const repeatsPerPerson = new Map<string, number[]>();
  for (const [key, indices] of byStaffBench) {
    if (indices.length < 2) continue;
    const staffId = key.split("|")[0];
    const repeat = model.addContinuous(0, indices.length);
    model.add([...MipModel.sum(vars(indices)), { v: repeat, c: -1 }], "<=", 1);
    model.cost(repeat, wRepeat);
    repeatsPerPerson.set(staffId, [...(repeatsPerPerson.get(staffId) ?? []), repeat]);
  }

  // Fairness: the burden of repeating should not land on one person. Anyone a
  // same_bench_all_week rule deliberately parks is left out, or their
  // requested continuity would read as unfair and drag everyone else around.
  const wFair = setting(problem, "weight_fairness_spread");
  const parked = new Set<string>();
  for (const rule of problem.rules) {
    if (rule.action !== "same_bench_all_week") continue;
    for (const slot of scopeSlots(index, rule, slots)) parked.add(slot.staffId);
  }

  const counted = [...repeatsPerPerson.entries()].filter(([staffId]) => !parked.has(staffId));
  if (wFair && counted.length > 1) {
    const hi = model.addContinuous(0, 7);
    const lo = model.addContinuous(0, 7);
    for (const [, repeats] of counted) {
      model.add([...MipModel.sum(repeats), { v: hi, c: -1 }], "<=", 0);
      model.add([...MipModel.sum(repeats), { v: lo, c: -1 }], ">=", 0);
    }
    model.cost(hi, wFair);
    model.cost(lo, -wFair);
  }

  // Diagnostic pass only: leaving a bench short is far worse than any of the
  // above, so the relaxed solve still tries hardest to cover.
  for (const v of shortfall.values()) model.cost(v, SHORTFALL_COST);

  return { model, index, slots, slotVar, soft, shortfall, notes };
}

export type { InfeasibleReport };
