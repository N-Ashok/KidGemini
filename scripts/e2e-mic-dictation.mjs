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
  // Mic-permission stub (2026-07-20 recovery cards): "granted" by default so
  // the dictation flows skip the pre-ask coach; scenarios flip it to
  // "denied"/"prompt" to drive the device-aware recovery cards.
  state.permission = "granted";
  Object.defineProperty(navigator, "permissions", {
    value: { query: async () => ({ state: state.permission }) },
    configurable: true,
  });
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

// 7b) Android duplicate-final artifact (2026-07-19 take 4, Pixel Chrome+Edge):
// the recognizer RE-APPENDS the same final on successive events — each
// duplicate is a fresh single-segment slice past the counter, which take 3's
// single-match allowance let through, once per event ("every 3 words captured
// 30-40 times"). Adjacent in-list duplicates must never re-commit.
await page.evaluate(() => window.__emit(
  [["make me a maze game", true], ["with penguins", true], ["in 3d", true], ["please", true], ["please", true]], 0));
await page.evaluate(() => window.__emit(
  [["make me a maze game", true], ["with penguins", true], ["in 3d", true], ["please", true], ["please", true], ["please", true]], 0));
const afterDupes = await box.inputValue();
check(
  "Android re-appended duplicate finals never re-commit",
  afterDupes === "make me a maze game with penguins in 3d please",
  `got "${afterDupes}"`,
);

// 7c) The take-3 allowance survives take 4: a genuine repeat as the FIRST
// final of a fresh session (no in-list predecessor) still commits.
await page.evaluate(() => window.__end());
await page.waitForTimeout(350);
await page.evaluate(() => window.__emit([["please", true]], 0));
const afterRepeat = await box.inputValue();
check(
  "a real repeated phrase in a fresh session still commits (no over-dedup)",
  afterRepeat === "make me a maze game with penguins in 3d please please",
  `got "${afterRepeat}"`,
);

// 7d) Android growing re-finalization (take 4 shape 2, production screenshot
// "I I want I want to..."): the same utterance re-finalized as it grows must
// commit only the newly-heard words, never the whole snapshot again.
await page.evaluate(() => window.__emit([["please", true], ["please and a dragon", true]], 0));
await page.evaluate(() => window.__emit(
  [["please", true], ["please and a dragon", true], ["please and a dragon that flies", true]], 0));
const afterGrowth = await box.inputValue();
check(
  "growing re-finalized snapshots commit only their delta",
  afterGrowth === "make me a maze game with penguins in 3d please please and a dragon that flies",
  `got "${afterGrowth}"`,
);

// 8) Stop: pressed state clears and typing unlocks. force: the listening
// button pulses (mic-listening animation) and never reads as "stable".
await mic.click({ force: true });
check("stop returns the button to idle", await mic.getAttribute("aria-pressed") === "false");
check("composer editable again after stop", await box.getAttribute("readonly") === null);

// 9) Fatal error path: permission denied mid-listen → recovery card,
// listening ends (no silent "nothing happened").
await mic.click();
await page.evaluate(() => window.__error("not-allowed"));
await page.locator("text=The mic is switched off for Ari").waitFor({ timeout: 5_000 }).catch(() => {});
check(
  "permission error shows the site-blocked recovery card",
  await page.locator("text=The mic is switched off for Ari").count() === 1,
);
check("error ends the listening state", await mic.getAttribute("aria-pressed") === "false");

// 10) Device-aware recovery cards (BUG-FIX-LOG 2026-07-20 "laptop told to
// fix Siri"). Headless Chromium on this box reports a Mac desktop — the
// exact device class the bug hit.
console.log("recovery cards:");

// 10a) Site-blocked card: lock-icon steps + Try again, and NEVER Siri.
check("site-blocked card has the lock-icon step", await page.locator("text=/lock next to the web address/i").count() === 1);
const tryAgainBtn = page.locator('button:has-text("Try again")');
check("site-blocked card offers Try again", await tryAgainBtn.count() === 1);
check("laptop card never mentions Siri", await page.locator("text=/siri/i").count() === 0);

// 10b) Try again re-attempts the mic (card clears, a new session starts).
const startsBefore = await page.evaluate(() => window.__mic.startCalls);
await tryAgainBtn.click();
check("Try again starts a fresh session", await page.evaluate(() => window.__mic.startCalls) === startsBefore + 1);
check("Try again clears the card", await page.locator("text=The mic is switched off for Ari").count() === 0);

// 10c) OS-blocked on a LAPTOP (the incident): System Settings steps, the
// grown-up chip, and never Siri/phone wording.
await page.evaluate(() => { window.__mic.permission = "denied"; });
await page.evaluate(() => window.__error("service-not-allowed"));
await page.locator("text=/System Settings/").waitFor({ timeout: 5_000 }).catch(() => {});
check("os-blocked laptop card names System Settings", await page.locator("text=/System Settings/").count() >= 1);
check("os-blocked card flags a grown-up", await page.locator("span:has-text('Ask a grown-up')").count() === 1);
check("os-blocked laptop card never mentions Siri", await page.locator("text=/siri/i").count() === 0);
// Visual pass artifact (§8 gate 9): the card at mobile width.
await page.setViewportSize({ width: 375, height: 720 });
await page.screenshot({ path: process.env.MIC_CARD_SHOT ?? "/tmp/mic-recovery-card.png" });
await page.setViewportSize({ width: 1280, height: 720 });
await page.locator('button[aria-label="Dismiss"]').click();

// 10d) Pre-ask coach: a fresh page with permission still at "prompt" — the
// first mic tap coaches instead of firing the browser prompt blind.
const page2 = await browser.newPage();
await page2.addInitScript(() => {
  const state = { instance: null, startCalls: 0, permission: "prompt" };
  window.__mic = state;
  window.SpeechRecognition = class {
    constructor() { state.instance = this; this.onresult = null; this.onend = null; this.onerror = null; }
    start() { state.startCalls += 1; }
    stop() {}
    abort() {}
  };
  Object.defineProperty(navigator, "permissions", {
    value: { query: async () => ({ state: state.permission }) },
    configurable: true,
  });
});
await page2.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
const mic2 = page2.locator('button[aria-label="Talk"], button[aria-label="Stop listening"]');
await mic2.waitFor({ timeout: 15_000 });
await mic2.click();
await page2.locator("text=Your browser will ask about the microphone").waitFor({ timeout: 5_000 }).catch(() => {});
check("first tap at state=prompt shows the coach, not the raw prompt",
  await page2.locator("text=Your browser will ask about the microphone").count() === 1);
check("coach did not start a session yet", await page2.evaluate(() => window.__mic.startCalls) === 0);
await page2.locator('button:has-text("Okay, ask me!")').click();
check("coach's Okay starts the real session", await page2.evaluate(() => window.__mic.startCalls) === 1);
await page2.close();

await browser.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
