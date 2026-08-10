// Component harness driver for the preview pane + composer (2026-08-09).
//
// Built after two regressions shipped in df9bd61 with the note "the two-iframe
// wiring itself and the composer change ... the rendering needs a human". This
// is that human, automated: a real browser, the real components, the real
// verify controller.
//
//   npm run dev                      # the app on :3001 (or :3000)
//   node scripts/harness-preview.mjs [--url http://localhost:3001] [--headed]
//
// Reuses playwright-core from wherever it is installed, same convention as
// scripts/verify-game-html.mjs (PLAYWRIGHT_CORE_DIR).

import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const urlIdx = argv.indexOf("--url");
const BASE = urlIdx >= 0 ? argv[urlIdx + 1] : "http://localhost:3001";
const HEADED = argv.includes("--headed");
// --webkit: run on Safari's engine. The owner UATs on Safari, and the WebGL
// guard's pagehide/pageshow behavior (2026-08-10 №3) is Safari-specific —
// Chromium alone cannot vouch for it.
const WEBKIT = argv.includes("--webkit");

const pw = await (async () => {
  try {
    return await import("playwright-core");
  } catch {
    const dir = process.env.PLAYWRIGHT_CORE_DIR;
    if (!dir) throw new Error("playwright-core not installed — set PLAYWRIGHT_CORE_DIR");
    return await import(pathToFileURL(`${dir}/index.mjs`).href);
  }
})();
const chromium = WEBKIT ? pw.webkit : pw.chromium;

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const dir = readdirSync(cache).find((d) =>
  d.startsWith(WEBKIT ? "webkit-" : HEADED ? "chromium-" : "chromium_headless_shell-"),
);
const exe = WEBKIT
  ? `${cache}/${dir}/pw_run.sh`
  : HEADED
    ? `${cache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
    : `${cache}/${dir}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: exe, headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
// Keep the stack, not just the message: an intermittent one-liner with no
// frames is unactionable, which is how the "reading 'trim'" error sat here
// unattributed.
page.on("pageerror", (e) => pageErrors.push(`${e.message}\n${(e.stack || "").split("\n").slice(1, 6).join("\n")}`));

// The save channel's traffic. Its own comment says it must be "active only
// once the game is up and playable (never mid-verify-cover), so the existing-
// save lookup and autosave never race the verify loop" — so a request to it
// while a new version is being probed is that invariant breaking.
// Console from EVERY frame, so we can prove our injected guard actually runs.
const glConsole = [];
page.on("console", (m) => glConsole.push(m.text()));

const saveCalls = [];
page.on("request", (r) => {
  if (r.url().includes("/api/game-save")) saveCalls.push({ at: Date.now(), url: r.url() });
});

await page.goto(`${BASE}/dev/preview-harness`, { waitUntil: "domcontentloaded" });

// ── 1. The first game settles and becomes playable ──────────────────────────
await page.waitForTimeout(9000);
const frames = () => page.frames().filter((f) => f !== page.mainFrame());
check("first game mounts an iframe", frames().length >= 1, `${frames().length} frame(s)`);

/** Does the visible preview actually have a drawn 3D scene? */
async function sceneState(frame) {
  return frame
    .evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return { canvas: false };
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      return { canvas: true, w: c.width, h: c.height, lost: gl ? gl.isContextLost() : "no-gl" };
    })
    .catch((e) => ({ error: e.message }));
}

// ── 2. Typing into the composer BEFORE an edit (the control) ────────────────
const box = page.locator("textarea");
await box.click();
await box.type("hello before edit", { delay: 20 });
const before = await box.inputValue();
check("composer accepts typing while a game plays", before === "hello before edit", JSON.stringify(before));
await box.fill("");

