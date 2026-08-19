import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Empty, ErrorNote, Loading, Tag, Toolbar } from "../components/Bits";
import { GRADE_LABELS, GRADE_ORDER } from "../lib/format";
import {
  useAbsences,
  useAvailability,
  useShifts,
  useStaff,
  useStaffSummaries,
} from "../lib/queries";
import type { Staff } from "../lib/types";
import { WEEKDAY_SHORT, formatDate } from "../lib/week";

/** Compact glyph strip: M T W T F · · with worked days filled. */
function PatternStrip({ weekdays }: { weekdays: Set<number> }) {
  return (
    <span className="pattern" aria-label={`Works ${[...weekdays].map((d) => WEEKDAY_SHORT[d - 1]).join(", ")}`}>
      {WEEKDAY_SHORT.map((label, index) => (
        <span
          key={label}
          className={weekdays.has(index + 1) ? "pattern__on" : "pattern__off"}
          aria-hidden="true"
        >
          {weekdays.has(index + 1) ? label[0] : "·"}
        </span>
      ))}
    </span>
  );
}

export default function StaffList() {
  const [params] = useSearchParams();
  const highlightAbsencesFrom = params.get("absences");

  const staff = useStaff();
  const summaries = useStaffSummaries();
  const availability = useAvailability();
  const absences = useAbsences();
  const shifts = useShifts();

  const [grade, setGrade] = useState<string>("");
  const [activeOnly, setActiveOnly] = useState(true);

  const defaultShift = shifts.data?.find((s) => s.is_default)?.id;

  const patterns = useMemo(() => {
    const out = new Map<string, Set<number>>();
    for (const row of availability.data ?? []) {
      if (!row.is_available) continue;
      if (defaultShift && row.shift_id !== defaultShift) continue;
      const set = out.get(row.staff_id) ?? new Set<number>();
      set.add(row.weekday);
      out.set(row.staff_id, set);
    }
    return out;
  }, [availability.data, defaultShift]);

  const summaryById = useMemo(
    () => new Map((summaries.data ?? []).map((s) => [s.staff_id, s])),
    [summaries.data],
  );

  const absencesById = useMemo(() => {
    const out = new Map<string, typeof absences.data>();
    for (const row of absences.data ?? []) {
      out.set(row.staff_id, [...(out.get(row.staff_id) ?? []), row]);
    }
    return out;
  }, [absences.data]);

  const rows = useMemo(() => {
    let list = staff.data ?? [];
    if (activeOnly) list = list.filter((s) => s.status === "active");
    if (grade) list = list.filter((s) => s.grade === grade);
    return [...list].sort(
      (a, b) =>
        GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) ||
        a.full_name.localeCompare(b.full_name),
    );
  }, [staff.data, activeOnly, grade]);

  if (staff.error) return <ErrorNote error={staff.error} />;
  if (staff.isLoading) return <Loading what="staff" />;
  if ((staff.data ?? []).length === 0) {
    return (
      <Empty title="No staff yet">
        Add people, or run the seed files in <code>supabase/seed</code> to load a set of
        dummy records.
      </Empty>
    );
  }

  return (
    <>
      <Toolbar>
        <select value={grade} onChange={(e) => setGrade(e.target.value)} aria-label="Grade">
          <option value="">All grades</option>
          {GRADE_ORDER.map((g) => (
            <option key={g} value={g}>
              {GRADE_LABELS[g]}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
          />
          Active only
        </label>
        <span className="toolbar__count">{rows.length} people</span>
      </Toolbar>

      {highlightAbsencesFrom && (
        <div className="notice notice--info">
          Showing who is away around {formatDate(highlightAbsencesFrom)}.
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Staff code</th>
              <th>Grade</th>
              <th>Contracted pattern</th>
              <th>Competencies</th>
              <th>Away</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((person: Staff) => {
              const summary = summaryById.get(person.id);
              const away = (absencesById.get(person.id) ?? []).filter((a) =>
                highlightAbsencesFrom
                  ? a.starts_on <= highlightAbsencesFrom && a.ends_on >= highlightAbsencesFrom
                  : a.ends_on >= new Date().toISOString().slice(0, 10),
              );
              return (
                <tr key={person.id}>
                  <td>
                    <Link to={`/staff/${person.id}`}>{person.full_name}</Link>
                  </td>
                  <td className="mono">{person.staff_code}</td>
                  <td>{GRADE_LABELS[person.grade]}</td>
                  <td>
                    <PatternStrip weekdays={patterns.get(person.id) ?? new Set()} />
                  </td>
                  <td>
                    {summary?.competency_count ?? 0}
                    {summary?.expiring_soon_count ? (
                      <Tag tone="caution" glyph="◐">
                        {summary.expiring_soon_count} expiring
                      </Tag>
                    ) : null}
                    {summary?.expired_count ? (
                      <Tag tone="alert" glyph="✕">
                        {summary.expired_count} expired
                      </Tag>
                    ) : null}
                  </td>
                  <td className="mono">
                    {away.length ? formatDate(away[0].starts_on) : "—"}
                  </td>
                  <td>
                    {person.status === "active" ? (
                      "Active"
                    ) : (
                      <Tag tone="neutral">Inactive</Tag>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
