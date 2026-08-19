// Kick off a solve on a GitHub Actions runner.
//
// The browser cannot hold a token that can start a workflow, so this function
// does it. The caller's Supabase JWT is verified by the platform before this
// code runs; the GitHub token lives only in this function's secrets.
//
// Deploy:  supabase functions deploy dispatch-solve
// Secrets: supabase secrets set GITHUB_TOKEN=... GITHUB_REPO=owner/repo
//
// See docs/SETUP.md.

const GITHUB_API = "https://api.github.com";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }

  const githubToken = Deno.env.get("GITHUB_TOKEN");
  const repo = Deno.env.get("GITHUB_REPO");
  if (!githubToken || !repo) {
    return json(
      {
        error:
          "This function needs GITHUB_TOKEN and GITHUB_REPO. " +
          "Run: supabase secrets set GITHUB_TOKEN=... GITHUB_REPO=owner/repo",
      },
      500,
    );
  }

  let runId: string | undefined;
  let weekStart: string | undefined;
  try {
    const body = await req.json();
    runId = body?.run_id;
    weekStart = body?.week_start;
  } catch {
    return json({ error: "Expected a JSON body with run_id." }, 400);
  }

  if (!runId) {
    return json({ error: "run_id is required." }, 400);
  }

  // Confirm the run exists and is still waiting, so a stale retry from the UI
  // cannot start a second runner on a job that already finished.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const lookup = await fetch(
    `${supabaseUrl}/rest/v1/rota_run?id=eq.${runId}&select=id,status,week_start`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (!lookup.ok) {
    return json({ error: `Could not read run ${runId}.` }, 502);
  }
  const rows = await lookup.json();
  if (!rows.length) {
    return json({ error: `No run with id ${runId}.` }, 404);
  }
  if (rows[0].status !== "queued") {
    return json({ status: rows[0].status, dispatched: false });
  }
  weekStart = weekStart ?? rows[0].week_start;

  const dispatch = await fetch(`${GITHUB_API}/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "solve-rota",
      client_payload: { run_id: runId, week_start: weekStart },
    }),
  });

  if (!dispatch.ok) {
    const detail = await dispatch.text();
    // Leave the run queued: the cron fallback in solve.yml will pick it up.
    return json(
      {
        error: `GitHub refused the dispatch (${dispatch.status}).`,
        detail: detail.slice(0, 400),
        dispatched: false,
        note: "The run stays queued and the scheduled worker will collect it.",
      },
      502,
    );
  }

  return json({ dispatched: true, run_id: runId, week_start: weekStart });
});
