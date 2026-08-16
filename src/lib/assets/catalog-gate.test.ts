// Tier/keyword gate tests (PRD-3D-GAMES-AND-ASSETS §9, §11; save gate added
// 2026-08-03 docs/2026-08-01_PRD_SaveContinueBuilding.md Phase 2): the
// catalog injection matrix. Chit-chat never pays catalog tokens; paid unlocks
// the 3D/audio catalogs on any build turn (save stays keyword/artifact-gated
// even for paid — a build/world game is identified by what it IS, not by the
// child's plan); free unlocks per-catalog on cheap keyword triggers, scanning
// history too so iteration turns keep the catalog the game was built with
// (err toward unlocking — a false unlock costs a few prompt tokens, an
// under-unlock breaks the kid's game mid-iteration).

import { describe, it, expect } from "vitest";
import { catalogGates } from "./catalog-gate";
import type { ChatMessage } from "@/types/chat.types";

const msg = (role: "child" | "assistant", text: string, artifactHtml?: string): ChatMessage =>
  ({ role, text, artifactHtml }) as ChatMessage;

describe("3D intent — the child asks for 'realistic', not '3d' (KNOWN_BUGS #14)", () => {
  // Owner 2026-08-15: "when child is asking realistic, he is asking for 3D...
  // we need to understand the intent from child, not verbatim." Before this,
  // every one of these left the 3D catalog OFF, so the model never received
  // the 3D playbook, the model library, AR_ASSETS or placeModel — which no
  // prompt wording could recover, because that text is what was withheld.
  // A real chat: the child asked for a game and got one, so an artifact
  // exists — which is what makes every later message a build turn.
  const withGame = [
    msg("child", "make a racing game"),
    msg("assistant", "here you go", "<html><canvas></canvas></html>"),
  ];

  for (const phrase of [
    "make it realistic",
    "i want it to look real",
    "make it look like real life",
    "realistic graphics please",
    "make it lifelike",
    "a real looking car",
    "make the trees realistic",
  ]) {
    it(`unlocks 3D for "${phrase}"`, () => {
      expect(catalogGates({ message: phrase, history: withGame, paid: false }).three).toBe(true);
    });
  }

  it("still unlocks 3D for the literal word", () => {
    expect(catalogGates({ message: "make a 3d game", history: [], paid: false }).three).toBe(true);
  });

  it("does not unlock 3D for an ordinary 2D ask", () => {
    expect(catalogGates({ message: "add a red car", history: withGame, paid: false }).three).toBe(false);
    expect(catalogGates({ message: "make it faster", history: withGame, paid: false }).three).toBe(false);
  });
});

describe("catalogGates — the build-turn gate comes first (§9: chit-chat pays zero catalog tokens)", () => {
  it("a chit-chat turn unlocks nothing, whatever the tier", () => {
    expect(catalogGates({ message: "how are you today?", history: [], paid: false })).toEqual({ three: false, audio: false, save: false, physics: false });
    expect(catalogGates({ message: "how are you today?", history: [], paid: true })).toEqual({ three: false, audio: false, save: false, physics: false });
  });

  it("an audio keyword outside a build turn stays locked (\"i like music\" is chat, not a game ask)", () => {
    expect(catalogGates({ message: "i like music", history: [], paid: false })).toEqual({ three: false, audio: false, save: false, physics: false });
  });
});

describe("catalogGates — paid tier: inbuilt, both catalogs on every build turn", () => {
  it("unlocks both with no keywords at all", () => {
    expect(catalogGates({ message: "make me a racing game", history: [], paid: true })).toEqual({ three: true, audio: true, save: false, physics: false });
  });

  it("save is NOT part of the paid bundle — it still needs a build/world keyword or artifact", () => {
    expect(catalogGates({ message: "a game where I build a fort", history: [], paid: true })).toEqual({ three: true, audio: true, save: true, physics: false });
  });
});

