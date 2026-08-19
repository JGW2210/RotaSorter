# Assumptions, and where this departs from the spec

Everything the build decided that the design spec did not, and the three places
it deliberately does something different. Nothing here is hidden in the code.

## Departures from the spec

### The solver is client-side, but it is not OR-Tools

The spec asks for a client-side solve; the brief asked for OR-Tools by name.
Both were not possible: CP-SAT has no browser build.

The first version put CP-SAT on a GitHub Actions runner, which made a 0.8 second
computation take forty seconds and needed six credentials to arrange. Auditing
the model showed it never used constraint programming at all — every constraint
was linear or a standard indicator — so it is now a mixed-integer program solved
by HiGHS compiled to WebAssembly, in a Web Worker.

That satisfies the spec's own architecture. Section 4.3's four states are intact
and the elapsed counter is honest because the solve is off the main thread. The
cost is about 1.7 seconds rather than the 1.4 the spec imagined.

The CP-SAT implementation is kept in `solver/` as the reference the browser
solver is checked against. See `docs/ARCHITECTURE.md`.

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

The spec's `bench` table has a single "Min staff, per shift".
`bench_shift_requirement` carries a `weekdays` array instead, so a bench can
run on some days and not others, and so a weekend service can be a smaller
requirement than the weekday one rather than the same one repeated.

Every bench now runs every weekday, which is what the array is set to. It was
not always: the first roster of 20 could not cover 20 benches five days a week,
so benches ran on the days their work actually arrived — Mycology on a
Thursday, reference lab reports on a Wednesday — and the Rota Board read "Not
run" over most of the grid. Filling every bench every weekday takes the weekday
minimum from 13 to 16 people, depending on the day, to 21 every day, and the
roster was grown to 30 to carry it. The
mechanism is unchanged and the weekend still uses it: Saturday and Sunday are
Urines and Blood Cultures, one person each.

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
each, covered by the three staff on Wednesday-to-Sunday patterns. Every other
bench runs Monday to Friday. Extending the weekend to all twenty benches would
need 17 more people again, every one of them working both Saturday and Sunday.

**60 days is "expiring soon"**, from the spec's Staff table. It is in
`v_staff_competency_summary` and `v_competency_matrix`, not in the app.

## The synthetic data

All invented. No real employee records at any point.

30 staff: 5 Senior BMS, 15 BMS, 7 Assistant Practitioners, 3 trainees.
Twenty-two work Monday to Friday; the rest are 0.8 and 0.6 patterns and three
Wednesday-to-Sunday patterns that carry the weekend.

Ten of those thirty are there to make five-day bench cover possible, and they
are all signed off rather than in training: under the supervision rule a
trainee on a bench consumes cover rather than adding it, so a trainee cannot be
the answer to an uncovered bench. Eight is the arithmetic minimum. The week
solves on eight, but only exactly: 21 of the 28 people could not then book a
week's leave without the week going infeasible. On ten, none of the thirty can
break it single-handed, which is the difference between a demo that survives
being poked and one that does not.

The seeded week (14–20 September 2026, the week the spec mocks up) leaves four
people of headroom on the tightest weekday and one at the weekend. The tension
has moved rather than gone: what used to be scarce was people, and what is
scarce now is the four benches with the shallowest signed-off pools —
Reporting Ref Lab Reports, Mycology, Molecular and Serology — which is what the
Benches screen and the Competency Matrix are for.

Three people are away during the seeded week: annual leave Monday to Wednesday,
annual leave Thursday and Friday, and one sickness day on the Tuesday.

Two benches used to be thin on purpose, and are no longer: Mycology had one
signed-off mycologist and Reporting Ref Lab Reports had one person who could
sign off a report. That was survivable while those benches ran one day a week.
Running them five days a week on one person each would have nailed Rakesh Menon
and Claire Dunwoody to a single bench all week and lost the week outright the
first time either booked leave, so both pools were widened. The infeasibility
demo is unaffected: it is the paused *Blood Cultures needs three people* rule,
which asks for more people than the bench's own maximum allows.

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