// ── 2b. Mark the RUNNING game — the edit is EXPECTED to replace it ──────────
// Owner decision 2026-08-10: one iframe, the child is building not playing,
// so an edit replaces the running document (the chat holds earlier versions).
// The mark proves the replacement actually happened at promotion (§7).
await frames()[0].evaluate(() => {
  window.__harnessMark = 4242;
});
const markBefore = await frames()[0].evaluate(() => window.__harnessMark ?? null);
check("mark set on the running game", markBefore === 4242, `mark=${markBefore}`);

// ── 3. Swap the game → the pane verifies IN PLACE, behind the cover ─────────
// Shadow verify (a second hidden iframe preserving the old game) was removed
// by owner decision 2026-08-10 — if a second frame ever appears again, that
// architecture is creeping back without the owner being asked.
const coverBefore = await page.getByText("Testing your game").count();
check("first game settled (no cover)", coverBefore === 0, `cover elements=${coverBefore}`);

await page.getByTestId("swap").click();
let sawCover = false;
for (let i = 0; i < 40; i++) {
  if ((await page.getByText("Testing your game").count()) > 0) { sawCover = true; break; }
  await page.waitForTimeout(250);
}
check("the edit verifies behind the cover", sawCover, sawCover ? "cover is up" : "no cover within 10s");
check("no second iframe is ever mounted", frames().length === 1, `${frames().length} frame(s)`);

// ── 3a. The invariants gated on `settled` during a verify round ─────────────
// The 2026-08-10 lesson stands under either architecture: consumers that talk
// to the game, own the mic, or move focus key off `settled`, never the cover.
const saveCallsAtEditStart = saveCalls.length;
const ideaMounted = await page.locator('[data-testid="idea-mic-tab"], button:has-text("IDEA")').count();
check(
  "the Idea mic tab is NOT mounted during an edit (one SpeechRecognition per page)",
  ideaMounted === 0,
  `idea tab elements=${ideaMounted}`,
);

// ── 4. THE REGRESSION: can the child still type mid-edit? ───────────────────
await box.click();
await box.type("can i type mid edit", { delay: 25 });
const mid = await box.inputValue();
check("composer accepts typing while the edit verifies", mid === "can i type mid edit", JSON.stringify(mid));

