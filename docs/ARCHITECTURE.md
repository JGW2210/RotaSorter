# How RotaSorter fits together

```
  ┌──────────────────────────────────────┐        ┌────────────────────────┐
  │  React app — GitHub Pages            │  read  │  Supabase              │
  │                                      │ ─────► │  Postgres + RLS + Auth │
  │  ┌────────────────────────────────┐  │ ◄───── │                        │
  │  │ Web Worker                     │  │  write └────────────────────────┘
  │  │   HiGHS (MILP) compiled to     │  │
  │  │   WebAssembly                  │  │        ┌────────────────────────┐
  │  └────────────────────────────────┘  │        │  solver/ — Python +    │
  └──────────────────────────────────────┘        │  OR-Tools CP-SAT       │
                                                  │  reference only, CI    │
                                                  └────────────────────────┘
```

Two moving parts, two credentials, and both of those are safe to publish. There
is no server, no queue and no background worker.

## Why the solver is in the browser

The first version put Google OR-Tools CP-SAT on a GitHub Actions runner, because
CP-SAT has no browser build. That worked, but it cost an edge function holding a
GitHub token, a `repository_dispatch`, a cron fallback, a service role key in
Actions secrets, a Realtime subscription and two extra run states — all to make
a 0.8 second computation take forty seconds.

Auditing the model settled it. It used `Add` (linear), `AddAtMostOne`,
`AddImplication`, `AddMax/MinEquality` and ten `OnlyEnforceIf` sites. Every one
of those is a linear constraint or a standard indicator constraint. There was no
interval, no cumulative, no table, no all-different: nothing that needs a
constraint programming engine. It was a mixed-integer linear program of about
700 binaries all along, and MILP does have a browser build.

