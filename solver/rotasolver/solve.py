"""The CP-SAT rota model.

One boolean per (person, day, shift, bench) that the person could legally work.
Hard constraints carve away the impossible; the objective picks between what is
left. If the hard constraints leave nothing, diagnose.py takes over and explains
which requirement could not be met and who was missing.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import replace
from datetime import date, timedelta
from typing import Any, Callable

from ortools.sat.python import cp_model

from .models import (
    AssignmentOut,
    BreachOut,
    Problem,
    Rule,
    Solution,
    WEEKDAY_NAMES,
)
from .rules import (
    Slot,
    condition_people,
    group_in_scope,
    matches,
    scope_slots,
    strip_staff_conditions,
)

SOLVER_VERSION = "rotasolver 0.1.0"


class SoftTerm:
    """A penalty in the objective that maps back to a sentence when it fires."""

    def __init__(
        self,
        expr: Any,
        weight: int,
        describe: Callable[[int], str],
        rule: Rule | None = None,
        work_date: date | None = None,
        bench_id: str | None = None,
        shift_id: str | None = None,
        staff_id: str | None = None,
    ) -> None:
        self.expr = expr
        self.weight = weight
        self.describe = describe
        self.rule = rule
        self.work_date = work_date
        self.bench_id = bench_id
        self.shift_id = shift_id
        self.staff_id = staff_id


def eligible_slots(problem: Problem) -> list[Slot]:
    """Every (person, day, shift, bench) the rules of competency allow."""
    slots: list[Slot] = []
    for day in problem.dates:
        for req in merged_requirements(problem, day):
            for person in problem.staff:
                ok, _reason = problem.eligibility(person.id, req, day)
                if ok:
                    slots.append(Slot(person.id, day, req.shift_id, req.bench_id))
    return slots


def merged_requirements(problem: Problem, day: date) -> list[Any]:
    """Requirements in force on a day, one per bench and shift.

    Weekday sets under a bench and shift are meant to be disjoint. If two rows
    do overlap, the stricter minimum and the tighter maximum win rather than the
    two silently summing.
    """
    from .models import Requirement

    grouped: dict[tuple[str, str], list[Requirement]] = defaultdict(list)
    for req in problem.requirements_on(day):
        grouped[(req.bench_id, req.shift_id)].append(req)

    merged: list[Requirement] = []
    for (bench_id, shift_id), reqs in grouped.items():
        if len(reqs) == 1:
            merged.append(reqs[0])
            continue
        maxes = [r.max_staff for r in reqs if r.max_staff is not None]
        merged.append(
            Requirement(
                bench_id=bench_id,
                shift_id=shift_id,
                label="+".join(sorted(r.label for r in reqs)),
                weekdays=frozenset({day.isoweekday()}),
                min_staff=max(r.min_staff for r in reqs),
                max_staff=min(maxes) if maxes else None,
                required_level=next(
                    (r.required_level for r in reqs if r.required_level), None
                ),
            )
        )
    return merged


class RotaModel:
    def __init__(
        self,
        problem: Problem,
        relax_coverage: bool = False,
        soften_rules: bool = False,
        drop_pins: bool = False,
    ) -> None:
        self.p = problem
        self.relax_coverage = relax_coverage
        self.soften_rules = soften_rules
        self.drop_pins = drop_pins
        self.model = cp_model.CpModel()
        self.slots = eligible_slots(problem)
        self.x: dict[Slot, cp_model.IntVar] = {}
        self.soft: list[SoftTerm] = []
        self.shortfall: dict[tuple[date, str, str], cp_model.IntVar] = {}
        self.notes: list[str] = []

        self._create_vars()
        self._one_bench_per_day()
        self._coverage()
        self._trainee_supervision()
        self._apply_pins()
        self._apply_rules()
        self._objective()

    # -- variables ----------------------------------------------------------

    def _create_vars(self) -> None:
        for slot in self.slots:
            name = f"x[{slot.staff_id[:8]},{slot.work_date},{slot.bench_id[:8]}]"
            self.x[slot] = self.model.NewBoolVar(name)

    def _slots_by(self, *keys: str) -> dict[tuple, list[Slot]]:
        grouped: dict[tuple, list[Slot]] = defaultdict(list)
        for slot in self.slots:
            grouped[tuple(getattr(slot, k) for k in keys)].append(slot)
        return grouped

    # -- hard structure -----------------------------------------------------

    def _one_bench_per_day(self) -> None:
        """Nobody is on two benches on the same day.

        This is the whole-day model. If the Late shift is ever staffed, this
        also stops one person covering Day and Late back to back.
        """
        for (_staff_id, _day), slots in self._slots_by("staff_id", "work_date").items():
            self.model.AddAtMostOne(self.x[s] for s in slots)

    def _coverage(self) -> None:
        for day in self.p.dates:
            for req in merged_requirements(self.p, day):
                slots = [
                    s for s in self.slots
                    if s.work_date == day
                    and s.bench_id == req.bench_id
                    and s.shift_id == req.shift_id
                ]
                total = sum(self.x[s] for s in slots) if slots else 0

                if self.relax_coverage:
                    # Diagnostic pass: coverage may fall short, at a price, so
                    # the solver has to tell us exactly where it gave up.
                    short = self.model.NewIntVar(
                        0, req.min_staff, f"short[{day},{req.bench_id[:8]}]"
                    )
                    self.shortfall[(day, req.bench_id, req.shift_id)] = short
                    self.model.Add(total + short >= req.min_staff)
                else:
                    self.model.Add(total >= req.min_staff)

                if req.max_staff is not None and slots:
                    self.model.Add(total <= req.max_staff)

    def _trainee_supervision(self) -> None:
        """A trainee on a bench means a signed-off colleague on the same bench.

        Trainees count towards cover, but never alone.
        """
        grouped = self._slots_by("work_date", "shift_id", "bench_id")
        for (day, _shift_id, bench_id), slots in grouped.items():
            trainees = [
                s for s in slots
                if not self.p.is_signed_off(s.staff_id, bench_id, day)
            ]
            supervisors = [
                s for s in slots
                if self.p.is_signed_off(s.staff_id, bench_id, day)
            ]
            if not trainees:
                continue
            for trainee in trainees:
                if not supervisors:
                    # No signed-off person can work this bench today, so the
                    # trainee cannot be placed here at all.
                    self.model.Add(self.x[trainee] == 0)
                    continue
                self.model.Add(
                    sum(self.x[s] for s in supervisors) >= 1
                ).OnlyEnforceIf(self.x[trainee])

    def _apply_pins(self) -> None:
        if self.drop_pins:
            return
        for pin in self.p.pins:
            slot = Slot(pin.staff_id, pin.work_date, pin.shift_id, pin.bench_id)
            if slot in self.x:
                self.model.Add(self.x[slot] == 1)
            else:
                person = self.p.person(pin.staff_id)
                bench = self.p.bench(pin.bench_id)
                self.notes.append(
                    f"Pin ignored: {person.full_name} cannot work {bench.name} "
                    f"on {pin.work_date:%a %d %b}."
                )

    # -- rules --------------------------------------------------------------

    def _apply_rules(self) -> None:
        if self.p.history and any(
            r.action == "max_consecutive_days" and r.status == "active"
            for r in self.p.rules
        ):
            self.notes.append(
                f"Consecutive-day rules look back at {len(self.p.history)} "
                "assignments from last week's published rota."
            )
        for rule in self.p.rules:
            if rule.status != "active":
                continue
            if self.soften_rules and rule.is_hard:
                # Diagnostic pass: let a hard rule break, expensively, so the
                # solver has to name which one it could not honour.
                rule = replace(rule, is_hard=False, weight=10_000)
            handler = getattr(self, f"_rule_{rule.action}", None)
            if handler is None:
                self.notes.append(f"Rule '{rule.name}' has no handler for {rule.action}.")
                continue
            handler(rule)

    def _scoped(self, rule: Rule) -> list[Slot]:
        return scope_slots(self.p, rule, self.slots)

    def _group(self, slots: list[Slot], *keys: str) -> dict[tuple, list[Slot]]:
        grouped: dict[tuple, list[Slot]] = defaultdict(list)
        for slot in slots:
            grouped[tuple(getattr(slot, k) for k in keys)].append(slot)
        return grouped

    def _where(self, day: date, bench_id: str) -> str:
        return f"{self.p.bench(bench_id).name} on {WEEKDAY_NAMES[day.isoweekday()]}"

    def _soft_or_hard_at_least(
        self, rule: Rule, slots: list[Slot], n: int, day: date, bench_id: str
    ) -> None:
        total = sum(self.x[s] for s in slots) if slots else 0
        if rule.is_hard:
            self.model.Add(total >= n)
            return
        breached = self.model.NewBoolVar(f"breach[{rule.id[:8]},{day},{bench_id[:8]}]")
        self.model.Add(total >= n).OnlyEnforceIf(breached.Not())
        self.model.Add(total <= n - 1).OnlyEnforceIf(breached)
        where = self._where(day, bench_id)
        self.soft.append(
            SoftTerm(
                breached, rule.weight,
                lambda _v, where=where, n=n: f"{where} has fewer than {n} of the people this rule asks for",
                rule=rule, work_date=day, bench_id=bench_id,
            )
        )

    def _bench_day_groups(self, rule: Rule) -> list[tuple[date, str, str, list[Slot]]]:
        """Every bench-day the rule covers, with the slots that count towards it.

        The scoped list can be empty while the group is still in scope: that is
        a bench-day where nobody qualifies, which for a hard rule is a conflict
        and not something to skip over.
        """
        out = []
        for (day, shift_id, bench_id), slots in self._slots_by(
            "work_date", "shift_id", "bench_id"
        ).items():
            if not group_in_scope(self.p, rule, slots):
                continue
            counting = [s for s in slots if matches(self.p, rule.conditions, s)]
            out.append((day, shift_id, bench_id, counting))
        return out

    def _rule_requires_at_least(self, rule: Rule) -> None:
        n = int(rule.params.get("n", 1))
        for day, _shift, bench_id, slots in self._bench_day_groups(rule):
            self._soft_or_hard_at_least(rule, slots, n, day, bench_id)

    def _rule_requires_at_most(self, rule: Rule) -> None:
        n = int(rule.params.get("n", 1))
        for day, _shift, bench_id, slots in self._bench_day_groups(rule):
            if not slots:
                continue
            total = sum(self.x[s] for s in slots)
            if rule.is_hard:
                self.model.Add(total <= n)
                continue
            over = self.model.NewIntVar(0, len(slots), f"over[{rule.id[:8]},{day}]")
            self.model.Add(over >= total - n)
            where = self._where(day, bench_id)
            self.soft.append(
                SoftTerm(
                    over, rule.weight,
                    lambda v, where=where, n=n: f"{where} is {v} over the limit of {n}",
                    rule=rule, work_date=day, bench_id=bench_id,
                )
            )

    def _rule_cannot_be_assigned(self, rule: Rule) -> None:
        for slot in self._scoped(rule):
            if rule.is_hard:
                self.model.Add(self.x[slot] == 0)
                continue
            person = self.p.person(slot.staff_id)
            where = self._where(slot.work_date, slot.bench_id)
            self.soft.append(
                SoftTerm(
                    self.x[slot], rule.weight,
                    lambda _v, who=person.full_name, where=where: f"{who} is on {where}",
                    rule=rule, work_date=slot.work_date, bench_id=slot.bench_id,
                    staff_id=slot.staff_id,
                )
            )

    def _rule_must_be_assigned(self, rule: Rule) -> None:
        for (staff_id, day), slots in self._group(
            self._scoped(rule), "staff_id", "work_date"
        ).items():
            total = sum(self.x[s] for s in slots)
            if rule.is_hard:
                self.model.Add(total >= 1)
                continue
            breached = self.model.NewBoolVar(f"must[{rule.id[:8]},{staff_id[:8]},{day}]")
            self.model.Add(total >= 1).OnlyEnforceIf(breached.Not())
            self.model.Add(total == 0).OnlyEnforceIf(breached)
            who = self.p.person(staff_id).full_name
            self.soft.append(
                SoftTerm(
                    breached, rule.weight,
                    lambda _v, who=who, day=day: f"{who} is not where this rule wants them on {day:%A}",
                    rule=rule, work_date=day, staff_id=staff_id,
                )
            )

    def _rule_requires_supervisor(self, rule: Rule) -> None:
        wanted = rule.params.get("supervisor_level", "trainer")
        from .models import LEVEL_RANK

        for day, _shift, bench_id, slots in self._bench_day_groups(rule):
            if not slots:
                continue
            supervisors = []
            for slot in slots:
                comp = self.p.competency(slot.staff_id, bench_id)
                if comp and comp.valid_on(day) and LEVEL_RANK[comp.level] >= LEVEL_RANK[wanted]:
                    supervisors.append(slot)

            anyone = sum(self.x[s] for s in slots)
            sup_total = sum(self.x[s] for s in supervisors) if supervisors else 0
            staffed = self.model.NewBoolVar(f"staffed[{day},{bench_id[:8]}]")
            self.model.Add(anyone >= 1).OnlyEnforceIf(staffed)
            self.model.Add(anyone == 0).OnlyEnforceIf(staffed.Not())

            where = self._where(day, bench_id)
            if rule.is_hard:
                self.model.Add(sup_total >= 1).OnlyEnforceIf(staffed)
                continue
            breached = self.model.NewBoolVar(f"sup[{rule.id[:8]},{day},{bench_id[:8]}]")
            self.model.Add(sup_total >= 1).OnlyEnforceIf([staffed, breached.Not()])
            self.soft.append(
                SoftTerm(
                    breached, rule.weight,
                    lambda _v, where=where, wanted=wanted: f"{where} has no {wanted} on it",
                    rule=rule, work_date=day, bench_id=bench_id,
                )
            )

    def _rule_same_bench_all_week(self, rule: Rule) -> None:
        for (staff_id,), slots in self._group(self._scoped(rule), "staff_id").items():
            by_bench: dict[str, list[Slot]] = defaultdict(list)
            for slot in slots:
                by_bench[slot.bench_id].append(slot)
            if len(by_bench) <= 1:
                continue

            used = []
            for bench_id, bench_slots in by_bench.items():
                y = self.model.NewBoolVar(f"uses[{staff_id[:8]},{bench_id[:8]}]")
                for slot in bench_slots:
                    self.model.AddImplication(self.x[slot], y)
                self.model.Add(sum(self.x[s] for s in bench_slots) >= 1).OnlyEnforceIf(y)
                used.append(y)

            total_used = sum(used)
            who = self.p.person(staff_id).full_name
            if rule.is_hard:
                self.model.Add(total_used <= 1)
                continue
            extra = self.model.NewIntVar(0, len(used), f"extra[{staff_id[:8]}]")
            self.model.Add(extra >= total_used - 1)
            self.soft.append(
                SoftTerm(
                    extra, rule.weight,
                    lambda v, who=who: f"{who} is spread across {v + 1} benches this week",
                    rule=rule, staff_id=staff_id,
                )
            )

    def _rule_max_shifts_in_period(self, rule: Rule) -> None:
        n = int(rule.params.get("n", 5))
        for (staff_id,), slots in self._group(self._scoped(rule), "staff_id").items():
            total = sum(self.x[s] for s in slots)
            who = self.p.person(staff_id).full_name
            if rule.is_hard:
                self.model.Add(total <= n)
                continue
            over = self.model.NewIntVar(0, len(slots), f"cap[{rule.id[:8]},{staff_id[:8]}]")
            self.model.Add(over >= total - n)
            self.soft.append(
                SoftTerm(
                    over, rule.weight,
                    lambda v, who=who, n=n: f"{who} is {v} day(s) over the limit of {n}",
                    rule=rule, staff_id=staff_id,
                )
            )

    def _rule_max_consecutive_days(self, rule: Rule) -> None:
        n = max(1, int(rule.params.get("n", 1)))
        same_bench = rule.params.get("same_bench") is not False

        # person (and bench, in same-bench mode) -> date -> matching slots
        grouped: dict[tuple, dict[date, list[Slot]]] = defaultdict(
            lambda: defaultdict(list)
        )
        for slot in self._scoped(rule):
            key = (slot.staff_id, slot.bench_id) if same_bench else (slot.staff_id,)
            grouped[key][slot.work_date].append(slot)

        # What each group already worked at the end of last week's published
        # rota. Only the n days butting up against this Monday can extend a
        # run into this week; the rest of the history cannot matter.
        week_start = self.p.dates[0]
        history_dates = [week_start - timedelta(days=n - i) for i in range(n)]
        history_set = set(history_dates)
        staff_ids = {s.id for s in self.p.staff}
        bench_ids = {b.id for b in self.p.benches}
        worked_before: dict[tuple, set[date]] = defaultdict(set)
        for past in self.p.history:
            if past.work_date not in history_set:
                continue
            if past.staff_id not in staff_ids or past.bench_id not in bench_ids:
                continue
            past_slot = Slot(past.staff_id, past.work_date, past.shift_id,
                             past.bench_id)
            if not matches(self.p, rule.conditions, past_slot):
                continue
            key = (past.staff_id, past.bench_id) if same_bench else (past.staff_id,)
            worked_before[key].add(past.work_date)

        # The dates are in order, so every slice is a run of calendar-
        # consecutive days. A day with no matching slot contributes nothing,
        # which is right: a day you cannot work breaks the run. History days
        # are constants, folded into the right hand side.
        dates = history_dates + self.p.dates
        for key, by_date in grouped.items():
            staff_id = key[0]
            bench_id = key[1] if same_bench else None
            worked = worked_before.get(key, set())
            for start in range(len(dates) - n):
                window = dates[start : start + n + 1]
                already = sum(1 for d in window if d in worked)
                if already + sum(1 for d in window if d in by_date) <= n:
                    continue
                counting = [s for d in window for s in by_date.get(d, [])]
                if not counting:
                    continue
                # One bench per day keeps each day's sum at 0 or 1, so this is
                # exactly "at most n of these n+1 consecutive days".
                total = sum(self.x[s] for s in counting)
                if rule.is_hard:
                    self.model.Add(total <= n - already)
                    continue
                over = self.model.NewIntVar(
                    0, 1, f"run[{rule.id[:8]},{staff_id[:8]},{window[0]}]"
                )
                self.model.Add(over >= total - (n - already))
                who = self.p.person(staff_id).full_name
                doing = f"is on {self.p.bench(bench_id).name}" if same_bench else "works"
                plural = "" if n == 1 else "s"
                breach_date = next((d for d in window if d in by_date), window[0])
                self.soft.append(
                    SoftTerm(
                        over, rule.weight,
                        lambda _v, who=who, doing=doing, n=n, plural=plural:
                            f"{who} {doing} more than {n} day{plural} in a row",
                        rule=rule, work_date=breach_date, staff_id=staff_id,
                        bench_id=bench_id,
                    )
                )

    def _rule_min_days_in_period(self, rule: Rule) -> None:
        n = max(1, int(rule.params.get("n", 1)))
        by_person = self._group(self._scoped(rule), "staff_id")

        # A person the rule names with no matching slot at all can never meet
        # the floor. For a hard rule that is a conflict, not a pass.
        for staff_id in condition_people(self.p, rule):
            if (staff_id,) in by_person:
                continue
            who = self.p.person(staff_id).full_name
            if rule.is_hard:
                self.model.Add(0 >= n)
            self.notes.append(
                f"Rule '{rule.name}': {who} has no eligible day it could count."
            )

        for (staff_id,), slots in by_person.items():
            # One bench per day caps each day at 1, so ≥ n means n distinct days.
            total = sum(self.x[s] for s in slots)
            who = self.p.person(staff_id).full_name
            if rule.is_hard:
                self.model.Add(total >= n)
                continue
            short = self.model.NewIntVar(
                0, n, f"short_days[{rule.id[:8]},{staff_id[:8]}]"
            )
            self.model.Add(total + short >= n)
            self.soft.append(
                SoftTerm(
                    short, rule.weight,
                    lambda v, who=who, n=n:
                        f"{who} is {v} day(s) short of the {n} this rule asks for",
                    rule=rule, staff_id=staff_id,
                )
            )

    def _rule_must_be_together(self, rule: Rule) -> None:
        people = condition_people(self.p, rule)
        if len(people) < 2:
            self.notes.append(
                f"Rule '{rule.name}' names fewer than two people, so it does nothing."
            )
            return

        # The person conditions say who is kept together; the rest of the
        # tree says where and when it applies.
        where = strip_staff_conditions(rule.conditions)
        wanted = set(people)
        by_person_date: dict[str, dict[date, list[Slot]]] = defaultdict(
            lambda: defaultdict(list)
        )
        for slot in self.slots:
            if slot.staff_id in wanted and matches(self.p, where, slot):
                by_person_date[slot.staff_id][slot.work_date].append(slot)

        for a in range(len(people)):
            for b in range(a + 1, len(people)):
                days_a = by_person_date.get(people[a])
                days_b = by_person_date.get(people[b])
                if not days_a or not days_b:
                    continue
                for day in self.p.dates:
                    slots_a = days_a.get(day, [])
                    slots_b = days_b.get(day, [])
                    if not slots_a or not slots_b:
                        continue
                    # Forbid "A on bench x while B works a different bench":
                    #   x[a] + Σ x[B, elsewhere] ≤ 1  for each of A's slots.
                    # One direction covers both people: any day they work apart
                    # has a violated row for A's actual bench.
                    rows = []
                    for sa in slots_a:
                        elsewhere = [s for s in slots_b if s.bench_id != sa.bench_id]
                        if elsewhere:
                            rows.append(self.x[sa] + sum(self.x[s] for s in elsewhere))
                    if not rows:
                        continue
                    if rule.is_hard:
                        for row in rows:
                            self.model.Add(row <= 1)
                        continue
                    breach = self.model.NewBoolVar(
                        f"apart[{rule.id[:8]},{people[a][:8]},{day}]"
                    )
                    for row in rows:
                        self.model.Add(row <= 1).OnlyEnforceIf(breach.Not())
                    name_a = self.p.person(people[a]).full_name
                    name_b = self.p.person(people[b]).full_name
                    self.soft.append(
                        SoftTerm(
                            breach, rule.weight,
                            lambda _v, name_a=name_a, name_b=name_b, day=day:
                                f"{name_a} and {name_b} are on different benches on {day:%A}",
                            rule=rule, work_date=day,
                        )
                    )

    def _rule_not_together(self, rule: Rule) -> None:
        people = set(condition_people(self.p, rule))
        if len(people) < 2:
            self.notes.append(
                f"Rule '{rule.name}' names fewer than two people, so it does nothing."
            )
            return

        grouped = self._group(
            [s for s in self.slots if s.staff_id in people],
            "work_date", "shift_id", "bench_id",
        )
        for (day, _shift, bench_id), slots in grouped.items():
            if len(slots) < 2:
                continue
            total = sum(self.x[s] for s in slots)
            where = self._where(day, bench_id)
            if rule.is_hard:
                self.model.Add(total <= 1)
                continue
            over = self.model.NewIntVar(0, len(slots), f"pair[{rule.id[:8]},{day}]")
            self.model.Add(over >= total - 1)
            self.soft.append(
                SoftTerm(
                    over, rule.weight,
                    lambda _v, where=where: f"people this rule keeps apart are together on {where}",
                    rule=rule, work_date=day, bench_id=bench_id,
                )
            )

    # -- objective ----------------------------------------------------------

    def _continuity_staff(self) -> set[str]:
        """Staff an active same_bench_all_week rule deliberately keeps put."""
        parked: set[str] = set()
        for rule in self.p.rules:
            if rule.status != "active" or rule.action != "same_bench_all_week":
                continue
            parked.update(s.staff_id for s in self._scoped(rule))
        return parked

    def _objective(self) -> None:
        p = self.p
        terms: list[Any] = []

        scale = p.setting("weight_soft_breach_scale")
        for term in self.soft:
            terms.append(term.expr * term.weight * scale)

        # Utilisation: an available person left off the rota entirely is waste,
        # and a trainee left off is a week of training lost.
        w_idle = p.setting("weight_idle_staff")
        w_trainee = p.setting("weight_trainee_placement")
        by_person_day = self._slots_by("staff_id", "work_date")
        for (staff_id, day), slots in by_person_day.items():
            worked = sum(self.x[s] for s in slots)
            weight = w_idle
            if p.person(staff_id).grade == "trainee":
                weight += w_trainee
            terms.append((1 - worked) * weight)

        # Rotation: doing the same bench again this week is the thing people
        # complain about, so each repeat costs.
        w_repeat = p.setting("weight_rotation_repeat")
        repeats_per_person: dict[str, list[Any]] = defaultdict(list)
        for (staff_id, bench_id), slots in self._slots_by("staff_id", "bench_id").items():
            if len(slots) < 2:
                continue
            count = sum(self.x[s] for s in slots)
            repeat = self.model.NewIntVar(0, len(slots), f"rep[{staff_id[:8]},{bench_id[:8]}]")
            self.model.Add(repeat >= count - 1)
            terms.append(repeat * w_repeat)
            repeats_per_person[staff_id].append(repeat)

        # Fairness: and the burden of repeating should not land on one person.
        # Anyone a same_bench_all_week rule deliberately parks on one bench is
        # left out of this, or their requested continuity would read as unfair
        # and drag everybody else's rota around to compensate.
        w_fair = p.setting("weight_fairness_spread")
        parked = self._continuity_staff()
        if w_fair and len(repeats_per_person) - len(parked) > 1:
            totals = []
            for staff_id, reps in repeats_per_person.items():
                if staff_id in parked:
                    continue
                total = self.model.NewIntVar(0, 7, f"reptotal[{staff_id[:8]}]")
                self.model.Add(total == sum(reps))
                totals.append(total)
            if len(totals) > 1:
                hi = self.model.NewIntVar(0, 7, "rep_max")
                lo = self.model.NewIntVar(0, 7, "rep_min")
                self.model.AddMaxEquality(hi, totals)
                self.model.AddMinEquality(lo, totals)
                terms.append((hi - lo) * w_fair)

        # Diagnostic pass only: leaving a bench short is far worse than any of
        # the above, so the relaxed solve still tries hardest to cover.
        for short in self.shortfall.values():
            terms.append(short * 100_000)

        self.model.Minimize(sum(terms))

    # -- solving ------------------------------------------------------------

    def solve(self) -> tuple[cp_model.CpSolver, int]:
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = float(self.p.setting("max_solve_seconds"))
        solver.parameters.random_seed = self.p.setting("random_seed")
        # Several workers is 16x faster here, and CP-SAT races between them, so
        # among the many equally optimal rotas it returns whichever was found
        # first. That is fine: the fixtures record the optimum's value and the
        # counts, which are the same whichever optimum you land on, never the
        # arbitrary choice itself. Drop to one worker to reproduce an exact
        # rota while debugging — see --deterministic.
        solver.parameters.num_workers = int(self.p.settings.get("cp_sat_workers", 8))
        status = solver.Solve(self.model)
        return solver, status


def solve(problem: Problem) -> Solution:
    """Solve a week. Falls back to a diagnostic pass if the week is impossible."""
    started = time.monotonic()
    rota = RotaModel(problem)
    solver, status = rota.solve()
    elapsed = int((time.monotonic() - started) * 1000)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        assignments = _extract(problem, rota, solver)
        breaches = _breaches(rota, solver)
        return Solution(
            status="solved_with_breaches" if breaches else "solved",
            assignments=assignments,
            breaches=breaches,
            objective_value=int(solver.ObjectiveValue()),
            solve_ms=elapsed,
            log="\n".join(rota.notes),
        )

    if status == cp_model.INFEASIBLE:
        from .diagnose import diagnose

        report = diagnose(problem)
        return Solution(
            status="infeasible",
            solve_ms=int((time.monotonic() - started) * 1000),
            infeasible_report=report,
            log="\n".join(rota.notes),
        )

    return Solution(
        status="error",
        solve_ms=elapsed,
        log=f"Solver returned {solver.StatusName(status)}.\n" + "\n".join(rota.notes),
    )


def _extract(problem: Problem, rota: RotaModel, solver: cp_model.CpSolver) -> list[AssignmentOut]:
    pinned = {
        (p.work_date, p.shift_id, p.bench_id, p.staff_id) for p in problem.pins
    }
    out = []
    for slot, var in rota.x.items():
        if solver.Value(var):
            key = (slot.work_date, slot.shift_id, slot.bench_id, slot.staff_id)
            out.append(
                AssignmentOut(
                    work_date=slot.work_date,
                    shift_id=slot.shift_id,
                    bench_id=slot.bench_id,
                    staff_id=slot.staff_id,
                    is_pinned=key in pinned,
                )
            )
    out.sort(key=lambda a: (a.work_date, a.bench_id, a.staff_id))
    return out


def _breaches(rota: RotaModel, solver: cp_model.CpSolver) -> list[BreachOut]:
    out = []
    for term in rota.soft:
        value = solver.Value(term.expr)
        if value <= 0:
            continue
        out.append(
            BreachOut(
                rule_id=term.rule.id if term.rule else None,
                rule_name=term.rule.name if term.rule else "Objective",
                weight=term.weight,
                detail=term.describe(value),
                work_date=term.work_date,
                shift_id=term.shift_id,
                bench_id=term.bench_id,
                staff_id=term.staff_id,
            )
        )
    return out
