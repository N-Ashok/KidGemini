// E2E regression pin for mic dictation (useSpeechInput + Composer wiring).
// Real SpeechRecognition can't run headless (it needs Chrome's Google audio
// backend and a live microphone), so this drives the REAL page in a real
// Chromium with a scripted SpeechRecognition fake injected before app JS
// runs — pinning, in a browser, what the vm-based unit tests can't: the
// composer's live interim display, final commits, the repeat-mic classes
// (BUG-FIX-LOG 2026-07-14 resultIndex replay + 2026-07-16 restart race),
// the interim flush on session end, and the kid-friendly error banner.
//
// Prereqs: `npm run dev` on :3001, `playwright-core` resolvable (npm i OR
// PLAYWRIGHT_CORE_DIR), and the Playwright chromium-headless-shell cache.
// Run: node scripts/e2e-mic-dictation.mjs
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const chromium = await (async () => {
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    const dir = process.env.PLAYWRIGHT_CORE_DIR;
    if (!dir) throw new Error("playwright-core not installed — npm i playwright-core or set PLAYWRIGHT_CORE_DIR");
    return (await import(pathToFileURL(`${dir}/index.mjs`).href)).chromium;
  }
})();

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const shell = readdirSync(cache).find((d) => d.startsWith("chromium_headless_shell-"));
if (!shell) throw new Error("no chromium_headless_shell in playwright cache");
const EXE = `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const BASE = process.env.BASE_URL ?? "http://localhost:3001";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✖"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();

// The fake mimics Chrome's cumulative-results semantics: one results LIST per
// session, growing over time; events may replay earlier entries with a stale
// resultIndex (the 2026-07-14 bug's trigger). Controlled from the test via
// window.__mic.
await page.addInitScript(() => {
  const state = { instance: null, startCalls: 0, throwNextStart: false, started: false };
  window.__mic = state;
  window.SpeechRecognition = class {
    constructor() {
      state.instance = this;
      this.onresult = null;
      this.onend = null;
      this.onerror = null;
    }
    start() {
      state.startCalls += 1;
      if (state.throwNextStart) {
        state.throwNextStart = false;
        throw new Error("already started"); // Chrome's restart-race quirk
      }
      state.started = true;
    }
    stop() { state.started = false; }
    abort() { state.started = false; }
  };
  // Helper the test calls: emit a results event shaped like Chrome's.
  window.__emit = (segments, resultIndex = 0) => {
    const results = segments.map(([transcript, isFinal]) => {
      const r = [{ transcript }];
      r.isFinal = isFinal;
      return r;
    });
    state.instance?.onresult?.({ resultIndex, results });
  };
  window.__end = () => state.instance?.onend?.();
  window.__error = (code) => state.instance?.onerror?.({ error: code });
});

console.log(`mic dictation e2e against ${BASE}`);
await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });

const mic = page.locator('button[aria-label="Talk"], button[aria-label="Stop listening"]');
const box = page.locator("textarea");

// 1) Supported detection: the fake exists, so the mic button must render.
await mic.waitFor({ timeout: 15_000 });
check("mic button renders when SpeechRecognition is available", await mic.count() === 1);

// 2) Toggle on: start() called, pressed state, composer locked for typing.
await mic.click();
check("click starts a recognition session", await page.evaluate(() => window.__mic.startCalls) === 1);
check("button flips to listening (aria-pressed)", await mic.getAttribute("aria-pressed") === "true");
check("composer is read-only while dictating", await box.getAttribute("readonly") !== null);

// 3) Interim results appear live in the composer.
await page.evaluate(() => window.__emit([["make me a", false]]));
check("interim words appear as the kid speaks", (await box.inputValue()).includes("make me a"));

// 4) A finalized segment commits; interim tail keeps showing after it.
await page.evaluate(() => window.__emit([["make me a maze game", true], ["with pen", false]]));
check("final + live tail both visible", (await box.inputValue()) === "make me a maze game with pen");

// 5) Repeat-mic class (2026-07-14): the browser replays ALL finals with a
// stale resultIndex — already-committed finals must not duplicate.
await page.evaluate(() => window.__emit([["make me a maze game", true], ["with penguins", true]], 0));
const afterReplay = await box.inputValue();
check("replayed finals never duplicate", afterReplay === "make me a maze game with penguins", `got "${afterReplay}"`);

// 6) Interim flush (2026-07-10): a session that dies mid-speech commits the
// pending tail exactly once, and auto-restarts while the kid wants the mic.
await page.evaluate(() => window.__emit([["make me a maze game", true], ["with penguins", true], ["in 3d", false]], 0));
await page.evaluate(() => window.__end());
const afterFlush = await box.inputValue();
check("pending tail committed once on session end", afterFlush === "make me a maze game with penguins in 3d", `got "${afterFlush}"`);
await page.waitForTimeout(350); // silent-restart delay is 200ms
check("mic auto-restarted after silence end", await page.evaluate(() => window.__mic.startCalls) === 2);

// 7) Restart race (2026-07-16 take 2): start() throws, the OLD session (with
// its cumulative finals) keeps running — a replay must still not duplicate.
await page.evaluate(() => { window.__mic.throwNextStart = true; });
await page.evaluate(() => window.__end());
await page.waitForTimeout(350);
await page.evaluate(() => window.__emit(
  [["make me a maze game", true], ["with penguins", true], ["in 3d", true], ["please", true]], 0));
const afterRace = await box.inputValue();
check(
  "failed restart keeps the committed counter — no replay flood",
  afterRace === "make me a maze game with penguins in 3d please",
  `got "${afterRace}"`,
);

// 8) Stop: pressed state clears and typing unlocks. force: the listening
// button pulses (mic-listening animation) and never reads as "stable".
await mic.click({ force: true });
check("stop returns the button to idle", await mic.getAttribute("aria-pressed") === "false");
check("composer editable again after stop", await box.getAttribute("readonly") === null);

// 9) Fatal error path: permission denied mid-listen → kid-friendly banner,
// listening ends (no silent "nothing happened").
await mic.click();
await page.evaluate(() => window.__error("not-allowed"));
const banner = await page.locator("text=/microphone|mic/i").first().textContent().catch(() => "");
check("permission error shows a kid-friendly message", Boolean(banner && banner.trim()), "no error banner found");
check("error ends the listening state", await mic.getAttribute("aria-pressed") === "false");

await browser.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
