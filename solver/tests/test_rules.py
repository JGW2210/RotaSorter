"""Condition matching and rule compilation."""

from dataclasses import replace
from datetime import date

import pytest

from rotasolver.fixtures import seeded_problem
from rotasolver.models import Problem, Rule
from rotasolver.rules import (
    Slot,
    condition_people,
    group_in_scope,
    matches,
    strip_staff_conditions,
)
from rotasolver.solve import solve

MONDAY = date(2026, 9, 14)
THURSDAY = date(2026, 9, 17)


@pytest.fixture(scope="module")
def problem() -> Problem:
    return seeded_problem()


def slot(problem: Problem, code: str, bench: str, day: date = MONDAY) -> Slot:
    return Slot(staff_id=code, work_date=day, shift_id="DAY", bench_id=bench)


def cond(subject, operator, values):
    return {"subject": subject, "operator": operator, "values": values}


# -- condition matching -----------------------------------------------------

@pytest.mark.parametrize(
    "condition,code,bench,expected",
    [
        (cond("person", "is", ["BMS-0141"]), "BMS-0141", "Urines", True),
        (cond("person", "is", ["BMS-0141"]), "BMS-0155", "Urines", False),
        (cond("person", "is not", ["BMS-0141"]), "BMS-0155", "Urines", True),
        (cond("person", "is one of", ["BMS-0141", "BMS-0155"]), "BMS-0155", "Urines", True),
        (cond("grade", "is", ["trainee"]), "TRN-0402", "Urines", True),
        (cond("grade", "is", ["trainee"]), "SBMS-0041", "Urines", False),
        (cond("grade", "is not", ["trainee"]), "SBMS-0041", "Urines", True),
        (cond("bench", "is", ["Urines"]), "SBMS-0041", "Urines", True),
        (cond("bench", "is not", ["Urines"]), "SBMS-0041", "Urines", False),
        (cond("bench", "is in group", ["Sterile Sites"]), "SBMS-0041", "CSF", True),
        (cond("bench", "is in group", ["Sterile Sites"]), "SBMS-0041", "Urines", False),
        (cond("day", "is", ["Monday"]), "SBMS-0041", "Urines", True),
        (cond("day", "is", ["Tuesday"]), "SBMS-0041", "Urines", False),
        (cond("day", "is one of", [1, 3, 5]), "SBMS-0041", "Urines", True),
        (cond("shift", "is", ["DAY"]), "SBMS-0041", "Urines", True),
        (cond("competency_level", "is", ["trainer"]), "SBMS-0041", "Urines", True),
        (cond("competency_level", "is at least", ["competent"]), "TRN-0402", "Urines", False),
        (cond("competency_level", "is at least", ["competent"]), "BMS-0112", "Urines", True),
    ],
)
def test_single_conditions(problem, condition, code, bench, expected):
    assert matches(problem, condition, slot(problem, code, bench)) is expected


def test_date_operators(problem):
    s = slot(problem, "SBMS-0041", "Urines", MONDAY)
    assert matches(problem, cond("date", "before", ["2026-09-15"]), s)
    assert not matches(problem, cond("date", "after", ["2026-09-15"]), s)
    assert matches(problem, cond("date", "between", ["2026-09-13", "2026-09-16"]), s)


def test_empty_tree_matches_everything(problem):
    s = slot(problem, "SBMS-0041", "Urines")
    assert matches(problem, None, s)
    assert matches(problem, {"op": "all", "children": []}, s)


def test_all_and_any_nesting(problem):
    s = slot(problem, "TRN-0402", "Urines", MONDAY)
    tree = {
        "op": "all",
        "children": [
            cond("bench", "is", ["Urines"]),
            {
                "op": "any",
                "children": [
                    cond("grade", "is", ["trainee"]),
                    cond("day", "is", ["Sunday"]),
                ],
            },
        ],
    }
    assert matches(problem, tree, s)

    tree["children"][1]["children"][0] = cond("grade", "is", ["senior_bms"])
    assert not matches(problem, tree, s)


def test_unknown_operator_is_rejected(problem):
    with pytest.raises(ValueError):
        matches(problem, cond("grade", "resembles", ["bms"]),
                slot(problem, "BMS-0141", "Urines"))


# -- scope splitting --------------------------------------------------------

def test_strip_staff_conditions_keeps_where_and_when():
    tree = {
        "op": "all",
        "children": [
            cond("bench", "is", ["Reporting Ref Lab Reports"]),
            cond("grade", "is", ["senior_bms"]),
        ],
    }
    stripped = strip_staff_conditions(tree)
    assert stripped == {
        "op": "all",
        "children": [cond("bench", "is", ["Reporting Ref Lab Reports"])],
    }


def test_strip_staff_conditions_returns_none_when_only_people_named():
    tree = {"op": "all", "children": [cond("person", "is", ["BMS-0141"])]}
    assert strip_staff_conditions(tree) is None


