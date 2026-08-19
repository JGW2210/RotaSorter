import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ErrorNote, Loading, Panel, Toolbar } from "../components/Bits";
import { GRADE_LABELS, GRADE_ORDER, MATRIX_GLYPHS, MATRIX_LABELS } from "../lib/format";
import {
  useBenches,
  useClearCompetency,
  useCompetencyMatrix,
  useSetCompetency,
  useStaff,
} from "../lib/queries";
import type { CompetencyLevel, MatrixCell, MatrixDisplayState } from "../lib/types";
import { formatDate } from "../lib/week";

const STATES: MatrixDisplayState[] = [
  "trainer",
  "competent",
  "trainee",
  "expiring_soon",
  "expired",
];

interface CellRef {
  staffIndex: number;
  benchIndex: number;
}

export default function Matrix() {
  const [params] = useSearchParams();
  const focusBench = params.get("bench");

  const staff = useStaff();
  const benches = useBenches();
  const matrix = useCompetencyMatrix();
  const setCompetency = useSetCompetency();
  const clearCompetency = useClearCompetency();

  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [range, setRange] = useState<CellRef[] | null>(null);
  const [editing, setEditing] = useState<{ staffId: string; benchId: string } | null>(null);

  const people = useMemo(
    () =>
      (staff.data ?? [])
        .filter((s) => s.status === "active")
        .sort(
          (a, b) =>
            GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) ||
            a.full_name.localeCompare(b.full_name),
        ),
    [staff.data],
  );
  const benchList = useMemo(
    () => (benches.data ?? []).filter((b) => b.is_active),
    [benches.data],
  );

  const cellIndex = useMemo(() => {
    const out = new Map<string, MatrixCell>();
    for (const cell of matrix.data ?? []) out.set(`${cell.staff_id}|${cell.bench_id}`, cell);
    return out;
  }, [matrix.data]);

  const competentPerBench = useMemo(() => {
    const out = new Map<string, number>();
    for (const cell of matrix.data ?? []) {
      if (cell.display_state === "expired") continue;
      if (cell.level === "trainee") continue;
      out.set(cell.bench_id, (out.get(cell.bench_id) ?? 0) + 1);
    }
    return out;
  }, [matrix.data]);

  if (staff.error || benches.error) return <ErrorNote error={staff.error ?? benches.error} />;
  if (staff.isLoading || benches.isLoading) return <Loading what="the matrix" />;

  const selectedKeys = new Set(
    (range ?? []).map((r) => `${people[r.staffIndex]?.id}|${benchList[r.benchIndex]?.id}`),
  );

  function onCellClick(staffIndex: number, benchIndex: number, shiftKey: boolean) {
    if (shiftKey && anchor) {
      const rows = [anchor.staffIndex, staffIndex].sort((a, b) => a - b);
      const cols = [anchor.benchIndex, benchIndex].sort((a, b) => a - b);
      const cells: CellRef[] = [];
      for (let r = rows[0]; r <= rows[1]; r++) {
        for (let c = cols[0]; c <= cols[1]; c++) cells.push({ staffIndex: r, benchIndex: c });
      }
      setRange(cells);
      setEditing(null);
      return;
    }
    setAnchor({ staffIndex, benchIndex });
    setRange([{ staffIndex, benchIndex }]);
    setEditing({ staffId: people[staffIndex].id, benchId: benchList[benchIndex].id });
  }

  async function bulkSet(level: CompetencyLevel | null) {
    const targets = range ?? [];
    for (const ref of targets) {
      const staffId = people[ref.staffIndex]?.id;
      const benchId = benchList[ref.benchIndex]?.id;
      if (!staffId || !benchId) continue;
      if (level === null) {
        await clearCompetency.mutateAsync({ staffId, benchId });
      } else {
        await setCompetency.mutateAsync({
          staff_id: staffId,
          bench_id: benchId,
          level,
          assessed_on: new Date().toISOString().slice(0, 10),
        });
      }
    }
    setEditing(null);
  }

  const editingCell = editing
    ? cellIndex.get(`${editing.staffId}|${editing.benchId}`)
    : undefined;

  return (
    <>
      <Toolbar>
        <span className="toolbar__count">
          {people.length} staff × {benchList.length} benches
        </span>
        <span className="legend">
          {STATES.map((state) => (
            <span key={state} className={`legend__item legend__item--${state}`}>
              <span aria-hidden="true">{MATRIX_GLYPHS[state]}</span> {MATRIX_LABELS[state]}
            </span>
          ))}
        </span>
        {range && range.length > 1 && (
          <span className="toolbar__count">{range.length} cells selected</span>
        )}
      </Toolbar>

      {range && range.length > 0 && (
        <div className="notice notice--info">
          <span>
            {range.length === 1
              ? "Set this cell:"
              : `Set all ${range.length} selected cells:`}
          </span>
          <button type="button" className="btn" onClick={() => void bulkSet("trainee")}>
            {MATRIX_GLYPHS.trainee} Trainee
          </button>
          <button type="button" className="btn" onClick={() => void bulkSet("competent")}>
            {MATRIX_GLYPHS.competent} Competent
          </button>
          <button type="button" className="btn" onClick={() => void bulkSet("trainer")}>
            {MATRIX_GLYPHS.trainer} Trainer
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => void bulkSet(null)}>
            Clear
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              setRange(null);
              setEditing(null);
            }}
          >
            Done
          </button>
        </div>
      )}

      <div className="grid-wrap">
        <table className="matrix">
          <caption className="visually-hidden">
            Staff down the rows, benches across the columns. Click a cell to set it,
            shift-click to select a range.
          </caption>
          <thead>
            <tr>
              <th className="matrix__corner">Staff</th>
              {benchList.map((bench) => (
                <th
                  key={bench.id}
                  scope="col"
                  className={`matrix__benchhead${focusBench === bench.id ? " is-focus" : ""}`}
                >
                  <span className="matrix__benchname">{bench.name}</span>
                  <span className="matrix__benchcount mono">
                    {competentPerBench.get(bench.id) ?? 0}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((person, staffIndex) => (
              <tr key={person.id}>
                <th scope="row" className="matrix__rowhead">
                  <span>{person.full_name}</span>
                  <span className="matrix__grade">{GRADE_LABELS[person.grade]}</span>
                </th>
                {benchList.map((bench, benchIndex) => {
                  const cell = cellIndex.get(`${person.id}|${bench.id}`);
                  const key = `${person.id}|${bench.id}`;
                  const state = cell?.display_state;
                  return (
                    <td
                      key={bench.id}
                      className={[
                        "matrix__cell",
                        state && `is-${state}`,
                        selectedKeys.has(key) && "is-selected",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <button
                        type="button"
                        onClick={(e) => onCellClick(staffIndex, benchIndex, e.shiftKey)}
                        title={
                          cell
                            ? `${MATRIX_LABELS[cell.display_state]}` +
                              (cell.document_ref ? ` · document ${cell.document_ref}` : "") +
                              (cell.assessed_on ? ` · assessed ${formatDate(cell.assessed_on)}` : "") +
                              (cell.expires_on ? ` · expires ${formatDate(cell.expires_on)}` : "")
                            : `${person.full_name} is not competent on ${bench.name}`
                        }
                      >
                        <span aria-hidden="true">{state ? MATRIX_GLYPHS[state] : ""}</span>
                        <span className="visually-hidden">
                          {person.full_name}, {bench.name}:{" "}
                          {state ? MATRIX_LABELS[state] : "not competent"}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && range?.length === 1 && (
        <Panel title="Cell detail">
          <p>
            <strong>
              {people.find((p) => p.id === editing.staffId)?.full_name}
            </strong>{" "}
            on <strong>{benchList.find((b) => b.id === editing.benchId)?.name}</strong>
          </p>
          {editingCell ? (
            <ul className="stack">
              <li>Level: {MATRIX_LABELS[editingCell.display_state]}</li>
              <li className="mono">Document: {editingCell.document_ref ?? "—"}</li>
              <li>Assessed: {formatDate(editingCell.assessed_on)}</li>
              <li>
                Expires:{" "}
                <input
                  type="date"
                  value={editingCell.expires_on ?? ""}
                  onChange={(e) =>
                    setCompetency.mutate({
                      staff_id: editing.staffId,
                      bench_id: editing.benchId,
                      level: editingCell.level,
                      expires_on: e.target.value || null,
                    })
                  }
                />
              </li>
              <li>Assessor: {editingCell.assessor_name ?? "—"}</li>
            </ul>
          ) : (
            <p className="muted">No record yet. Use the buttons above to set one.</p>
          )}
        </Panel>
      )}
    </>
  );
}
