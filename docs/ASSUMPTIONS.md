# Assumptions, and where this departs from the spec

Everything the build decided that the design spec did not, and the three places
it deliberately does something different. Nothing here is hidden in the code.

## Departures from the spec

### The solver does not run client-side

The spec says "solver running client-side" and designs the solve states around a
1.4-second in-page solve. Google OR-Tools CP-SAT has no browser build, so this
was not possible while keeping OR-Tools, which the brief asked for by name.

The solver runs on a GitHub Actions runner. Section 4.3's four states survive
intact — the *Solving* state gains a queued phase and an elapsed counter driven
by Supabase Realtime rather than by solver callbacks, and the cancel control
still appears after three seconds. See `docs/ARCHITECTURE.md`.

### The Late shift is defined but not staffed

The spec's Settings screen lands on shift definitions, the grid carries a shift
filter, and its infeasibility example mentions "Tuesday late". The rota shape
chosen for the prototype is one assignee per bench per whole day, so seeding a
second shift would have meant splitting the roster across two shifts and losing
the headroom the week needs.

Both shifts exist in `shift`, the schema and UI handle several, and the Day
shift is the one with bench requirements. To turn Late on, add
`bench_shift_requirement` rows for it and the matching `availability` rows —
data changes, not code changes.

### Coverage is per weekday, not per shift alone

The spec's `bench` table has a single "Min staff, per shift". Twenty benches
each needing someone every weekday is 20+ people a day, against a roster of 20
with part-time patterns and leave, so every week would have been infeasible.

`bench_shift_requirement` therefore carries a `weekdays` array. Benches run on
the days they actually run: Mycology on Thursday, reference lab reports on
Wednesday, CAT-3 set up Monday and Wednesday and read Wednesday and Friday.
`bench.min_staff` and `bench.max_staff` remain as the defaults the Benches
screen edits.

## Decisions the spec left open

**A trainee counts towards cover but never works alone.** The brief said
trainees go on the bench regardless of sign-off. They are eligible for any bench
they are working through, and a hard constraint requires at least one signed-off
colleague on the same bench that day. This is the single most expensive
constraint in the model: a trainee on a bench needing one person consumes two.

**One bench per person per day.** The whole-day rota shape. It also stops one
person covering Day and Late back to back if the Late shift is ever staffed.

**Nobody available is left off the rota.** Idle staff cost more than bench
repetition in the objective, so the solver fills the week rather than buying
variety by benching people. This is a weight on Settings, not a hard rule.

**Competencies expire three years after assessment.** A routine interval, with
eight deliberate exceptions in the seed so the caution and expired states have
something to show. Expiry is checked against the *work date*, not today, so a
signoff lapsing mid-week removes that person from the back half of it.

**Weekends run a skeleton service.** Urines and Blood Cultures only, one person
each, covered by the three staff on Wednesday-to-Sunday patterns.

**60 days is "expiring soon"**, from the spec's Staff table. It is in
`v_staff_competency_summary` and `v_competency_matrix`, not in the app.

## The synthetic data

All invented. No real employee records at any point.

20 staff: 3 Senior BMS, 10 BMS, 4 Assistant Practitioners, 3 trainees. Fourteen
work Monday to Friday; the rest are 0.8 and 0.6 patterns and three
Wednesday-to-Sunday patterns that carry the weekend.

The seeded week (14–20 September 2026, the week the spec mocks up) is
deliberately tight — two to four people of headroom on a weekday, one at the
weekend. A roomy week makes a dull demo and hides exactly the problems this
tool exists to surface.

Two benches are thin on purpose, and the Benches screen flags both:

- **Mycology** — one signed-off mycologist and two trainees. It breaks the
  first time Rakesh Menon books leave.
- **Reporting Ref Lab Reports** — one person can sign off reference lab
  reports, and a hard rule requires a Senior BMS on it.

Three people are away during the seeded week: annual leave Monday to Wednesday,
annual leave Thursday and Friday, and one sickness day on the Tuesday.

Eight rules are seeded, seven active. The eighth — *Blood Cultures needs three
people* — is paused on purpose. Activate it on the Rules screen to watch the
week go infeasible and see the explanation screen name the conflict.

Bench day patterns were tuned against the solver, not guessed. `python -m
rotasolver.cli --self-check` re-verifies the week solves, and CI runs it on
every push, so a change to the roster or the bench list that makes the demo
impossible fails the build rather than the demo.

## Out of scope, as the spec says

Real employee data of any kind, multi-week generation, staff self-service
views, notifications, Excel import, audit logging beyond run history, and
mobile layout. Desktop only for now.
