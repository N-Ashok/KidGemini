// E2E regression pin for "Continue from here" (an earlier game version was
// better than the newest one — chat-rewind.ts). Non-destructive design: the
// button PINS an earlier message as the edit target for the next turn
// (Conversation.activeGameMessageId) instead of deleting anything — every
// message, including the regressed one, stays in the thread. Pins, in a real
// browser, what unit tests can't (no @testing-library here): button
// visibility rules, the pin banner + Cancel, that nothing is removed from
// the DOM, that the preview swaps to the pinned version, and that the pin is
// actually sent to (and consumed by) the next /api/chat request.
//
// Prereqs: `npm run dev` on :3000, `playwright-core` resolvable (npm i in this
// repo OR PLAYWRIGHT_CORE_DIR=/path/to/node_modules/playwright-core), and the
// Playwright chromium-headless-shell cache
// (~/Library/Caches/ms-playwright/chromium_headless_shell-*).
// Run: node scripts/e2e-continue-from-here.mjs
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

const game = (title) =>
  `<!doctype html><html><head><title>${title}</title></head><body style="margin:0;background:#123;color:#fff"><h1>${title}</h1></body></html>`;

const convo = {
  activeId: "c1",
  convos: [
    {
      id: "c1",
      title: "t",
      messages: [
        { id: "m1", role: "child", text: "make me a game", createdAt: 1 },
        { id: "m2", role: "assistant", text: "Here's V1! 🌟", artifactHtml: game("GameV1"), createdAt: 2 },
        { id: "m3", role: "child", text: "add a jump button", createdAt: 3 },
        { id: "m4", role: "assistant", text: "Added it! 🎮", artifactHtml: game("GameV2"), createdAt: 4 },
      ],
    },
  ],
};

let failures = 0;
const check = (name, ok) => {
  console.log(ok ? "  ✓" : "  ✗", name);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Capture the NEXT /api/chat request body so we can prove the pin actually
// travels to the server, instead of just trusting client-side state.
let lastRequestBody = null;
await page.route("**/api/chat", async (route) => {
  lastRequestBody = route.request().postDataJSON();
  await route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: JSON.stringify({ type: "done", text: "patched!", artifactHtml: game("GameV3") }) + "\n",
  });
});

await page.goto("http://localhost:3000/");
await page.evaluate((d) => localStorage.setItem("kidgemini:chats:v1", JSON.stringify(d)), convo);
await page.reload();
await page.waitForSelector("text=Added it!");

console.log("button visibility:");
const v1Bubble = page.locator("div.group", { hasText: "Here's V1!" });
const v2Bubble = page.locator("div.group", { hasText: "Added it!" });
check("earlier game (V1, has something after it) shows Continue from here", await v1Bubble.getByRole("button", { name: "Continue from here" }).isVisible());
check("latest game (V2, nothing after it) has no Continue from here", (await v2Bubble.getByRole("button", { name: "Continue from here" }).count()) === 0);
check("latest game still offers Open game", await v2Bubble.getByRole("button", { name: "Open game" }).isVisible());

console.log("clicking Continue from here pins WITHOUT deleting anything:");
await v1Bubble.getByRole("button", { name: "Continue from here" }).click();
await page.waitForTimeout(200);
check("V2 message is still in the thread — nothing destructive happened", await page.getByText("Added it!").isVisible());
check("V1 message is still in the thread too", await page.getByText("Here's V1!").isVisible());
check("V1 now shows the pinned badge", await v1Bubble.getByText("Building from this version").isVisible());
check("V1's own Continue-from-here button disappears once it IS the pin", (await v1Bubble.getByRole("button", { name: "Continue from here" }).count()) === 0);
check("the composer shows the pin banner", await page.getByText(/next message will build on the earlier version/).isVisible());

const srcGame = () =>
  page.evaluate(() => document.querySelector("iframe")?.getAttribute("srcdoc")?.match(/Game(V\d)/)?.[1] ?? "?");
check("preview panel swapped to V1 (the pinned version)", (await srcGame()) === "V1");

console.log("Cancel un-pins without touching the thread:");
await page.getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(150);
check("pin banner is gone after Cancel", (await page.getByText(/next message will build on the earlier version/).count()) === 0);
check("Continue from here reappears on V1 now that it's unpinned", await v1Bubble.getByRole("button", { name: "Continue from here" }).isVisible());
check("nothing was removed from the thread by Cancel either", await page.getByText("Added it!").isVisible());

console.log("sending a message after re-pinning actually carries the pin to the server:");
await v1Bubble.getByRole("button", { name: "Continue from here" }).click();
await page.waitForTimeout(150);
await page.getByPlaceholder(/Ask me anything/).fill("add a medic kit");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector("iframe")?.getAttribute("srcdoc")?.includes("GameV3"), null, { timeout: 15000 }).catch(() => {});
check("request body named the pinned message as activeGameMessageId", lastRequestBody?.activeGameMessageId === "m2");
check("request history still contains BOTH earlier versions — nothing was dropped client-side", (lastRequestBody?.history ?? []).length === 4);
check("new reply reached the preview", (await srcGame()) === "V3");

console.log("the pin is consumed — it does not silently apply to the NEXT unrelated message too:");
check("pin banner is gone after sending", (await page.getByText(/next message will build on the earlier version/).count()) === 0);

await browser.close();
console.log(failures ? `FAIL (${failures})` : "PASS");
process.exit(failures ? 1 : 0);