So the model is now built in TypeScript, serialised to CPLEX LP format, and
solved by [HiGHS](https://highs.dev) compiled to WebAssembly. Each
`OnlyEnforceIf` became an explicit indicator encoding:

```
hard   Σx ≥ n
soft   Σx + n·breach ≥ n,   cost weight·breach
```

The solver drives `breach` to zero wherever it can, because it costs.

**What was kept.** Proven infeasibility. The whole point of the infeasibility
screen is that the solver can show no rota exists, and that relaxing one class
of constraint at a time locates why. A heuristic can only fail to find a
solution, which is the "no solution found" the design spec forbids. HiGHS is
exact, so all three diagnosis passes ported unchanged.

**What it costs.** About 1.7 seconds to prove the seeded week optimal, against
0.8 in native CP-SAT. Fine here; if this ever grows to sixty staff and multiple
weeks, the browser stops being the right place.

## The worker, and why the timer is honest

1.7 seconds on the main thread is 1.7 seconds of frozen interface, and the
design spec asks for an elapsed counter and a cancel button during a solve.
Both would be a lie. The solve therefore runs in a Web Worker.

The worker is kept alive between solves: compiling the 3.4MB wasm costs more
than the solve, and the interaction this exists for — pin something, re-solve
around it, look, pin again — would pay that on every iteration otherwise. It is
warmed when the Rota Board mounts, so the first Generate does not pay for it,
and terminated on Cancel, because there is no other way to stop wasm mid-solve.

The wasm is a separate 3.4MB asset, fetched on first use, not part of the main
bundle. It needs no COOP/COEP headers and no cross-origin isolation, which is
just as well: GitHub Pages cannot set them.

## Solving and recording

The browser solves, then writes the finished run. That ordering matters: a tab
closed mid-solve simply produces no run, rather than leaving a row stuck at
`running` that nothing will ever finish.

`rota_run` keeps `queued` and `running` in its status enum. Rows written by the
old pipeline are still valid history and the Runs screen still renders them.

## The reference solver

`solver/` is the same model in Python with CP-SAT. It is not in the deploy path
and never writes to the database. It is the oracle:

- `python -m rotasolver.export_fixture` writes four weeks and its own answers to
  `web/src/solver/__fixtures__` — the seeded week, the same week with no rules
  at all, one with a pin, and one made infeasible by a hard rule.
- `web/src/solver/crosscheck.test.ts` solves each with the browser solver and
  asserts the same verdict, the same optimal objective value, the same soft
  rules breached, and for the infeasible case the same conflict and bench.
- CI regenerates the fixtures and fails if the reference solver's answers moved.

Equal optima is the strong claim. Both are exact optimisers, so a mis-ported
constraint or a wrong weight shows up as a different optimum. That check earned
its place immediately: it caught the port dropping the objective contribution of
pinned variables, which made a pinned week score 40 worse than the identical
unpinned one.

The fixtures record the optimum's **value** and the counts, never a particular
rota. A week usually has many rotas of equal cost, and CP-SAT runs several
workers that race, so which one comes back varies between runs. Storing one
would make the fixture drift for no reason — it did, until the fixtures were
narrowed to what is actually determined. Coverage, pins and trainee supervision
are checked directly against the problem rather than against a stored answer,
which is a better test anyway: it asserts the rota is correct, not that it is
the same as last time. CI exports twice and diffs the two to catch any
reintroduction of this.

`--deterministic` drops CP-SAT to a single worker when an exact rota needs
reproducing while debugging. It is around 16x slower, which is why it is not
the default.

## The data model

Three additions beyond the tables the design spec lists:

**`competency_document`.** The spec models competency as one staff-to-bench
pairing with a document reference. The register is not shaped like that: a bench
has several documents and people sign off one at a time. Urines alone is 93,
411, 412 and 394. `competency` stays as the authoritative bench-level record the
matrix edits and the solver reads; `staff_document` holds the evidence trail
underneath it.

**`bench_shift_requirement.weekdays`.** Not every bench runs every day. Mycology
is Thursday, reference lab reports are read on a Wednesday. Without this the
week asks for more benches than there are people to staff them. The `label`
column lets one bench carry a separate, smaller weekend requirement.

**`pin` as its own table.** Pins are solver *inputs*; assignments are *outputs*.
Keeping them apart means a re-solve can discard every assignment for the week
and still honour every human decision, and it is what lets the diagnosis ask
"does this week solve if I let the pins go?".

## The model

One boolean per legal (person, day, shift, bench). A slot only exists if the
person is active, contracted that weekday, not absent, and holds a valid
competency — so the impossible is never modelled, only the undesirable.

Hard: one bench per person per day, coverage minimums and maximums, pins,
trainee supervision, and every active hard rule.

**Trainee supervision** is the constraint with real cost. A trainee counts
towards cover but may never be alone on a bench, so placing one where a single
person is needed consumes two. Three trainees therefore need roughly two people
of slack, which is why the seeded roster leaves two to four.

The objective, in rough order of weight:

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

Rotation is also what makes this a real MIP rather than a matching problem:
removing it drops the solve from 1.6s to 0.14s.

## Explaining an impossible week

`web/src/solver/diagnose.ts` re-solves with one class of constraint relaxed at a
time and reports the first thing that gives:

1. **Coverage** — minimums become soft at a large penalty. Any bench-day left
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
by hand in the dashboard, so anyone who can sign in is trusted to run a rota.
`profile.role` and the `app_role()` helper exist so this can be tightened to
read-only viewers without a migration.

Moving the solver into the browser removed the only component that needed to
bypass RLS. Nothing in this project uses the service role key.

## Repository layout

```
supabase/migrations/   schema, RLS, views and RPCs
supabase/seed/         generate_seed.py plus the SQL it emits
web/src/solver/        the MIP: model, LP serialiser, rules, diagnosis, worker
web/src/solver/__fixtures__/  weeks and answers exported by the reference solver
web/src/lib/           pure logic: week maths, coverage, pivots, rule text
web/src/screens/       one file per section of the left rail
solver/rotasolver/     the Python reference implementation
.github/workflows/     CI and the Pages deploy
```

`web/src/lib` and `web/src/solver` are deliberately free of React so the parts
worth testing can be tested directly.
