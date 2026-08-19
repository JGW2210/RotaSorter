import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The anon key is safe in the browser: it grants exactly what RLS allows, and
 * every policy in 0002_rls.sql requires an authenticated session. The service
 * role key is a different thing entirely and must never appear here — it lives
 * in GitHub Actions secrets for the solver. See docs/SETUP.md.
 */
const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const isConfigured = Boolean(url && anonKey);

export const missingConfig: string[] = [
  !url && "VITE_SUPABASE_URL",
  !anonKey && "VITE_SUPABASE_ANON_KEY",
].filter(Boolean) as string[];

/** Guard against the mistake that would matter: shipping the service key. */
export const looksLikeServiceKey =
  Boolean(anonKey) && /"role"\s*:\s*"service_role"/.test(decodeJwtPayload(anonKey!));

function decodeJwtPayload(token: string): string {
  try {
    const [, payload] = token.split(".");
    if (!payload) return "";
    return atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "";
  }
}

export const supabase: SupabaseClient = createClient(
  url ?? "https://placeholder.supabase.co",
  anonKey ?? "placeholder",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // No self-registration and no email links to catch, so nothing to parse
      // out of the URL. Keeps the hash router's fragment intact.
      detectSessionInUrl: false,
    },
  },
);

/** Ask the Edge Function to start a solve on a GitHub runner. */
export async function dispatchSolve(runId: string, weekStart: string) {
  const { data, error } = await supabase.functions.invoke("dispatch-solve", {
    body: { run_id: runId, week_start: weekStart },
  });
  if (error) {
    // Not fatal: the run stays queued and the scheduled worker collects it.
    return {
      dispatched: false,
      note:
        "Could not reach the dispatch-solve function. The run is queued and the " +
        "scheduled worker will pick it up within ten minutes.",
      error: error.message,
    };
  }
  return data as { dispatched: boolean; note?: string; error?: string };
}
