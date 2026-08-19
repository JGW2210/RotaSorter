import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorNote, Loading, Panel, Tag } from "../components/Bits";
import { ABSENCE_LABELS, GRADE_LABELS, MATRIX_GLYPHS, MATRIX_LABELS } from "../lib/format";
import {
  useAbsences,
  useAvailability,
  useBenches,
  useCompetencyDocuments,
  useCompetencyMatrix,
  useRecentAssignments,
  useStaff,
  useStaffDocuments,
} from "../lib/queries";
import { WEEKDAY_SHORT, formatDate } from "../lib/week";

export default function StaffDetail() {
  const { staffId } = useParams();
  const staff = useStaff();
  const benches = useBenches();
  const matrix = useCompetencyMatrix();
  const availability = useAvailability();
  const absences = useAbsences();
  const documents = useCompetencyDocuments();
  const staffDocuments = useStaffDocuments(staffId);
  const recent = useRecentAssignments(staffId);

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
  const worked = new Set(
    (availability.data ?? [])
      .filter((a) => a.staff_id === person.id && a.is_available)
      .map((a) => a.weekday),
  );
  const away = (absences.data ?? []).filter((a) => a.staff_id === person.id);

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
          <div className="pattern pattern--large">
            {WEEKDAY_SHORT.map((label, index) => (
              <span
                key={label}
                className={worked.has(index + 1) ? "pattern__on" : "pattern__off"}
              >
                {label}
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Absences">
          {away.length === 0 ? (
            <p className="muted">Nothing booked.</p>
          ) : (
            <ul className="stack">
              {away.map((a) => (
                <li key={a.id}>
                  <Tag tone={a.kind === "sick" ? "alert" : "neutral"}>
                    {ABSENCE_LABELS[a.kind] ?? a.kind}
                  </Tag>{" "}
                  {formatDate(a.starts_on)}
                  {a.ends_on !== a.starts_on && ` – ${formatDate(a.ends_on)}`}
                  {a.notes && <span className="muted"> · {a.notes}</span>}
                </li>
              ))}
            </ul>
          )}
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
