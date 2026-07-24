// The mobile tab bar is the ONLY navigation on a phone (the desktop menu is
// hidden there), so what it offers defines what a surface can reach. These
// tests exist because ArNav is a client component in a node-environment suite —
// the decision lives here as pure logic precisely so it can be attacked.
import { describe, it, expect } from "vitest";
import { surfaceFor, mobileTabs } from "./nav-tabs";

const GAMES = "https://games.ariantra.com";
const BIBLE = "https://games.ariantra.com/bible-games";
// Dev shape, where the two live at DIFFERENT paths — the case that makes
// deriving one from the other wrong.
const DEV_GAMES = "http://localhost:3000/catalog";
const DEV_BIBLE = "http://localhost:3000/bible-games";

describe("surfaceFor — which product the path belongs to", () => {
  it("treats the bible-teacher path (and anything under it) as the teacher surface", () => {
    expect(surfaceFor("/bible-teacher")).toBe("bible-teacher");
    expect(surfaceFor("/bible-teacher/")).toBe("bible-teacher");
  });

  it("treats everything else as the kid surface", () => {
    for (const p of ["/", "/assets", "/parent", "/upgrade"]) {
      expect(surfaceFor(p)).toBe("kid");
    }
  });

  it("does not mistake a lookalike path for the teacher surface", () => {
    expect(surfaceFor("/bible-teachers-guide")).toBe("kid");
  });
});

describe("mobileTabs — kid surface (unchanged behaviour)", () => {
  const tabs = mobileTabs("/", GAMES, BIBLE);

  it("offers chat, arcade, toy box and parent", () => {
    expect(tabs.map((t) => t.id)).toEqual(["chat", "arcade", "toybox", "parent"]);
  });

  it("sends arcade to the full games catalog", () => {
    expect(tabs.find((t) => t.id === "arcade")!.href).toBe(GAMES);
  });

  it("keeps the parent area reachable", () => {
    expect(tabs.find((t) => t.id === "parent")!.href).toBe("/parent");
  });
});

describe("mobileTabs — bible-teacher surface (2026-07-24, owner report)", () => {
  const tabs = mobileTabs("/bible-teacher", GAMES, BIBLE);

  it("sends arcade to the BIBLE games listing, not the general catalog", () => {
    // Reported: the arcade tab dropped teachers into the full kid catalog.
    expect(tabs.find((t) => t.id === "arcade")!.href).toBe(BIBLE);
  });

  it("hides the parent area entirely — it is a kid-safety surface, meaningless to a teacher", () => {
    expect(tabs.map((t) => t.id)).not.toContain("parent");
  });

  it("keeps chat pointing AT the teacher surface, never ejecting to the kid home", () => {
    // The tab bar is the only navigation on a phone. If chat went to "/", a
    // teacher who tapped it could not get back — a dead end (CLAUDE.md §6).
    expect(tabs.find((t) => t.id === "chat")!.href).toBe("/bible-teacher");
  });

  it("still offers the toy box (the asset gallery is persona-neutral)", () => {
    expect(tabs.find((t) => t.id === "toybox")!.href).toBe("/assets");
  });

  it("never leaves a surface with fewer than two ways to go", () => {
    expect(tabs.length).toBeGreaterThanOrEqual(2);
  });

  it("uses the injected bible URL verbatim — never gamesUrl + '/bible-games'", () => {
    // In dev the catalog is at /catalog but bible games are at /bible-games,
    // so concatenation silently 404s locally.
    const dev = mobileTabs("/bible-teacher", DEV_GAMES, DEV_BIBLE);
    expect(dev.find((t) => t.id === "arcade")!.href).toBe(DEV_BIBLE);
    expect(dev.find((t) => t.id === "arcade")!.href).not.toContain("/catalog/bible-games");
  });
});

describe("every tab is renderable", () => {
  it.each([["/"], ["/bible-teacher"], ["/assets"], ["/parent"]])(
    "path %s produces tabs that all have an href, label and icon",
    (path) => {
      for (const t of mobileTabs(path, GAMES, BIBLE)) {
        expect(t.href.length).toBeGreaterThan(0);
        expect(t.label.length).toBeGreaterThan(0);
        expect(t.icon.length).toBeGreaterThan(0);
      }
    },
  );
});
