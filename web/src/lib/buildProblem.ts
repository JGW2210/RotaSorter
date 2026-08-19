/** Assemble a solver problem from the rows the screens already have loaded.
 *
 * Nothing extra is fetched: the Rota Board needs staff, benches, requirements,
 * competencies, availability, absences, rules and pins to render anyway, so a
 * solve costs no round trips at all.
 */

import { DEFAULT_SETTINGS, type SolverProblem, type SolverSettings } from "../solver";
import type {
  Absence,
  Assignment,
  Availability,
  Bench,
  BenchShiftRequirement,
  MatrixCell,
  Pin,
  Rule,
  Shift,
  SolverSetting,
  Staff,
} from "./types";

export interface ProblemInputs {
  weekStart: string;
  shifts: Shift[];
  benches: Bench[];
  requirements: BenchShiftRequirement[];
  staff: Staff[];
  competencies: MatrixCell[];
  availability: Availability[];
  absences: Absence[];
  rules: Rule[];
  pins: Pin[];
  /** Last week's published assignments, for rules that look across weeks. */
  history?: Assignment[];
  settings: SolverSetting[];
}

export function buildProblem(input: ProblemInputs): SolverProblem {
  const activeBenches = input.benches.filter((b) => b.is_active);
  const benchIds = new Set(activeBenches.map((b) => b.id));
  const activeStaff = input.staff.filter((s) => s.status === "active");
  const staffIds = new Set(activeStaff.map((s) => s.id));

  const settings = { ...DEFAULT_SETTINGS } as SolverSettings;
  for (const row of input.settings) {
    const value = Number(row.value);
    if (row.key in settings && Number.isFinite(value)) {
      settings[row.key as keyof SolverSettings] = value;
    }
  }

  return {
    weekStart: input.weekStart,
    shifts: input.shifts.map((s) => ({ id: s.id, code: s.code, name: s.name })),
    benches: activeBenches.map((b) => ({
      id: b.id,
      name: b.name,
      groupName: b.bench_group?.name ?? null,
      requiredLevel: b.required_level,
      sortOrder: b.sort_order,
    })),
    requirements: input.requirements
      .filter((r) => benchIds.has(r.bench_id))
      .map((r) => ({
        benchId: r.bench_id,
        shiftId: r.shift_id,
        label: r.label,
        weekdays: r.weekdays ?? [],
        minStaff: r.min_staff,
        maxStaff: r.max_staff,
        requiredLevel: r.required_level,
      })),
    staff: activeStaff.map((s) => ({
      id: s.id,
      code: s.staff_code,
      fullName: s.full_name,
      grade: s.grade,
      status: s.status,
    })),
    competencies: input.competencies
      .filter((c) => staffIds.has(c.staff_id) && benchIds.has(c.bench_id))
      .map((c) => ({
        staffId: c.staff_id,
        benchId: c.bench_id,
        level: c.level,
        expiresOn: c.expires_on,
      })),
    absences: input.absences
      .filter((a) => staffIds.has(a.staff_id))
      .map((a) => ({
        staffId: a.staff_id,
        startsOn: a.starts_on,
        endsOn: a.ends_on,
        kind: a.kind,
      })),
    availability: input.availability
      .filter((a) => a.is_available && staffIds.has(a.staff_id))
      .map((a) => ({
        staffId: a.staff_id,
        weekday: a.weekday,
        shiftId: a.shift_id,
      })),
    rules: input.rules
      .filter((r) => r.status === "active")
      .map((r) => ({
        id: r.id,
        name: r.name,
        action: r.action,
        params: r.params ?? {},
        conditions: r.conditions ?? null,
        isHard: r.is_hard,
        weight: r.weight,
        plainEnglish: r.plain_english,
      })),
    pins: input.pins
      .filter((p) => staffIds.has(p.staff_id) && benchIds.has(p.bench_id))
      .map((p) => ({
        workDate: p.work_date,
        shiftId: p.shift_id,
        benchId: p.bench_id,
        staffId: p.staff_id,
      })),
    history: (input.history ?? [])
      .filter((a) => staffIds.has(a.staff_id) && benchIds.has(a.bench_id))
      .map((a) => ({
        staffId: a.staff_id,
        workDate: a.work_date,
        shiftId: a.shift_id,
        benchId: a.bench_id,
      })),
    settings,
  };
}