describe("catalogGates — free tier: keyword-invoked, 3D and audio gate independently", () => {
  it("a plain game ask unlocks neither catalog (rung-1 inline content, exactly today's product)", () => {
    expect(catalogGates({ message: "make me a platformer game", history: [], paid: false })).toEqual({ three: false, audio: false, save: false, physics: false });
  });

  it("\"3d\" unlocks the 3D catalog only", () => {
    expect(catalogGates({ message: "3d cars", history: [], paid: false })).toEqual({ three: true, audio: false, save: false, physics: false });
  });

  // BUG_LOG 2026-08-09 ("Calvin"). A child ended his ask with "Make it 3-D" —
  // the hyphenated spelling, which `\b3d\b` does not match. The 3D catalog was
  // withheld from a turn that was LITERALLY a 3D request, so the model built in
  // 3D with none of the house rules (no USES_THREE marker, no import map, no
  // curated import list) and fell back on the open internet's default: a cdnjs
  // <script> tag pulling three r128. r128 predates CapsuleGeometry, so the game
  // threw on the first shape it drew and the child got a blank screen.
  // The lint in three-import-lint.ts is the safety net; THIS is the cause.
  it("the ways a child actually writes it all unlock the 3D catalog", () => {
    for (const ask of [
      "Can you make the game Make it 3-D", // Calvin's real words
      "make it 3d",
      "make it 3 d",
      "a 3-d racing game",
      "I want a three dimensional game",
      "make a 3-dimensional maze",
    ]) {
      expect(catalogGates({ message: ask, history: [], paid: false }).three, ask).toBe(true);
    }
  });

  it("still does not fire on look-alikes that are not a 3D ask", () => {
    for (const ask of [
      "make a game about a 3-day trip",
      "a game with 3 dogs",
      "a grade3d game",
      "3ds max is my favourite",
    ]) {
      expect(catalogGates({ message: ask, history: [], paid: false }).three, ask).toBe(false);
    }
  });

  it("\"sound\"/\"music\"/\"sound effects\" unlock the audio catalog only", () => {
    for (const ask of ["make me a game with sound", "a jumping game with music", "platformer game with sound effects"]) {
      expect(catalogGates({ message: ask, history: [], paid: false }), ask).toEqual({ three: false, audio: true, save: false, physics: false });
    }
  });

  it("both keywords unlock both catalogs", () => {
    expect(catalogGates({ message: "a 3d dino game with music", history: [], paid: false })).toEqual({ three: true, audio: true, save: false, physics: false });
  });

  it("does not fire inside words (\"grade3d\", \"unsound\", \"musical\" stay locked)", () => {
    expect(catalogGates({ message: "make a grade3d unsound musical game", history: [], paid: false })).toEqual({ three: false, audio: false, save: false, physics: false });
  });
});

describe("catalogGates — iteration turns keep the catalog (history scan, §9 err-toward-unlocking)", () => {
  const built3d: ChatMessage[] = [
    msg("child", "3d cars"),
    msg("assistant", "Here's your game! 🎮", "<!doctype html><html>…</html>"),
  ];

  it("\"make it faster\" after a 3d ask keeps the 3D catalog", () => {
    expect(catalogGates({ message: "make it faster", history: built3d, paid: false })).toEqual({ three: true, audio: false, save: false, physics: false });
  });

  it("a prior artifact carrying USES_AUDIO keeps the audio catalog even if the keyword text is gone", () => {
    const history = [msg("assistant", "Here's your game! 🎮", "<html><!--USES_AUDIO: jump--><canvas></canvas></html>")];
    expect(catalogGates({ message: "add a second level", history, paid: false })).toEqual({ three: false, audio: true, save: false, physics: false });
  });

  it("a prior artifact carrying USES_THREE / USES_MODELS keeps the 3D catalog", () => {
    const history = [msg("assistant", "Here's your game! 🎮", "<html><!--USES_THREE--><!--USES_MODELS: car--></html>")];
    expect(catalogGates({ message: "make the car red", history, paid: false })).toEqual({ three: true, audio: false, save: false, physics: false });
  });

  // REGRESSION (BUG-FIX-LOG 2026-07-20, "DoubleSide" — days-long UAT
  // struggle): a three.js game whose generation FORGOT the <!--USES_THREE-->
  // marker ran every edit turn with 3d=false; untaught, the model imported
  // names outside the curated bundle (Shape/ShapeGeometry/DoubleSide) and
  // the whole game died on its import line. The gate must also read the
  // game's STRUCTURE — an import from "three", the importmap entry, or a
  // loadModel() call — not just the marker the model remembered to write.
  it("a marker-less game that IMPORTS three still keeps the 3D catalog (structural evidence)", () => {
    const noMarker =
      '<html><head><script type="importmap">{"imports":{"three":"https://assets.ariantra.com/three.07fb80.js"}}</script></head>' +
      '<body><!--USES_MULTIPLAYER--><script type="module">import { Scene } from "three";</script></body></html>';
    expect(catalogGates({ message: "add an oval track", history: [msg("assistant", "Here! 🌟", noMarker)], paid: false }))
      .toEqual({ three: true, audio: false, save: false, physics: false });
  });

  it("a marker-less game calling loadModel() keeps the 3D catalog", () => {
    const history = [msg("assistant", "Here! 🌟", '<html><script>loadModel("car").then(m => {});</script></html>')];
    expect(catalogGates({ message: "make the car red", history, paid: false })).toEqual({ three: true, audio: false, save: false, physics: false });
  });

  it("a marker-less game calling playSound()/playMusic() keeps the audio catalog", () => {
    const history = [msg("assistant", "Here! 🌟", '<html><script>playSound("win"); playMusic("bg_loop_chill");</script></html>')];
    expect(catalogGates({ message: "add a second level", history, paid: false })).toEqual({ three: false, audio: true, save: false, physics: false });
  });

  it("iterating on a plain 2D silent game stays locked (no keyword anywhere)", () => {
    const history = [msg("child", "make me a maze game"), msg("assistant", "Here's your game! 🎮", "<html><canvas></canvas></html>")];
    expect(catalogGates({ message: "add more walls", history, paid: false })).toEqual({ three: false, audio: false, save: false, physics: false });
  });
});

