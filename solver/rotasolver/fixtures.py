"""Build the seeded week as an in-memory Problem.

The data is read straight out of supabase/seed/generate_seed.py so the fixture
and the SQL cannot drift apart. Ids are natural keys (staff code, bench name,
shift code) rather than uuids, which keeps test failures readable.

One deliberate simplification: routine competency expiries are dropped, because
the generator draws them at random three years out and every one of them is
valid throughout the seeded week. The two expiries that do bite — Kyle Mbeki on
Faeces Microscopy and Reece Underhill on Deep Wounds/ Tissues — are kept.
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import date
from pathlib import Path
from typing import Any

from .models import (
    Absence,
    Availability,
    Bench,
    Competency,
    Problem,
    Requirement,
    Rule,
    Shift,
    Staff,
)

SEED_SCRIPT = (
    Path(__file__).resolve().parents[2] / "supabase" / "seed" / "generate_seed.py"
)


def _load_seed_module() -> Any:
    if "rotasorter_seed" in sys.modules:
        return sys.modules["rotasorter_seed"]
    spec = importlib.util.spec_from_file_location("rotasorter_seed", SEED_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import the seed generator at {SEED_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["rotasorter_seed"] = module
    spec.loader.exec_module(module)
    return module


def seeded_problem(week_start: date | None = None) -> Problem:
    seed = _load_seed_module()
    week = week_start or seed.SEED_WEEK

    shifts = [
        Shift(id=code, code=code, name=name, sort_order=order)
        for code, name, _s, _e, _d, order in seed.SHIFTS
    ]

    benches = [
        Bench(id=name, name=name, group_name=group, required_level=level, sort_order=i)
        for i, (name, group, _mn, _mx, level, _reqs, _docs) in enumerate(seed.BENCHES)
    ]

    requirements = [
        Requirement(
            bench_id=name,
            shift_id="DAY",
            label=label,
            weekdays=frozenset(days),
            min_staff=mn,
            max_staff=mx,
        )
        for name, _g, _dmn, _dmx, _l, reqs, _docs in seed.BENCHES
        for label, days, mn, mx in reqs
    ]

    staff = [
        Staff(id=code, code=code, full_name=name, grade=grade, fte=fte)
        for _k, code, name, grade, fte, _days, _started in seed.STAFF
    ]

    availability = [
        Availability(staff_id=code, weekday=day, shift_id="DAY")
        for _k, code, _n, _g, _f, days, _s in seed.STAFF
        for day in days
    ]

    absences = [
        Absence(
            staff_id=seed.STAFF_BY_KEY[key][1],
            starts_on=start,
            ends_on=end,
            kind=kind,
        )
        for key, start, end, kind, _note in seed.ABSENCES
    ]

    competencies = [
        Competency(
            staff_id=seed.STAFF_BY_KEY[key][1],
            bench_id=bench_name,
            level=level,
            expires_on=seed.EXPIRY_OVERRIDES.get((key, bench_name)),
        )
        for bench_name, holders in seed.COMPETENCY.items()
        for key, level in holders.items()
    ]

    rules = [
        Rule(
            id=r["name"],
            name=r["name"],
            action=r["action"],
            params=r["params"],
            conditions=r["conditions"],
            is_hard=r["is_hard"],
            weight=r["weight"],
            status=r["status"],
            plain_english=r["plain_english"],
            scope=r["scope"],
        )
        for r in seed.RULES
    ]

    settings = {key: value for key, value, _l, _d, _o in seed.SOLVER_SETTINGS}

    return Problem(
        week_start=week,
        shifts=shifts,
        benches=benches,
        requirements=requirements,
        staff=staff,
        competencies=competencies,
        absences=absences,
        availability=availability,
        rules=rules,
        pins=[],
        settings=settings,
    )
