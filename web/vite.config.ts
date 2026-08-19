import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the app from /<repo>/, so the base path comes from the
// deploy workflow. Locally it stays at the root.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  worker: {
    // The solver worker dynamically imports the HiGHS wasm module, which means
    // the worker bundle is code-split, which rules out the default IIFE format.
    // It is created with { type: "module" } to match.
    format: "es",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/solver/testSetup.ts"],
    // The cross-check solves every fixture several times through wasm.
    testTimeout: 30_000,
  },
});
