import { useEffect, useState } from "react";
import { RUN_STATUS_LABELS } from "../lib/format";
import type { RotaRun } from "../lib/types";
import { formatDuration } from "../lib/week";

/* Solving on a runner is fast feedback but not instant, so every state gets a
 * treatment rather than a spinner: queued, claimed, finished, or impossible. */
export function SolveStatus({
  run,
  onCancel,
  onOpenBreaches,
}: {
  run: RotaRun | null;
  onCancel?: () => void;
  onOpenBreaches?: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const working = run?.status === "queued" || run?.status === "running";

  useEffect(() => {
    if (!working || !run) {
      setElapsed(0);
      return;
    }
    const started = new Date(run.requested_at).getTime();
    const tick = () => setElapsed(Math.max(0, Date.now() - started));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [working, run]);

  if (!run) {
    return (
      <div className="solve-status solve-status--idle">
        <span>No rota generated for this week yet.</span>
      </div>
    );
  }

  if (working) {
    const seconds = Math.floor(elapsed / 1000);
    return (
      <div className="solve-status solve-status--working" role="status" aria-live="polite">
        <span className="solve-status__pulse" aria-hidden="true" />
        <span>
          {run.status === "queued"
            ? "Queued. Waiting for a solver runner to pick this up."
            : "Solving on a runner."}
        </span>
        <span className="mono solve-status__clock">{seconds}s</span>
        {seconds >= 3 && onCancel && (
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    );
  }

  if (run.status === "solved") {
    return (
      <div className="solve-status solve-status--ok" role="status">
        <span className="solve-status__glyph" aria-hidden="true">✓</span>
        <span>
          Solved in {formatDuration(run.solve_ms)}. All coverage met.
          {run.pins_applied > 0 && ` ${run.pins_applied} pinned.`}
        </span>
      </div>
    );
  }

  if (run.status === "solved_with_breaches") {
    return (
      <div className="solve-status solve-status--caution" role="status">
        <span className="solve-status__glyph" aria-hidden="true">!</span>
        <span>
          Solved in {formatDuration(run.solve_ms)} with {run.soft_breach_count} soft{" "}
          {run.soft_breach_count === 1 ? "breach" : "breaches"}.
        </span>
        {onOpenBreaches && (
          <button type="button" className="btn btn--quiet" onClick={onOpenBreaches}>
            Show them
          </button>
        )}
      </div>
    );
  }

  if (run.status === "error") {
    return (
      <div className="solve-status solve-status--alert" role="alert">
        <span className="solve-status__glyph" aria-hidden="true">✕</span>
        <span>{run.status_detail ?? "The solver did not finish."}</span>
      </div>
    );
  }

  if (run.status === "cancelled") {
    return (
      <div className="solve-status solve-status--idle">
        <span>{run.status_detail ?? "Cancelled."}</span>
      </div>
    );
  }

  return (
    <div className="solve-status solve-status--alert" role="alert">
      <span className="solve-status__glyph" aria-hidden="true">✕</span>
      <span>{RUN_STATUS_LABELS[run.status]}</span>
    </div>
  );
}
