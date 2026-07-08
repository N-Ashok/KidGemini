import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression guard for BUG-FIX-LOG 2026-07-08 (3D preview dead in prod):
// three-vendor.ts reads src/lib/vendor/three-bundle.generated.js off disk at
// RUNTIME (readFileSync — webpack does not bundle it into .next), so the
// deploy script must ship that directory. The first deploy didn't, ENOENT
// killed the chat route's done event, and every 3D game's preview never
// opened. This pins the ship list textually so the class can't recur silently.
describe("deploy ships every runtime-read file (BUG-FIX-LOG 2026-07-08)", () => {
  const script = readFileSync(
    fileURLToPath(new URL("../../scripts/deploy-rsync.sh", import.meta.url)),
    "utf8",
  );

  it("rsyncs src/lib/vendor to the box", () => {
    expect(script).toMatch(/rsync[^\n]*src\/lib\/vendor/);
  });

  it("the vendored bundle exists locally to be shipped", () => {
    const bundle = readFileSync(
      fileURLToPath(new URL("./vendor/three-bundle.generated.js", import.meta.url)),
      "utf8",
    );
    expect(bundle).toContain("WebGLRenderer");
  });
});
