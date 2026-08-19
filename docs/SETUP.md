# Setting RotaSorter up

Start to finish, about twenty minutes. Nothing here needs a paid plan, a server,
or any account beyond Supabase and GitHub.

## Where the keys go

There are **two** credentials, they are the same two, and both are safe in a
browser:

| Credential | Goes in | Used by |
|---|---|---|
| `VITE_SUPABASE_URL` | `web/.env.local`, and a GitHub repo **variable** | The app |
| `VITE_SUPABASE_ANON_KEY` | `web/.env.local`, and a GitHub repo **variable** | The app |

The anon key is meant to be public. It ships in the JavaScript bundle by design,
and it grants exactly what the row level security policies allow — every policy
in `0002_rls.sql` requires a signed-in session.

**The service role key is not used anywhere in this project.** It bypasses every
RLS policy. Nothing needs it: the solver runs in the browser under the signed-in
user's own permissions. If you find yourself pasting it somewhere, stop. The app
checks the key it is given at startup and refuses to run if it is a service role
key.

Do not put these in Actions **secrets**: the Pages build cannot read secrets, so
they go in repository **variables**.

> Supabase renamed these in 2025. On a new project, **anon** is called
> **publishable**. Same thing.

---

## 1. Create the Supabase project

1. <https://supabase.com/dashboard> → **New project**.
2. Pick a region near the lab and set a database password.
3. Wait for it to provision, then open **SQL Editor**.

## 2. Run the migrations

Paste each file into the SQL Editor and run them **in order**. Each should
finish with "Success. No rows returned".

```
supabase/migrations/0001_schema.sql        tables, enums, indexes
supabase/migrations/0002_rls.sql           row level security on every table
supabase/migrations/0003_functions.sql     views, triggers and the RPCs
supabase/migrations/0004_client_solver.sql drops the two worker RPCs
```

Each file is wrapped in a transaction, so a failure leaves nothing behind and
you can simply run it again once the problem is fixed.

With the Supabase CLI linked to the project, all four at once:

```bash
supabase db push
```

**Starting over.** `supabase/migrations/0000_reset.sql` drops everything these
migrations create, so you can rebuild from nothing. It leaves `auth.users`
alone, so your login survives. Run it only when you mean it.

## 3. Load the synthetic staff

Same again, in order:

```
supabase/seed/0010_reference_data.sql   2 shifts, 10 groups, 20 benches, 51 documents
supabase/seed/0020_staff.sql            20 staff, contracted patterns, absences
supabase/seed/0030_competencies.sql     the competency matrix and document sign-off
supabase/seed/0040_rules_settings.sql   8 rules and the solver weights
```

`0010` begins with a `truncate`, so re-running the four resets the operational
data to a clean state. It does not touch `auth.users`.

To change the dummy data, edit `supabase/seed/generate_seed.py` and re-run it —
the `.sql` files are generated, and CI fails if they drift from the generator.

Check it landed:

```sql
select
  (select count(*) from staff)               as staff,        -- 20
  (select count(*) from bench)               as benches,      -- 20
  (select count(*) from competency_document) as documents,    -- 51
  (select count(*) from competency)          as matrix_cells, -- 201
  (select count(*) from rule)                as rules;        -- 8
```

## 4. Create yourself a login

There is no self-registration. In the dashboard:

**Authentication → Users → Add user → Create new user**

Set an email and password, and tick **Auto Confirm User**. A `profile` row is
created automatically by the trigger in `0003_functions.sql`, with the role
`manager`.

## 5. Point the app at the project

Get both values from **Project Settings → API**:

- **Project URL** → `VITE_SUPABASE_URL`
- **anon / publishable** key → `VITE_SUPABASE_ANON_KEY`

Create `web/.env.local` (git-ignored):

