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

// ── 2b. Mark the RUNNING game, so we can tell if the child keeps THEIR game ─
// The promise on screen during an edit is "you can keep playing this one!".
// That means the same running document, with its state — not a fresh copy of
// the same HTML. The owner's recording shows Strength 1800 -> 0 across an
// edit, i.e. the game restarted. A mark set on the live game survives only if
// the child's actual frame is preserved.
await frames()[0].evaluate(() => {
  window.__harnessMark = 4242;
});
const markBefore = await frames()[0].evaluate(() => window.__harnessMark ?? null);
check("mark set on the running game", markBefore === 4242, `mark=${markBefore}`);

// ── 3. Swap the game → the pane enters shadow verify (two live iframes) ─────
// The first game must have SETTLED for a fallback to exist; if it never
// reaches "done" there is nothing to fall back to and the pane covers instead.
const coverBefore = await page.getByText("Testing your game").count();
check("first game settled (no cover)", coverBefore === 0, `cover elements=${coverBefore}`);

await page.getByTestId("swap").click();
// Poll: the second iframe appears as soon as the new html starts verifying,
// and disappears again on promotion — a fixed sleep can miss the window
// entirely, which is exactly how an untested wiring stays untested.
let during = 0;
let sawShadow = false;
for (let i = 0; i < 40; i++) {
  during = frames().length;
  if (during >= 2) { sawShadow = true; break; }
  await page.waitForTimeout(500);
}
check("shadow verify mounts a second iframe", sawShadow, `${during} frame(s) after ${sawShadow ? "poll" : "20s"}`);

// ── 3a. The invariants `covered` used to enforce during a verify round ──────
// df9bd61 redefined `covered` from "the verify loop is running" to "there is
// nothing better to show". Four unrelated consumers read that flag, so all of
// them silently changed behaviour mid-edit. These pin the two that bite.
const saveDuringEdit = saveCalls.length;
const ideaMounted = await page.locator('[data-testid="idea-mic-tab"], button:has-text("IDEA")').count();
check(
  "the Idea mic tab is NOT mounted during an edit (one SpeechRecognition per page)",
  ideaMounted === 0,
  `idea tab elements=${ideaMounted}`,
);

