import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorNote, Loading, Panel, Tag } from "../components/Bits";
import { InfeasiblePanel } from "../components/InfeasiblePanel";
import { RUN_STATUS_LABELS } from "../lib/format";
import { useAllRuns, useAssignments, useBenches, useBreaches, useStaff } from "../lib/queries";
import { statusTone } from "./Runs";
import { dayShort, formatDate, formatDateTime, formatDuration } from "../lib/week";

interface SnapshotRule {
  id: string;
  name: string;
  is_hard: boolean;
  weight: number;
  plain_english?: string | null;
}

export default function RunDetail() {
  const { runId } = useParams();
  const runs = useAllRuns(200);
  const assignments = useAssignments(runId);
  const breaches = useBreaches(runId);
  const staff = useStaff();
  const benches = useBenches();

  const run = runs.data?.find((r) => r.id === runId);
  const staffById = useMemo(
    () => new Map((staff.data ?? []).map((s) => [s.id, s])),
    [staff.data],
  );
  const benchById = useMemo(
    () => new Map((benches.data ?? []).map((b) => [b.id, b])),
    [benches.data],
  );

  if (runs.error) return <ErrorNote error={runs.error} />;
  if (runs.isLoading) return <Loading what="this run" />;
  if (!run) return <ErrorNote error={new Error("No such run.")} />;

  const snapshot = (run.rule_snapshot as SnapshotRule[] | null) ?? [];

  return (
    <div className="detail">
      <div className="detail__head">
        <div>
          <h2>Run of {formatDateTime(run.requested_at)}</h2>
          <p className="detail__sub">
            Week of {formatDate(run.week_start)} · requested by{" "}
            {run.requested_by_name ?? "unknown"} ·{" "}
            <Tag tone={statusTone(run.status)}>{RUN_STATUS_LABELS[run.status]}</Tag>
          </p>
        </div>
        <Link to="/runs" className="btn">
          Back to runs
        </Link>
      </div>

      <Panel title="Outcome">
        <dl className="stats">
          <div>
            <dt>Solve time</dt>
            <dd className="mono">{formatDuration(run.solve_ms)}</dd>
          </div>
          <div>
            <dt>Assignments</dt>
            <dd className="mono">{assignments.data?.length ?? 0}</dd>
          </div>
          <div>
            <dt>Pins applied</dt>
            <dd className="mono">{run.pins_applied}</dd>
          </div>
          <div>
            <dt>Soft breaches</dt>
            <dd className="mono">{run.soft_breach_count}</dd>
          </div>
          <div>
            <dt>Objective</dt>
            <dd className="mono">{run.objective_value ?? "—"}</dd>
          </div>
          <div>
            <dt>Solver</dt>
            <dd className="mono">{run.solver_version ?? "—"}</dd>
          </div>
        </dl>
        {run.status_detail && <p>{run.status_detail}</p>}
        {run.worker_ref && (
          <p>
            <a href={run.worker_ref} target="_blank" rel="noreferrer">
              View the GitHub Actions run
            </a>
          </p>
        )}
      </Panel>

      {run.status === "infeasible" && run.infeasible_report && (
        <InfeasiblePanel report={run.infeasible_report} />
      )}

      {(breaches.data ?? []).length > 0 && (
        <Panel title="Soft breaches">
          <ul className="stack">
            {(breaches.data ?? []).map((breach) => (
              <li key={breach.id}>
                <Tag tone="caution">{breach.weight ?? "—"}</Tag>{" "}
                <strong>{breach.rule_name}</strong> — {breach.detail}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title={`Rule set at the time (${snapshot.length})`}>
        {snapshot.length === 0 ? (
          <p className="muted">No snapshot recorded.</p>
        ) : (
          <ul className="stack">
            {snapshot.map((rule) => (
              <li key={rule.id}>
                {rule.is_hard ? <Tag tone="accent">Hard</Tag> : <Tag tone="caution">Soft {rule.weight}</Tag>}{" "}
                {rule.plain_english ?? rule.name}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Assignments">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Day</th>
                <th>Bench</th>
                <th>Staff</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {(assignments.data ?? [])
                .slice()
                .sort(
                  (a, b) =>
                    a.work_date.localeCompare(b.work_date) ||
                    (benchById.get(a.bench_id)?.name ?? "").localeCompare(
                      benchById.get(b.bench_id)?.name ?? "",
                    ),
                )
                .map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.work_date}</td>
                    <td>{dayShort(a.work_date)}</td>
                    <td>{benchById.get(a.bench_id)?.name ?? "—"}</td>
                    <td>{staffById.get(a.staff_id)?.full_name ?? "—"}</td>
                    <td>
                      {a.is_pinned ? (
                        <Tag tone="override" glyph="📌">
                          pinned
                        </Tag>
                      ) : (
                        a.source
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
