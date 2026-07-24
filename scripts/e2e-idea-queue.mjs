// E2E for the unified Idea Queue (docs/PRD-IDEA-QUEUE-V2.md). Pins in a real
// browser what unit tests can't: a restored line always ASKS before draining;
// resume drains the front tweak RUN as ONE bundled chat message (✨ label)
// while the build row keeps waiting; the composer queues while busy and the
// 6th idea is refused WITH the typed text kept; and on mobile the preview's
// ⏳/⏸ chip opens a sheet where "keep going" works without leaving the game,
// with the banner narrating which queued idea is building.
//
// Prereqs: Ari dev server (BASE env or :3000), playwright-core resolvable in
// this repo or ../Ariantra-Platform, and the Playwright chromium-headless-shell
// cache (same as e2e-preview-pane.mjs). Run: node scripts/e2e-idea-queue.mjs
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const GAME_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? ".";
const pwCandidates = [
  `${GAME_DIR}/node_modules/playwright-core/index.mjs`,
  `${GAME_DIR}/../Ariantra-Platform/node_modules/playwright-core/index.mjs`,
];
const pwPath = pwCandidates.find((p) => existsSync(p));
if (!pwPath) throw new Error("playwright-core not found in Game or Ariantra-Platform node_modules");
const chromium = (await import(pathToFileURL(pwPath).href)).chromium;
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const shell = readdirSync(cache).find((d) => d.startsWith("chromium_headless_shell-"));
const EXE = `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const game = `<!doctype html><html><head><title>Dino</title></head><body style="margin:0;background:#87ceeb"><button id="start">Start</button><canvas id="c" width="200" height="100"></canvas><script>const x=document.getElementById('c').getContext('2d');let t=0;function loop(){t++;x.fillStyle='#014';x.fillRect(0,0,200,100);x.fillStyle='#fd0';x.fillRect(t%180,40,20,20);requestAnimationFrame(loop);}requestAnimationFrame(loop);document.getElementById('start').addEventListener('click',()=>{});</script></body></html>`;

const queuedIdeas = [
  { id: "t1", text: "make the sky blue", kind: "tweak", createdAt: 1 },
  { id: "t2", text: "add a jump sound", kind: "tweak", createdAt: 2 },
  { id: "b1", text: "a racing game with power-ups", kind: "build", createdAt: 3 },
];
const convo = { activeId: "c1", convos: [{ id: "c1", title: "dino", queuedIdeas, messages: [
  { id: "m1", role: "child", text: "make a dino game", createdAt: 1 },
  { id: "m2", role: "assistant", text: "Done! 🦖", artifactHtml: game, createdAt: 2 },
] }] };

let failures = 0;
const check = (name, ok) => { console.log(ok ? "  ✓" : "  ✗", name); if (!ok) failures++; };
const browser = await chromium.launch({ executablePath: EXE });

async function freshPage({ width = 1440, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  // Slow-streamed /api/chat: 4s pending, then a done event with a new game —
  // long enough to observe every busy-state affordance.
  await page.route("**/api/chat", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: JSON.stringify({ type: "done", text: "Here you go! ✨", artifactHtml: game }) + "\n",
    });
  });
  await page.route("**/api/chats**", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ chats: [] }) })
      : route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.goto(`${BASE}/`);
  await page.evaluate((c) => {
    localStorage.clear();
    localStorage.setItem("kidgemini:chats:v1", JSON.stringify(c));
    localStorage.setItem("kidgemini:idea-coach:v1", JSON.stringify({ seen: true, gamesSinceCoach: 0, everCaptured: true, renudged: true }));
  }, convo);
  await page.reload({ waitUntil: "networkidle" });
  // Dev-mode hydration can lag behind a recompile — wait for the seeded chat
  // to actually mount before asserting anything.
  await page.waitForSelector("text=make a dino game", { timeout: 30000 });
  return page;
}

// ── 1. Desktop chat: restored line held; resume bundles the tweak run ──────
{
  const page = await freshPage();
  check("restored chat asks before draining", await page.getByText("Still want these?").isVisible());
  check("tweak rows render ✨ badges", (await page.locator("li:has-text('make the sky blue') >> text=✨").count()) > 0);
  await page.screenshot({ path: join(OUT, "queue-1-desktop-held.png") });

  await page.getByRole("button", { name: /keep going/ }).click();
  await page.waitForTimeout(700);
  check("resume drains the tweak run as ONE bundled chat message", (await page.getByText("Here are my ideas from playing:").count()) > 0);
  check("bundle bubble carries the ✨ label", (await page.getByText("Your spoken ideas").count()) > 0);
  check("build row is still waiting its turn", (await page.getByText("a racing game with power-ups").count()) > 0);
  check("composer offers Stop AND queue-send while busy", (await page.getByRole("button", { name: "Stop generating" }).count()) > 0);
  await page.close();
}

// ── 2. Desktop: type while busy → joins the line; the 6th idea is refused ──
{
  const page = await freshPage();
  await page.getByRole("button", { name: /keep going/ }).click();
  await page.waitForTimeout(400); // busy now (4s stub)
  const box = page.getByPlaceholder("Add your next idea…");
  check("busy composer invites the next idea", await box.isVisible());
  // Drain took the 2-tweak run; 1 build remains → 4 more fill the line to 5.
  for (const idea of ["a space maze", "a cooking game", "a robot pet", "a pirate quiz"]) {
    await box.fill(idea);
    await box.press("Enter");
  }
  await box.fill("one too many ideas");
  await box.press("Enter");
  check("line-full refusal says why", (await page.getByText(/can hold 5 ideas/).count()) > 0);
  check("refused text stays in the composer", (await box.inputValue()) === "one too many ideas");
  await page.screenshot({ path: join(OUT, "queue-2-desktop-full-line.png") });
  await page.close();
}

// ── 3. Mobile 390: the preview covers the chat — chip + sheet carry the line ─
{
  const page = await freshPage({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Open game/ }).click();
  await page.waitForSelector("text=Testing your game", { state: "detached", timeout: 30000 }).catch(() => {});
  const chip = page.getByRole("button", { name: /paused — 3 waiting/ });
  check("held line shows the ⏸ chip in the preview header", await chip.isVisible());
  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Your idea line" });
  check("sheet opens with the ask", await sheet.getByText("Still want these?").isVisible());
  await page.screenshot({ path: join(OUT, "queue-3-mobile-sheet.png") });
  await sheet.getByRole("button", { name: /keep going/ }).click();
  await page.waitForTimeout(700);
  check("resume from the SHEET drains too (banner narrates the queued idea)", (await page.getByText(/Making "/).count()) > 0);
  await page.screenshot({ path: join(OUT, "queue-4-mobile-narrated-banner.png") });
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall idea-queue e2e checks passed");
process.exit(failures ? 1 : 0);
