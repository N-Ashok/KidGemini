// The publish sheet's keyboard flapped open and shut once a second on mobile
// (owner report 2026-08-17, BUG-FIX-LOG same date). Not a keyboard bug — a
// dependency-identity bug:
//
//   ArtifactFrame renders <PublishToArcade onClose={() => setPublishing(false)} />
//     → a NEW function identity on every render
//   useModalA11y lists `onClose` in its effect deps
//     → the effect tears down and re-runs on every parent render
//       cleanup: returnFocus.focus()  → the mobile keyboard CLOSES
//       setup:   firstFocusable.focus() → the mobile keyboard OPENS
//   ArtifactFrame re-renders once a second (perf-probe.ts's setInterval, 1s)
//   and again on every viewport resize (its ResizeObserver) — and the mobile
//   keyboard opening IS a viewport resize, so the loop feeds itself.
//
// Same mechanism made "use a different web address" unusable: the re-run
// focuses focusableWithin(box)[0], which is the NAME input, so focus was
// yanked out of the custom-address field every second.
//
// Pinned in two places on purpose:
//   - the HOOK must not depend on the callback's identity at all, so no future
//     caller can reintroduce this by forgetting to memoise;
//   - the CALL SITE passes a stable callback anyway, because an unstable one
//     re-renders the whole sheet needlessly even with the hook fixed.
//
// Source-reading test, same pattern as ar-nav-fixed.test.ts — this repo's
// vitest runs in the node environment, so there is no DOM to render into.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hook = readFileSync(join(__dirname, "useModalA11y.ts"), "utf8");
const frame = readFileSync(join(__dirname, "ArtifactFrame.tsx"), "utf8");

/** Comments out, so prose that happens to quote code can never satisfy — or
 *  defeat — an assertion about the code. (Both failure directions bit this
 *  repo already: a rule matched a word in a comment; then this very test
 *  matched a `focusableWithin(box)` written inside an explanatory comment.) */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The dependency array of the hook's focus/trap effect. */
function focusEffectDeps(source: string): string {
  // The effect that owns focus is the one that captures the return-focus
  // element — match from there to its closing `}, [...]);`.
  const m = code(source).match(/returnFocusRef\.current = document\.activeElement[\s\S]*?\n {2}}, \[([^\]]*)\]\);/);
  if (!m) throw new Error("could not find the focus effect's dependency array");
  return m[1]!;
}

describe("useModalA11y does not re-run its focus effect on every parent render", () => {
  it("K.1 the focus effect does NOT depend on the onClose identity", () => {
    // This is the whole bug. `onClose` here re-runs blur+focus on every render
    // of whatever component owns the dialog.
    expect(focusEffectDeps(hook)).not.toMatch(/\bonClose\b/);
  });

  it("K.2 the focus effect still reacts to open/close and the escape option", () => {
    // Narrowing the deps must not make the hook inert: `enabled` is what lets
    // a host that stays mounted toggle its dialog.
    const deps = focusEffectDeps(hook);
    expect(deps).toMatch(/\benabled\b/);
    expect(deps).toMatch(/\bcloseOnEscape\b/);
  });

  it("K.3 Escape calls the CURRENT callback, via a ref — not a captured stale one", () => {
    // Dropping onClose from the deps without this would freeze the first
    // render's callback forever, which is a worse bug than the one being fixed.
    expect(hook).toMatch(/onCloseRef/);
    expect(hook).toMatch(/onCloseRef\.current\(\)/);
    // And the ref is kept current — otherwise it is the stale capture again.
    expect(hook).toMatch(/onCloseRef\.current = onClose/);
  });

  it("K.4 the raw onClose prop is never called from inside the effect", () => {
    // A single surviving `onClose()` inside the effect body is a stale capture.
    const effect = hook.slice(hook.indexOf("returnFocusRef.current = document.activeElement"));
    expect(effect).not.toMatch(/(?<!Ref\.current)\bonClose\(\)/);
  });
});

describe("the publish sheet gets a stable onClose from ArtifactFrame", () => {
  it("K.5 <PublishToArcade> is not handed a fresh arrow function each render", () => {
    const tag = frame.match(/<PublishToArcade[\s\S]*?\/>/);
    expect(tag, "PublishToArcade should still be rendered by ArtifactFrame").toBeTruthy();
    expect(tag![0]).not.toMatch(/onClose=\{\(\)\s*=>/);
    expect(tag![0]).toMatch(/onClose=\{\w+\}/);
  });

  it("K.6 that handler is memoised, not just hoisted into the render body", () => {
    // A plain `const stopPublishing = () => ...` in the component body is a new
    // identity every render too — exactly the thing being fixed.
    expect(frame).toMatch(/const stopPublishing = useCallback\(/);
  });
});
