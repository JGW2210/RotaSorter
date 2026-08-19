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
| Solver | Google OR-Tools CP-SAT, on a GitHub Actions runner |

The solver runs on a runner because OR-Tools has no browser build and Supabase
Edge Functions are Deno. The UI queues a run, an edge function starts the
workflow, and the board follows it over Supabase Realtime. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

To see the solver work with no database at all:

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

Twenty staff over twenty benches, built from the provisional document register.
The week of 14 September 2026 is the one with data, and it is deliberately
tight. Two benches are thin on purpose so the warnings have something to warn
about. [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) has the details, including the
three places this departs from the design spec.

## Tests

```bash
cd solver && python -m pytest -q      # 39 tests: rules, constraints, diagnosis
cd web && npm run test -- --run       # 41 tests: week maths, coverage, rule text
```

CI runs both, re-runs the solver against the seeded week, and fails if the seed
SQL has drifted from the generator that produces it.
