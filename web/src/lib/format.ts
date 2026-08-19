import type { CompetencyLevel, MatrixDisplayState, RunStatus, StaffGrade } from "./types";

export const GRADE_LABELS: Record<StaffGrade, string> = {
  ap: "AP",
  bms: "BMS",
  senior_bms: "Senior BMS",
  trainee: "Trainee",
};

export const GRADE_ORDER: StaffGrade[] = ["senior_bms", "bms", "ap", "trainee"];

export const LEVEL_LABELS: Record<CompetencyLevel, string> = {
  trainee: "Trainee",
  competent: "Competent",
  trainer: "Trainer",
};

/* No state is carried by colour alone. Every matrix state has a glyph too,
 * both for accessibility and because this screen gets printed. */
export const MATRIX_GLYPHS: Record<MatrixDisplayState, string> = {
  trainee: "◍",
  competent: "●",
  trainer: "★",
  expiring_soon: "◐",
  expired: "✕",
};

export const MATRIX_LABELS: Record<MatrixDisplayState, string> = {
  trainee: "In training",
  competent: "Competent",
  trainer: "Trainer",
  expiring_soon: "Expiring soon",
  expired: "Expired",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Solving",
  solved: "Solved",
  solved_with_breaches: "Solved with breaches",
  infeasible: "Infeasible",
  error: "Error",
  cancelled: "Cancelled",
};

export const ABSENCE_LABELS: Record<string, string> = {
  annual_leave: "Annual leave",
  sick: "Sickness",
  study: "Study leave",
  other: "Other",
};

/** Initials for a staff chip. Two letters, upper case. */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function pluralise(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

export function listPhrase(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
