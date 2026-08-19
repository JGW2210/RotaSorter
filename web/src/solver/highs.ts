/** Lazy, cached HiGHS loader.
 *
 * The wasm is 3.3MB, so it is imported dynamically and only fetched the first
 * time someone actually solves.
 *
 * In the browser Vite resolves `?url` to the emitted asset. Under Node that
 * same value is a site-absolute URL rather than a path, so tests install a
 * locator that resolves the file properly; see testSetup.ts.
 */

import wasmUrl from "highs/runtime?url";

type HighsModule = {
  solve(problem: string, options?: Record<string, unknown>): HighsResult;
};

export interface HighsResult {
  Status: string;
  ObjectiveValue: number;
  Columns: Record<string, { Primal: number }>;
}

let pending: Promise<HighsModule> | null = null;
let locate: (() => string) | null = null;

/** Point the loader at the wasm binary. Resets any cached module. */
export function setWasmLocator(locator: (() => string) | null): void {
  locate = locator;
  pending = null;
}

export function loadHighs(): Promise<HighsModule> {
  pending ??= import("highs").then((mod) =>
    (mod.default as (o: unknown) => Promise<HighsModule>)({
      locateFile: () => (locate ? locate() : (wasmUrl as string)),
    }),
  );
  return pending;
}
