import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest — unit/integration tests (CLAUDE.md §7.4). Node environment; `@/` resolves to src/.
// Coverage threshold (≥70% on src/lib, CLAUDE.md §8) is intentionally NOT enforced yet — it would
// fail on the as-yet-untested legacy files. Enable it once the retrofit (KNOWN_BUGS #1) lands.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
