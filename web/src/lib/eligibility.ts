/** Can this person work this bench on this day, and if not, exactly why?
 *
 * This mirrors Problem.eligibility in the solver. A refused drop must say why,
 * immediately and specifically — "Marcus Kell is not competent on Blood
 * Cultures", never a generic rejection — because that is the moment the user
 * learns how the system thinks.
 */

import type {
  Absence,
  Availability,
  Bench,
  BenchShiftRequirement,
  Competency,
  CompetencyLevel,
  Staff,
} from "./types";
import { dayName, formatDate, isoWeekday } from "./week";

const LEVEL_RANK: Record<CompetencyLevel, number> = {
  trainee: 0,
  competent: 1,
  trainer: 2,
};

export type DropVerdict = "valid" | "soft" | "hard";

export interface EligibilityResult {
  verdict: DropVerdict;
  reason: string;
}

export interface EligibilityInput {
  person: Staff;
  bench: Bench;
  date: string;
  shiftId: string;
  requirement: BenchShiftRequirement | null;
  competency: Competency | undefined;
  availability: Availability[];
  absences: Absence[];
  /** Who else is already on that bench that day, for the supervision check. */
  benchStaff?: { staff: Staff; competency: Competency | undefined }[];
}

function validOn(competency: Competency, date: string): boolean {
  return !competency.expires_on || competency.expires_on >= date;
}

export function isSignedOff(competency: Competency | undefined, date: string): boolean {
  return Boolean(
    competency && competency.level !== "trainee" && validOn(competency, date),
  );
}

export function checkDrop(input: EligibilityInput): EligibilityResult {
  const { person, bench, date, shiftId, requirement, competency } = input;

  if (person.status !== "active") {
    return { verdict: "hard", reason: `${person.full_name} is not an active member of staff.` };
  }

  if (!requirement) {
    return {
      verdict: "hard",
      reason: `${bench.name} does not run on a ${dayName(date)}.`,
    };
  }

  const weekday = isoWeekday(date);
  const contracted = input.availability.some(
    (a) =>
      a.staff_id === person.id &&
      a.weekday === weekday &&
      a.shift_id === shiftId &&
      a.is_available,
  );
  if (!contracted) {
    return {
      verdict: "hard",
      reason: `${person.full_name} is not contracted on a ${dayName(date)}.`,
    };
  }

  const absence = input.absences.find(
    (a) => a.staff_id === person.id && a.starts_on <= date && a.ends_on >= date,
  );
  if (absence) {
    const kind = absence.kind.replace(/_/g, " ");
    return { verdict: "hard", reason: `${person.full_name} is on ${kind} on ${formatDate(date)}.` };
  }

  if (!competency) {
    return { verdict: "hard", reason: `${person.full_name} is not competent on ${bench.name}.` };
  }

  if (!validOn(competency, date)) {
    return {
      verdict: "hard",
      reason: `${person.full_name}'s ${bench.name} signoff expired on ${formatDate(
        competency.expires_on,
      )}.`,
    };
  }

  // A trainee goes on the bench regardless of signoff, but never unsupervised.
  if (competency.level === "trainee") {
    const supervised = (input.benchStaff ?? []).some(
      (other) => other.staff.id !== person.id && isSignedOff(other.competency, date),
    );
    if (!supervised) {
      return {
        verdict: "soft",
        reason: `${person.full_name} is still in training on ${bench.name}. Add a signed-off colleague to this bench or the solver will move them.`,
      };
    }
    return { verdict: "valid", reason: `${person.full_name} is in training on ${bench.name}.` };
  }

  const needed = requirement.required_level ?? bench.required_level;
  if (LEVEL_RANK[competency.level] < LEVEL_RANK[needed]) {
    return {
      verdict: "hard",
      reason: `${person.full_name} is ${competency.level} on ${bench.name}, which needs ${needed}.`,
    };
  }

  const max = requirement.max_staff;
  if (max != null && (input.benchStaff?.length ?? 0) >= max) {
    return {
      verdict: "soft",
      reason: `${bench.name} already has its maximum of ${max} on ${dayName(date)}.`,
    };
  }

  return { verdict: "valid", reason: `${person.full_name} can work ${bench.name}.` };
}
