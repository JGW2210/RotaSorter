import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorNote, Loading, Panel, Tag } from "../components/Bits";
import { ABSENCE_LABELS, GRADE_LABELS, MATRIX_GLYPHS, MATRIX_LABELS } from "../lib/format";
import {
  useAbsences,
  useAvailability,
  useBenches,
  useCompetencyDocuments,
  useCompetencyMatrix,
  useRecentAssignments,
  useShifts,
  useStaff,
  useStaffDocuments,
} from "../lib/queries";
import { supabase } from "../lib/supabase";
import type { AbsenceKind } from "../lib/types";
import { WEEKDAY_SHORT, formatDate } from "../lib/week";

const BLANK_ABSENCE = {
  starts_on: "",
  ends_on: "",
  kind: "annual_leave" as AbsenceKind,
  notes: "",
};

export default function StaffDetail() {
  const { staffId } = useParams();
  const queryClient = useQueryClient();
  const staff = useStaff();
  const benches = useBenches();
  const shifts = useShifts();
  const matrix = useCompetencyMatrix();
  const availability = useAvailability();
  const absences = useAbsences();
  const documents = useCompetencyDocuments();
  const staffDocuments = useStaffDocuments(staffId);
  const recent = useRecentAssignments(staffId);

  const [patternError, setPatternError] = useState<string | null>(null);
  const [absenceDraft, setAbsenceDraft] = useState(BLANK_ABSENCE);
  const [absenceError, setAbsenceError] = useState<string | null>(null);

  const person = staff.data?.find((s) => s.id === staffId);
  const benchById = useMemo(
    () => new Map((benches.data ?? []).map((b) => [b.id, b])),
    [benches.data],
  );
  const docById = useMemo(
    () => new Map((documents.data ?? []).map((d) => [d.id, d])),
    [documents.data],
  );

  if (staff.error) return <ErrorNote error={staff.error} />;
  if (staff.isLoading) return <Loading what="this person" />;
  if (!person) return <ErrorNote error={new Error("No such member of staff.")} />;

  const cells = (matrix.data ?? []).filter((c) => c.staff_id === person.id);
  const availableOn = new Map(
    (availability.data ?? [])
      .filter((a) => a.staff_id === person.id)
      .map((a) => [`${a.weekday}|${a.shift_id}`, a.is_available]),
  );
  const away = (absences.data ?? []).filter((a) => a.staff_id === person.id);

  async function toggleContracted(shiftId: string, weekday: number, on: boolean) {
    setPatternError(null);
    const { error } = await supabase.from("availability").upsert(
      { staff_id: person!.id, weekday, shift_id: shiftId, is_available: on },
      { onConflict: "staff_id,weekday,shift_id" },
    );
    if (error) {
      setPatternError(error.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["availability"] });
  }

  async function addAbsence() {
    if (!absenceDraft.starts_on) {
      setAbsenceError("An absence needs at least a start date.");
      return;
    }
    setAbsenceError(null);
    const ends = absenceDraft.ends_on || absenceDraft.starts_on;
    if (ends < absenceDraft.starts_on) {
      setAbsenceError("An absence cannot end before it starts.");
      return;
    }
    const { error } = await supabase.from("absence").insert({
      staff_id: person!.id,
      starts_on: absenceDraft.starts_on,
      ends_on: ends,
      kind: absenceDraft.kind,
      notes: absenceDraft.notes || null,
    });
    if (error) {
      setAbsenceError(error.message);
      return;
    }
    setAbsenceDraft(BLANK_ABSENCE);
    await queryClient.invalidateQueries({ queryKey: ["absence"] });
  }

  async function removeAbsence(id: string) {
    setAbsenceError(null);
    const { error } = await supabase.from("absence").delete().eq("id", id);
    if (error) {
      setAbsenceError(error.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["absence"] });
  }

  const shiftList = shifts.data ?? [];

  return (
    <div className="detail">
      <div className="detail__head">
        <div>
          <h2>{person.full_name}</h2>
          <p className="detail__sub">
            <span className="mono">{person.staff_code}</span> · {GRADE_LABELS[person.grade]} ·{" "}
            {person.fte.toFixed(2)} FTE
            {person.started_on && ` · started ${formatDate(person.started_on)}`}
          </p>
        </div>
        <Link to="/staff" className="btn">
          Back to staff
        </Link>
      </div>

      <div className="detail__cols">
        <Panel title="Contracted pattern">
          <div className="stack">
            {shiftList.map((shift) => (
              <div key={shift.id} className="pattern-row">
                {shiftList.length > 1 && (
                  <span className="pattern-row__shift">{shift.name}</span>
                )}
                <div className="pattern pattern--large">
                  {WEEKDAY_SHORT.map((label, index) => {
                    const on = availableOn.get(`${index + 1}|${shift.id}`) ?? false;
                    return (
                      <button
                        key={label}
                        type="button"
                        className={on ? "pattern__on" : "pattern__off"}
                        aria-pressed={on}
                        title={`${on ? "Contracted" : "Not contracted"} on the ${shift.name} shift. Click to change.`}
                        onClick={() => void toggleContracted(shift.id, index + 1, !on)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="muted">
            Click a day to change it. The solver only places people on their
            contracted days.
          </p>
          {patternError && <p className="login__error">{patternError}</p>}
        </Panel>

        <Panel title="Absences">
          {away.length === 0 ? (
            <p className="muted">Nothing booked.</p>
          ) : (
            <ul className="stack">
              {away.map((a) => (
                <li key={a.id} className="absence-row">
                  <Tag tone={a.kind === "sick" ? "alert" : "neutral"}>
                    {ABSENCE_LABELS[a.kind] ?? a.kind}
                  </Tag>{" "}
                  {formatDate(a.starts_on)}
                  {a.ends_on !== a.starts_on && ` – ${formatDate(a.ends_on)}`}
                  {a.notes && <span className="muted"> · {a.notes}</span>}
                  <button
                    type="button"
                    className="btn btn--quiet"
                    onClick={() => void removeAbsence(a.id)}
                    aria-label={`Remove this ${ABSENCE_LABELS[a.kind] ?? a.kind} absence`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="absence-form">
            <select
              value={absenceDraft.kind}
              aria-label="Kind of absence"
              onChange={(e) =>
                setAbsenceDraft({ ...absenceDraft, kind: e.target.value as AbsenceKind })
              }
            >
              {Object.entries(ABSENCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={absenceDraft.starts_on}
              aria-label="First day"
              onChange={(e) => setAbsenceDraft({ ...absenceDraft, starts_on: e.target.value })}
            />
            <input
              type="date"
              value={absenceDraft.ends_on}
              min={absenceDraft.starts_on || undefined}
              aria-label="Last day"
              onChange={(e) => setAbsenceDraft({ ...absenceDraft, ends_on: e.target.value })}
            />
            <input
              type="text"
              className="absence-form__notes"
              placeholder="Notes (optional)"
              value={absenceDraft.notes}
              onChange={(e) => setAbsenceDraft({ ...absenceDraft, notes: e.target.value })}
            />
            <button type="button" className="btn" onClick={() => void addAbsence()}>
              Add
            </button>
          </div>
          <p className="muted">
            One day off is just a start date. The solver never places anyone
            inside an absence.
          </p>
          {absenceError && <p className="login__error">{absenceError}</p>}
        </Panel>
      </div>

      <Panel title="Competencies">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Bench</th>
                <th>Level</th>
                <th>Document</th>
                <th>Assessed</th>
                <th>Expires</th>
                <th>Assessor</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((cell) => (
                <tr key={cell.id}>
                  <td>
                    <Link to={`/benches/${cell.bench_id}`}>
                      {benchById.get(cell.bench_id)?.name ?? "Unknown"}
                    </Link>
                  </td>
                  <td>
                    <span aria-hidden="true">{MATRIX_GLYPHS[cell.display_state]}</span>{" "}
                    {MATRIX_LABELS[cell.display_state]}
                  </td>
                  <td className="mono">{cell.document_ref ?? "—"}</td>
                  <td>{formatDate(cell.assessed_on)}</td>
                  <td>{formatDate(cell.expires_on)}</td>
                  <td>{cell.assessor_name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Document sign-off">
        {(staffDocuments.data ?? []).length === 0 ? (
          <p className="muted">No document records.</p>
        ) : (
          <ul className="doclist">
            {(staffDocuments.data ?? [])
              .slice()
              .sort((a, b) =>
                (docById.get(a.document_id)?.doc_number ?? "").localeCompare(
                  docById.get(b.document_id)?.doc_number ?? "",
                ),
              )
              .map((row) => {
                const doc = docById.get(row.document_id);
                return (
                  <li key={row.id}>
                    <span className="mono doclist__num">{doc?.doc_number ?? "?"}</span>
                    <span className="doclist__title">{doc?.title ?? ""}</span>
                    <Tag
                      tone={
                        row.status === "signed_off"
                          ? "ok"
                          : row.status === "in_training"
                            ? "caution"
                            : "neutral"
                      }
                    >
                      {row.status.replace(/_/g, " ")}
                    </Tag>
                  </li>
                );
              })}
          </ul>
        )}
      </Panel>

      <Panel title="Last four weeks">
        {(recent.data ?? []).length === 0 ? (
          <p className="muted">Nothing on the rota yet.</p>
        ) : (
          <ul className="stack">
            {(recent.data ?? []).map((a) => (
              <li key={a.id}>
                <span className="mono">{a.work_date}</span>{" "}
                {benchById.get(a.bench_id)?.name ?? "Unknown bench"}
                {a.is_pinned && <Tag tone="override" glyph="📌">pinned</Tag>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
