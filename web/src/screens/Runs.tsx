import { Link } from "react-router-dom";
import { Empty, ErrorNote, Loading, Tag } from "../components/Bits";
import { RUN_STATUS_LABELS } from "../lib/format";
import { useAllRuns } from "../lib/queries";
import type { RunStatus } from "../lib/types";
import { formatDate, formatDateTime, formatDuration } from "../lib/week";

export function statusTone(status: RunStatus) {
  if (status === "solved") return "ok" as const;
  if (status === "solved_with_breaches") return "caution" as const;
  if (status === "infeasible" || status === "error") return "alert" as const;
  if (status === "queued" || status === "running") return "accent" as const;
  return "neutral" as const;
}

export default function Runs() {
  const runs = useAllRuns();

  if (runs.error) return <ErrorNote error={runs.error} />;
  if (runs.isLoading) return <Loading what="run history" />;
  if ((runs.data ?? []).length === 0) {
    return (
      <Empty title="No runs yet">
        Every generation is recorded here, with the rule set as it stood at the time.
        That is what lets someone ask why they were put on Enteric three days running.
      </Empty>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Week</th>
            <th>Who</th>
            <th>Outcome</th>
            <th>Duration</th>
            <th>Pins</th>
            <th>Soft breaches</th>
          </tr>
        </thead>
        <tbody>
          {(runs.data ?? []).map((run) => (
            <tr key={run.id}>
              <td>
                <Link to={`/runs/${run.id}`}>{formatDateTime(run.requested_at)}</Link>
              </td>
              <td>{formatDate(run.week_start)}</td>
              <td>{run.requested_by_name ?? "—"}</td>
              <td>
                <Tag tone={statusTone(run.status)}>{RUN_STATUS_LABELS[run.status]}</Tag>
              </td>
              <td className="mono">{formatDuration(run.solve_ms)}</td>
              <td className="mono">{run.pins_applied}</td>
              <td className="mono">{run.soft_breach_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
