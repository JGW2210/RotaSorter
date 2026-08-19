/** The solver's own view of a week.
 *
 * Deliberately separate from the Supabase row types: the same shape is emitted
 * by the Python reference solver, so a problem can be round-tripped through
 * JSON and solved by both to check they agree. See solver/README.md.
 */

import type { CompetencyLevel, RuleAction, RuleGroup, StaffGrade } from "../lib/types";

export const LEVEL_RANK: Record<CompetencyLevel, number> = {
  trainee: 0,
  competent: 1,
  trainer: 2,
};

export const SIGNED_OFF: CompetencyLevel[] = ["competent", "trainer"];

export interface SolverShift {
  id: string;
  code: string;
  name: string;
}

export interface SolverBench {
  id: string;
  name: string;
  groupName: string | null;
  requiredLevel: CompetencyLevel;
  sortOrder: number;
}

export interface SolverRequirement {
  benchId: string;
  shiftId: string;
  label: string;
  weekdays: number[];
  minStaff: number;
  maxStaff: number | null;
  requiredLevel: CompetencyLevel | null;
}

export interface SolverStaff {
  id: string;
  code: string;
  fullName: string;
  grade: StaffGrade;
  status: "active" | "inactive";
}

export interface SolverCompetency {
  staffId: string;
  benchId: string;
  level: CompetencyLevel;
  expiresOn: string | null;
}

export interface SolverAbsence {
  staffId: string;
  startsOn: string;
  endsOn: string;
  kind: string;
}

export interface SolverAvailability {
  staffId: string;
  weekday: number;
  shiftId: string;
}

export interface SolverRule {
  id: string;
  name: string;
  action: RuleAction;
  params: Record<string, unknown>;
  conditions: RuleGroup | null;
  isHard: boolean;
  weight: number;
  plainEnglish: string | null;
}

export interface SolverPin {
  workDate: string;
  shiftId: string;
  benchId: string;
  staffId: string;
}

export interface SolverSettings {
  weight_fairness_spread: number;
  weight_rotation_repeat: number;
  weight_idle_staff: number;
  weight_trainee_placement: number;
  weight_soft_breach_scale: number;
  max_solve_seconds: number;
  random_seed: number;
}

export const DEFAULT_SETTINGS: SolverSettings = {
  weight_fairness_spread: 20,
  weight_rotation_repeat: 12,
  weight_idle_staff: 40,
  weight_trainee_placement: 25,
  weight_soft_breach_scale: 1,
  max_solve_seconds: 60,
  random_seed: 20260914,
};

export interface SolverProblem {
  weekStart: string;
  shifts: SolverShift[];
  benches: SolverBench[];
  requirements: SolverRequirement[];
  staff: SolverStaff[];
  competencies: SolverCompetency[];
  absences: SolverAbsence[];
  availability: SolverAvailability[];
  rules: SolverRule[];
  pins: SolverPin[];
  settings: SolverSettings;
}

export interface SolvedAssignment {
  workDate: string;
  shiftId: string;
  benchId: string;
  staffId: string;
  isPinned: boolean;
}

export interface SolvedBreach {
  ruleId: string | null;
  ruleName: string;
  weight: number;
  detail: string;
  workDate: string | null;
  shiftId: string | null;
  benchId: string | null;
  staffId: string | null;
}

export type SolveStatus =
  | "solved"
  | "solved_with_breaches"
  | "infeasible"
  | "error";

export interface SolveResult {
  status: SolveStatus;
  assignments: SolvedAssignment[];
  breaches: SolvedBreach[];
  objectiveValue: number | null;
  solveMs: number;
  infeasibleReport: import("../lib/types").InfeasibleReport | null;
  log: string;
}

/** One candidate assignment: this person, this bench, this day. */
export interface Slot {
  staffId: string;
  workDate: string;
  shiftId: string;
  benchId: string;
}

export function slotKey(slot: Slot): string {
  return `${slot.staffId}|${slot.workDate}|${slot.shiftId}|${slot.benchId}`;
}

export function groupKey(workDate: string, shiftId: string, benchId: string): string {
  return `${workDate}|${shiftId}|${benchId}`;
}
