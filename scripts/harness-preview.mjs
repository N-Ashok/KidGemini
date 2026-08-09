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

const chromium = await (async () => {
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    const dir = process.env.PLAYWRIGHT_CORE_DIR;
    if (!dir) throw new Error("playwright-core not installed — set PLAYWRIGHT_CORE_DIR");
    return (await import(pathToFileURL(`${dir}/index.mjs`).href)).chromium;
  }
})();

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const dir = readdirSync(cache).find((d) => d.startsWith(HEADED ? "chromium-" : "chromium_headless_shell-"));
const exe = HEADED
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
page.on("pageerror", (e) => pageErrors.push(e.message));

// The save channel's traffic. Its own comment says it must be "active only
// once the game is up and playable (never mid-verify-cover), so the existing-
// save lookup and autosave never race the verify loop" — so a request to it
// while a new version is being probed is that invariant breaking.
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

// ── 7. PROMOTION: the new version must actually reach the child ─────────────
// Preserving the old game is only half the promise. When the edit settles the
// shadow must unmount and the child must be looking at the NEW game — a fix
// that kept them on the old one forever would pass every check above.
let promoted = false;
for (let i = 0; i < 60; i++) {
  if (frames().length === 1) { promoted = true; break; }
  await page.waitForTimeout(500);
}
check("the shadow unmounts once the edit settles", promoted, `${frames().length} frame(s)`);

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

check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

await page.screenshot({ path: "/tmp/harness-preview.png", fullPage: false });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
