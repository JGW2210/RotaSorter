"""The seeded week must solve, and the hard constraints must actually hold.

These run against the same data the SQL seed emits, so a change to the roster
or the bench list that makes the demo week impossible fails here rather than in
the Supabase SQL editor.
"""

from collections import defaultdict

import pytest

from rotasolver.fixtures import seeded_problem
from rotasolver.solve import merged_requirements, solve


@pytest.fixture(scope="module")
def solved():
    problem = seeded_problem()
    return problem, solve(problem)


def test_week_solves_without_breaching_a_soft_rule(solved):
    problem, solution = solved
    assert solution.status == "solved", solution.infeasible_report
    assert solution.breaches == []
    assert solution.assignments


def test_nobody_is_on_two_benches_in_a_day(solved):
    _problem, solution = solved
    seen = defaultdict(set)
    for a in solution.assignments:
        seen[(a.staff_id, a.work_date)].add(a.bench_id)
    doubled = {k: v for k, v in seen.items() if len(v) > 1}
    assert not doubled, f"double booked: {doubled}"


def test_coverage_minimums_and_maximums_are_met(solved):
    problem, solution = solved
    placed = defaultdict(int)
    for a in solution.assignments:
        placed[(a.work_date, a.bench_id, a.shift_id)] += 1

    for day in problem.dates:
        for req in merged_requirements(problem, day):
            got = placed[(day, req.bench_id, req.shift_id)]
            bench = problem.bench(req.bench_id).name
            assert got >= req.min_staff, f"{bench} on {day} has {got}, needs {req.min_staff}"
            if req.max_staff is not None:
                assert got <= req.max_staff, f"{bench} on {day} has {got}, max {req.max_staff}"


def test_nobody_is_placed_on_a_bench_they_are_not_cleared_for(solved):
    problem, solution = solved
    for a in solution.assignments:
        req = next(
            r for r in merged_requirements(problem, a.work_date)
            if r.bench_id == a.bench_id and r.shift_id == a.shift_id
        )
        ok, reason = problem.eligibility(a.staff_id, req, a.work_date)
        assert ok, reason


def test_nobody_is_placed_while_absent_or_off_contract(solved):
    problem, solution = solved
    for a in solution.assignments:
        person = problem.person(a.staff_id)
        assert not problem.is_absent(a.staff_id, a.work_date), (
            f"{person.full_name} is placed on {a.work_date} while absent"
        )
        assert problem.is_contracted(a.staff_id, a.work_date, a.shift_id), (
            f"{person.full_name} is placed on a day they do not work"
        )


def test_every_trainee_on_a_bench_has_a_signed_off_colleague(solved):
    problem, solution = solved
    grouped = defaultdict(list)
    for a in solution.assignments:
        grouped[(a.work_date, a.bench_id)].append(a.staff_id)

    for (day, bench_id), staff_ids in grouped.items():
        trainees = [s for s in staff_ids if not problem.is_signed_off(s, bench_id, day)]
        if not trainees:
            continue
        supervisors = [s for s in staff_ids if problem.is_signed_off(s, bench_id, day)]
        names = [problem.person(s).full_name for s in trainees]
        assert supervisors, (
            f"{names} unsupervised on {problem.bench(bench_id).name} on {day}"
        )


def test_trainees_are_placed_rather_than_left_off(solved):
    """The whole point of the trainee rule: they go on the bench regardless."""
    problem, solution = solved
    worked = defaultdict(set)
    for a in solution.assignments:
        worked[a.staff_id].add(a.work_date)

    for person in problem.staff:
        if person.grade != "trainee":
            continue
        available = [
            d for d in problem.dates
            if problem.is_contracted(person.id, d, "DAY")
            and not problem.is_absent(person.id, d)
        ]
        assert len(worked[person.id]) == len(available), (
            f"{person.full_name} worked {len(worked[person.id])} of "
            f"{len(available)} available days"
        )


def test_no_available_member_of_staff_is_left_idle(solved):
    problem, solution = solved
    worked = defaultdict(set)
    for a in solution.assignments:
        worked[a.staff_id].add(a.work_date)

    idle = []
    for person in problem.staff:
        available = {
            d for d in problem.dates
            if problem.is_contracted(person.id, d, "DAY")
            and not problem.is_absent(person.id, d)
        }
        missed = available - worked[person.id]
        if missed:
            idle.append((person.full_name, sorted(missed)))
    assert not idle, f"idle staff days: {idle}"
