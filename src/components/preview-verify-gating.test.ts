import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Regression guard for the 2026-08-09 preview regressions (docs/BUG-FIX-LOG.md).
//
// Shadow verify redefined `covered` from "the verify loop is running" to
// "there is nothing better to show". The second meaning is FALSE for the whole
// of an edit whenever a playable fallback exists — and four unrelated
// consumers were still reading that flag, so all four silently began running
// mid-verify, against the hidden document under test rather than the game in
// the child's hands. The save channel's own comment named the invariant it had
// just lost: "never race the verify loop".
//
// This repo has no component harness in Vitest (environment: 'node', no
// testing-library), and the browser harness cannot see this class — it needs
// SpeechRecognition and a live save endpoint to exercise the affected
// features, neither of which exists headless. So the contract is pinned at the
// source level, the same technique as sparks-parent-buy-cta.test.ts. The
// browser check lives in scripts/harness-preview.mjs.
describe("preview gating: verify-loop consumers use `settled`, not `!covered`", () => {
  const src = readFileSync(path.join(__dirname, "ArtifactFrame.tsx"), "utf8");

  it("defines `settled` from the verify phase itself", () => {
    expect(src).toMatch(/const settled = state\.phase === "done"/);
  });

  it("the save channel is gated on `settled` — it must never race the verify loop", () => {
    // Anything else here means autosave/restore can fire mid-edit and post
    // into the shadow iframe instead of the one being played.
    expect(src).toMatch(/active: settled,/);
    expect(src).not.toMatch(/active: !covered/);
  });

  it("the Idea mic tab is gated on `settled` — one SpeechRecognition per page", () => {
    // Mounting it mid-edit puts a second recognizer on the page alongside the
    // composer's, which is how the chat box's mic goes dead.
    expect(src).toContain("{settled && onCaptureIdea && (");
    expect(src).not.toContain("{!covered && onCaptureIdea && (");
  });

  it("the help tab and slowdown banner are gated on `settled`", () => {
    expect(src).toContain("{settled && helpTab}");
    expect(src).toContain("{settled && onFixSlowdown");
    expect(src).not.toContain("{!covered && helpTab}");
  });

  it("auto-focus waits for `settled` — mid-edit the ref is the HIDDEN iframe", () => {
    // Focusing it would take the keyboard from both the playable fallback and
    // the chat box.
    expect(src).toMatch(/if \(!settled \|\| tab !== "preview"\) return;/);
  });

  // ── The iframe roles (2026-08-10, the actual cause of the blank preview) ──
  // The first attempt kept the child's game "playable" by mounting a SECOND
  // iframe that replayed the same HTML from scratch, and handed their live
  // frame to the probes. Their game restarted (Strength 1800 -> 0 in the
  // owner's recording) and both frames re-fetched every model, so nothing drew
  // until the edit ended. The frames are ROLES now, not documents.

  it("the played iframe's key varies ONLY with the gl-dead epoch, never the document", () => {
    // A key that varies with the document is the remount: it throws away the
    // child's progress and forces every GLB to be downloaded again. The ONE
    // sanctioned remount is the gl-dead self-heal (2026-08-10 №4): a game
    // whose GPU context is gone and not coming back is already blank — a
    // remount is strictly better, and it is what the owner's manual
    // code↔preview toggle did.
    expect(src).toMatch(/key=\{`preview-play#\$\{playEpoch\}`\}/);
    expect(src).not.toMatch(/key=\{`play:\$\{lastGoodHtml/);
  });

  it("gl-dead from the PLAYED frame remounts it — and only from the played frame", () => {
    // The message is the last rung of the guard's watchdog ladder. The source
    // check matters: the shadow (an unvetted new version) must never be able
    // to remount the child's game; and a rate limit stops a game whose
    // context can never be re-created from remount-looping forever.
    expect(src).toMatch(/__ari !== "gl-dead"/);
    expect(src).toMatch(/e\.source !== playElRef\.current\?\.contentWindow/);
    expect(src).toMatch(/setPlayEpoch/);
    expect(src).toMatch(/GL_DEAD_REMOUNT_COOLDOWN_MS/);
  });

  it("ONE iframe: no shadow frame exists, and srcDoc drives it directly (owner decision 2026-08-10)", () => {
    // Shadow verify was removed by explicit owner decision: the child is
    // BUILDING, not playing — an edit may replace the running game — and the
    // rollback path is the chat history. A second live 3D document was also
    // half the GPU story behind the 2026-08-10 context-cap outage. If a
    // shadow/second-iframe pattern reappears, it must go back through the
    // owner.
    expect(src).not.toMatch(/shadowElRef|attachShadow|shadowing/);
    expect(src).not.toMatch(/playDoc/);
    expect(src).toContain("srcDoc={srcDoc}");
  });

  it("iframeRef always addresses the single play iframe", () => {
    // The probes, the ready handshake and the save channel all go through
    // this ref; it must re-point per document (gl-dead remounts the element).
    expect(src).toMatch(/iframeRef\.current = playElRef\.current;/);
  });

  it("`covered` still drives the cover card itself (the rendering question)", () => {
    // The split is the point: covered = "is the cover up?", settled = "has this
    // version finished verifying?". Collapsing them again is the regression.
    expect(src).toMatch(/const covered = display\.covered;/);
    expect(src).toContain("{covered && (");
  });
});
