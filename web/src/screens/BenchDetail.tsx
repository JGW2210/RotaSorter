import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorNote, Field, Loading, Panel, Tag } from "../components/Bits";
import { LEVEL_LABELS, MATRIX_GLYPHS, MATRIX_LABELS } from "../lib/format";
import {
  useBenchRequirements,
  useBenches,
  useCompetencyDocuments,
  useCompetencyMatrix,
  useStaff,
  useUpsert,
} from "../lib/queries";
import type { Bench } from "../lib/types";
import { WEEKDAY_SHORT, formatDate } from "../lib/week";

export default function BenchDetail() {
  const { benchId } = useParams();
  const benches = useBenches();
  const staff = useStaff();
  const matrix = useCompetencyMatrix();
  const documents = useCompetencyDocuments();
  const requirements = useBenchRequirements();
  const save = useUpsert<Bench>("bench", ["bench", "v_bench_pool"]);

  const bench = benches.data?.find((b) => b.id === benchId);
  const [minStaff, setMinStaff] = useState<number | null>(null);
  const [maxStaff, setMaxStaff] = useState<number | null>(null);

  const staffById = useMemo(
    () => new Map((staff.data ?? []).map((s) => [s.id, s])),
    [staff.data],
  );

  if (benches.error) return <ErrorNote error={benches.error} />;
  if (benches.isLoading) return <Loading what="this bench" />;
  if (!bench) return <ErrorNote error={new Error("No such bench.")} />;

  const cells = (matrix.data ?? []).filter((c) => c.bench_id === bench.id);
  const docs = (documents.data ?? []).filter((d) => d.bench_id === bench.id);
  const reqs = (requirements.data ?? []).filter((r) => r.bench_id === bench.id);
  const min = minStaff ?? bench.min_staff;
  const max = maxStaff ?? bench.max_staff;
  const dirty = min !== bench.min_staff || max !== bench.max_staff;

  return (
    <div className="detail">
      <div className="detail__head">
        <div>
          <h2>{bench.name}</h2>
          <p className="detail__sub">
            {bench.bench_group?.name ?? "No group"} · needs{" "}
            {LEVEL_LABELS[bench.required_level]}
          </p>
        </div>
        <Link to="/benches" className="btn">
          Back to benches
        </Link>
      </div>

      <Panel
        title="Staffing"
        actions={
          <button
            type="button"
            className="btn btn--primary"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate({ id: bench.id, min_staff: min, max_staff: max } as Partial<Bench>)
            }
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        }
      >
        <div className="detail__cols">
          <Field label="Minimum staff" hint="Under this is the only thing that shows the alert colour.">
            <input
              type="number"
              min={0}
              value={min}
              onChange={(e) => setMinStaff(Number(e.target.value))}
            />
          </Field>
          <Field label="Maximum staff" hint="Leave empty for no ceiling.">
            <input
              type="number"
              min={min}
              value={max ?? ""}
              onChange={(e) => setMaxStaff(e.target.value === "" ? null : Number(e.target.value))}
            />
          </Field>
        </div>
        {save.error && <p className="login__error">{(save.error as Error).message}</p>}

        <h3 className="panel__subhead">Days this bench runs</h3>
        <ul className="stack">
          {reqs.map((req) => (
            <li key={`${req.shift_id}-${req.label}`}>
              <Tag tone="neutral">{req.label}</Tag>{" "}
              {(req.weekdays ?? []).map((d) => WEEKDAY_SHORT[d - 1]).join(", ")} · min{" "}
              {req.min_staff}
              {req.max_staff != null && `, max ${req.max_staff}`}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Competency documents">
        <ul className="doclist">
          {docs.map((doc) => (
            <li key={doc.id}>
              <span className="mono doclist__num">{doc.doc_number}</span>
              <span className="doclist__title">{doc.title}</span>
              {doc.is_primary && <Tag tone="accent">primary</Tag>}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={`Who is competent (${cells.length})`}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Staff code</th>
                <th>Level</th>
                <th>Assessed</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((cell) => {
                const person = staffById.get(cell.staff_id);
                return (
                  <tr key={cell.id}>
                    <td>
                      <Link to={`/staff/${cell.staff_id}`}>
                        {person?.full_name ?? "Unknown"}
                      </Link>
                    </td>
                    <td className="mono">{person?.staff_code ?? "—"}</td>
                    <td>
                      <span aria-hidden="true">{MATRIX_GLYPHS[cell.display_state]}</span>{" "}
                      {MATRIX_LABELS[cell.display_state]}
                    </td>
                    <td>{formatDate(cell.assessed_on)}</td>
                    <td>{formatDate(cell.expires_on)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
