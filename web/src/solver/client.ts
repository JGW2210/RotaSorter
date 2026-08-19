/** Run a solve in a worker, with cancellation.
 *
 * The worker is kept alive between solves. Compiling the 3.4MB HiGHS wasm
 * costs more than the solve itself, and the interaction this exists for —
 * pin something, re-solve around it, look, pin again — would pay that cost on
 * every iteration if the worker were torn down each time.
 *
 * Cancelling does terminate it, because there is no other way to stop wasm
 * mid-solve; the next solve then starts a fresh one and pays the warm-up once.
 */

import type { SolveResponse } from "./worker";
import type { SolveResult, SolverProblem } from "./types";

export class SolveCancelled extends Error {
  constructor() {
    super("Solve cancelled.");
    this.name = "SolveCancelled";
  }
}

let worker: Worker | null = null;
let busy = false;

function ensureWorker(): Worker {
  worker ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return worker;
}

/** Throw the worker away, e.g. on cancellation. The next solve makes a new one. */
export function disposeSolver(): void {
  worker?.terminate();
  worker = null;
  busy = false;
}

/** Start the worker and let it compile the wasm before anyone asks for a rota. */
export function warmSolver(): void {
  ensureWorker().postMessage({ warm: true });
}

export function solveInWorker(
  problem: SolverProblem,
  signal?: AbortSignal,
): Promise<SolveResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SolveCancelled());
      return;
    }
    if (busy) {
      reject(new Error("A solve is already running."));
      return;
    }

    const active = ensureWorker();
    busy = true;

    const cleanup = () => {
      busy = false;
      signal?.removeEventListener("abort", onAbort);
      active.removeEventListener("message", onMessage);
      active.removeEventListener("error", onError);
    };

    const onAbort = () => {
      cleanup();
      disposeSolver();
      reject(new SolveCancelled());
    };

    const onMessage = (event: MessageEvent<SolveResponse>) => {
      const data = event.data;
      if (data.warmed) return;
      cleanup();
      if (data.ok) resolve(data.result);
      else reject(new Error(data.message));
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      disposeSolver();
      reject(new Error(event.message || "The solver worker failed."));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    active.addEventListener("message", onMessage);
    active.addEventListener("error", onError);
    active.postMessage({ problem });
  });
}
