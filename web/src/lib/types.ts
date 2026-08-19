/** Row types mirroring supabase/migrations/0001_schema.sql. */

export type StaffGrade = "ap" | "bms" | "senior_bms" | "trainee";
export type StaffStatus = "active" | "inactive";
export type CompetencyLevel = "trainee" | "competent" | "trainer";
export type DocStatus = "not_started" | "in_training" | "signed_off";
export type AbsenceKind = "annual_leave" | "sick" | "study" | "other";
export type RuleScope = "global" | "staff" | "bench";
export type RuleStatus = "active" | "paused";
export type AssignmentSource = "solver" | "manual";

export type RuleAction =
  | "must_be_assigned"
  | "cannot_be_assigned"
  | "requires_at_least"
  | "requires_at_most"
  | "requires_supervisor"
  | "same_bench_all_week"
  | "max_shifts_in_period"
  | "not_together";

export type RunStatus =
  | "queued"
  | "running"
  | "solved"
  | "solved_with_breaches"
  | "infeasible"
  | "error"
  | "cancelled";

export interface Shift {
  id: string;
  code: string;
  name: string;
  starts_at: string;
  ends_at: string;
  is_default: boolean;
  sort_order: number;
}

export interface BenchGroup {
  id: string;
  name: string;
  sort_order: number;
}

export interface Bench {
  id: string;
  name: string;
  group_id: string | null;
  min_staff: number;
  max_staff: number | null;
  required_level: CompetencyLevel;
  is_active: boolean;
  sort_order: number;
  notes: string | null;
  bench_group?: { name: string } | null;
}

export interface CompetencyDocument {
  id: string;
  bench_id: string;
  doc_number: string;
  title: string | null;
  is_primary: boolean;
  sort_order: number;
}

export interface BenchShiftRequirement {
  bench_id: string;
  shift_id: string;
  label: string;
  weekdays: number[];
  min_staff: number;
  max_staff: number | null;
  required_level: CompetencyLevel | null;
}

export interface Staff {
  id: string;
  staff_code: string;
  full_name: string;
  grade: StaffGrade;
  status: StaffStatus;
  fte: number;
  started_on: string | null;
  notes: string | null;
}

export interface Availability {
  id: string;
  staff_id: string;
  weekday: number;
  shift_id: string;
  is_available: boolean;
}

export interface Absence {
  id: string;
  staff_id: string;
  starts_on: string;
  ends_on: string;
  kind: AbsenceKind;
  notes: string | null;
}

export interface Competency {
  id: string;
  staff_id: string;
  bench_id: string;
  level: CompetencyLevel;
  assessed_on: string | null;
  expires_on: string | null;
  assessor_id: string | null;
  document_ref: string | null;
  notes: string | null;
}

/** v_competency_matrix: the cell state already resolved. */
export type MatrixDisplayState =
  | "trainee"
  | "competent"
  | "trainer"
  | "expiring_soon"
  | "expired";

export interface MatrixCell extends Competency {
  assessor_name: string | null;
  display_state: MatrixDisplayState;
}

export interface StaffDocument {
  id: string;
  staff_id: string;
  document_id: string;
  status: DocStatus;
  assessed_on: string | null;
  expires_on: string | null;
}

export interface RuleCondition {
  subject:
    | "person"
    | "grade"
    | "competency_level"
    | "day"
    | "shift"
    | "bench"
    | "bench_group"
    | "date";
  operator: string;
  values: (string | number)[];
}

export interface RuleGroup {
  op: "all" | "any";
  children: RuleNode[];
}

export type RuleNode = RuleCondition | RuleGroup;

export function isGroup(node: RuleNode): node is RuleGroup {
  return (node as RuleGroup).op === "all" || (node as RuleGroup).op === "any";
}

export interface Rule {
  id: string;
  name: string;
  description: string | null;
  action: RuleAction;
  params: Record<string, unknown>;
  conditions: RuleGroup;
  scope: RuleScope;
  is_hard: boolean;
  weight: number;
  status: RuleStatus;
  plain_english: string | null;
  created_at: string;
  updated_at: string;
}

export interface InfeasibleConflict {
  kind: "coverage" | "rule" | "pin";
  detail: string;
  bench_id?: string | null;
  bench_name?: string | null;
  shift_name?: string | null;
  work_date?: string | null;
  day_name?: string | null;
  required?: number;
  achieved?: number;
  short_by?: number;
  rule_id?: string;
  rule_name?: string;
  first_failure?: string;
  pool?: {
    staff_id: string;
    staff_code: string;
    name: string;
    level: CompetencyLevel;
    reason: string;
    available?: boolean;
  }[];
  pins?: {
    staff_id: string;
    name: string;
    bench_id: string;
    bench_name: string;
    work_date: string;
    day_name: string;
  }[];
}

export interface InfeasibleSuggestion {
  label: string;
  action:
    | "edit_bench"
    | "absences"
    | "matrix"
    | "edit_rule"
    | "pause_rule"
    | "rules"
    | "pins"
    | "clear_pins";
  bench_id?: string;
  rule_id?: string;
  date?: string;
}

export interface InfeasibleReport {
  summary: string;
  conflicts: InfeasibleConflict[];
  suggestions: InfeasibleSuggestion[];
  note?: string;
}

export interface RotaRun {
  id: string;
  week_start: string;
  status: RunStatus;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  solve_ms: number | null;
  pins_applied: number;
  soft_breach_count: number;
  objective_value: number | null;
  status_detail: string | null;
  infeasible_report: InfeasibleReport | null;
  rule_snapshot: unknown;
  solver_version: string | null;
  worker_ref: string | null;
  log: string | null;
}

export interface Assignment {
  id: string;
  run_id: string | null;
  week_start: string;
  work_date: string;
  shift_id: string;
  bench_id: string;
  staff_id: string;
  source: AssignmentSource;
  is_pinned: boolean;
}

export interface Pin {
  id: string;
  week_start: string;
  work_date: string;
  shift_id: string;
  bench_id: string;
  staff_id: string;
  reason: string | null;
  created_at: string;
}

export interface RuleBreach {
  id: string;
  run_id: string;
  rule_id: string | null;
  rule_name: string | null;
  weight: number | null;
  work_date: string | null;
  shift_id: string | null;
  bench_id: string | null;
  staff_id: string | null;
  detail: string;
}

export interface RotaWeek {
  week_start: string;
  published_run_id: string | null;
  published_at: string | null;
  published_by: string | null;
  notes: string | null;
}

export interface SolverSetting {
  key: string;
  value: number;
  label: string | null;
  description: string | null;
  sort_order: number;
}

export interface BenchPool {
  bench_id: string;
  bench_name: string;
  group_name: string | null;
  min_staff: number;
  max_staff: number | null;
  required_level: CompetencyLevel;
  is_active: boolean;
  sort_order: number;
  competent_count: number;
  trainer_count: number;
  trainee_count: number;
  expired_count: number;
}

export interface StaffCompetencySummary {
  staff_id: string;
  competency_count: number;
  signed_off_count: number;
  trainee_count: number;
  expiring_soon_count: number;
  expired_count: number;
}
