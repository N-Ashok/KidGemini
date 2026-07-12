// PRD-3D-GAMES-AND-ASSETS §9b/Decision M: discovery drives usage — an
// invisible library never gets asked for. The gallery must stay reachable
// from BOTH kid surfaces: the mobile tab bar and the desktop sidebar.
// (The desktop top menu is the canonical cross-site Ariantra header and must
// stay in lockstep with the platform's nav — the gallery link lives in the
// kidgemini-owned surfaces instead.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const arNav = readFileSync(join(__dirname, "ArNav.tsx"), "utf8");
const sidebar = readFileSync(join(__dirname, "Sidebar.tsx"), "utf8");

describe("Game Stuff gallery is discoverable (§9b)", () => {
  it("mobile tab bar carries a /assets tab", () => {
    expect(arNav).toContain('href="/assets"');
    expect(arNav).toContain("Toy Box");
  });

  it("desktop sidebar links to /assets", () => {
    expect(sidebar).toContain('href="/assets"');
    expect(sidebar).toContain("Game Stuff");
  });
});
