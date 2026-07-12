// E2E for the Idea Button first-run coach (docs/PRD-IDEA-BUTTON.md §coach).
// Pins in a real browser what unit tests can't: intro shows once and stays
// SILENT (voice only via the 🔊 Hear it button — auto voice-over was removed
// as intrusive), all three dismissal paths persist `seen` (OK / backdrop / tab —
// the tab path must go STRAIGHT to listening), dismissal cancels an in-flight
// read-aloud, the wiggle-only re-nudge fires exactly once and only while
// unused, and reduced-motion keeps the full demo text.
// Stubs SpeechRecognition + SpeechSynthesis (headless has neither).
//
// Prereqs: `npm run dev` on :3000, playwright-core resolvable, and the
// Playwright chromium-headless-shell cache (same as e2e-preview-pane.mjs).
// Run: node scripts/e2e-idea-coach.mjs
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const GAME_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SHOT_DIR ?? ".";
const chromium = (await import(pathToFileURL(`${GAME_DIR}/node_modules/playwright-core/index.mjs`).href)).chromium;
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const shell = readdirSync(cache).find((d) => d.startsWith("chromium_headless_shell-"));
const EXE = `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const game = `<!doctype html><html><head><title>Dino</title></head><body style="margin:0;background:#87ceeb"><button id="start">Start</button><canvas id="c" width="200" height="100"></canvas><script>const x=document.getElementById('c').getContext('2d');let t=0;function loop(){t++;x.fillStyle='#001';x.fillRect(0,0,200,100);x.fillStyle='#fd0';x.fillRect(t%180,40,20,20);requestAnimationFrame(loop);}requestAnimationFrame(loop);document.getElementById('start').addEventListener('click',()=>{});</script></body></html>`;
const convo = { activeId: "c1", convos: [{ id: "c1", title: "dino", messages: [
  { id: "m1", role: "child", text: "make a dino game", createdAt: 1 },
  { id: "m2", role: "assistant", text: "Done! 🦖", artifactHtml: game, createdAt: 2 },
] }] };

const STUBS = `
window.__recs = []; window.__spoken = [];
window.SpeechRecognition = class {
  constructor(){ this.onresult=null; this.onend=null; this.onerror=null; window.__recs.push(this); }
  start(){} stop(){ queueMicrotask(()=>this.onend?.()); } abort(){}
};
window.SpeechSynthesisUtterance = class { constructor(t){ this.text = t; } };
window.__cancels = 0;
Object.defineProperty(window, "speechSynthesis", { value: {
  // Long enough to observe the ⏹ Stop state before onend flips back to idle.
  speak(u){ window.__spoken.push(u.text); setTimeout(()=>u.onend?.(), 1500); },
  cancel(){ window.__cancels++; }, pause(){}, resume(){}, getVoices(){ return []; }, speaking:false, paused:false,
}, configurable: true });`;

let failures = 0;
const check = (name, ok) => { console.log(ok ? "  ✓" : "  ✗", name); if (!ok) failures++; };
const browser = await chromium.launch({ executablePath: EXE });

async function freshPage(coachStore, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(STUBS);
  await page.goto("http://localhost:3000/");
  await page.evaluate(([c, coach]) => {
    localStorage.clear();
    localStorage.setItem("kidgemini:chats:v1", JSON.stringify(c));
    if (coach) localStorage.setItem("kidgemini:idea-coach:v1", JSON.stringify(coach));
  }, [convo, coachStore]);
  await page.reload();
  await page.getByRole("button", { name: /Open game/ }).click();
  await page.waitForSelector("text=Testing your game", { state: "detached", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return page;
}
const coachFlag = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("kidgemini:idea-coach:v1") ?? "null"));

console.log("A. fresh device → intro shows SILENTLY; 🔊 Hear it reads on request");
let p = await freshPage(null);
check("coach dialog visible", await p.getByRole("dialog", { name: "Meet the Idea Button" }).isVisible());
check("bubble copy present", await p.getByText("I'm your Idea Button!").isVisible());
check("NO auto voice-over", (await p.evaluate(() => window.__spoken)).length === 0);
check("Hear it button offered", await p.getByRole("button", { name: "Hear it" }).isVisible());
await p.screenshot({ path: `${OUT}/coach-A-intro.png` });
await p.getByRole("button", { name: "Hear it" }).click();
await p.waitForTimeout(200);
const spoken = await p.evaluate(() => window.__spoken);
check("Hear it spoke the coach line", spoken.some((t) => t.includes("Tap me and say your idea")));
check("button flips to Stop while speaking", await p.getByRole("button", { name: "Stop" }).isVisible());
await p.screenshot({ path: `${OUT}/coach-A-hear-it-speaking.png` });
await p.getByRole("button", { name: "Stop" }).click();
await p.waitForTimeout(100);
check("Stop returns to Hear it", await p.getByRole("button", { name: "Hear it" }).isVisible());

console.log("B. OK dismisses + persists seen + cancels an in-flight read-aloud");
await p.getByRole("button", { name: "Hear it" }).click();
const cancelsBefore = await p.evaluate(() => window.__cancels);
await p.getByRole("button", { name: /OK, got it/ }).click();
await p.waitForTimeout(200);
check("coach gone after OK", !(await p.getByRole("dialog", { name: "Meet the Idea Button" }).isVisible().catch(() => false)));
check("seen=true persisted", (await coachFlag(p))?.seen === true);
check("dismissal cancelled the read-aloud", (await p.evaluate(() => window.__cancels)) > cancelsBefore);

console.log("C. reload → never again");
await p.reload();
await p.getByRole("button", { name: /Open game/ }).click();
await p.waitForSelector("text=Testing your game", { state: "detached", timeout: 30000 }).catch(() => {});
await p.waitForTimeout(800);
check("no coach on second visit", !(await p.getByRole("dialog", { name: "Meet the Idea Button" }).isVisible().catch(() => false)));
await p.close();

console.log("D. tapping the TAB during the intro → dismiss AND straight to listening");
p = await freshPage(null);
await p.getByTitle("Tell me your idea!").click();
await p.waitForTimeout(300);
check("coach gone after tab tap", !(await p.getByRole("dialog", { name: "Meet the Idea Button" }).isVisible().catch(() => false)));
check("listening bar open (no second click needed)", await p.getByText("I'm listening!").isVisible());
check("seen=true persisted via tab tap", (await coachFlag(p))?.seen === true);
await p.screenshot({ path: `${OUT}/coach-D-tab-tap-listening.png` });
await p.close();

console.log("E. backdrop tap dismisses");
p = await freshPage(null);
await p.mouse.click(1100, 800); // dim area, away from bubble/tab
await p.waitForTimeout(200);
check("coach gone after backdrop tap", !(await p.getByRole("dialog", { name: "Meet the Idea Button" }).isVisible().catch(() => false)));
check("seen persisted", (await coachFlag(p))?.seen === true);
await p.close();

console.log("F. re-nudge after 3 idea-less games — wiggle only, once");
p = await freshPage({ seen: true, gamesSinceCoach: 3, everCaptured: false, renudged: false });
check("no full coach (already seen)", !(await p.getByRole("dialog", { name: "Meet the Idea Button" }).isVisible().catch(() => false)));
const tabClass = await p.getByTitle("Tell me your idea!").getAttribute("class");
check("tab wiggling", tabClass.includes("idea-coach-wiggle"));
await p.waitForTimeout(3400);
check("renudged=true persisted after the animation", (await coachFlag(p))?.renudged === true);
const tabClass2 = await p.getByTitle("Tell me your idea!").getAttribute("class");
check("wiggle over", !tabClass2.includes("idea-coach-wiggle"));
await p.close();

console.log("G. no re-nudge when the kid already captured an idea");
p = await freshPage({ seen: true, gamesSinceCoach: 9, everCaptured: true, renudged: false });
check("tab quiet", !(await p.getByTitle("Tell me your idea!").getAttribute("class")).includes("idea-coach-wiggle"));
await p.close();

console.log("H. no re-nudge twice");
p = await freshPage({ seen: true, gamesSinceCoach: 9, everCaptured: false, renudged: true });
check("tab quiet", !(await p.getByTitle("Tell me your idea!").getAttribute("class")).includes("idea-coach-wiggle"));
await p.close();

console.log("I. capturing an idea sets everCaptured (kills future nudges)");
p = await freshPage({ seen: true, gamesSinceCoach: 0, everCaptured: false, renudged: false });
const tab = p.getByTitle("Tell me your idea!");
await tab.click(); await p.waitForTimeout(200);
await tab.click(); await p.waitForTimeout(200);
await p.evaluate(() => {
  const r = window.__recs.at(-1);
  r.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: "make him purple" }], { isFinal: true })] });
});
await p.waitForTimeout(200);
await p.getByRole("button", { name: "✅ Got it!" }).click();
await p.waitForTimeout(300);
check("everCaptured=true persisted", (await coachFlag(p))?.everCaptured === true);
await p.close();

console.log("J. reduced motion → static coach, full demo text, still silent, Hear it works");
p = await freshPage(null, { reducedMotion: true });
check("coach visible", await p.getByRole("dialog", { name: "Meet the Idea Button" }).isVisible());
check("demo text fully visible (no typewriter)", await p.getByText('"make the dino purple!"').isVisible());
check("still no auto voice", (await p.evaluate(() => window.__spoken)).length === 0);
await p.getByRole("button", { name: "Hear it" }).click();
await p.waitForTimeout(200);
check("Hear it still reads aloud", (await p.evaluate(() => window.__spoken)).length > 0);
await p.screenshot({ path: `${OUT}/coach-J-reduced-motion.png` });
await p.close();

await browser.close();
console.log(failures ? `FAILURES: ${failures}` : "ALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
