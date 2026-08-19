/// <reference lib="webworker" />

/** Solves off the main thread.
 *
 * The seeded week takes a couple of seconds to prove optimal. On the main
 * thread that is a frozen interface, which would make the solving state's
 * elapsed counter and cancel button a lie. Here the page stays live.
 */

import { loadHighs } from "./highs";
import { solveWeek } from "./solve";
import type { SolveResult, SolverProblem } from "./types";

export interface SolveRequest {
  problem?: SolverProblem;
  /** Compile the wasm now, so the first real solve does not pay for it. */
  warm?: boolean;
}

export type SolveResponse =
  | { ok: true; warmed?: false; result: SolveResult }
  | { ok: false; warmed?: false; message: string }
  | { ok: true; warmed: true };

const post = (message: SolveResponse) =>
  (self as unknown as Worker).postMessage(message);

self.onmessage = async (event: MessageEvent<SolveRequest>) => {
  const { problem, warm } = event.data;

  if (warm && !problem) {
    try {
      await loadHighs();
    } catch {
      // Warming is best effort; a real solve will report the failure properly.
    }
    post({ ok: true, warmed: true });
    return;
  }

  if (!problem) return;

  try {
    post({ ok: true, result: await solveWeek(problem) });
  } catch (error) {
    post({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
