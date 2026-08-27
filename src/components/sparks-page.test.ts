// The Sparks page (⚡ Sparks tab next to Games-Lab → /wallet) shows the money
// side too (owner decision 2026-08-27, docs/2026-08-27_PRD_SparksPage.md):
// available, used, added, what each chat used, and — on opening a chat there —
// what each request cost. The chat window shows them too (owner, later the
// same day: "chat window also is fine"). Source pins, house style.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const wallet = readFileSync(join(__dirname, "WalletPanel.tsx"), "utf8");
const panel = readFileSync(join(__dirname, "ChatPanel.container.tsx"), "utf8");
const sidebar = readFileSync(join(__dirname, "Sidebar.tsx"), "utf8");
const nav = readFileSync(join(__dirname, "ArNav.tsx"), "utf8");

describe("Sparks page shows usage", () => {
  it("P.1 fetches /api/sparks/usage and shows available / used / added", () => {
    expect(wallet).toContain('"/api/sparks/usage"');
    expect(wallet).toContain("⚡ available");
    expect(wallet).toContain("⚡ used");
    expect(wallet).toContain("⚡ added");
  });
  it("P.2 lists what each chat used and drills into what each request cost", () => {
    expect(wallet).toContain("What each chat used");
    expect(wallet).toContain("/api/sparks/usage?chat=");
    expect(wallet).toContain("formatSparks(");
  });
  it("P.3 loading + failure states exist — never a blank or dead end", () => {
    expect(wallet).toMatch(/usage\s*===\s*null/); // loading branch
    expect(wallet).toContain("usageError");
  });
});

describe("chat window shows Sparks too (owner 2026-08-27: 'chat window also is fine')", () => {
  it("W.1 per-ask line under the reply, per-chat total in the sidebar, live balance in the nav + mobile tab (with a loading state)", () => {
    expect(panel).toContain("for this ask");
    expect(panel).toContain("chatSparksTotal(c.messages)");
    expect(sidebar).toContain("formatSparks(r.sparks)");
    expect(nav).toContain("useSparksBalance");
    expect(nav).toMatch(/balance\s*==\s*null\s*\?/);
    expect(nav).toMatch(/tab\.id === "sparks" && balance != null \? formatSparks\(balance\) : tab\.label/);
  });
  it("W.2 the receipt frame is recorded on the reply and the balance broadcast to the header", () => {
    expect(panel).toContain('ev.type === "sparks"');
    expect(panel).toMatch(/sparks: charged/);
    expect(panel).toContain("publishSparksBalance(");
  });
});
