/* Shown when the app has no Supabase credentials, or has the wrong one. It is
 * the first thing a new checkout does, so it says exactly where the keys go
 * rather than failing with a network error. */
export default function SetupNeeded({
  missing,
  serviceKeyInBrowser,
}: {
  missing: string[];
  serviceKeyInBrowser: boolean;
}) {
  return (
    <main className="setup">
      <div className="setup__card">
        <h1>RotaSorter needs its Supabase keys</h1>

        {serviceKeyInBrowser ? (
          <div className="setup__alarm" role="alert">
            <strong>That is the service role key.</strong>
            <p>
              It bypasses every row level security policy, and anything shipped to a
              browser is public. Replace <code>VITE_SUPABASE_ANON_KEY</code> with the{" "}
              <em>anon / publishable</em> key, and rotate the service role key in the
              Supabase dashboard.
            </p>
          </div>
        ) : (
          <p>
            {missing.length === 2
              ? "Neither environment variable is set."
              : `${missing.join(" and ")} is not set.`}
          </p>
        )}

        <h2>Running locally</h2>
        <p>
          Create <code>web/.env.local</code>, which is git-ignored:
        </p>
        <pre className="mono">{`VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...`}</pre>
        <p>
          Both come from the Supabase dashboard under{" "}
          <strong>Project Settings → API</strong>. Restart <code>npm run dev</code>
          after changing them; Vite only reads env at startup.
        </p>

        <h2>Deployed to GitHub Pages</h2>
        <p>
          Add them as repository <em>variables</em>, not secrets, under{" "}
          <strong>Settings → Secrets and variables → Actions → Variables</strong>. The
          build needs to read them, and secrets are hidden from it.
        </p>

        <p className="setup__foot">
          Full walkthrough, including the solver's keys and the Edge Function, is in{" "}
          <code>docs/SETUP.md</code>.
        </p>
      </div>
    </main>
  );
}
