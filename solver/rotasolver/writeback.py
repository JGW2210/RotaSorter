"""Write a solved week back to Supabase."""

from __future__ import annotations

import os
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from .models import Problem, Solution
from .solve import SOLVER_VERSION
from .supabase import Supabase


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _worker_ref() -> str | None:
    """The GitHub Actions run this came from, so Runs history can link to it."""
    server = os.environ.get("GITHUB_SERVER_URL")
    repo = os.environ.get("GITHUB_REPOSITORY")
    run_id = os.environ.get("GITHUB_RUN_ID")
    if server and repo and run_id:
        return f"{server}/{repo}/actions/runs/{run_id}"
    return None


def mark_running(db: Supabase, run_id: str) -> None:
    db.update("rota_run", {"status": "running", "started_at": _now()}, id=f"eq.{run_id}")


def mark_error(db: Supabase, run_id: str, message: str) -> None:
    db.update(
        "rota_run",
        {
            "status": "error",
            "finished_at": _now(),
            "status_detail": message[:500],
            "log": message[:20000],
            "worker_ref": _worker_ref(),
        },
        id=f"eq.{run_id}",
    )


def rule_snapshot(problem: Problem) -> list[dict[str, Any]]:
    """The rule set as it stood, so Runs history can answer "why then"."""
    return [
        {
            "id": rule.id,
            "name": rule.name,
            "action": rule.action,
            "params": rule.params,
            "conditions": rule.conditions,
            "is_hard": rule.is_hard,
            "weight": rule.weight,
            "plain_english": rule.plain_english,
        }
        for rule in problem.rules
    ]


def write_solution(
    db: Supabase, run_id: str, problem: Problem, solution: Solution
) -> None:
    if solution.assignments:
        db.insert(
            "assignment",
            [
                {
                    "run_id": run_id,
                    "week_start": problem.week_start.isoformat(),
                    "work_date": a.work_date.isoformat(),
                    "shift_id": a.shift_id,
                    "bench_id": a.bench_id,
                    "staff_id": a.staff_id,
                    "source": "manual" if a.is_pinned else "solver",
                    "is_pinned": a.is_pinned,
                }
                for a in solution.assignments
            ],
        )

    if solution.breaches:
        db.insert(
            "rule_breach",
            [
                {
                    "run_id": run_id,
                    "rule_id": b.rule_id,
                    "rule_name": b.rule_name,
                    "weight": b.weight,
                    "work_date": b.work_date.isoformat() if b.work_date else None,
                    "shift_id": b.shift_id,
                    "bench_id": b.bench_id,
                    "staff_id": b.staff_id,
                    "detail": b.detail,
                }
                for b in solution.breaches
            ],
        )

    db.update(
        "rota_run",
        {
            "status": solution.status,
            "finished_at": _now(),
            "solve_ms": solution.solve_ms,
            "pins_applied": len(problem.pins),
            "soft_breach_count": len(solution.breaches),
            "objective_value": solution.objective_value,
            "infeasible_report": solution.infeasible_report,
            "rule_snapshot": rule_snapshot(problem),
            "solver_version": SOLVER_VERSION,
            "worker_ref": _worker_ref(),
            "log": solution.log[:20000] if solution.log else None,
            "status_detail": _status_detail(solution),
        },
        id=f"eq.{run_id}",
    )


def _status_detail(solution: Solution) -> str:
    seconds = solution.solve_ms / 1000
    if solution.status == "solved":
        return f"Solved in {seconds:.1f}s. All coverage met."
    if solution.status == "solved_with_breaches":
        n = len(solution.breaches)
        return (f"Solved in {seconds:.1f}s with {n} soft "
                f"{'breach' if n == 1 else 'breaches'}.")
    if solution.status == "infeasible":
        report = solution.infeasible_report or {}
        conflicts = report.get("conflicts") or []
        if conflicts:
            return conflicts[0].get("detail", "No valid rota for this week.")
        return "No valid rota for this week."
    return solution.log[:200] if solution.log else "Solver did not finish."
