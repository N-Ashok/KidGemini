// E2E regression pin for docs/2026-08-01_PRD_SaveContinueBuilding.md Phase 2:
// pins, in a real browser, what unit tests can't (no @testing-library here;
// ArtifactFrame has no component test file, same convention as
// e2e-preview-pane.mjs) —
//   1. A game carrying <!--SUPPORTS_SAVE--> with an existing server-side save
//      shows the "Continue your build?" banner.
//   2. Tapping Continue reloads the SAME iframe with
//      window.__ARIANTRA_INITIAL_STATE__ injected, matching the saved state.
//   3. Tapping Start fresh dismisses the banner WITHOUT reloading the iframe
//      (the already-running fresh game is left untouched).
//   4. A game with no marker at all never shows the banner and never calls
//      GET /api/game-save.
//
// Prereqs: `npm run dev` on :3000 (or PORT env), playwright-core resolvable
// (npm i in this repo OR PLAYWRIGHT_CORE_DIR=/path/to/node_modules/playwright-core),
// and the Playwright chromium-headless-shell cache.
// Run: node scripts/e2e-game-save.mjs
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

const PORT = process.env.PORT || 3911;
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const shell = readdirSync(cache).find((d) => d.startsWith("chromium_headless_shell-"));
if (!shell) throw new Error("no chromium_headless_shell in playwright cache");
const EXE = `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

let failures = 0;
const check = (name, ok) => { console.log(ok ? "  ✓" : "  ✗", name); if (!ok) failures++; };

// A minimal "build/world" game implementing the save contract §3a: replies to
// a save request with a fixed payload, and if booted with an initial state,
// stamps it onto the DOM so the test can read it back out of the rendered doc.
const saveAwareGame = (title, savedPayload) => `<!doctype html><html><head><title>${title}</title></head>
<body style="margin:0;background:#123;color:#fff">
<!--SUPPORTS_SAVE-->
<h1>${title}</h1>
<div id="restored">none</div>
<script>
if (window.__ARIANTRA_INITIAL_STATE__) {
  document.getElementById('restored').textContent = JSON.stringify(window.__ARIANTRA_INITIAL_STATE__);
}
addEventListener('message', (e) => {
  if (e.data && e.data.type === 'ariantra:request-save') {
    parent.postMessage({ type: 'ariantra:save-state', payload: ${JSON.stringify(savedPayload)} }, '*');
  }
});
</script>
</body></html>`;

const plainGame = (title) => `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;background:#123;color:#fff"><h1>${title}</h1></body></html>`;

const savedState = { areas: [{ id: "city-1", originX: 0, originZ: 0, objects: [{ type: "block", x: 1, y: 0, z: 1 }] }] };

function convoWithGame(id, html) {
  return {
    v: 1, activeId: id,
    convos: [{ id, title: "t", messages: [
      { id: "m1", role: "child", text: "make a game where I can build a city", createdAt: 1 },
      { id: "m2", role: "assistant", text: "Here! 🌟", artifactHtml: html, createdAt: 2 },
    ] }],
  };
}

const browser = await chromium.launch({ executablePath: EXE });

async function setup(convo, { hasSave }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const gameSaveGets = [];
  await page.route("**/api/game-save**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      gameSaveGets.push(req.url());
      if (hasSave) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: savedState, updatedAt: 1 }) });
      } else {
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
      }
      return;
    }
    // PUT (autosave) — accept, never exercised within this script's short runtime.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, written: true }) });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForLoadState("networkidle").catch(() => {}); // reduce the localStorage-seed race (same flake class as e2e-preview-pane.mjs)
  await page.evaluate((d) => localStorage.setItem("kidgemini:chats:v1", JSON.stringify(d)), convo);
  await page.reload();
  await page.getByRole("button", { name: /Open game/ }).click();
  await page.waitForSelector("text=Testing your game", { state: "detached", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  return { page, gameSaveGets };
}

console.log("Scenario 1 — existing save found → Continue/Start fresh banner:");
{
  const { page } = await setup(convoWithGame("c1", saveAwareGame("V1", savedState)), { hasSave: true });
  const banner = page.getByText(/Continue your build/);
  check("banner is visible", await banner.isVisible().catch(() => false));

  console.log("  tapping Continue:");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForTimeout(500);
  const restored = await page.frameLocator("iframe").locator("#restored").textContent().catch(() => null);
  check("the injected initial state reaches the game", restored === JSON.stringify(savedState));
  check("banner is gone after the decision", !(await banner.isVisible().catch(() => false)));
  await page.close();
}

console.log("Scenario 2 — Start fresh dismisses without reloading the game:");
{
  const { page } = await setup(convoWithGame("c2", saveAwareGame("V2", savedState)), { hasSave: true });
  await page.getByRole("button", { name: "Start fresh" }).click();
  await page.waitForTimeout(500);
  const restored = await page.frameLocator("iframe").locator("#restored").textContent().catch(() => null);
  check("no initial state was injected (game stays as booted)", restored === "none");
  check("banner is gone", !(await page.getByText(/Continue your build/).isVisible().catch(() => false)));
  await page.close();
}

console.log("Scenario 3 — no existing save → no banner, still checks once:");
{
  const { page, gameSaveGets } = await setup(convoWithGame("c3", saveAwareGame("V3", savedState)), { hasSave: false });
  check("no banner shown", !(await page.getByText(/Continue your build/).isVisible().catch(() => false)));
  check("checked exactly once for this message", gameSaveGets.length === 1);
  await page.close();
}

console.log("Scenario 4 — a game with no SUPPORTS_SAVE marker never calls the API:");
{
  const { page, gameSaveGets } = await setup(convoWithGame("c4", plainGame("V4")), { hasSave: true });
  check("no banner shown", !(await page.getByText(/Continue your build/).isVisible().catch(() => false)));
  check("never called GET /api/game-save", gameSaveGets.length === 0);
  await page.close();
}

await browser.close();

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