describe("catalogGates — save gate (docs/2026-08-01_PRD_SaveContinueBuilding.md Phase 2)", () => {
  it("build/stack/place/inventory/world/city/base keywords unlock the save clause", () => {
    for (const ask of [
      "let me build a fort in this game",
      "a game where I stack blocks",
      "a game where I place towers on a map",
      "a game with an inventory",
      "a build-your-own-world game",
      "a game where I build a city",
      "let me build a base in this game",
    ]) {
      expect(catalogGates({ message: ask, history: [], paid: false }), ask).toMatchObject({ save: true });
    }
  });

  it("does not fire inside words (\"rebuild\", \"placement\", \"worldwide\" stay locked — same word-bounding convention as THREE_TRIGGER)", () => {
    expect(catalogGates({ message: "can you rebuild the level", history: [], paid: false })).toEqual({ three: false, audio: false, save: false, physics: false });
    expect(catalogGates({ message: "improve the placement of enemies", history: [], paid: false })).toEqual({ three: false, audio: false, save: false, physics: false });
  });

  it("a plain game ask with no build/world keyword stays locked", () => {
    expect(catalogGates({ message: "make me a platformer game", history: [], paid: false })).toEqual({ three: false, audio: false, save: false, physics: false });
  });

  it("a prior artifact carrying SUPPORTS_SAVE keeps the clause even once the keyword scrolls away", () => {
    const history = [msg("assistant", "Here's your game! 🎮", "<html><!--SUPPORTS_SAVE--><canvas></canvas></html>")];
    expect(catalogGates({ message: "add a second level", history, paid: false })).toMatchObject({ save: true });
  });

  it("a prior artifact wired for the postMessage protocol (marker forgotten) still keeps the clause", () => {
    const history = [msg("assistant", "Here! 🌟", '<html><script>parent.postMessage({type:"ariantra:save-state", payload:{}}, "*");</script></html>')];
    expect(catalogGates({ message: "add a second level", history, paid: false })).toMatchObject({ save: true });
  });

  it("save gates independently of three/audio — a 2D building game unlocks save with neither engine nor sound", () => {
    expect(catalogGates({ message: "a game where I build a tower", history: [], paid: false })).toEqual({ three: false, audio: false, save: true, physics: false });
  });
});

describe("physics gate — the engine playbook only when the game is about physics", () => {
  // Measured across 1,227 stored game versions: 55% use three, only 4% use
  // physics. Riding physics on `three` meant teaching cannon-es on 96% of 3D
  // turns for a library the game never imports.
  const withGame = [msg("child", "make a game"), msg("assistant", "done", "<html></html>")];

  for (const phrase of ["make the balls bounce", "add gravity", "the blocks should topple", "realistic falling", "add physics", "knock over the pins"]) {
    it(`unlocks for "${phrase}"`, () =>
      expect(catalogGates({ message: phrase, history: withGame, paid: false }).physics).toBe(true));
  }

  for (const phrase of ["make the car red", "add a tree", "make it faster", "move the house"]) {
    it(`stays locked for "${phrase}"`, () =>
      expect(catalogGates({ message: phrase, history: withGame, paid: false }).physics).toBe(false));
  }

  it("a game that already imports cannon-es keeps it after the words scroll away", () => {
    const history = [
      msg("child", "make a bouncing ball game"),
      msg("assistant", "done", `<html><script type="module">import * as CANNON from "cannon-es";</script></html>`),
    ];
    expect(catalogGates({ message: "make it blue", history, paid: false }).physics).toBe(true);
  });

  it("paid does NOT force physics on — it is evidence-based, not a content catalog", () => {
    expect(catalogGates({ message: "make a game", history: withGame, paid: true }).physics).toBe(false);
  });

  it("a non-build turn returns physics false", () => {
    expect(catalogGates({ message: "why is the sky blue?", history: [], paid: false }).physics).toBe(false);
  });
});
