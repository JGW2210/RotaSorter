"""Explaining an impossible week.

"No solution found" is useless to the person holding the rota. This module
re-solves with one class of constraint relaxed at a time until something gives,
then reports what gave and who was missing, in the order a human would check:

    1. coverage   — a bench nobody could staff
    2. rules      — a hard rule that cannot hold alongside the rest
    3. pins       — the manual overrides themselves conflict

Each conflict comes with suggested resolutions that carry enough identifiers for
the UI to turn them into working links.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from ortools.sat.python import cp_model

from .models import Problem, WEEKDAY_NAMES
from .solve import RotaModel, merged_requirements


def diagnose(problem: Problem) -> dict[str, Any]:
    week = f"{problem.week_start:%d %b %Y}"

    coverage = _coverage_conflicts(problem)
    if coverage["conflicts"]:
        return coverage

    rules = _rule_conflicts(problem)
    if rules["conflicts"]:
        return rules

    pins = _pin_conflicts(problem)
    if pins["conflicts"]:
        return pins

    return {
        "summary": f"No valid rota for the week of {week}.",
        "conflicts": [],
        "suggestions": [
            {
                "label": "Review this week's rules",
                "action": "rules",
            },
            {
                "label": "Review absences for this week",
                "action": "absences",
                "date": problem.week_start.isoformat(),
            },
        ],
        "note": (
            "The constraints conflict in a way that relaxing coverage, rules and "
            "pins individually did not isolate. Try pausing rules one at a time."
        ),
    }


def _solve_relaxed(problem: Problem, **flags: bool) -> tuple[RotaModel, cp_model.CpSolver, int]:
    model = RotaModel(problem, **flags)
    solver, status = model.solve()
    return model, solver, status


def _coverage_conflicts(problem: Problem) -> dict[str, Any]:
    """Which bench-days could not be staffed, and who was missing."""
    model, solver, status = _solve_relaxed(problem, relax_coverage=True)
    week = f"{problem.week_start:%d %b %Y}"
    result: dict[str, Any] = {
        "summary": f"No valid rota for the week of {week}.",
        "conflicts": [],
        "suggestions": [],
    }
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return result

    placed: dict[tuple[str, date], str] = {}
    for slot, var in model.x.items():
        if solver.Value(var):
            placed[(slot.staff_id, slot.work_date)] = slot.bench_id

    for (day, bench_id, shift_id), short_var in model.shortfall.items():
        short_by = solver.Value(short_var)
        if short_by <= 0:
            continue

        bench = problem.bench(bench_id)
        shift = problem.shift(shift_id)
        req = next(
            r for r in merged_requirements(problem, day)
            if r.bench_id == bench_id and r.shift_id == shift_id
        )
        day_name = WEEKDAY_NAMES[day.isoweekday()]

        pool = []
        for person in problem.staff:
            comp = problem.competency(person.id, bench_id)
            if comp is None:
                continue
            ok, reason = problem.eligibility(person.id, req, day)
            if ok:
                elsewhere = placed.get((person.id, day))
                if elsewhere and elsewhere != bench_id:
                    reason = f"{person.full_name} is on {problem.bench(elsewhere).name}"
                elif elsewhere == bench_id:
                    continue
                else:
                    reason = f"{person.full_name} is free but a rule blocks this bench"
            pool.append({
                "staff_id": person.id,
                "staff_code": person.code,
                "name": person.full_name,
                "level": comp.level,
                "reason": reason,
            })

        available = req.min_staff - short_by
        result["conflicts"].append({
            "kind": "coverage",
            "bench_id": bench_id,
            "bench_name": bench.name,
            "shift_id": shift_id,
            "shift_name": shift.name,
            "work_date": day.isoformat(),
            "day_name": day_name,
            "required": req.min_staff,
            "achieved": available,
            "short_by": short_by,
            "detail": (
                f"{bench.name} needs {req.min_staff} "
                f"{'person' if req.min_staff == 1 else 'people'} on {day_name} "
                f"{shift.name.lower()}. "
                + (f"Only {available} could be placed."
                   if available else "Nobody could be placed.")
            ),
            "pool": pool,
        })

    result["conflicts"].sort(key=lambda c: (-c["short_by"], c["work_date"]))

    if result["conflicts"]:
        first = result["conflicts"][0]
        result["suggestions"] = [
            {
                "label": (f"Relax the minimum on {first['bench_name']} to "
                          f"{max(first['required'] - first['short_by'], 0)}"),
                "action": "edit_bench",
                "bench_id": first["bench_id"],
            },
            {
                "label": f"Check {first['day_name']} absences",
                "action": "absences",
                "date": first["work_date"],
            },
            {
                "label": f"Sign off more staff on {first['bench_name']}",
                "action": "matrix",
                "bench_id": first["bench_id"],
            },
        ]
    return result


def _rule_conflicts(problem: Problem) -> dict[str, Any]:
    """No coverage gap, so a hard rule is the thing that cannot hold."""
    model, solver, status = _solve_relaxed(
        problem, relax_coverage=True, soften_rules=True
    )
    week = f"{problem.week_start:%d %b %Y}"
    result: dict[str, Any] = {
        "summary": f"No valid rota for the week of {week}.",
        "conflicts": [],
        "suggestions": [],
    }
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return result

    placed: dict[tuple[str, date], str] = {}
    for slot, var in model.x.items():
        if solver.Value(var):
            placed[(slot.staff_id, slot.work_date)] = slot.bench_id

    seen: set[str] = set()
    for term in model.soft:
        if term.rule is None or solver.Value(term.expr) <= 0:
            continue
        if not term.rule.is_hard and term.weight < 10_000:
            continue   # a soft rule breaking is normal, not a conflict
        if term.rule.id in seen:
            continue
        seen.add(term.rule.id)

        bench_name = problem.bench(term.bench_id).name if term.bench_id else None
        day_name = WEEKDAY_NAMES[term.work_date.isoweekday()] if term.work_date else None
        where = " ".join(part for part in (bench_name, f"on {day_name}" if day_name else None) if part)

        result["conflicts"].append({
            "kind": "rule",
            "rule_id": term.rule.id,
            "rule_name": term.rule.name,
            "work_date": term.work_date.isoformat() if term.work_date else None,
            "day_name": day_name,
            "bench_id": term.bench_id,
            "bench_name": bench_name,
            "staff_id": term.staff_id,
            "detail": (
                f"{term.rule.plain_english or term.rule.name} "
                + (f"This cannot hold on {where}, " if where else "This cannot hold, ")
                + "alongside everything else the week has to satisfy."
            ),
            "first_failure": term.describe(solver.Value(term.expr)),
        })

    if result["conflicts"]:
        first = result["conflicts"][0]
        if first.get("bench_id"):
            first["pool"] = _bench_pool(
                problem,
                first["bench_id"],
                date.fromisoformat(first["work_date"]) if first.get("work_date") else None,
                placed,
            )
        result["suggestions"] = [
            {
                "label": f"Make \"{first['rule_name']}\" soft",
                "action": "edit_rule",
                "rule_id": first["rule_id"],
            },
            {
                "label": f"Pause \"{first['rule_name']}\"",
                "action": "pause_rule",
                "rule_id": first["rule_id"],
            },
            {
                "label": "Review absences for this week",
                "action": "absences",
                "date": problem.week_start.isoformat(),
            },
        ]
    return result


def _bench_pool(
    problem: Problem,
    bench_id: str,
    day: date | None,
    placed: dict[tuple[str, date], str] | None = None,
) -> list[dict[str, Any]]:
    """Everyone with any competency on a bench, and where they stood on the day.

    "Available" on its own is not an answer when the week is impossible. If the
    relaxed solve put someone on another bench, say which one, because that is
    the trade the user is actually being asked to unpick.
    """
    placed = placed or {}
    pool = []
    reqs = [r for r in merged_requirements(problem, day) if r.bench_id == bench_id] if day else []
    req = reqs[0] if reqs else None
    for person in problem.staff:
        comp = problem.competency(person.id, bench_id)
        if comp is None:
            continue
        if req and day:
            ok, reason = problem.eligibility(person.id, req, day)
        else:
            ok, reason = True, ""

        if ok and day:
            elsewhere = placed.get((person.id, day))
            if elsewhere and elsewhere != bench_id:
                reason = f"{person.full_name} is on {problem.bench(elsewhere).name}"
            elif elsewhere == bench_id:
                reason = f"{person.full_name} is already on this bench"
        pool.append({
            "staff_id": person.id,
            "staff_code": person.code,
            "name": person.full_name,
            "level": comp.level,
            "reason": reason or f"{person.full_name} is available",
            "available": ok,
        })
    return pool


def _pin_conflicts(problem: Problem) -> dict[str, Any]:
    """Coverage and rules both relax cleanly, so the pins are the problem."""
    week = f"{problem.week_start:%d %b %Y}"
    result: dict[str, Any] = {
        "summary": f"No valid rota for the week of {week}.",
        "conflicts": [],
        "suggestions": [],
    }
    if not problem.pins:
        return result

    _model, _solver, status = _solve_relaxed(problem, drop_pins=True)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return result

    result["conflicts"].append({
        "kind": "pin",
        "detail": (
            f"The week solves once the {len(problem.pins)} pinned "
            f"{'assignment' if len(problem.pins) == 1 else 'assignments'} are "
            "released. Two or more pins are asking for the same person, or for "
            "someone a rule cannot place there."
        ),
        "pins": [
            {
                "staff_id": pin.staff_id,
                "name": problem.person(pin.staff_id).full_name,
                "bench_id": pin.bench_id,
                "bench_name": problem.bench(pin.bench_id).name,
                "work_date": pin.work_date.isoformat(),
                "day_name": WEEKDAY_NAMES[pin.work_date.isoweekday()],
            }
            for pin in problem.pins
        ],
    })
    result["suggestions"] = [
        {"label": "Open the pins panel", "action": "pins"},
        {"label": "Clear all pins and re-solve", "action": "clear_pins"},
        {
            "label": "Review absences for this week",
            "action": "absences",
            "date": problem.week_start.isoformat(),
        },
    ]
    return result