```bash
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

```bash
cd web
npm install
npm run dev
```

Sign in at <http://localhost:5173>. Move the week selector to **14 Sep 2026**,
the week the seed data is built around, and press **Generate rota**. It solves
in about two seconds, in the tab you are looking at.

Vite reads env only at startup, so restart `npm run dev` after editing
`.env.local`.

## 6. Publish the app

**GitHub → Settings → Pages → Build and deployment → Source: GitHub Actions.**

Then **Settings → Secrets and variables → Actions**, open the **Variables** tab,
and use **New repository variable** — the *Repository variables* section, not
*Environment variables*:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | the project URL |
| `VITE_SUPABASE_ANON_KEY` | the anon / publishable key |

Two distinctions that both bite silently:

- **Not Secrets.** The Pages build has to read these to bake them into the
  bundle, and secrets are hidden from it.
- **Not Environment variables.** Those are only visible to a job that declares
  that environment. In `deploy-web.yml` the `build` job declares none — only
  `deploy` uses `github-pages` — so a variable scoped to that environment is
  invisible exactly where it is needed.

Get either wrong and the build would otherwise succeed with empty strings and
deploy an app that shows the setup screen. The workflow checks first and fails
with a message naming the cause, so you will not have to guess.

Push to `main`, or run **Actions → Deploy web to GitHub Pages** by hand. The app
lands at `https://<you>.github.io/<repo>/`.

## 7. Run one end to end

1. Open the app, go to **Rota**, set the week to **14 Sep 2026**.
2. **Generate rota**. The strip shows an elapsed counter, then
   *Solved in 1.7s. All coverage met.*
3. Drag a chip onto another bench. It becomes a pin, the button changes to
   **Re-solve around 1 pin**, and Cmd+Z undoes it.
4. Try dragging someone onto a bench they are not signed off for. The drop is
   refused and names the reason.
5. **Rules → Blood Cultures needs three people → Activate**, then regenerate.
   The week goes infeasible and the screen names the conflict. Pause the rule
   again afterwards.

---

## Checking the SQL without a Supabase project

`supabase/test/run.sh` runs every migration and seed against a throwaway
PostgreSQL database and then asserts the result: row counts, RLS enabled on
every table, `anon` holding no privileges, the check constraints actually
rejecting bad data, and each trigger and RPC doing its job. It finishes by
running the reset and rebuilding from scratch to prove that works too.

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres supabase/test/run.sh
```

`supabase/test/00_supabase_shim.sql` provides the little that Supabase gives you
and a bare cluster does not — the `anon`, `authenticated` and `service_role`
roles, `auth.users`, `auth.uid()` and the realtime publication. It is only ever
used for this; nothing in it runs against a real project.

CI runs this on every push against a `postgres:16` service container.

## The reference solver

`solver/` holds a second implementation of the same model, in Python with
Google OR-Tools CP-SAT. It is not part of the running app and never writes to
the database. It exists to keep the browser solver honest: CI runs both against
the same weeks and fails if they disagree on feasibility or on the value of the
optimum.

```bash
cd solver
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

python -m rotasolver.cli --self-check --print   # no database needed
python -m pytest -q
```

Ask it for a second opinion on real data — read-only:

```bash
export SUPABASE_URL=https://YOUR-PROJECT.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...     # only ever leaves your shell
python -m rotasolver.cli --week 2026-09-14 --print
```

After changing the model, regenerate the cross-check fixtures and commit them:

```bash
python -m rotasolver.export_fixture ../web/src/solver/__fixtures__
```

---

## When something is wrong

**The app shows "RotaSorter needs its Supabase keys".** No env vars at build
time. Locally, check `web/.env.local` and restart the dev server. Deployed, the
build should have failed before it got that far — check the *Deploy web to
GitHub Pages* run for the error, and that the two values are **repository**
variables rather than secrets or environment variables.

**"relation ... does not exist".** The migrations have not been run, or only
some of them.

**Sign-in says "Invalid login credentials".** The user was created without
**Auto Confirm User**. Delete and recreate, or confirm them in the dashboard.

**Every screen is empty but there are no errors.** RLS is doing its job and you
are not signed in, or the seed files have not been run. Check with
`select count(*) from staff;` in the SQL editor.

**Generate does nothing, or the console mentions a worker.** The solver runs in
a Web Worker and loads a 3.4MB WebAssembly module on first use. A hard refresh
clears a half-fetched cache. It needs no special headers and no cross-origin
isolation.

**A solve takes much longer than a couple of seconds.** The time is spent
proving the rota is optimal, and it grows with how much freedom the rules leave.
Settings → Solve time limit caps it; past the limit you get the best rota found
so far rather than the proven best.

**The week is infeasible and you did not expect it.** Read the conflict: it
names the bench, the day, and where every competent person went instead. The
usual cause is an absence on a bench with a thin pool — **Benches** flags any
bench whose competent pool is at or below its minimum.
