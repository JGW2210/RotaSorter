/** Week maths on plain YYYY-MM-DD strings.
 *
 * Dates are handled as strings and UTC throughout. A rota day is a calendar
 * day in the lab, not an instant, and letting a Date pick up the browser's
 * timezone is how a Monday becomes the previous Sunday for someone.
 */

const MS_DAY = 86_400_000;

export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function toUtc(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(iso: string): number {
  const day = toUtc(iso).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Monday of whatever week a date falls in. */
export function mondayOf(iso: string): string {
  const date = toUtc(iso);
  return toIso(new Date(date.getTime() - (isoWeekday(iso) - 1) * MS_DAY));
}

export function addDays(iso: string, days: number): string {
  return toIso(new Date(toUtc(iso).getTime() + days * MS_DAY));
}

export function addWeeks(iso: string, weeks: number): string {
  return addDays(iso, weeks * 7);
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function currentWeekStart(): string {
  return mondayOf(toIso(new Date()));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = toUtc(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatDateShort(iso: string): string {
  const d = toUtc(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function formatWeekLabel(weekStart: string): string {
  return `Week of ${formatDate(weekStart)}`;
}

export function dayName(iso: string): string {
  return WEEKDAY_NAMES[isoWeekday(iso) - 1];
}

export function dayShort(iso: string): string {
  return WEEKDAY_SHORT[isoWeekday(iso) - 1];
}

export function isWeekend(iso: string): boolean {
  return isoWeekday(iso) >= 6;
}

export function daysUntil(iso: string, from = toIso(new Date())): number {
  return Math.round((toUtc(iso).getTime() - toUtc(from).getTime()) / MS_DAY);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${time}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
