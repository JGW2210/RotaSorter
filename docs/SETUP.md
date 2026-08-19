# Setting RotaSorter up

Start to finish, about half an hour. Nothing here needs a paid plan.

There are **six** credentials in this system and they live in **three different
places**. Putting one in the wrong place is the only way to do real damage, so
that table comes first.

## Where every key goes

| Credential | Goes in | Public? | Used by |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `web/.env.local`, and a GitHub repo **variable** | Yes | The browser app |
| `VITE_SUPABASE_ANON_KEY` | `web/.env.local`, and a GitHub repo **variable** | Yes | The browser app |
| `SUPABASE_URL` | GitHub Actions **secret** | — | The solver worker |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub Actions **secret** | **No, never** | The solver worker |
| `GITHUB_TOKEN` | Supabase **Edge Function secret** | **No, never** | The dispatch function |
| `GITHUB_REPO` | Supabase **Edge Function secret** | — | The dispatch function |

Two rules that matter:

- **The service role key must never reach the browser.** It bypasses every row
  level security policy in the database. It belongs in GitHub Actions secrets
  and nowhere else. The app checks the key it was given at startup and refuses
  to run if it is a service role key, but do not rely on that.
- **The anon key is meant to be public.** It is in the JavaScript bundle by
  design. It grants exactly what the RLS policies allow, and every policy in
  `0002_rls.sql` requires a signed-in session. Do not put it in Actions
  *secrets*: the Pages build cannot read secrets, so use repository
  **variables**.

Supabase renamed these keys in 2025. On a new project, **anon** is now called
**publishable** and **service_role** is now called **secret**. Same things.

---

## 1. Create the Supabase project

1. <https://supabase.com/dashboard> → **New project**.
2. Pick a region near the lab and set a database password.
3. Wait for it to provision, then open **SQL Editor**.

## 2. Run the migrations

Paste each file's contents into the SQL Editor and run them **in order**. Each
one should finish with "Success. No rows returned".

```
supabase/migrations/0001_schema.sql     tables, enums, indexes
supabase/migrations/0002_rls.sql        row level security on every table
supabase/migrations/0003_functions.sql  views, triggers and the RPCs
```

If you have the Supabase CLI linked to the project you can do all three with:

```bash
supabase db push
```

## 3. Load the synthetic staff

Same again, in order:

```
supabase/seed/0010_reference_data.sql   2 shifts, 10 groups, 20 benches, 51 documents
supabase/seed/0020_staff.sql            20 staff, contracted patterns, absences
supabase/seed/0030_competencies.sql     the competency matrix and document sign-off
supabase/seed/0040_rules_settings.sql   8 rules and the solver weights
```

`0010` begins with a `truncate`, so running the four again resets the
operational data to a clean state. It does not touch `auth.users`.

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

## 5. Point the web app at the project

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
which is the week the seed data is built around.

Vite reads env only at startup, so restart `npm run dev` after editing
`.env.local`.

## 6. Give the solver worker its keys

**GitHub → your repo → Settings → Secrets and variables → Actions**

On the **Secrets** tab, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | the same project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → **service_role / secret** key |

The worker uses the service role key deliberately: it writes assignments on
behalf of whoever asked for the rota, and it has no session of its own.

Now try it without any of the rest wired up:

**Actions → Solve rota → Run workflow**, leave the inputs empty, and it will
claim the oldest queued run. With nothing queued it prints "Nothing queued" and
stops, which is the confirmation you want.

To solve a week directly, put `2026-09-14` in the **week** input.

## 7. Deploy the dispatch function

This is what lets the **Generate rota** button start a solve straight away
rather than waiting for the cron. Skip it and everything still works, just up
to ten minutes slower.

Create a **fine-grained personal access token** at
<https://github.com/settings/personal-access-tokens>:

- Repository access: only this repository
- Permissions: **Actions: read and write**, and **Contents: read**
- Expiry: whatever your policy allows

Then, with the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set GITHUB_TOKEN=github_pat_... GITHUB_REPO=jgw2210/rotasorter
supabase functions deploy dispatch-solve
```

The token stays server-side in the function. The browser calls the function,
the function calls GitHub.

## 8. Publish the web app

**GitHub → Settings → Pages → Build and deployment → Source: GitHub Actions.**

Then, back on **Settings → Secrets and variables → Actions**, open the
**Variables** tab (not Secrets) and add:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | the project URL |
| `VITE_SUPABASE_ANON_KEY` | the anon / publishable key |

Push to `main`, or run **Actions → Deploy web to GitHub Pages** by hand. The
app lands at `https://<you>.github.io/<repo>/`.

If the deployed page shows the setup screen, the variables went in as Secrets
rather than Variables. The Pages build cannot read secrets.

## 9. Run one end to end

1. Open the app, go to **Rota**, set the week to **14 Sep 2026**.
2. **Generate rota**. The strip reads *Queued*, then *Solving*, then
   *Solved in 0.8s. All coverage met.*
3. Drag a chip onto another bench. It becomes a pin, the button changes to
   **Re-solve around 1 pin**, and Cmd+Z undoes it.
4. Try dragging someone onto a bench they are not signed off for. The drop is
   refused and names the reason.
5. **Rules → Blood Cultures needs three people → Activate**, then regenerate.
   The week goes infeasible and the screen names the conflict.
   Pause the rule again afterwards.

---

## Running the solver on your own machine

Useful for changing the model without waiting on a runner.

```bash
cd solver
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

python -m rotasolver.cli --self-check --print   # no database needed
python -m pytest -q
```

Against the real project:

```bash
export SUPABASE_URL=https://YOUR-PROJECT.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...
python -m rotasolver.cli --week 2026-09-14 --print
```

---

## When something is wrong

**The app shows "RotaSorter needs its Supabase keys".** No env vars at build
time. Locally, check `web/.env.local` and restart the dev server. Deployed,
check they are repository *variables*.

**"relation ... does not exist".** The migrations have not been run, or only
some of them.

**Sign-in says "Invalid login credentials".** The user was created without
**Auto Confirm User**. Delete and recreate, or confirm them in the dashboard.

**Every screen is empty but there are no errors.** RLS is doing its job and you
are not signed in, or the seed files have not been run. Check with:
`select count(*) from staff;` in the SQL editor.

**The rota stays "Queued" for more than ten minutes.** The dispatch function is
not deployed *and* the cron has not fired. Check **Actions** for a run of
*Solve rota*; if the workflow is not there, the branch has not been pushed. Run
it by hand to confirm the Supabase secrets are right.

**The run comes back as `error`.** Open it under **Runs** — the traceback from
the worker is stored on the run, and the run links to its GitHub Actions log.

**The week is infeasible and you did not expect it.** Read the conflict, it
names the bench, the day and where every competent person went instead. The
most common cause is an absence on a bench with a thin pool: **Benches** flags
any bench whose competent pool is at or below its minimum.
