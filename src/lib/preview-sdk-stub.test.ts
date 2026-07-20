// REGRESSION (BUG-FIX-LOG 2026-07-20, "multiplayer game never loads in the
// preview"): the build prompt PROMISES the game (multiplayer-prompt.ts rule
// 9) that `Ariantra` always exists — "in the preview and on the published
// page alike" — and forbids the game from stubbing it. The platform keeps
// that promise on published pages; Ari's preview iframe never did, so every
// rule-following multiplayer game threw ReferenceError at load, classified
// load_error, and sent the repair loop chasing a correct game forever.
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { injectPreviewSdkStub, PREVIEW_SDK_STUB_MARKER } from "./preview-sdk-stub";

const MP_GAME = `<!doctype html><html><head></head><body><!--USES_MULTIPLAYER-->
<script>
  // Exactly what rule 9 tells the model to write: direct, unconditional calls.
  window.__loaded = false;
  Ariantra.onPlayers(function (players) { window.__roster = players; });
  Ariantra.onMessage(function (data, from) {});
  window.__me = Ariantra.myPlayerId();
  window.__peer = Ariantra.getPeerState("p2");
  Ariantra.broadcast({ type: "hello" });
  Ariantra.broadcastState({ x: 1 });
  window.__loaded = true;
</script></body></html>`;

/** Runs every <script> in the html inside one sandboxed context, like the
 *  preview iframe would. setTimeout runs immediately so the stub's async
 *  roster fire lands within the test. Throws propagate, like a load_error. */
function runScripts(html: string): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    window: undefined,
    Promise,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(m[1]!, sandbox);
  }
  return sandbox;
}

describe("injectPreviewSdkStub", () => {
  it("a rule-9 multiplayer game LOADS in the preview instead of throwing", () => {
    const out = injectPreviewSdkStub(MP_GAME);
    const w = runScripts(out);
    expect(w.__loaded).toBe(true); // pre-fix: ReferenceError before this line
  });

  it("without the stub the same game crashes (the bug this pins)", () => {
    expect(() => runScripts(MP_GAME)).toThrow(/Ariantra/);
  });

  it("solo-session semantics (owner decision 2026-07-20, 'waiting for host'): the kid IS player 1 and host, so the game starts", () => {
    const w = runScripts(injectPreviewSdkStub(MP_GAME));
    expect(w.__me).toBe("preview-solo"); // a real id — roster comparisons work
    const roster = w.__roster as Array<Record<string, unknown>>;
    expect(roster).toHaveLength(1); // onPlayers fired with the solo roster
    expect(roster[0]).toMatchObject({ playerId: "preview-solo", isHost: true, displayName: "You" });
    expect(w.__peer).toBeNull(); // no peers — getPeerState stays null
  });

  it("never overwrites a real SDK (defensive only-if-undefined)", () => {
    const out = injectPreviewSdkStub(MP_GAME);
    const sandbox: Record<string, unknown> = { window: undefined };
    sandbox.window = sandbox;
    (sandbox as { Ariantra?: unknown }).Ariantra = { real: true };
    vm.createContext(sandbox);
    for (const m of out.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      try {
        vm.runInContext(m[1]!, sandbox);
      } catch {
        /* game script may fail against the fake "real" SDK — irrelevant */
      }
    }
    expect((sandbox as { Ariantra: { real?: boolean } }).Ariantra.real).toBe(true);
  });

  it("injects before any game code and is idempotent", () => {
    const out = injectPreviewSdkStub(MP_GAME);
    expect(out.indexOf(PREVIEW_SDK_STUB_MARKER)).toBeLessThan(out.indexOf("__loaded"));
    expect(injectPreviewSdkStub(out)).toBe(out);
  });

  it("leaves single-player games byte-identical (no SDK reference → no stub)", () => {
    const solo = "<!doctype html><html><body><script>let x=1;</script></body></html>";
    expect(injectPreviewSdkStub(solo)).toBe(solo);
  });
});
