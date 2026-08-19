/** Indexed view of a week, and the eligibility rules the model is built on.
 *
 * This mirrors Problem.eligibility in the Python reference solver, including
 * the wording of the refusal reasons, because those reasons are what the
 * infeasibility screen shows the user.
 */

import { WEEKDAY_NAMES, formatDate, isoWeekday } from "../lib/week";
import {
  LEVEL_RANK,
  SIGNED_OFF,
  type SolverBench,
  type SolverCompetency,
  type SolverProblem,
  type SolverRequirement,
  type SolverShift,
  type SolverStaff,
} from "./types";

export class ProblemIndex {
  readonly staffById = new Map<string, SolverStaff>();
  readonly benchById = new Map<string, SolverBench>();
  readonly shiftById = new Map<string, SolverShift>();
  private readonly competencyBy = new Map<string, SolverCompetency>();
  private readonly contracted = new Set<string>();
  private readonly absencesBy = new Map<string, { startsOn: string; endsOn: string; kind: string }[]>();

  constructor(readonly problem: SolverProblem) {
    for (const s of problem.staff) this.staffById.set(s.id, s);
    for (const b of problem.benches) this.benchById.set(b.id, b);
    for (const s of problem.shifts) this.shiftById.set(s.id, s);
    for (const c of problem.competencies) {
      this.competencyBy.set(`${c.staffId}|${c.benchId}`, c);
    }
    for (const a of problem.availability) {
      this.contracted.add(`${a.staffId}|${a.weekday}|${a.shiftId}`);
    }
    for (const a of problem.absences) {
      const list = this.absencesBy.get(a.staffId);
      if (list) list.push(a);
      else this.absencesBy.set(a.staffId, [a]);
    }
  }

  get dates(): string[] {
    const start = this.problem.weekStart;
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(`${start}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
  }

  staff(id: string): SolverStaff {
    const found = this.staffById.get(id);
    if (!found) throw new Error(`Unknown member of staff: ${id}`);
    return found;
  }

  bench(id: string): SolverBench {
    const found = this.benchById.get(id);
    if (!found) throw new Error(`Unknown bench: ${id}`);
    return found;
  }

  competency(staffId: string, benchId: string): SolverCompetency | undefined {
    return this.competencyBy.get(`${staffId}|${benchId}`);
  }

  isContracted(staffId: string, date: string, shiftId: string): boolean {
    return this.contracted.has(`${staffId}|${isoWeekday(date)}|${shiftId}`);
  }

  absenceOn(staffId: string, date: string) {
    return (this.absencesBy.get(staffId) ?? []).find(
      (a) => a.startsOn <= date && a.endsOn >= date,
    );
  }

  /** Requirements in force on a date, one per bench and shift. */
  requirementsOn(date: string): SolverRequirement[] {
    const weekday = isoWeekday(date);
    const grouped = new Map<string, SolverRequirement[]>();
    for (const req of this.problem.requirements) {
      if (!req.weekdays.includes(weekday)) continue;
      const key = `${req.benchId}|${req.shiftId}`;
      const list = grouped.get(key);
      if (list) list.push(req);
      else grouped.set(key, [req]);
    }

    const merged: SolverRequirement[] = [];
    for (const reqs of grouped.values()) {
      if (reqs.length === 1) {
        merged.push(reqs[0]);
        continue;
      }
      // Overlapping weekday sets are a data mistake, not a feature. Take the
      // strictest reading, the same way the reference solver does.
      const maxes = reqs.map((r) => r.maxStaff).filter((m): m is number => m != null);
      merged.push({
        ...reqs[0],
        label: reqs.map((r) => r.label).sort().join("+"),
        weekdays: [weekday],
        minStaff: Math.max(...reqs.map((r) => r.minStaff)),
        maxStaff: maxes.length ? Math.min(...maxes) : null,
      });
    }
    return merged;
  }

  requiredLevel(req: SolverRequirement): string {
    return req.requiredLevel ?? this.bench(req.benchId).requiredLevel;
  }

  isSignedOff(staffId: string, benchId: string, date: string): boolean {
    const c = this.competency(staffId, benchId);
    return Boolean(
      c && SIGNED_OFF.includes(c.level) && (!c.expiresOn || c.expiresOn >= date),
    );
  }

  /** Can this person work this bench on this day, and if not, why not? */
  eligibility(
    staffId: string,
    req: SolverRequirement,
    date: string,
  ): { ok: boolean; reason: string } {
    const person = this.staff(staffId);
    if (person.status !== "active") {
      return { ok: false, reason: `${person.fullName} is inactive` };
    }

    if (!this.isContracted(staffId, date, req.shiftId)) {
      return {
        ok: false,
        reason: `${person.fullName} is not contracted on ${WEEKDAY_NAMES[isoWeekday(date) - 1]}`,
      };
    }

    const absence = this.absenceOn(staffId, date);
    if (absence) {
      return {
        ok: false,
        reason: `${person.fullName} is on ${absence.kind.replace(/_/g, " ")}`,
      };
    }

    const bench = this.bench(req.benchId);
    const competency = this.competency(staffId, req.benchId);
    if (!competency) {
      return { ok: false, reason: `${person.fullName} is not competent on ${bench.name}` };
    }

    if (competency.expiresOn && competency.expiresOn < date) {
      return {
        ok: false,
        reason: `${person.fullName}'s ${bench.name} signoff expired on ${formatDate(competency.expiresOn)}`,
      };
    }

    // A trainee is placed on the bench while working through the documents, so
    // training status is never itself a blocker. The supervision constraint in
    // build.ts is what keeps that safe.
    if (competency.level === "trainee") return { ok: true, reason: "" };

    const needed = this.requiredLevel(req);
    if (LEVEL_RANK[competency.level] < LEVEL_RANK[needed as never]) {
      return {
        ok: false,
        reason: `${person.fullName} is ${competency.level} on ${bench.name}, which needs ${needed}`,
      };
    }

    return { ok: true, reason: "" };
  }
}
