"""Command line entry point for the rota solver worker.

    rotasolver --self-check                 solve the committed fixture week
    rotasolver --run-id <uuid>              solve one queued run and write back
    rotasolver --claim                      claim the oldest queued run, if any
    rotasolver --week 2026-09-14            queue and solve a week (local dev)

The Supabase paths need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
environment. --self-check needs neither.
"""

from __future__ import annotations

import argparse
import sys
import traceback
from collections import defaultdict
from datetime import date

from .models import Problem, Solution
from .solve import SOLVER_VERSION, solve


def _print_rota(problem: Problem, solution: Solution) -> None:
    if solution.status == "infeasible":
        report = solution.infeasible_report or {}
        print(f"\n{report.get('summary', 'No valid rota for this week.')}\n")
        for conflict in report.get("conflicts", [])[:5]:
            print(f"  {conflict['detail']}")
            for member in conflict.get("pool", [])[:8]:
                print(f"      - {member['reason']}")
            print()
        print("  Try:")
        for suggestion in report.get("suggestions", []):
            print(f"    * {suggestion['label']}")
        return

    by_day: dict[date, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for a in solution.assignments:
        name = problem.person(a.staff_id).full_name
        by_day[a.work_date][problem.bench(a.bench_id).name].append(name)

    for day in sorted(by_day):
        placed = sum(len(v) for v in by_day[day].values())
        print(f"\n{day:%a %d %b}  ({placed} placed)")
        for bench in sorted(by_day[day]):
            print(f"  {bench:<38} {', '.join(sorted(by_day[day][bench]))}")

    if solution.breaches:
        print("\nSoft breaches:")
        for breach in solution.breaches:
            print(f"  [{breach.weight:>3}] {breach.rule_name}: {breach.detail}")


def _self_check(show: bool) -> int:
    from .fixtures import seeded_problem

    problem = seeded_problem()
    print(f"{SOLVER_VERSION} — self check on the seeded week "
          f"({problem.week_start:%d %b %Y})")
    print(f"  {len(problem.staff)} staff, {len(problem.benches)} benches, "
          f"{len(problem.rules)} rules")

    solution = solve(problem)
    print(f"  status: {solution.status} in {solution.solve_ms}ms, "
          f"{len(solution.assignments)} assignments, "
          f"{len(solution.breaches)} soft breaches")
    if show or solution.status == "infeasible":
        _print_rota(problem, solution)

    return 0 if solution.status in ("solved", "solved_with_breaches") else 1


def _solve_run(run_id: str, week_start: date | None, show: bool) -> int:
    from .loader import load_problem
    from .supabase import Supabase
    from .writeback import mark_error, mark_running, write_solution

    with Supabase() as db:
        if week_start is None:
            rows = db.select("rota_run", "id,week_start,status", id=f"eq.{run_id}")
            if not rows:
                print(f"No run with id {run_id}", file=sys.stderr)
                return 1
            week_start = date.fromisoformat(rows[0]["week_start"])

        print(f"Solving run {run_id} for week starting {week_start}")
        mark_running(db, run_id)
        try:
            problem = load_problem(db, week_start)
            print(f"  loaded {len(problem.staff)} staff, {len(problem.benches)} benches, "
                  f"{len(problem.rules)} active rules, {len(problem.pins)} pins")
            solution = solve(problem)
            write_solution(db, run_id, problem, solution)
        except Exception:
            detail = traceback.format_exc()
            print(detail, file=sys.stderr)
            mark_error(db, run_id, detail)
            return 1

    print(f"  {solution.status} in {solution.solve_ms}ms, "
          f"{len(solution.assignments)} assignments, "
          f"{len(solution.breaches)} soft breaches")
    if show:
        _print_rota(problem, solution)
    return 0 if solution.status != "error" else 1


def _claim(show: bool) -> int:
    from .supabase import Supabase

    with Supabase() as db:
        claimed = db.rpc("claim_next_run")

    rows = claimed if isinstance(claimed, list) else ([claimed] if claimed else [])
    if not rows:
        print("Nothing queued.")
        return 0

    row = rows[0]
    return _solve_run(row["run_id"], date.fromisoformat(row["week_start"]), show)


def _queue_week(week_start: date, show: bool) -> int:
    from .supabase import Supabase

    with Supabase() as db:
        created = db.insert(
            "rota_run",
            [{"week_start": week_start.isoformat(), "status": "running",
              "requested_by_name": "cli"}],
        )
    return _solve_run(created[0]["id"], week_start, show)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rotasolver", description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-check", action="store_true",
                       help="solve the committed fixture week, no database needed")
    group.add_argument("--run-id", help="solve this queued run and write the result back")
    group.add_argument("--claim", action="store_true",
                       help="claim and solve the oldest queued run")
    group.add_argument("--week", help="queue and solve a week, as YYYY-MM-DD")
    parser.add_argument("--print", dest="show", action="store_true",
                        help="print the resulting rota")
    args = parser.parse_args(argv)

    if args.self_check:
        return _self_check(args.show)
    if args.run_id:
        return _solve_run(args.run_id, None, args.show)
    if args.claim:
        return _claim(args.show)
    return _queue_week(date.fromisoformat(args.week), args.show)


if __name__ == "__main__":
    raise SystemExit(main())
