"""Problem and solution types for the bench rota solver.

Everything the solver needs is in `Problem`. It is deliberately free of any
Supabase or HTTP concern so the model can be built from a fixture and tested
without a database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Iterable

LEVEL_RANK = {"trainee": 0, "competent": 1, "trainer": 2}
SIGNED_OFF = ("competent", "trainer")

WEEKDAY_NAMES = {
    1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday",
    5: "Friday", 6: "Saturday", 7: "Sunday",
}
GRADE_LABELS = {
    "ap": "AP", "bms": "BMS", "senior_bms": "Senior BMS", "trainee": "Trainee",
}


@dataclass(frozen=True)
class Shift:
    id: str
    code: str
    name: str
    sort_order: int = 0


@dataclass(frozen=True)
class Bench:
    id: str
    name: str
    group_name: str | None
    required_level: str = "competent"
    sort_order: int = 0


@dataclass(frozen=True)
class Requirement:
    """How many people a bench needs, on which shift, on which weekdays."""

    bench_id: str
    shift_id: str
    label: str
    weekdays: frozenset[int]
    min_staff: int
    max_staff: int | None
    required_level: str | None = None


@dataclass(frozen=True)
class Staff:
    id: str
    code: str
    full_name: str
    grade: str
    status: str = "active"
    fte: float = 1.0

    @property
    def grade_label(self) -> str:
        return GRADE_LABELS.get(self.grade, self.grade)


@dataclass(frozen=True)
class Competency:
    staff_id: str
    bench_id: str
    level: str
    expires_on: date | None = None

    def valid_on(self, day: date) -> bool:
        return self.expires_on is None or self.expires_on >= day


@dataclass(frozen=True)
class Absence:
    staff_id: str
    starts_on: date
    ends_on: date
    kind: str = "annual_leave"

    def covers(self, day: date) -> bool:
        return self.starts_on <= day <= self.ends_on


@dataclass(frozen=True)
class Availability:
    staff_id: str
    weekday: int
    shift_id: str
    is_available: bool = True


@dataclass(frozen=True)
class Rule:
    id: str
    name: str
    action: str
    params: dict[str, Any]
    conditions: dict[str, Any]
    is_hard: bool
    weight: int
    status: str = "active"
    plain_english: str | None = None
    scope: str = "global"


@dataclass(frozen=True)
class Pin:
    work_date: date
    shift_id: str
    bench_id: str
    staff_id: str
    reason: str | None = None


@dataclass(frozen=True)
class PastAssignment:
    """An assignment that already happened, from last week's published rota.

    History is fact, not choice: it enters the model only as constants, so
    rules that look at runs of days can see across the Sunday-to-Monday
    boundary.
    """

    staff_id: str
    work_date: date
    shift_id: str
    bench_id: str


DEFAULT_SETTINGS: dict[str, int] = {
    "weight_fairness_spread": 20,
    "weight_rotation_repeat": 12,
    "weight_idle_staff": 40,
    "weight_trainee_placement": 25,
    "weight_soft_breach_scale": 1,
    "max_solve_seconds": 60,
    "random_seed": 20260914,
}


@dataclass
class Problem:
    week_start: date
    shifts: list[Shift] = field(default_factory=list)
    benches: list[Bench] = field(default_factory=list)
    requirements: list[Requirement] = field(default_factory=list)
    staff: list[Staff] = field(default_factory=list)
    competencies: list[Competency] = field(default_factory=list)
    absences: list[Absence] = field(default_factory=list)
    availability: list[Availability] = field(default_factory=list)
    rules: list[Rule] = field(default_factory=list)
    pins: list[Pin] = field(default_factory=list)
    history: list[PastAssignment] = field(default_factory=list)
    settings: dict[str, int] = field(default_factory=lambda: dict(DEFAULT_SETTINGS))

    # -- lookups ------------------------------------------------------------

    @property
    def dates(self) -> list[date]:
        return [self.week_start + timedelta(days=i) for i in range(7)]

    def bench(self, bench_id: str) -> Bench:
        return self._by_id(self.benches, bench_id)

    def shift(self, shift_id: str) -> Shift:
        return self._by_id(self.shifts, shift_id)

    def person(self, staff_id: str) -> Staff:
        return self._by_id(self.staff, staff_id)

    @staticmethod
    def _by_id(items: Iterable[Any], wanted: str) -> Any:
        for item in items:
            if item.id == wanted:
                return item
        raise KeyError(wanted)

    def setting(self, key: str) -> int:
        return int(self.settings.get(key, DEFAULT_SETTINGS[key]))

    # -- derived facts ------------------------------------------------------

    def competency(self, staff_id: str, bench_id: str) -> Competency | None:
        for c in self.competencies:
            if c.staff_id == staff_id and c.bench_id == bench_id:
                return c
        return None

    def is_absent(self, staff_id: str, day: date) -> Absence | None:
        for a in self.absences:
            if a.staff_id == staff_id and a.covers(day):
                return a
        return None

    def is_contracted(self, staff_id: str, day: date, shift_id: str) -> bool:
        weekday = day.isoweekday()
        for a in self.availability:
            if (a.staff_id == staff_id and a.weekday == weekday
                    and a.shift_id == shift_id):
                return a.is_available
        return False

    def requirements_on(self, day: date) -> list[Requirement]:
        weekday = day.isoweekday()
        return [r for r in self.requirements if weekday in r.weekdays]

    def required_level_for(self, req: Requirement) -> str:
        return req.required_level or self.bench(req.bench_id).required_level

    def eligibility(self, staff_id: str, req: Requirement, day: date) -> tuple[bool, str]:
        """Can this person work this bench on this day, and if not, why not?

        The reason string is what the infeasibility screen and the refused-drop
        tooltip show the user, so it names the specific blocker.
        """
        person = self.person(staff_id)
        if person.status != "active":
            return False, f"{person.full_name} is inactive"

        if not self.is_contracted(staff_id, day, req.shift_id):
            return False, (f"{person.full_name} is not contracted on "
                           f"{WEEKDAY_NAMES[day.isoweekday()]}")

        absence = self.is_absent(staff_id, day)
        if absence:
            kind = absence.kind.replace("_", " ")
            return False, f"{person.full_name} is on {kind}"

        bench = self.bench(req.bench_id)
        comp = self.competency(staff_id, req.bench_id)
        if comp is None:
            return False, f"{person.full_name} is not competent on {bench.name}"

        if not comp.valid_on(day):
            return False, (f"{person.full_name}'s {bench.name} signoff expired on "
                           f"{comp.expires_on:%d %b %Y}")

        # A trainee is placed on the bench while working through the documents,
        # so training status is never itself a blocker. The supervision
        # constraint in solve.py is what keeps that safe.
        if comp.level == "trainee":
            return True, ""

        needed = self.required_level_for(req)
        if LEVEL_RANK[comp.level] < LEVEL_RANK[needed]:
            return False, (f"{person.full_name} is {comp.level} on {bench.name}, "
                           f"which needs {needed}")

        return True, ""

    def is_signed_off(self, staff_id: str, bench_id: str, day: date) -> bool:
        comp = self.competency(staff_id, bench_id)
        return bool(comp and comp.level in SIGNED_OFF and comp.valid_on(day))


@dataclass(frozen=True)
class AssignmentOut:
    work_date: date
    shift_id: str
    bench_id: str
    staff_id: str
    is_pinned: bool = False


@dataclass(frozen=True)
class BreachOut:
    rule_id: str | None
    rule_name: str
    weight: int
    detail: str
    work_date: date | None = None
    shift_id: str | None = None
    bench_id: str | None = None
    staff_id: str | None = None


@dataclass
class Solution:
    status: str                       # solved | solved_with_breaches | infeasible | error
    assignments: list[AssignmentOut] = field(default_factory=list)
    breaches: list[BreachOut] = field(default_factory=list)
    objective_value: int | None = None
    solve_ms: int = 0
    infeasible_report: dict[str, Any] | None = None
    log: str = ""
