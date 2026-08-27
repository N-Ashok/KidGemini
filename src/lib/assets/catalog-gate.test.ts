// Tier/keyword gate tests (PRD-3D-GAMES-AND-ASSETS §9, §11; save gate added
// 2026-08-03 docs/2026-08-01_PRD_SaveContinueBuilding.md Phase 2): the
// catalog injection matrix. Chit-chat never pays catalog tokens; paid unlocks
// the 3D/audio catalogs on any build turn (save stays keyword/artifact-gated
// even for paid — a build/world game is identified by what it IS, not by the
// child's plan); free unlocks per-catalog on cheap keyword triggers, scanning
// history too so iteration turns keep the catalog the game was built with
// (err toward unlocking — a false unlock costs a few prompt tokens, an
// under-unlock breaks the kid's game mid-iteration).

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { catalogGates, threeUnlockReason, editGates } from "./catalog-gate";
import type { ChatMessage } from "@/types/chat.types";

// THREE_SUBJECT_UNLOCK is stubbed per-test below; never let it leak between tests.
afterEach(() => vi.unstubAllEnvs());

const msg = (role: "child" | "assistant", text: string, artifactHtml?: string): ChatMessage =>
  ({ role, text, artifactHtml }) as ChatMessage;

describe("catalogGates — the build-turn gate comes first (§9: chit-chat pays zero catalog tokens)", () => {
  it("a chit-chat turn unlocks nothing, whatever the tier", () => {
    expect(catalogGates({ message: "how are you today?", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
    expect(catalogGates({ message: "how are you today?", history: [], paid: true })).toEqual({ three: false, audio: false, save: false });
  });

  it("an audio keyword outside a build turn stays locked (\"i like music\" is chat, not a game ask)", () => {
    expect(catalogGates({ message: "i like music", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
  });
});

describe("catalogGates — paid tier: inbuilt, both catalogs on every build turn", () => {
  it("unlocks both with no keywords at all", () => {
    expect(catalogGates({ message: "make me a racing game", history: [], paid: true })).toEqual({ three: true, threeReason: "subject", audio: true, save: false });
  });

  it("save is NOT part of the paid bundle — it still needs a build/world keyword or artifact", () => {
    expect(catalogGates({ message: "a game where I build a fort", history: [], paid: true })).toEqual({ three: true, threeReason: "subject", audio: true, save: true });
  });
});

describe("catalogGates — free tier: keyword-invoked, 3D and audio gate independently", () => {
  it("a plain game ask unlocks neither catalog (rung-1 inline content, exactly today's product)", () => {
    expect(catalogGates({ message: "make me a platformer game", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
  });

  it("\"3d\" unlocks the 3D catalog only", () => {
    expect(catalogGates({ message: "3d cars", history: [], paid: false })).toEqual({ three: true, threeReason: "asked", audio: false, save: false });
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
      "a grade3d game",
      "3ds max is my favourite",
      // "a game with 3 dogs" used to live here as a `\b3d\b` look-alike. It
      // now unlocks — via the SUBJECT gate, not the digit — because "dogs" is
      // a real thing the library models (2026-08-23). The look-alike property
      // this test guards is still pinned: it must not be reported as `asked`.
    ]) {
      expect(catalogGates({ message: ask, history: [], paid: false }).three, ask).toBe(false);
    }
  });

  it("\"3 dogs\" unlocks on the SUBJECT, never on the digit — the reason proves which gate fired", () => {
    vi.stubEnv("THREE_SUBJECT_UNLOCK", "on"); // subject unlock is opt-in since 2026-08-27
    expect(threeUnlockReason({ message: "a game with 3 dogs", history: [], paid: false })).toBe("subject");
  });

  it("\"sound\"/\"music\"/\"sound effects\" unlock the audio catalog only", () => {
    for (const ask of ["make me a game with sound", "a jumping game with music", "platformer game with sound effects"]) {
      expect(catalogGates({ message: ask, history: [], paid: false }), ask).toEqual({ three: false, audio: true, save: false });
    }
  });

  it("both keywords unlock both catalogs", () => {
    expect(catalogGates({ message: "a 3d dino game with music", history: [], paid: false })).toEqual({ three: true, threeReason: "asked", audio: true, save: false });
  });

  it("does not fire inside words (\"grade3d\", \"unsound\", \"musical\" stay locked)", () => {
    expect(catalogGates({ message: "make a grade3d unsound musical game", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
  });
});

describe("catalogGates — iteration turns keep the catalog (history scan, §9 err-toward-unlocking)", () => {
  const built3d: ChatMessage[] = [
    msg("child", "3d cars"),
    msg("assistant", "Here's your game! 🎮", "<!doctype html><html>…</html>"),
  ];

  it("\"make it faster\" after a 3d ask keeps the 3D catalog", () => {
    expect(catalogGates({ message: "make it faster", history: built3d, paid: false })).toEqual({ three: true, threeReason: "asked", audio: false, save: false });
  });

  it("a prior artifact carrying USES_AUDIO keeps the audio catalog even if the keyword text is gone", () => {
    const history = [msg("assistant", "Here's your game! 🎮", "<html><!--USES_AUDIO: jump--><canvas></canvas></html>")];
    expect(catalogGates({ message: "add a second level", history, paid: false })).toEqual({ three: false, audio: true, save: false });
  });

  it("a prior artifact carrying USES_THREE / USES_MODELS keeps the 3D catalog", () => {
    const history = [msg("assistant", "Here's your game! 🎮", "<html><!--USES_THREE--><!--USES_MODELS: car--></html>")];
    expect(catalogGates({ message: "make the car red", history, paid: false })).toEqual({ three: true, threeReason: "asked", audio: false, save: false });
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
      .toEqual({ three: true, threeReason: "asked", audio: false, save: false });
  });

  it("a marker-less game calling loadModel() keeps the 3D catalog", () => {
    const history = [msg("assistant", "Here! 🌟", '<html><script>loadModel("car").then(m => {});</script></html>')];
    expect(catalogGates({ message: "make the car red", history, paid: false })).toEqual({ three: true, threeReason: "asked", audio: false, save: false });
  });

  it("a marker-less game calling playSound()/playMusic() keeps the audio catalog", () => {
    const history = [msg("assistant", "Here! 🌟", '<html><script>playSound("win"); playMusic("bg_loop_chill");</script></html>')];
    expect(catalogGates({ message: "add a second level", history, paid: false })).toEqual({ three: false, audio: true, save: false });
  });

  it("iterating on a plain 2D silent game stays locked (no keyword anywhere)", () => {
    const history = [msg("child", "make me a maze game"), msg("assistant", "Here's your game! 🎮", "<html><canvas></canvas></html>")];
    expect(catalogGates({ message: "add more walls", history, paid: false })).toEqual({ three: false, audio: false, save: false });
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
    expect(catalogGates({ message: "can you rebuild the level", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
    expect(catalogGates({ message: "improve the placement of enemies", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
  });

  it("a plain game ask with no build/world keyword stays locked", () => {
    expect(catalogGates({ message: "make me a platformer game", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
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
    expect(catalogGates({ message: "a game where I build a tower", history: [], paid: false })).toEqual({ three: false, audio: false, save: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Subject-noun unlock (owner decision 2026-08-23, BUG-FIX-LOG same date).
//
// The bug this closes: THREE_TRIGGER was the literal string "3D" and nothing
// else, so "make a game where I can ride horses" was built with the 3D catalog
// OFF — the rigged `horse` model (121 KB, gallop clip) was invisible to the
// turn, and the only way left to make a horse was to draw one with
// ctx.fillRect. A child asking to ride a horse never types "3D".
//
// The gate file's own §9 principle already said "err toward unlocking"; the
// audio gate follows it (5 words), the save gate follows it (12 words), and
// the 3D gate did not. These tests are that principle, applied.
// ─────────────────────────────────────────────────────────────────────────
describe("catalogGates — a SUBJECT the model library covers unlocks 3D (§9 err-toward-unlocking)", () => {
  // 2026-08-27: the subject unlock is OFF by default (owner: first game is 2D);
  // these tests pin the fallback path behind THREE_SUBJECT_UNLOCK=on.
  beforeEach(() => vi.stubEnv("THREE_SUBJECT_UNLOCK", "on"));
  afterEach(() => vi.unstubAllEnvs());
  it("the demo session's exact ask unlocks the 3D catalog — the horse model must be reachable", () => {
    // 2026-08-22, demo, iOS Safari. This turn shipped a canvas horse drawn
    // from a filled rectangle, stroked legs and a dot eye.
    expect(catalogGates({ message: "Please make a game where I can ride horses and jump over fences", history: [], paid: false }).three).toBe(true);
    expect(catalogGates({ message: "Make a game where I can ride horses", history: [], paid: false }).three).toBe(true);
  });

  it("names a real subject across every genre that owns physical models", () => {
    for (const ask of [
      "a game with a dog and a cat", // animals
      "make a car racing game", // racing
      "a game with a rocket flying to a planet", // space
      "a skiing game in the snow", // snow
      "a castle adventure game with knights", // castle
      "a game in a big city with buildings", // city
      "a game in a forest with trees", // nature
      "a game with a boat sailing on the ocean", // water
      "a football game with goals", // sports
      "a game with tanks and soldiers", // military
    ]) {
      expect(catalogGates({ message: ask, history: [], paid: false }).three, ask).toBe(true);
    }
  });

  it("a MECHANIC is not a subject — it says nothing about what is in the game", () => {
    // Deliberately excluded genres. "platformer"/"maze"/"collect coins" name
    // how the game PLAYS, not what it contains, so they cannot tell us a
    // model would help. Keeping them out also keeps the plain 2D platformer —
    // a core, good product — exactly as it is today.
    for (const ask of ["make me a platformer game", "a maze game", "a game where I collect coins"]) {
      expect(catalogGates({ message: ask, history: [], paid: false }).three, ask).toBe(false);
    }
  });

  it("the genres that are better flat stay flat — a quiz or a board game must not be dragged into Three.js", () => {
    // `people` is excluded for being over-broad on its own words (man/women/
    // kids/walking/sitting all fire on ordinary chat about a quiz); `food` and
    // `indian_games` (carrom, ludo, dice, marbles) are board/flat games.
    for (const ask of [
      "a quiz game for kids",
      "a spelling game for boys and girls",
      "a word game about food",
      "a ludo game with dice",
      "a carrom game",
    ]) {
      expect(catalogGates({ message: ask, history: [], paid: false }).three, ask).toBe(false);
    }
  });

  it("still nested under the build-turn gate — a subject noun in chit-chat pays nothing", () => {
    expect(catalogGates({ message: "i have a dog at home", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
    expect(catalogGates({ message: "do you like horses?", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
  });

  it("word-bounded, same convention as every other trigger here", () => {
    expect(catalogGates({ message: "a game about a carpet in a scarcity", history: [], paid: false }).three).toBe(false);
  });
});

describe("threeUnlockReason — which lead-in the 3D prompt gets", () => {
  it("an explicit 3D ask is 'asked' — the strong, unchanged wording", () => {
    expect(threeUnlockReason({ message: "make it 3d", history: [], paid: false })).toBe("asked");
    expect(threeUnlockReason({ message: "Make it 3-D", history: [], paid: false })).toBe("asked");
  });

  it("a game that is ALREADY 3D is 'asked' too — the child is iterating on a real 3D scene", () => {
    const history = [msg("assistant", "Here! 🎮", "<html><!--USES_THREE--><canvas id='scene'></canvas></html>")];
    expect(threeUnlockReason({ message: "make it faster", history, paid: false })).toBe("asked");
  });

  it("a subject-only unlock is 'subject' — 3D is OFFERED, never forced", () => {
    vi.stubEnv("THREE_SUBJECT_UNLOCK", "on"); // subject unlock is opt-in since 2026-08-27
    expect(threeUnlockReason({ message: "Make a game where I can ride horses", history: [], paid: false })).toBe("subject");
  });

  it("no unlock at all reports null", () => {
    expect(threeUnlockReason({ message: "make me a platformer game", history: [], paid: false })).toBeNull();
    expect(threeUnlockReason({ message: "how are you today?", history: [], paid: false })).toBeNull();
  });
});

// 2026-08-25 plan "slim the 3D instruction on edit turns" (noble-orbiting-stallman):
// the sports playbook (~1,000 tokens) used to ride EVERY 3D turn because the
// MANIFEST holds sports models. It is a genre playbook — gate it on the game.
describe("catalogGates — sports gate (playbook only for sports games)", () => {
  const game3d = (html: string): ChatMessage => ({ id: "g", role: "assistant", text: "here", createdAt: 1, artifactHtml: html });

  it("SP.1 a plain 3D ask does not unlock sports", () => {
    const g = catalogGates({ message: "3D - make a race track", history: [], paid: false });
    expect(g.three).toBe(true);
    expect(g.sports).toBeUndefined();
  });

  it("SP.2 sports words in the ask unlock it (football, cricket, goalkeeper…)", () => {
    for (const ask of ["3D - a football game", "make a cricket game in 3D", "3d penalty shootout"]) {
      expect(catalogGates({ message: ask, history: [], paid: false }), ask).toMatchObject({ three: true, sports: true });
    }
  });

  it("SP.3 a game that already loads a sports model keeps the playbook on edits (iteration insurance)", () => {
    const history = [game3d('<script type="module">import {Scene} from "three"; loadModel("soccer_ball")</script>')];
    expect(catalogGates({ message: "make the ball faster", history, paid: false })).toMatchObject({ three: true, sports: true });
  });

  it("SP.4 sports is a build-turn gate like the others — chit-chat about football pays nothing", () => {
    expect(catalogGates({ message: "who won the football last night?", history: [], paid: false })).toEqual({ three: false, audio: false, save: false });
  });
});

// Same plan, step 2: the save playbooks (~870 tokens) rode 62 of 72 prod turns
// on EDITS, unlocked by "build" in "build me a race track". On an edit turn they
// are sent only when the ask itself is about saving/progress.
describe("editGates — what an EDIT turn's ask re-introduces", () => {
  it("EG.1 a plain edit needs nothing extra", () => {
    expect(editGates("change the blocks to red and blue")).toEqual({});
    expect(editGates("add a reset button")).toEqual({});
  });

  it("EG.2 save/progress words bring the save playbooks", () => {
    for (const ask of ["add a save button", "remember my progress", "let me continue where I left off", "add checkpoints"]) {
      expect(editGates(ask), ask).toMatchObject({ save: true });
    }
  });

  it("EG.3 'build' alone does NOT (it unlocked save on 'build me a race track')", () => {
    expect(editGates("build a second tower")).toEqual({});
  });

  it("EG.4 audio / models / physics / sports / multiplayer words bring their sections", () => {
    expect(editGates("play a sound when the tower falls")).toMatchObject({ audio: true });
    expect(editGates("add a horse that runs around")).toMatchObject({ models: true });
    expect(editGates("make gravity stronger so blocks fall faster")).toMatchObject({ physics: true });
    expect(editGates("turn it into a football match")).toMatchObject({ sports: true, models: true });
    expect(editGates("make it two player with my friend")).toMatchObject({ multiplayer: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2026-08-27 (owner decision, reverses the 2026-08-23 subject unlock by
// default): a child's FIRST game is 2D. 3D is unlocked only when they ask —
// "3D" or quality words (realistic / real life / better graphics). The
// subject unlock stays in the code behind THREE_SUBJECT_UNLOCK=on (rule 11:
// a working path is kept as a fallback, never deleted in the same change).
// ─────────────────────────────────────────────────────────────────────────
describe("catalogGates — 2D first; 3D only when the child asks for it (2026-08-27)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("F.1 a first-time subject ask (car / horse / rocket / football) is 2D by default", () => {
    for (const ask of ["make a car racing game", "Make a game where I can ride horses", "a game with a rocket flying to a planet", "a football game with goals"]) {
      expect(catalogGates({ message: ask, history: [], paid: false }).three, ask).toBe(false);
      expect(threeUnlockReason({ message: ask, history: [], paid: false }), ask).toBeNull();
    }
  });

  it("F.2 quality words unlock 3D as 'asked' — realistic / real life / better graphics", () => {
    for (const ask of ["make a realistic car game", "a real life horse riding game", "a dino game with better graphics", "make my game look real"]) {
      expect(catalogGates({ message: ask, history: [], paid: false }).three, ask).toBe(true);
      expect(threeUnlockReason({ message: ask, history: [], paid: false }), ask).toBe("asked");
    }
  });

  it("F.3 quality words in an EARLIER child turn still count (history is monotonic, same as '3d')", () => {
    const history = [msg("child", "make it realistic"), msg("assistant", "Sure!")];
    expect(catalogGates({ message: "make a car game", history, paid: false }).three).toBe(true);
  });

  it("F.4 THREE_SUBJECT_UNLOCK=on restores the 2026-08-23 behaviour (subject → 'subject')", () => {
    vi.stubEnv("THREE_SUBJECT_UNLOCK", "on");
    expect(threeUnlockReason({ message: "Make a game where I can ride horses", history: [], paid: false })).toBe("subject");
    expect(catalogGates({ message: "make a car racing game", history: [], paid: false }).three).toBe(true);
  });
});