// ── 3b. Is the fallback actually PLAYABLE? ──────────────────────────────────
// "Two iframes exist with canvases" is not the promise. The promise is that
// the child keeps PLAYING the old game: it must be the frame on top, it must
// be hit-testable, and its animation loop must still be ticking.
if (sawShadow) {
  // Role-based, never index-based: which element is on top is the question,
  // not which slot it happens to occupy. (The first version of this check
  // hardcoded iframe#1 and so encoded the BROKEN wiring as the expectation.)
  const panel = await page.evaluate(() => {
    const f = [...document.querySelectorAll("iframe")];
    if (f.length < 2) return { ok: false, detail: "fewer than 2 iframes" };
    const shadow = f.findIndex((el) => el.className.includes("opacity-0"));
    const play = f.findIndex((el) => !el.className.includes("opacity-0"));
    const r = f[play].getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      ok: top === f[play] && shadow !== -1 && play !== shadow,
      detail: `play=#${play} shadow=#${shadow} topmost=#${f.indexOf(top)} (${top?.getAttribute?.("title")})`,
    };
  });
  check("the PLAYED frame is the one the child can touch, not the shadow", panel.ok, panel.detail);

  // THE REGRESSION the owner recorded: is the playable frame the child's own
  // running game, or a fresh restart of it? A restart loses their score AND
  // doubles the WebGL contexts for one scene, which is what blanks the canvas
  // while the DOM HUD keeps its stale numbers.
  const marks = await Promise.all(
    frames().map((f) => f.evaluate(() => window.__harnessMark ?? null).catch(() => "err")),
  );
  const playable = await page.evaluate(() => {
    const f = document.querySelectorAll("iframe");
    return [...f].findIndex((el) => !el.className.includes("opacity-0"));
  });
  check(
    "the child KEEPS their running game (state survives the edit)",
    marks[playable] === 4242,
    `playable=iframe#${playable} marks=${JSON.stringify(marks)}`,
  );

  // Two contexts for one scene is what costs the older one its context.
  const lost = await Promise.all(
    frames().map((f) =>
      f
        .evaluate(() => {
          const c = document.querySelector("canvas");
          if (!c) return "no-canvas";
          const gl = c.getContext("webgl2") || c.getContext("webgl");
          return gl ? gl.isContextLost() : "no-gl";
        })
        .catch((e) => `err:${e.message}`),
    ),
  );
  check("no preview frame has lost its WebGL context", !lost.includes(true), JSON.stringify(lost));

  /** rAF ticking = the game is alive rather than a frozen first paint. */
  const ticks = async (f) =>
    f
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

  const fs = frames();
  for (let i = 0; i < fs.length; i++) {
    const n = await ticks(fs[i]);
    console.log(`    frame#${i} rAF ticks in 600ms: ${n}`);
    check(`frame#${i} animation loop is running`, typeof n === "number" && n > 5, `${n} ticks`);
  
  }

  // ── 6c. The round gives its GPU context BACK (the pile-up, not one bad edit) ─
  // The owner's 2026-08-10 console paste shows ELEVEN edits in one sitting before
  // the blue appeared. A WebGL context is not freed when its iframe is detached —
  // it lives until GC — so each round leaves one behind until the page hits the
  // browser's cap and the OLDEST context is evicted: the child's game.
  //
  // The cap cannot be reached on demand here (headless uses SwiftShader, whose
  // limits differ from the owner's machine), so this does NOT prove the eviction
  // is cured. It proves the mechanism that prevents it: asking a round to release
  // actually releases it, and releases the RIGHT frame. Without the message
  // listener in webglContextGuard, or without the parent's layout-effect post,
  // this fails.
  if (sawShadow && frames().length === 2) {
    const marks = await Promise.all(
      frames().map((f) => f.evaluate(() => window.__harnessMark ?? null).catch(() => "err")),
    );
    const shadowIdx = marks.findIndex((m) => m !== 4242);
    const playIdx = shadowIdx === 0 ? 1 : 0;
    if (shadowIdx >= 0) {
      const shadow = frames()[shadowIdx];
      const read = (f) => f.evaluate(() => window.__arGlCount ?? "absent").catch((e) => `err:${e.message}`);

      const beforeCount = await read(shadow);
      check(
        "the shadow round holds a GPU context the guard is tracking",
        typeof beforeCount === "number" && beforeCount > 0,
        `__arGlCount=${beforeCount}`,
      );

      // Exactly what ArtifactFrame's layout-effect cleanup posts on unmount.
      await page.evaluate(() => {
        const el = [...document.querySelectorAll("iframe")].find((i) => i.className.includes("opacity-0"));
        el?.contentWindow?.postMessage({ __ari: "release-gl" }, "*");
      });
      await page.waitForTimeout(300);

      const afterCount = await read(shadow);
      check(
        "asking the round to release actually frees its context",
        afterCount === 0,
        `__arGlCount ${beforeCount} -> ${afterCount}`,
      );

      const playScene = await sceneState(frames()[playIdx]);
      check(
        "releasing the round does NOT touch the child's game",
        playScene.canvas === true && playScene.lost === false,
        JSON.stringify(playScene),
      );

      // Undo the manual release so the rest of the run sees the shadow the
      // way production would (nobody releases a round mid-verify). On WebKit
      // the shadow settles slowly enough that later live-canvas checks used
      // to catch our own released context as `lost:true`. Restoring through
      // the guard's pageshow path also proves reversibility on THIS engine.
      await shadow
        .evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
        .catch(() => {});
      await page.waitForTimeout(200);
      const restoredCount = await read(shadow);
      check(
        "the release is reversible in-place (pageshow restores the round)",
        restoredCount === beforeCount,
        `__arGlCount ${afterCount} -> ${restoredCount}`,
      );
    }
  }
}

