"""Rule matching.

A rule is a condition tree plus an action. The tree selects a set of candidate
assignment slots, and the action says what must be true of that set. Keeping
selection and action separate is what lets one small vocabulary of conditions
cover every rule in the preset library.

Condition values reference things the way a human wrote them in the builder:
staff by staff code, benches and groups by name, shifts by code, days by name.
They are resolved here rather than stored as ids so a rule stays readable in the
database.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Iterable, NamedTuple

from .models import LEVEL_RANK, Problem, Rule, WEEKDAY_NAMES

DAY_LOOKUP = {name.lower(): iso for iso, name in WEEKDAY_NAMES.items()}
DAY_LOOKUP.update({name.lower()[:3]: iso for iso, name in WEEKDAY_NAMES.items()})


class Slot(NamedTuple):
    """One candidate assignment: this person, this bench, this day."""

    staff_id: str
    work_date: date
    shift_id: str
    bench_id: str


def _as_list(values: Any) -> list[Any]:
    if values is None:
        return []
    if isinstance(values, (list, tuple)):
        return list(values)
    return [values]


def _parse_day(value: Any) -> int | None:
    if isinstance(value, int):
        return value if 1 <= value <= 7 else None
    if isinstance(value, str):
        if value.isdigit():
            iso = int(value)
            return iso if 1 <= iso <= 7 else None
        return DAY_LOOKUP.get(value.strip().lower())
    return None


def _parse_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


def _subject_value(problem: Problem, subject: str, slot: Slot) -> Any:
    """The slot's value for a condition subject, in the form the builder uses."""
    if subject == "person":
        return problem.person(slot.staff_id).code
    if subject == "grade":
        return problem.person(slot.staff_id).grade
    if subject == "day":
        return slot.work_date.isoweekday()
    if subject == "shift":
        return problem.shift(slot.shift_id).code
    if subject == "bench":
        return problem.bench(slot.bench_id).name
    if subject == "bench_group":
        return problem.bench(slot.bench_id).group_name
    if subject == "date":
        return slot.work_date
    if subject == "competency_level":
        comp = problem.competency(slot.staff_id, slot.bench_id)
        return comp.level if comp else None
    raise ValueError(f"Unknown condition subject: {subject}")


def _matches_condition(problem: Problem, cond: dict[str, Any], slot: Slot) -> bool:
    subject = cond.get("subject")
    operator = (cond.get("operator") or "is").strip().lower()
    values = _as_list(cond.get("values"))

    if subject is None:
        return True

    actual = _subject_value(problem, subject, slot)

    if subject == "day":
        wanted = {d for d in (_parse_day(v) for v in values) if d is not None}
        if operator in ("is", "is one of"):
            return actual in wanted
        if operator == "is not":
            return actual not in wanted
        raise ValueError(f"Operator {operator!r} is not valid for a day condition")

    if subject == "date":
        parsed = [d for d in (_parse_date(v) for v in values) if d is not None]
        if not parsed:
            return True
        if operator == "before":
            return actual < parsed[0]
        if operator == "after":
            return actual > parsed[0]
        if operator == "between":
            if len(parsed) < 2:
                return True
            lo, hi = sorted(parsed[:2])
            return lo <= actual <= hi
        raise ValueError(f"Operator {operator!r} is not valid for a date condition")

    if subject == "competency_level":
        if actual is None:
            return operator in ("is not",)
        if operator == "is at least":
            wanted = min((LEVEL_RANK[v] for v in values if v in LEVEL_RANK),
                         default=0)
            return LEVEL_RANK[actual] >= wanted
        if operator in ("is", "is one of"):
            return actual in values
        if operator == "is not":
            return actual not in values
        raise ValueError(f"Operator {operator!r} is not valid for a competency condition")

    if subject == "bench" and operator == "is in group":
        group = problem.bench(slot.bench_id).group_name
        return group in values

    if operator in ("is", "is one of"):
        return actual in values
    if operator == "is not":
        return actual not in values

    raise ValueError(f"Operator {operator!r} is not valid for subject {subject!r}")


def matches(problem: Problem, node: dict[str, Any] | None, slot: Slot) -> bool:
    """Evaluate a condition tree against one slot.

    An empty tree matches everything, which is what "WHEN any assignment" with
    no conditions means in the builder.
    """
    if not node:
        return True

    op = node.get("op")
    if op in ("all", "any"):
        children = node.get("children") or []
        if not children:
            return True
        results = (matches(problem, child, slot) for child in children)
        return all(results) if op == "all" else any(results)

    return _matches_condition(problem, node, slot)


def scope_slots(problem: Problem, rule: Rule, slots: Iterable[Slot]) -> list[Slot]:
    """The slots a rule applies to."""
    return [s for s in slots if matches(problem, rule.conditions, s)]


def condition_people(problem: Problem, rule: Rule) -> list[str]:
    """Staff ids named directly by a `person` condition anywhere in the tree.

    `not_together` needs the named pair rather than the slots they could fill.
    """
    codes: list[str] = []

    def walk(node: dict[str, Any] | None) -> None:
        if not node:
            return
        if node.get("op") in ("all", "any"):
            for child in node.get("children") or []:
                walk(child)
            return
        if node.get("subject") == "person":
            codes.extend(str(v) for v in _as_list(node.get("values")))

    walk(rule.conditions)
    by_code = {p.code: p.id for p in problem.staff}
    return [by_code[c] for c in codes if c in by_code]


def describe_scope(problem: Problem, rule: Rule) -> str:
    """Short human description of what a rule covers, for breach text."""
    return rule.plain_english or rule.name


STAFF_SUBJECTS = frozenset({"person", "grade", "competency_level"})


def strip_staff_conditions(node: dict[str, Any] | None) -> dict[str, Any] | None:
    """Drop the conditions that talk about a person, keeping where and when.

    Rules like "Reporting Ref Lab Reports must have at least 1 Senior BMS" mix
    two different jobs in one tree: the bench and day conditions say *where the
    rule applies*, the grade condition says *who counts towards it*. Without
    this split, a day on which nobody matches produces no slots, no constraint,
    and a hard rule that quietly does nothing on precisely the day it mattered.
    """
    if not node:
        return None

    if node.get("op") in ("all", "any"):
        children = [
            stripped
            for stripped in (strip_staff_conditions(c) for c in node.get("children") or [])
            if stripped is not None
        ]
        if not children:
            return None
        return {"op": node["op"], "children": children}

    if node.get("subject") in STAFF_SUBJECTS:
        return None
    return node


def group_in_scope(problem: Problem, rule: Rule, group_slots: Iterable[Slot]) -> bool:
    """Does this rule apply to this bench-day at all, whoever is standing on it?"""
    where = strip_staff_conditions(rule.conditions)
    if where is None:
        return True
    return any(matches(problem, where, slot) for slot in group_slots)
