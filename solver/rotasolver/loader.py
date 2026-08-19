"""Read a week's problem out of Supabase."""

from __future__ import annotations

from datetime import date
from typing import Any

from .models import (
    Absence,
    Availability,
    Bench,
    Competency,
    DEFAULT_SETTINGS,
    Pin,
    Problem,
    Requirement,
    Rule,
    Shift,
    Staff,
)
from .supabase import Supabase


def _date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def load_problem(db: Supabase, week_start: date) -> Problem:
    week_end = date.fromordinal(week_start.toordinal() + 6)

    shifts = [
        Shift(id=r["id"], code=r["code"], name=r["name"], sort_order=r["sort_order"])
        for r in db.select("shift", "id,code,name,sort_order", order="sort_order")
    ]

    benches = [
        Bench(
            id=r["id"],
            name=r["name"],
            group_name=(r.get("bench_group") or {}).get("name") if r.get("bench_group") else None,
            required_level=r["required_level"],
            sort_order=r["sort_order"],
        )
        for r in db.select(
            "bench",
            "id,name,required_level,sort_order,is_active,bench_group(name)",
            is_active="eq.true",
            order="sort_order",
        )
    ]
    bench_ids = {b.id for b in benches}

    requirements = [
        Requirement(
            bench_id=r["bench_id"],
            shift_id=r["shift_id"],
            label=r["label"],
            weekdays=frozenset(r["weekdays"] or []),
            min_staff=r["min_staff"],
            max_staff=r["max_staff"],
            required_level=r["required_level"],
        )
        for r in db.select("bench_shift_requirement")
        if r["bench_id"] in bench_ids
    ]

    staff = [
        Staff(
            id=r["id"],
            code=r["staff_code"],
            full_name=r["full_name"],
            grade=r["grade"],
            status=r["status"],
            fte=float(r["fte"]),
        )
        for r in db.select(
            "staff", "id,staff_code,full_name,grade,status,fte",
            status="eq.active", order="full_name",
        )
    ]
    staff_ids = {s.id for s in staff}

    availability = [
        Availability(
            staff_id=r["staff_id"],
            weekday=r["weekday"],
            shift_id=r["shift_id"],
            is_available=r["is_available"],
        )
        for r in db.select("availability")
        if r["staff_id"] in staff_ids and r["is_available"]
    ]

    # Only absences that touch the week matter.
    absences = [
        Absence(
            staff_id=r["staff_id"],
            starts_on=_date(r["starts_on"]),
            ends_on=_date(r["ends_on"]),
            kind=r["kind"],
        )
        for r in db.select(
            "absence", "*",
            starts_on=f"lte.{week_end.isoformat()}",
            ends_on=f"gte.{week_start.isoformat()}",
        )
        if r["staff_id"] in staff_ids
    ]

    competencies = [
        Competency(
            staff_id=r["staff_id"],
            bench_id=r["bench_id"],
            level=r["level"],
            expires_on=_date(r["expires_on"]),
        )
        for r in db.select("competency", "staff_id,bench_id,level,expires_on")
        if r["staff_id"] in staff_ids and r["bench_id"] in bench_ids
    ]

    rules = [
        Rule(
            id=r["id"],
            name=r["name"],
            action=r["action"],
            params=r.get("params") or {},
            conditions=r.get("conditions") or {},
            is_hard=r["is_hard"],
            weight=r["weight"],
            status=r["status"],
            plain_english=r.get("plain_english"),
            scope=r["scope"],
        )
        for r in db.select("rule", "*", status="eq.active")
    ]

    pins = [
        Pin(
            work_date=_date(r["work_date"]),
            shift_id=r["shift_id"],
            bench_id=r["bench_id"],
            staff_id=r["staff_id"],
            reason=r.get("reason"),
        )
        for r in db.select("pin", "*", week_start=f"eq.{week_start.isoformat()}")
        if r["staff_id"] in staff_ids and r["bench_id"] in bench_ids
    ]

    settings = dict(DEFAULT_SETTINGS)
    for row in db.select("solver_setting", "key,value"):
        try:
            settings[row["key"]] = int(row["value"])
        except (TypeError, ValueError):
            continue

    return Problem(
        week_start=week_start,
        shifts=shifts,
        benches=benches,
        requirements=requirements,
        staff=staff,
        competencies=competencies,
        absences=absences,
        availability=availability,
        rules=rules,
        pins=pins,
        settings=settings,
    )