// Which element actually holds focus? If the preview iframe stole it, typing
// goes into the game and the chat looks dead.
const focused = await page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName}${a.getAttribute("title") ? `[${a.getAttribute("title")}]` : ""}` : "none";
});
check("focus stays in the composer mid-edit", focused.startsWith("TEXTAREA"), `activeElement=${focused}`);

// ── 5. Is anything covering the composer? ───────────────────────────────────
const overlay = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  if (!ta) return "no textarea";
  const r = ta.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!top) return "nothing at point";
  return top === ta ? "textarea" : `${top.tagName}.${(top.className || "").toString().slice(0, 60)}`;
});
check("nothing overlays the composer", overlay === "textarea", `hit-test=${overlay}`);

// ── 7. PROMOTION: the verified version must reach the child ─────────────────
// The cover must lift once the edit settles, and the document behind it must
// be the NEW game — the mark set on the old document proves the replacement.
let promoted = false;
// Does a torn-down document hand its GPU context back with nobody asking?
// With one iframe the teardown is the srcDoc swap itself: the outgoing
// document fires pagehide and the guard releases. Only `(pagehide)` releases
// count for that — this is what stops an editing session accumulating
// contexts toward the browser's cap.
const spontaneous = () => glConsole.filter((m) => m.includes("released (pagehide)")).length;
for (let i = 0; i < 120; i++) {
  if ((await page.getByText("Testing your game").count()) === 0) { promoted = true; break; }
  await page.waitForTimeout(500);
}
check("the cover lifts once the edit settles", promoted, promoted ? "cover down" : "cover still up after 60s");
check(
  "the save channel stayed quiet while the edit verified",
  saveCalls.length === saveCallsAtEditStart,
  `${saveCalls.length - saveCallsAtEditStart} save call(s) mid-verify`,
);

// A teardown's console line still has to cross CDP after the frame is gone, so
// give it a moment rather than reading once.
for (let i = 0; i < 8 && spontaneous() === 0; i++) await page.waitForTimeout(250);
check(
  "verify rounds hand their GPU context back at teardown, unasked",
  spontaneous() > 0,
  `${spontaneous()} spontaneous release(s); trace below`,
);

if (promoted) {
  const after = frames()[0];
  const mark = await after.evaluate(() => window.__harnessMark ?? null).catch(() => "err");
  // The mark belonged to the OLD document; its absence proves the child is now
  // looking at the newly verified game rather than being stranded on the old.
  check("the child now sees the NEW game (old document replaced)", mark === null, `mark=${mark}`);
  const s = await sceneState(after);
  check("the promoted game renders", s.canvas === true && s.lost === false, JSON.stringify(s));
  const t = await after
    .evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const t0 = performance.now();
          const loop = () => {
            n++;
            if (performance.now() - t0 < 600) requestAnimationFrame(loop);
            else res(n);
          };
          requestAnimationFrame(loop);
        }),
    )
    .catch((e) => `err:${e.message}`);
  check("the promoted game is animating", typeof t === "number" && t > 5, `${t} ticks`);
}

// ── 8. A lost context FREEZES the loop — it must not die, and must resume ───
// The residual behind "blank and clicking does not restart it" (owner,
// 2026-08-10 second report): while a context is lost, three.js's render
// throws (`null.trim` in getUniforms — the stack this harness attributed),
// and games request their next frame AFTER rendering, so the throw kills the
// loop. preventDefault restores the CONTEXT; nothing is left to draw with it.
// The guard now holds rAF callbacks while any tracked context is lost.
// Deterministic both ways: without the hold, `heldDuring` reads ~30 ticks
// (and 1-in-3 runs die on the trim error); with it, 0 — then restore, and
// the SAME loop must come back on its own.
if (promoted) {
  const f8 = frames()[0];
  const freeze = await f8
    .evaluate(async () => {
      const c = document.querySelector("canvas");
      const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
      const ext = gl && gl.getExtension("WEBGL_lose_context");
      if (!ext) return { ok: false, why: "no WEBGL_lose_context (cannot test here)" };
      // Timing-independent measurement: with preventDefault in place Chrome
      // auto-restores an evicted context in well under a second, so "wait,
      // then probe" races the recovery (measured: lostNow=false by +600ms —
      // the system healing faster than the test). Instead classify every
      // probe tick by whether the context was lost AT THAT INSTANT.
      let lostTicks = 0;
      let liveTicks = 0;
      const probe = () => {
        if (gl.isContextLost()) lostTicks++;
        else liveTicks++;
        requestAnimationFrame(probe);
      };
      requestAnimationFrame(probe);
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 1200));
      ext.restoreContext(); // no-op if the browser already restored
      await new Promise((r) => setTimeout(r, 600));
      return {
        ok: true,
        lostTicks,
        liveTicks,
        stillLost: gl.isContextLost(),
        guard: !!window.__arGlGuard,
        tracked: window.__arGlCount ?? "absent",
      };
    })
    .catch((e) => ({ ok: false, why: e.message }));
  check(
    // ≤3, not ===0: a stray callback can slip through around the loss edge.
    // The failure mode under test is the loop running FREE against dead GL —
    // dozens of lost-instant ticks without the hold.
    "while the context is lost, the loop is HELD (nothing renders against dead GL)",
    freeze.ok === true && freeze.lostTicks <= 3,
    JSON.stringify(freeze),
  );
  check(
    "after restore the SAME loop is running (it survived the loss)",
    freeze.ok === true && freeze.liveTicks > 5 && freeze.stillLost === false,
    JSON.stringify(freeze),
  );
}

// ── 9. iOS-style backgrounding must NOT kill the live game (2026-08-10 №3) ──
// Safari fires pagehide(persisted=true) on a mere app/tab switch and brings
// the page back. The first ship of the guard released on EVERY pagehide, so
// backgrounding killed the live game's context and the loop-hold froze it —
// the owner's "pane froze, then turned blue when I clicked back". Simulate
// both halves: a persisted pagehide must release nothing; a non-persisted
// release followed by pageshow must restore and resume.
if (promoted) {
  const f9 = frames()[0];
  const bg = await f9
    .evaluate(async () => {
      const count = () => window.__arGlCount ?? "absent";
      const before = count();
      dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      await new Promise((r) => setTimeout(r, 100));
      const afterBackground = count();
      let n = 0;
      const probe = () => { n++; requestAnimationFrame(probe); };
      requestAnimationFrame(probe);
      await new Promise((r) => setTimeout(r, 400));
      const ticksAfterBackground = n;
      // Now the reversibility half: a real release, then the page "comes back".
      dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      await new Promise((r) => setTimeout(r, 100));
      const afterRelease = count();
      dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      await new Promise((r) => setTimeout(r, 300));
      const nAtShow = n;
      await new Promise((r) => setTimeout(r, 400));
      return {
        before,
        afterBackground,
        ticksAfterBackground,
        afterRelease,
        afterShow: count(),
        resumedTicks: n - nAtShow,
      };
    })
    .catch((e) => ({ err: e.message }));
  check(
    "a backgrounding pagehide (persisted) releases NOTHING — game keeps running",
    bg.afterBackground === bg.before && bg.ticksAfterBackground > 5,
    JSON.stringify(bg),
  );
  check(
    "a release followed by pageshow is fully reversible (restored + running)",
    bg.afterRelease === 0 && bg.afterShow === bg.before && bg.resumedTicks > 5,
    JSON.stringify(bg),
  );
}

// ── 10. gl-dead: a context that cannot come back remounts the game frame ────
// The last rung of the watchdog ladder (2026-08-10 №4, "it didnot regain"):
// when restoreContext is refused too, the game document can never draw again
// — the runtime posts {__ari:'gl-dead'} and ArtifactFrame must replace the
// played iframe (the automatic version of the owner's manual code↔preview
// toggle). Posted here directly (the real watchdog waits 5s of wall clock);
// what's under test is the parent's handling: remount, fresh document, alive.
if (promoted) {
  const before = frames()[0];
  await before.evaluate(() => { window.__harnessMark = 777; });
  await before.evaluate(() => parent.postMessage({ __ari: "gl-dead" }, "*"));
  let fresh = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    const f = frames()[0];
    const mark = await f?.evaluate(() => window.__harnessMark ?? null).catch(() => "gone");
    if (mark === null) { fresh = f; break; }
  }
  check("gl-dead remounts the played frame (fresh document)", fresh !== null, fresh ? "mark cleared" : "old document still mounted");
  if (fresh) {
    const alive = await fresh
      .evaluate(
        () =>
          new Promise((res) => {
            let n = 0;
            const t0 = performance.now();
            const loop = () => {
              n++;
              if (performance.now() - t0 < 600) requestAnimationFrame(loop);
              else res(n);
            };
            requestAnimationFrame(loop);
          }),
      )
      .catch((e) => `err:${e.message}`);
    check("the remounted game is animating (self-heal complete)", typeof alive === "number" && alive > 5, `${alive} ticks`);
  }
}

// The guard's own trace, in order. Collected silently above, so print it —
// without this the WebGL checks can only ever say pass/fail with no evidence.
console.log(
  `\n  [ari] runtime trace:\n${
    glConsole
      .filter((m) => /^\[ari(-debug)?\]/.test(m))
      .map((m) => `    ${m.slice(0, 120)}`)
      .join("\n") || "    (none)"
  }`,
);

check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

await page.screenshot({ path: "/tmp/harness-preview.png", fullPage: false });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
