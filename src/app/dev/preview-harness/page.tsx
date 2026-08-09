// Dev-only component harness for the preview pane (built 2026-08-09 after two
// regressions shipped in df9bd61, whose own commit message said the two-iframe
// wiring and the composer change were untested and "the rendering needs a
// human"). CLAUDE.md §9.6: if no instrument exists for a class of bug, build it
// first — it is cheaper than another round of the owner's UAT.
//
// This mounts the REAL ArtifactFrame and the REAL Composer, in the real split
// layout, in a real browser. Driven by scripts/harness-preview.mjs.

import { notFound } from "next/navigation";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Harness } from "./Harness";

// Never reachable in production, whatever the routing does.
export const dynamic = "force-dynamic";

function golden(name: string): string {
  try {
    return readFileSync(path.join(process.cwd(), "golden", "runs", name), "utf8");
  } catch {
    return "";
  }
}

export default function PreviewHarnessPage() {
  if (process.env.NODE_ENV === "production") notFound();

  // Two REAL generated 3D games (croc/jungle class — the one in the owner's
  // screenshot). Game A verifies first and becomes the playable fallback;
  // swapping to B is what puts the pane into shadow verify.
  const a = golden("river-jungle.html");
  const b = golden("jungle-animals.html");
  if (!a || !b) {
    return <p style={{ padding: 24 }}>Missing golden/runs fixtures — run the golden harness first.</p>;
  }
  return <Harness gameA={a} gameB={b} />;
}
