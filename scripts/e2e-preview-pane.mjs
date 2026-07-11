// E2E regression pin for docs/PRD-PREVIEW-PANE.md (BUG-FIX-LOG 2026-07-11).
// Pins, in a real browser, what unit tests can't (no @testing-library here):
//   1. Full-screen toggle expands/collapses WITHOUT remounting the iframe.
//   2. While an update streams, the OLD game stays visible + playable
//      (no verify cover), with the "Making your update…" strip shown.
//   3. When the update lands, the NEW game actually reaches the iframe
//      (round-collision bug: it used to stay on the old game forever).
//
// Prereqs: `npm run dev` on :3000, `playwright-core` resolvable (npm i in this
// repo OR PLAYWRIGHT_CORE_DIR=/path/to/node_modules/playwright-core), and the
// Playwright chromium-headless-shell cache
// (~/Library/Caches/ms-playwright/chromium_headless_shell-*).
// Run: node scripts/e2e-preview-pane.mjs
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

const game = (title) => `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;background:#123;color:#fff"><h1>${title}</h1><button id="start">Start</button><canvas id="c" width="360" height="240"></canvas>
<script>const x=document.getElementById('c').getContext('2d');let t=0;function loop(){t++;x.fillStyle='#001';x.fillRect(0,0,360,240);x.fillStyle='#fd0';x.fillRect(t%300,100,20,20);requestAnimationFrame(loop);}requestAnimationFrame(loop);document.getElementById('start').addEventListener('click',()=>{});</script></body></html>`;

const convo = { v: 1, activeId: "c1", convos: [{ id: "c1", title: "t", messages: [
  { id: "m1", role: "child", text: "make me a game", createdAt: 1 },
  { id: "m2", role: "assistant", text: "Here! 🌟", artifactHtml: game("GameV1"), createdAt: 2 },
] }] };

let failures = 0;
const check = (name, ok) => { console.log(ok ? "  ✓" : "  ✗", name); if (!ok) failures++; };

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route("**/api/chat", async (route) => {
  await new Promise((r) => setTimeout(r, 3000)); // simulate generation time
  await route.fulfill({ status: 200, contentType: "application/x-ndjson",
    body: JSON.stringify({ type: "done", text: "v2 ready", artifactHtml: game("GameV2") }) + "\n" });
});
await page.goto("http://localhost:3000/");
await page.evaluate((d) => localStorage.setItem("kidgemini:chats:v1", JSON.stringify(d)), convo);
await page.reload();
await page.getByRole("button", { name: /Open game/ }).click();
await page.waitForSelector("text=Testing your game", { state: "detached", timeout: 30000 }).catch(() => {});
await page.waitForTimeout(800);
const srcGame = () => page.evaluate(() => document.querySelector("iframe")?.getAttribute("srcdoc")?.match(/Game(V\d)/)?.[1] ?? "?");

console.log("full-screen toggle:");
const panelWidth = () => page.locator("aside", { hasText: "Preview" }).boundingBox().then((b) => b?.width ?? 0);
const expand = page.getByRole("button", { name: "Full screen" });
check("expand button visible+enabled", (await expand.isVisible()) && (await expand.isEnabled()));
const widthBefore = await panelWidth();
check("collapsed panel is the side column (~440px)", widthBefore < 600);
await expand.click();
await page.waitForTimeout(400);
check("expanded panel fills the viewport", (await panelWidth()) > 1400);
check("iframe not remounted (still V1)", (await srcGame()) === "V1");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Esc restores the side column at its prior width", (await panelWidth()) === widthBefore);

console.log("old game during update:");
await page.getByPlaceholder(/Ask me anything/).fill("add score");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500); // mid-generation
check("old game still in iframe", (await srcGame()) === "V1");
check("no verify cover over old game", !(await page.getByText("Testing your game").isVisible().catch(() => false)));
check("updating strip shown", await page.getByText("keep playing this one").isVisible());

console.log("new game swaps in when done:");
await page.waitForFunction(() => document.querySelector("iframe")?.getAttribute("srcdoc")?.includes("GameV2"), null, { timeout: 15000 }).catch(() => {});
check("new game reached the iframe (round-collision pin)", (await srcGame()) === "V2");
await page.waitForSelector("text=Testing your game", { state: "detached", timeout: 30000 }).catch(() => {});
check("verify uncovered the new game", !(await page.getByText("Testing your game").isVisible().catch(() => false)));

await browser.close();
console.log(failures ? `FAIL (${failures})` : "PASS");
process.exit(failures ? 1 : 0);
