"""Command line entry point for the reference solver.

    rotasolver --self-check                 solve the committed fixture week
    rotasolver --week 2026-09-14            read a real week and solve it

The app solves its own rotas in the browser; this is the reference
implementation the TypeScript port is checked against, and a way to ask a
second, independent solver what it makes of real data when a week surprises
you. It never writes anything back.

--week needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
--self-check needs neither.
"""

from __future__ import annotations

import argparse
import sys
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


def _self_check(show: bool, deterministic: bool = False) -> int:
    from .fixtures import seeded_problem

    problem = seeded_problem()
    if deterministic:
        problem.settings["cp_sat_workers"] = 1
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


def _check_week(week_start: date, show: bool, deterministic: bool = False) -> int:
    """Load a real week and report what the reference solver makes of it."""
    from .loader import load_problem
    from .supabase import Supabase

    with Supabase() as db:
        problem = load_problem(db, week_start)

    if deterministic:
        problem.settings["cp_sat_workers"] = 1

    print(f"{SOLVER_VERSION} — week beginning {week_start:%d %b %Y}")
    print(f"  {len(problem.staff)} staff, {len(problem.benches)} benches, "
          f"{len(problem.rules)} active rules, {len(problem.pins)} pins")

    solution = solve(problem)
    print(f"  status: {solution.status} in {solution.solve_ms}ms, "
          f"objective {solution.objective_value}, "
          f"{len(solution.assignments)} assignments, "
          f"{len(solution.breaches)} soft breaches")
    if show or solution.status == "infeasible":
        _print_rota(problem, solution)
    print("\nNothing was written. This is a read-only second opinion.")
    return 0 if solution.status != "error" else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rotasolver", description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-check", action="store_true",
                       help="solve the committed fixture week, no database needed")
    group.add_argument("--week",
                       help="read a real week (YYYY-MM-DD) and solve it, read-only")
    parser.add_argument("--print", dest="show", action="store_true",
                        help="print the resulting rota")
    parser.add_argument("--deterministic", action="store_true",
                        help="solve on one worker, so the same input gives the "
                             "same rota every time. Around 16x slower.")
    args = parser.parse_args(argv)

    if args.self_check:
        return _self_check(args.show, args.deterministic)
    return _check_week(date.fromisoformat(args.week), args.show, args.deterministic)


if __name__ == "__main__":
    raise SystemExit(main())
