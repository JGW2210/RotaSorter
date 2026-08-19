# RotaSorter

A prototype for sorting bench rotas in a clinical microbiology laboratory.

One person, usually a lab manager or senior BMS, sits down on a Thursday
afternoon and needs next week's rota to exist. They have benches that must be
covered, people with different competencies and different contracted patterns,
and a handful of awkward constraints they hold in their head. This makes the
holes visible and the fixes fast.

The single question the main screen answers without reading a word: **is
anything uncovered?**

**Synthetic staff only. No real employee records at any point.**

## What it is

| Part | Built with |
|---|---|
| Web app | React, TypeScript and Vite, deployed to GitHub Pages |
| Database and auth | Supabase, with row level security on every table |
| Solver | HiGHS compiled to WebAssembly, in a Web Worker in the browser |
| Reference solver | Google OR-Tools CP-SAT, Python, CI only |

The rota is solved in the tab you are looking at, in about two seconds. No
server, no queue, no background worker, and the only two credentials involved
are both safe to publish.

`solver/` holds the same model in CP-SAT. It is not part of the app: CI runs
both against the same weeks and fails if they disagree on feasibility or on the
value of the optimum. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting it running

[docs/SETUP.md](docs/SETUP.md) is the walkthrough: Supabase project, migrations,
seed data, and exactly which of the six credentials goes where. About half an
hour, no paid plan needed.

The short version:

```bash
# 1. Run supabase/migrations/*.sql then supabase/seed/*.sql in the SQL editor
# 2. Create yourself a user in the Supabase dashboard
# 3. Point the app at the project
cd web && cp ../.env.example .env.local && $EDITOR .env.local
npm install && npm run dev
```

To see the reference solver work with no database at all:

```bash
cd solver && pip install -e ".[dev]"
python -m rotasolver.cli --self-check --print
```

## The screens

- **Rota** — benches by days, or staff by days, over the same assignments.
  Coverage rails, drag to override, pins, re-solve, publish.
- **Staff** — who exists, their contracted pattern, their competencies.
- **Benches** — what needs covering, to what depth, and which benches have no
  resilience left.
- **Competency** — the matrix, editable, the shape people already recognise.
- **Rules** — the rule library, each shown as the sentence someone would say.
- **Runs** — every generation, with the rule set as it stood at the time.

## What is synthetic

Thirty staff over twenty benches, built from the provisional document register.
The week of 14 September 2026 is the one with data. Every bench runs every
weekday, which takes 21 people a day to cover and is what the roster is sized
for; the weekend stays a skeleton service of Urines and Blood Cultures.
[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) has the details, including the three
places this departs from the design spec.

## Tests

```bash
cd solver && python -m pytest -q      # 39 tests: rules, constraints, diagnosis
cd web && npm run test -- --run       # 67 tests, including the cross-check
```

The cross-check is the interesting one: it solves four weeks with both solvers
and asserts they reach the same verdict and the same optimal objective value.
Both are exact optimisers, so a mis-ported constraint shows up as a different
optimum.

CI runs both suites, re-runs the reference solver against the seeded week, and
fails if either the seed SQL or the cross-check fixtures have drifted from the
generators that produce them.
