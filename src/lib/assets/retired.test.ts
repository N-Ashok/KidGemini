/**
 * Retirement has to hold BOTH halves at once, and the second is the one that
 * bites: a name that stops being offered but also stops resolving would strip
 * the model out of a child's existing game on its next edit turn, silently
 * (injectAssets drops unknown names fail-soft). These tests pin both.
 */
import { describe, it, expect } from "vitest";
import { RETIRED, RETIRED_MODELS, offerable } from "./retired";
import { retrievedModelNames } from "./prompt-catalog";
import { selectModelNames } from "./model-select";
import { injectAssets } from "./inject";
import { galleryCards } from "./gallery";
import manifest from "./manifest.json";
import type { AssetManifest } from "./manifest";
import type { ChatMessage } from "@/types/chat.types";

const real = manifest as AssetManifest;
const modelNames = real.assets.filter((a) => a.type === "model").map((a) => a.name);

describe("retired models — never offered", () => {
  it("R.1 a retired name is not in the catalogue Ari picks from", () => {
    const names = retrievedModelNames({ message: "make a game with a bird flying", history: [], manifest: real });
    for (const r of RETIRED) expect(names).not.toContain(r);
  });

  it("R.2 not even when the child names it outright", () => {
    // selectModelNames rule 2 matches the word in the child's text — a retired
    // model must not sneak back in that way.
    const names = selectModelNames({ message: "i want a bird", history: [], manifest: real });
    for (const r of RETIRED) expect(names).not.toContain(r);
  });

  it("R.3 the kid-facing gallery does not advertise it", () => {
    const shown = galleryCards().models.map((c) => c.name);
    for (const r of RETIRED) expect(shown).not.toContain(r);
  });
});

describe("retired models — still resolvable, so nobody's game breaks", () => {
  it("R.4 stays in the manifest — deleting the entry is NOT what retirement means", () => {
    for (const r of RETIRED) expect(modelNames).toContain(r);
  });

  it("R.5 injectAssets still wires it up for a game that already uses it", () => {
    const html = `<!DOCTYPE html><html><body><!--USES_THREE-->
<!--USES_MODELS: bird-->
<script type="module">import { Scene } from "three"; const s = new Scene();</script></body></html>`;
    const out = injectAssets(html);
    expect(out.dropped).not.toContain("bird");
    expect(out.html).toContain('"bird":');
  });

  it("R.6 selectModelNames rule 1 KEEPS it when the current game already uses it", () => {
    // The whole point. Without this, an edit turn would drop the bird out of
    // the two published games that reference it.
    const history: ChatMessage[] = [
      { id: "m1", createdAt: 1, role: "child", text: "a flying game" },
      { id: "m2", createdAt: 2, role: "assistant", text: "here", artifactHtml: "<!--USES_MODELS: bird,tree--><html></html>" },
    ];
    const names = selectModelNames({ message: "make it faster", history, manifest: real });
    expect(names).toContain("bird");
  });
});

describe("the retirement list itself", () => {
  it("R.7 every retired name really exists — a typo would silently retire nothing", () => {
    for (const r of RETIRED) expect(modelNames).toContain(r);
  });

  it("R.8 every entry records WHY, so the list cannot rot into a bare denylist", () => {
    for (const [name, why] of Object.entries(RETIRED_MODELS)) {
      expect(why.length, `${name} needs a reason`).toBeGreaterThan(40);
    }
  });

  it("R.9 offerable() strips exactly the retired names and nothing else", () => {
    const out = offerable(modelNames);
    expect(out).toHaveLength(modelNames.length - RETIRED.size);
    for (const r of RETIRED) expect(out).not.toContain(r);
  });
});
