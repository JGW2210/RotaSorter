import { createRequire } from "node:module";
import { setWasmLocator } from "./highs";

// Under Node the packaged wasm has to be resolved from disk. The package only
// exposes it under the "highs/runtime" subpath.
const require = createRequire(import.meta.url);
setWasmLocator(() => require.resolve("highs/runtime"));
