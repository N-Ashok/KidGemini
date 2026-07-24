// PRD-3D-GAMES-AND-ASSETS §9b/Decision M: discovery drives usage — an
// invisible library never gets asked for. The gallery must stay reachable
// from BOTH kid surfaces: the mobile tab bar and the desktop sidebar.
// (The desktop top menu is the canonical cross-site Ariantra header and must
// stay in lockstep with the platform's nav — the gallery link lives in the
// kidgemini-owned surfaces instead.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mobileTabs } from "@/lib/nav-tabs";

const sidebar = readFileSync(join(__dirname, "Sidebar.tsx"), "utf8");

describe("Game Stuff gallery is discoverable (§9b)", () => {
  // Asserted against the tab DATA, not ArNav's source text: the markup moved
  // into nav-tabs.ts on 2026-07-24 and a grep-the-file test broke while the
  // contract it guards was still perfectly intact. Checking the real source of
  // truth means a future refactor can't fake a pass either.
  it.each([["/"], ["/assets"], ["/parent"], ["/bible-teacher"]])(
    "mobile tab bar carries the Toy Box tab on %s",
    (path) => {
      const toybox = mobileTabs(path, "https://games.ariantra.com", "https://games.ariantra.com/bible-games").find((t) => t.id === "toybox");
      expect(toybox).toBeDefined();
      expect(toybox!.href).toBe("/assets");
      expect(toybox!.label).toBe("Toy Box");
    },
  );

  it("desktop sidebar links to /assets", () => {
    expect(sidebar).toContain('href="/assets"');
    expect(sidebar).toContain("Game Stuff");
  });
});
