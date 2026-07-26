import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest — unit/integration tests (CLAUDE.md §7.4). Node environment; `@/` resolves to src/.
// Coverage threshold (≥70% on src/lib, CLAUDE.md §8) is intentionally NOT enforced yet — it would
// fail on the as-yet-untested legacy files. Enable it once the retrofit (KNOWN_BUGS #1) lands.
export default defineConfig({
  // Next's tsconfig sets `jsx: preserve` (its compiler does the transform);
  // in the test process the bundler must do it instead, or importing any
  // .tsx component fails to parse (first needed for SparksCelebrationCard's
  // render test, PRD-SPARKS closure §4). This vite is rolldown-based → oxc
  // options, not esbuild.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` is a build-time guard with no runtime export, so it
      // can't resolve in a plain node test process. Stubbing it lets
      // server-side modules (the safety gate, provider adapters) be unit
      // tested directly; the real guard still applies to next build.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
});