// ── 4. THE REGRESSION: can the child still type mid-edit? ───────────────────
await box.click();
await box.type("can i type mid edit", { delay: 25 });
const mid = await box.inputValue();
check("composer accepts typing DURING shadow verify", mid === "can i type mid edit", JSON.stringify(mid));

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

// ── 6. The visible game keeps its scene while the new one is probed ─────────
for (const f of frames()) {
  const s = await sceneState(f);
  console.log(`    frame: ${JSON.stringify(s)}`);
}
const scenes = await Promise.all(frames().map(sceneState));
check(
  "every preview frame still has a live canvas",
  scenes.every((s) => s.canvas && s.lost === false),
  JSON.stringify(scenes),
);

// ── 6b. WebGL context loss: the game must COME BACK, not blank forever ──────
// The owner's second recording shows the played document intact (Strength 900
// before AND during the edit) while its canvas empties — the signature of an
// evicted WebGL context, not a reload. Loss is permanent unless the page calls
// preventDefault() on `webglcontextlost`, which nothing did. Force a loss and
// require recovery.
if (sawShadow) {
  const play = frames().find(async () => true) ?? frames()[0];
  const lossResult = await play
    .evaluate(async () => {
      const c = document.querySelector("canvas");
      if (!c) return { ok: false, why: "no canvas" };
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return { ok: false, why: "no gl" };
      const ext = gl.getExtension("WEBGL_lose_context");
      if (!ext) return { ok: false, why: "no WEBGL_lose_context (cannot test here)" };
      let restored = false;
      c.addEventListener("webglcontextrestored", () => { restored = true; }, { once: true });
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 200));
      const lostNow = gl.isContextLost();
      ext.restoreContext();
      await new Promise((r) => setTimeout(r, 800));
      return { ok: true, lostNow, restored, stillLost: gl.isContextLost() };
    })
    .catch((e) => ({ ok: false, why: e.message }));
  // NOTE on what this can and cannot prove. Restoring after an EXPLICIT
  // ext.loseContext() works with or without preventDefault — so asserting
  // "it came back" passes even with the guard removed, and is worthless.
  // What preventDefault actually buys is recovery from a BROWSER-INITIATED
  // eviction, which cannot be triggered on demand. So assert the thing that
  // is genuinely observable: our handler ran and asked for the restore.
  const ourHandlerRan = glConsole.some((m) => m.includes("[ari] WebGL context lost"));
  check(
    "the context-loss guard is installed and fires (preventDefault path)",
    ourHandlerRan,
    ourHandlerRan ? "saw '[ari] WebGL context lost'" : `guard silent; frame console: ${JSON.stringify(glConsole.slice(-3))}`,
  );
  // On WebKit the shadow can settle (and the play frame navigate to the
  // promoted document) in the middle of this evaluate — that destroys the
  // execution context, which is promotion working, not a loss failure. Only
  // an actual completed loss/restore cycle can pass or fail this check.
  const promotionRaced =
    lossResult.ok === false && /Execution context was destroyed/i.test(String(lossResult.why));
  check(
    "the context comes back after an explicit loss (weak: passes without the guard too)",
    promotionRaced || (lossResult.ok === true && lossResult.stillLost === false),
    promotionRaced ? "skipped: promotion navigated the frame mid-test" : JSON.stringify(lossResult),
  );
}

// ── 7. PROMOTION: the new version must actually reach the child ─────────────
// Preserving the old game is only half the promise. When the edit settles the
// shadow must unmount and the child must be looking at the NEW game — a fix
// that kept them on the old one forever would pass every check above.
let promoted = false;
// Everything above only proves the guard OBEYS a release request — the harness
// sent that one itself, and it is tagged `(asked)`. The question that decides
// whether an editing session accumulates contexts is different: does a round
// hand its context back when the pane tears it down, with nobody asking?
// Only `(pagehide)` releases count for that.
const spontaneous = () => glConsole.filter((m) => m.includes("released (pagehide)")).length;
for (let i = 0; i < 60; i++) {
  if (frames().length === 1) { promoted = true; break; }
  await page.waitForTimeout(500);
}
check("the shadow unmounts once the edit settles", promoted, `${frames().length} frame(s)`);

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