def test_group_stays_in_scope_when_no_person_qualifies(problem):
    """The case that made hard rules silently vanish.

    A bench-day where nobody matches the grade condition is still a bench-day
    the rule governs, and for a hard rule that is a conflict, not a pass.
    """
    rule = Rule(
        id="r", name="seniors only", action="requires_at_least",
        params={"n": 1},
        conditions={"op": "all", "children": [
            cond("bench", "is", ["Mycology"]),
            cond("grade", "is", ["senior_bms"]),
        ]},
        is_hard=True, weight=100,
    )
    mycology_thursday = [
        Slot(p.id, THURSDAY, "DAY", "Mycology") for p in problem.staff
    ]
    assert group_in_scope(problem, rule, mycology_thursday)

    trainees_only = [Slot("TRN-0402", THURSDAY, "DAY", "Mycology")]
    assert group_in_scope(problem, rule, trainees_only)

    other_bench = [Slot("SBMS-0041", THURSDAY, "DAY", "Urines")]
    assert not group_in_scope(problem, rule, other_bench)


def test_condition_people_resolves_staff_codes(problem):
    rule = Rule(
        id="r", name="apart", action="not_together", params={},
        conditions={"op": "all", "children": [
            cond("person", "is one of", ["BMS-0141", "BMS-0155"]),
        ]},
        is_hard=True, weight=100,
    )
    assert set(condition_people(problem, rule)) == {"BMS-0141", "BMS-0155"}


# -- rules actually bind the solution ---------------------------------------

def solve_with(problem: Problem, **overrides) -> tuple[Problem, object]:
    changed = replace(problem, **overrides)
    return changed, solve(changed)


def test_not_together_keeps_the_named_pair_apart(problem):
    solution = solve(problem)
    together = [
        (a.work_date, a.bench_id)
        for a in solution.assignments if a.staff_id == "BMS-0141"
        for b in solution.assignments
        if b.staff_id == "BMS-0155"
        and b.work_date == a.work_date and b.bench_id == a.bench_id
    ]
    assert not together, f"Marcus and Sarah share a bench on {together}"


def test_trainees_are_kept_off_csf(problem):
    solution = solve(problem)
    offenders = [
        problem.person(a.staff_id).full_name
        for a in solution.assignments
        if a.bench_id == "CSF" and problem.person(a.staff_id).grade == "trainee"
    ]
    assert not offenders


def test_cat3_always_has_a_trainer_on_it(problem):
    solution = solve(problem)
    by_day = {}
    for a in solution.assignments:
        if a.bench_id == "CAT-3":
            by_day.setdefault(a.work_date, []).append(a.staff_id)
    assert by_day, "CAT-3 was never staffed, so the rule proves nothing"
    for day, staff_ids in by_day.items():
        levels = [problem.competency(s, "CAT-3").level for s in staff_ids]
        assert "trainer" in levels, f"CAT-3 on {day} has {levels}"


def test_hard_rule_that_cannot_hold_makes_the_week_infeasible(problem):
    """The paused demo rule: Blood Cultures needing three people."""
    rules = [
        replace(r, status="active") if r.name == "Blood Cultures needs three people" else r
        for r in problem.rules
    ]
    changed, solution = solve_with(problem, rules=rules)
    assert solution.status == "infeasible"

    report = solution.infeasible_report
    assert report["conflicts"], report
    named = {c.get("bench_name") for c in report["conflicts"]}
    assert "Blood Cultures" in named, report["conflicts"]
    assert report["suggestions"], "an infeasible week must offer a way out"


def test_soft_rule_breach_is_reported_rather_than_blocking(problem):
    """Force a soft breach and check it is named, weighted and located.

    The weight is deliberately under weight_idle_staff. Keeping Alison off the
    rota entirely is possible now that the roster covers every bench every
    weekday, so the only thing that makes the solver break this rule is the
    arithmetic: a day of her sitting idle costs 40, breaking the rule costs 20.
    A weight above the idle cost would simply be honoured and the test would
    prove nothing.
    """
    rules = list(problem.rules) + [
        Rule(
            id="soft-test", name="Keep Alison off Urines", action="cannot_be_assigned",
            params={},
            conditions={"op": "all", "children": [
                cond("person", "is", ["SBMS-0041"]),
            ]},
            is_hard=False, weight=20,
            plain_english="Alison Ferreira should not be assigned at all.",
        )
    ]
    _changed, solution = solve_with(problem, rules=rules)
    assert solution.status == "solved_with_breaches"
    assert any(b.rule_name == "Keep Alison off Urines" for b in solution.breaches)
    breach = next(b for b in solution.breaches if b.rule_name == "Keep Alison off Urines")
    assert breach.weight == 20
    assert breach.staff_id == "SBMS-0041"
    assert breach.detail
