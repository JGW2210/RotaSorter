# How RotaSorter fits together

```
  ┌───────────────────────┐         ┌──────────────────────────┐
  │  React app            │  read   │  Supabase                │
  │  GitHub Pages         │ ──────► │  Postgres + RLS + Auth   │
  │  (static, anon key)   │ ◄────── │                          │
  └───────────┬───────────┘ realtime└──────────┬───────────────┘
              │ queue_rota_run()               │ service role key
              │                                │
              ▼                                ▼
  ┌───────────────────────┐        ┌───────────────────────────┐
  │  Edge Function        │  fires │  GitHub Actions runner     │
  │  dispatch-solve       │ ─────► │  Python + OR-Tools CP-SAT  │
  │  (holds GitHub token) │        │  reads inputs, writes rota │
  └───────────────────────┘        └───────────────────────────┘
```

## Why the solver is not in the browser

The design spec assumed a client-side solve. Google OR-Tools CP-SAT is a C++
library with Python bindings; there is no browser build, and Supabase Edge
Functions run Deno, so neither of the two obvious homes can host it. The solver
therefore runs on a GitHub Actions runner, which keeps everything inside GitHub
and Supabase with nothing else to pay for or operate.

The cost is latency. A solve is 0.5–1s of actual work wrapped in 30–60s of
runner startup, so the interaction is asynchronous:

1. The board calls `queue_rota_run(week)`, which inserts a `rota_run` row as
   `queued` and cancels any earlier queued run for the same week, so
   double-clicking Generate cannot start two runners.
2. It then calls the `dispatch-solve` Edge Function, which holds the only
   credential that can start a workflow and fires a `repository_dispatch`.
3. The runner installs the solver, loads the week, solves, and writes back
   assignments, breaches and a status.
4. The board is subscribed to `rota_run` over Supabase Realtime, so it moves
   from *Queued* to *Solving* to *Solved* without polling.

If the dispatch fails — function not deployed, token expired, GitHub having a
bad day — the run simply stays `queued` and a ten-minute cron claims it with
`claim_next_run()`. A solve is never lost, only slower. The UI says so rather
than pretending it worked.

## The data model

Three additions beyond the tables the design spec lists, each earning its place:

**`competency_document`.** The spec models competency as one staff-to-bench
pairing with a document reference. The register is not shaped like that: a
bench has several documents and people sign off one at a time. Urines alone is
93, 411, 412 and 394. `competency` stays as the authoritative bench-level record
the matrix edits and the solver reads; `staff_document` holds the evidence
trail underneath it, and `recompute_competency_from_documents()` derives one
from the other for bulk updates.

**`bench_shift_requirement.weekdays`.** Not every bench runs every day.
Mycology is Thursday, reference lab reports are read on a Wednesday, CAT-3 is
set up Monday and Wednesday and read Wednesday and Friday. Without this the
week asks for more benches than there are people to staff them, and every rota
is infeasible. The `label` column lets one bench carry a separate, smaller
weekend requirement rather than repeating the weekday one.

**`pin` as its own table.** Pins are solver *inputs*; assignments are solver
*outputs*. Keeping them apart means a re-solve can discard every assignment for
the week and still honour every human decision. It is also what lets the
infeasibility diagnosis ask "does this week solve if I let the pins go?".

## The solver

One boolean per legal (person, day, shift, bench). A slot only exists if the
person is active, contracted that weekday, not absent, and holds a valid
competency on that bench — so the impossible is never modelled, only the
undesirable.

Hard constraints: one bench per person per day, coverage minimums and maximums,
pins, trainee supervision, and every active hard rule.

**Trainee supervision** is the constraint with real cost. A trainee counts
towards cover but may never be the only person on a bench, so placing one on a
bench that needs one person consumes two people. Three trainees therefore need
roughly two people of slack in the week, which is why the seeded roster leaves
two to four.

The objective trades off, in rough order of weight:

| Term | Default | What it buys |
|---|---|---|
| Soft rule breaches | rule's own weight | the manager's preferences |
| Idle staff | 40/day | nobody available is left off the rota |
| Trainee placement | +25/day | a trainee's week is not wasted |
| Fairness spread | 20 | repetition is not dumped on one person |
| Bench rotation | 12/repeat | variety across the week |

Idleness must cost more than repetition. It did not at first, and the solver
correctly concluded that benching a trainee for four days was cheaper than
giving her a second day on the same bench.

## Explaining an impossible week

"No solution found" is useless to the person holding the rota, so
`diagnose.py` re-solves with one class of constraint relaxed at a time and
reports the first thing that gives:

1. **Coverage** — make minimums soft with a large penalty. Any bench-day left
   short is named, with every competent person and where they actually went.
2. **Rules** — if coverage relaxes and it is still impossible, soften the hard
   rules and report which one could not hold.
3. **Pins** — if both relax cleanly, the manual overrides are the conflict.

Each conflict carries enough identifiers for the UI to turn its suggested
resolutions into working links.

## Security posture

RLS is on for every table from the start. `anon` holds no privileges at all;
`authenticated` has full read and write on the operational tables. That is
deliberate for a prototype with no self-registration: every account is created
by hand in the dashboard, so anyone who can sign in is someone trusted to run a
rota. `profile.role` exists so this can be tightened to read-only viewers
without a migration — `app_role()` in `0002_rls.sql` is the helper for it.

The worker uses the service role key and so bypasses RLS entirely. That key
lives in GitHub Actions secrets and nowhere else.

## Repository layout

```
supabase/migrations/   schema, RLS, views and RPCs
supabase/seed/         generate_seed.py plus the SQL it emits
supabase/functions/    the dispatch-solve edge function
solver/rotasolver/     models, loader, rule compiler, CP-SAT, diagnosis, CLI
solver/tests/          39 tests over the rules and the seeded week
web/src/lib/           pure logic: week maths, coverage, pivots, rule text
web/src/screens/       one file per section of the left rail
.github/workflows/     CI, the solver worker, the Pages deploy
```

`web/src/lib` is deliberately free of React so the parts worth testing can be
tested directly. `solver/rotasolver/models.py` has no Supabase import for the
same reason: the model can be built from a fixture and solved without a
database.
