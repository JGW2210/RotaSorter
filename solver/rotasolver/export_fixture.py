"""Emit a week, and this solver's answer to it, as JSON.

The TypeScript solver in web/src/solver reads the same shape, so both can be
run against identical input and compared. This one stays the reference: it is
the older implementation, it has the larger test suite, and CP-SAT proves
optimality, so a disagreement means the port is wrong until shown otherwise.

    python -m rotasolver.export_fixture web/src/solver/__fixtures__
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from .fixtures import seeded_problem
from .models import Problem
from .solve import solve


def problem_to_json(problem: Problem) -> dict[str, Any]:
    """camelCase, to match the TypeScript SolverProblem exactly."""
    return {
        "weekStart": problem.week_start.isoformat(),
        "shifts": [
            {"id": s.id, "code": s.code, "name": s.name} for s in problem.shifts
        ],
        "benches": [
            {
                "id": b.id,
                "name": b.name,
                "groupName": b.group_name,
                "requiredLevel": b.required_level,
                "sortOrder": b.sort_order,
            }
            for b in problem.benches
        ],
        "requirements": [
            {
                "benchId": r.bench_id,
                "shiftId": r.shift_id,
                "label": r.label,
                "weekdays": sorted(r.weekdays),
                "minStaff": r.min_staff,
                "maxStaff": r.max_staff,
                "requiredLevel": r.required_level,
            }
            for r in problem.requirements
        ],
        "staff": [
            {
                "id": s.id,
                "code": s.code,
                "fullName": s.full_name,
                "grade": s.grade,
                "status": s.status,
            }
            for s in problem.staff
        ],
        "competencies": [
            {
                "staffId": c.staff_id,
                "benchId": c.bench_id,
                "level": c.level,
                "expiresOn": c.expires_on.isoformat() if c.expires_on else None,
            }
            for c in problem.competencies
        ],
        "absences": [
            {
                "staffId": a.staff_id,
                "startsOn": a.starts_on.isoformat(),
                "endsOn": a.ends_on.isoformat(),
                "kind": a.kind,
            }
            for a in problem.absences
        ],
        "availability": [
            {"staffId": a.staff_id, "weekday": a.weekday, "shiftId": a.shift_id}
            for a in problem.availability
            if a.is_available
        ],
        "rules": [
            {
                "id": r.id,
                "name": r.name,
                "action": r.action,
                "params": r.params,
                "conditions": r.conditions,
                "isHard": r.is_hard,
                "weight": r.weight,
                "plainEnglish": r.plain_english,
            }
            for r in problem.rules
            if r.status == "active"
        ],
        "pins": [
            {
                "workDate": p.work_date.isoformat(),
                "shiftId": p.shift_id,
                "benchId": p.bench_id,
                "staffId": p.staff_id,
            }
            for p in problem.pins
        ],
        "settings": dict(problem.settings),
    }


def solution_to_json(problem: Problem) -> dict[str, Any]:
    solution = solve(problem)
    return {
        "status": solution.status,
        "objectiveValue": solution.objective_value,
        # The count, not the list. A week usually has many rotas of equal cost
        # and which one comes back is arbitrary, so pinning one would make this
        # fixture drift for no reason. What must match is the optimum's value,
        # asserted separately, and that both solvers place the same number of
        # people. Coverage, pins and supervision are checked directly against
        # the problem by the cross-check rather than against a stored answer.
        "assignmentCount": len(solution.assignments),
        "pinnedCount": sum(1 for a in solution.assignments if a.is_pinned),
        "breaches": sorted(
            [{"ruleName": b.rule_name, "detail": b.detail} for b in solution.breaches],
            key=lambda b: (b["ruleName"], b["detail"]),
        ),
        "infeasibleConflictKinds": sorted(
            {c["kind"] for c in (solution.infeasible_report or {}).get("conflicts", [])}
        ),
        "infeasibleBenchNames": sorted(
            {
                c["bench_name"]
                for c in (solution.infeasible_report or {}).get("conflicts", [])
                if c.get("bench_name")
            }
        ),
    }


def cases() -> dict[str, Problem]:
    """The scenarios both solvers must agree on."""
    base = seeded_problem()

    activated = replace(
        base,
        rules=[
            replace(r, status="active") if r.name == "Blood Cultures needs three people" else r
            for r in base.rules
        ],
    )

    # A week with no rules at all, to isolate the core model from the compiler.
    bare = replace(base, rules=[])

    # Pins, including one the solver would not have chosen on its own.
    from .models import Pin
    from datetime import date

    # A valid pin the solver would not have chosen unprompted: Rakesh Menon is
    # a trainer on Urines and free that Monday, and the unpinned rota puts him
    # on one of the benches with a shallower pool instead. Which one varies
    # between equally optimal rotas, so it is not named here. Pinning an
    # impossible slot would only test that both solvers ignore it.
    pinned = replace(
        base,
        pins=[
            Pin(work_date=date(2026, 9, 14), shift_id="DAY", bench_id="Urines",
                staff_id="SBMS-0058"),
        ],
    )

    return {
        "seeded-week": base,
        "no-rules": bare,
        "with-pins": pinned,
        "infeasible-hard-rule": activated,
    }


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    manifest = []
    for name, problem in cases().items():
        payload = {
            "name": name,
            "problem": problem_to_json(problem),
            "expected": solution_to_json(problem),
        }
        path = out / f"{name}.json"
        path.write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n")
        manifest.append(name)
        expected = payload["expected"]
        print(f"  {name}: {expected['status']} "
              f"objective={expected['objectiveValue']} "
              f"assignments={expected['assignmentCount']}")

    (out / "manifest.json").write_text(json.dumps(sorted(manifest), indent=1) + "\n")
    print(f"wrote {len(manifest)} cases to {out}")


if __name__ == "__main__":
    import sys

    main(sys.argv[1] if len(sys.argv) > 1 else "../web/src/solver/__fixtures__")
