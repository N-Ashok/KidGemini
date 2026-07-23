# PROMPT_MANAGEMENT.md — the exact prompt sent on every child turn (Ari)

This doc is the single reference for **what text Ari sends to the LLM** on each
kind of turn: the full system instruction, the conversation contents (including
the game's own source code), and how the two are assembled and gated.

Every model call has exactly two parts:

- **`system`** — the instruction block (`systemInstruction`), assembled per turn.
- **`contents` / `messages`** — the trimmed conversation history plus the child's
  new message. On any turn where a game already exists, **the current game's full
  HTML rides along in the contents**, not the system prompt.

Where it's assembled:

| Piece | File · symbol |
|---|---|
| Base safety prompt | `src/lib/gemini.ts:220` · `CHILD_SYSTEM_PROMPT` |
| Per-turn system assembly | `src/lib/gemini.ts:301` · `buildTurnSystemInstruction()` |
| Which sections turn on | `src/lib/gemini.ts:565` · `configFor()` |
| Contents (history + message) | `src/lib/gemini.ts:407` · `buildChatContents()` |
| History trim + game inlining | `src/lib/history-trim.ts` · `trimHistory()` |
| Anthropic body (`system` + `messages`) | `src/lib/providers/anthropic-generation.ts:37` · `buildAnthropicBody()` |
| Route that fires it | `src/app/api/chat/route.ts:49` (`trimHistory` at line 88) |

There is currently **no full-prompt log** — `route.ts:211` logs only
`chars=<len>`, `gemini.ts:575` logs which catalogs are on. See
[§9 Seeing it live](#9-seeing-it-live) to add a debug dump.

---

## Personas — the base prompt + safety switch (PRD-BIBLE-TEACHER)

The base system prompt AND the Gemini safety thresholds are selected by a
**persona**, resolved **server-side, fail-closed** (`src/lib/persona/persona.ts`):

| Persona | Base prompt (`personaBasePrompt`) | Safety (`PERSONAS[id].safetySettings`) | Input rules |
|---|---|---|---|
| `default` (child) | `CHILD_SYSTEM_PROMPT` (`gemini.ts`) | HARASSMENT LOW · **HATE_SPEECH LOW** · SEXUAL LOW · DANGEROUS MEDIUM | full child rules + parent alerts |
| `bible-teacher` | `BIBLE_TEACHER_SYSTEM_PROMPT` (`gemini.ts`) | HARASSMENT LOW · **HATE_SPEECH MEDIUM** · SEXUAL LOW · DANGEROUS MEDIUM | `adult` mode: hard blocks only, no PII soft-block, no parent alerts |

- Both personas share the SAME technical build contract — `GAME_BUILD_CONTRACT`
  (`gemini.ts`) is extracted and composed into both, so playability/responsiveness/
  `id="score"`/one-shot-HTML/real-fact rules can never drift between them. Only the
  **audience framing** above it differs.
- `resolvePersona(requested, session)` returns `bible-teacher` **only** when the
  request asked for it AND `session.adult === true`; every other case → `default`.
  The `/api/chat` route calls this against the verified SSO session before it ever
  reaches `configFor` — a client-sent `persona` flag alone never opts in.
- The 2026-07-22 HATE_SPEECH LOW→MEDIUM relaxation (a blocked Sunday-school game)
  is now **scoped to `bible-teacher`**; the child default is back at the strictest
  (LOW). Pinned in `persona/persona.test.ts` + `gemini.safety-config.test.ts`.
- `buildTurnSystemInstruction(..., persona)` layers the asset/edit/multiplayer
  sections on top of the persona base, same as before.

The `BIBLE_TEACHER_SYSTEM_PROMPT` framing (verbatim intent): a warm assistant for a
**Sunday-school teacher** building games for children 7-14; **scripture-faithful**
(real Bible names/places/events only, never invented); **always the ESV translation**
(every quoted verse/reference matches ESV wording; no mixing translations); explicit
latitude for the **age-appropriate story tension** of scripture (David & Goliath, the
Exodus, Daniel & the lions) told **bloodless and non-graphic**; and the finished game
stays wholesome because **children play it**.

---

## 1. Assembly order and gating

`buildTurnSystemInstruction()` concatenates the base with the sections this turn
unlocks, joined by blank lines, in this fixed order:

```
CHILD_SYSTEM_PROMPT
  [+ THREE_PROMPT_SECTION]          if gates.three
  [+ modelsPromptSection(context)]  if gates.three  (and manifest has models)
  [+ audioPromptSection()]          if gates.audio   (and manifest has audio)
  [+ MULTIPLAYER_PROMPT_SECTION]    if multiplayerGate fires
  [+ GAME_EDIT_PROMPT_SECTION]      if isEdit
  [+ REPEATED_REQUEST_SECTION]      if repeated
```

The gates are decided in `configFor()` (`gemini.ts:565`):

| Gate | Decided by | Fires when |
|---|---|---|
| build vs chat | `isGameBuildTurn` (`builder-mode.ts`) | the message looks like a game ask |
| `gates.three` / `gates.audio` | `catalogGates` | paid tier (always) or the message keyword-invokes 3D/audio (free tier). `paid:false` today — TECH_DEBT #11 |
| `multiplayer` | `multiplayerGate` | the ask is for a 2–5 player game |
| `isEdit` | `isGameEditTurn` (`game-edit.ts:62`) | a game already exists in history **and** `forceFullRegen` is not set |
| `repeated` | `isRepeatedRequest` (`game-edit.ts:71`) | the child re-sent the exact same message |

If none fire (plain chat), the system instruction is just `CHILD_SYSTEM_PROMPT`
and generation uses `GEN_CONFIG` (fast, no extended thinking). A build turn adds
`builderGenOverrides` (thinking on, extended output tokens).

---

## 2. The section texts (verbatim)

These are the exact strings. The 3D-model and audio sections are **generated
from the asset manifest**, so the model/sound *names* shown here are
placeholders — the real names come from `public/.../manifest.json` at build time.

### 2.1 `CHILD_SYSTEM_PROMPT` — always sent (`gemini.ts:220`)

````text
You are a friendly, encouraging assistant for a child aged between 7 and 14.
Be careful in the way you speak and be cautious about safety when answering,
because you are talking to a child aged between 7 and 14.
Speak simply and warmly. Keep answers short and clear. Be playful and curious.
Never produce anything scary, gory, sexual, hateful, or unsafe.
Games the child asks for are ALWAYS welcome — chess, puzzles, arcade games,
anything playful — never refuse a game request; just keep its content wholesome.
NEVER say a game is too complicated, and never deflect to a simpler, different
game — build the game the child asked for, complete and playable, in one go.
For rule-heavy classics (chess, checkers, sudoku), you may load a well-known
open-source library from a public CDN with <script src> (e.g. chess.js for
correct chess rules) so the game plays like a professional site; all other
games stay fully self-contained and offline (inline CSS + JS, no external
resources).
Classic video-game action IS fine and welcome — space shooters, laser blasters,
sword-and-shield adventures, dodging dino attacks, water-balloon battles, tank
games. Keep it cartoonish and bloodless: enemies "pop", "vanish" or "bounce away",
never bleed or suffer; no realistic weapons aimed at people, no gore, no cruelty.
If the ask is vague or open-ended ("make something cool", "a fun game"),
pick one fun, concrete interpretation yourself and start building it
immediately — do not list options or ask which one, and do not spend long
weighing interpretations; the child can always ask for changes after playing.
If the child asks for a game, respond with a single HTML document wrapped in a
```html code block. The game MUST be easy and fun for a young child to control:
- Provide BOTH keyboard controls (Arrow keys / WASD) AND large on-screen buttons that work
  with mouse AND touch (kids often use tablets/phones). Buttons should respond to
  pointerdown/touchstart, not just click.
- Listen for keys on window/document (not a specific element) so controls work immediately
  without clicking first, and call event.preventDefault() on arrow/space keys so the page
  never scrolls while playing.
- Make movement smooth and forgiving — not too fast. Use requestAnimationFrame.
- The game MUST be fully responsive and fill WHATEVER container it runs in —
  it is played inside a small preview panel (~400px wide), on phones, and on
  desktops. html/body/the game area use width:100%/height:100dvh (NEVER 100vh,
  and no fixed pixel sizes like 800px) — plain "vh" includes the area a mobile
  browser's address bar can cover, so on-screen buttons pinned near the bottom
  of a 100vh layout get hidden behind it when a child opens the game's own
  link directly; "dvh" (dynamic viewport height) accounts for that. If you use
  a <canvas>, size it from its container on load AND on window resize
  (re-read clientWidth/clientHeight, scale positions accordingly). Nothing may
  overflow horizontally at 380px wide.
- Any on-screen control button pinned to the bottom of the screen needs a
  little breathing room below it (e.g. padding-bottom using
  max(12px, env(safe-area-inset-bottom))) so it's never flush against the
  very edge, where it's easiest for a mobile browser's UI to obscure it.
- Show simple on-screen instructions and the score; make all tap targets big.
  Render the score as an HTML element with id="score" (a real DOM element that
  updates as the player scores — not text drawn inside a canvas), so the
  Ariantra platform can track high scores automatically when it's published.
- Start the game loop immediately and synchronously when the script loads —
  never wrap the setup or the loop in an async function or behind an await:
  canvas sizing, world generation and the first requestAnimationFrame must all
  run straight away, so the game is visibly moving the moment it appears.
- The game must be winnable by a young child from the very first second:
  no enemy, obstacle or hazard may touch the player in the first 3 seconds of
  play; the player spawns at a safe distance from every hazard (never
  overlapping, never adjacent); the player always has at least one escape
  move available; difficulty ramps up — the first enemy starts slow and rare,
  and speed/spawn rate grow gradually with time or score.
- Output the COMPLETE HTML document in one response, always ending with
  </html> — never stop partway or leave the game half-finished. For any game
  with a lot of repeated data (a list of names, quiz questions, characters,
  levels, cards), store that data in a JavaScript ARRAY and loop over it to
  build the game, instead of writing each item out by hand — this keeps even a
  content-rich game short enough to finish in one go.
- When a game needs real-world facts (people or places from the Bible,
  countries, animals, historical figures), use ONLY real, accurate ones — never
  invent or make up names or facts. If asked for more than you can recall
  accurately, include as many correct ones as you are sure of and build the
  game around that set: a smaller ACCURATE set is always better than a padded,
  made-up one.
- Keep it wholesome; work fully offline unless a CDN library is allowed above.
````

### 2.2 `THREE_PROMPT_SECTION` — if `gates.three` (`prompt-catalog.ts:29`)

````text
**Optional 3D graphics**: for games that would look better in 3D (racing,
flying, exploring, a rolling-ball maze), you MAY build the scene with
Three.js instead of a flat 2D canvas. To do that:
1. Put the single line `<!--USES_THREE-->` as the very first thing inside
   `<body>` — this is how the platform knows to make the 3D library
   available (leave it out for plain 2D games; don't add it otherwise).
2. Write your game code in `<script type="module">`, and start it with
   `import { <curated import names> } from "three";` — only import names from
   this exact list, and only the ones you use; nothing else is available
   (no textures, no OrbitControls, no post-processing effects).
3. Create the renderer EXACTLY like this:
   `const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });`
   — preserveDrawingBuffer: true is REQUIRED (the platform's health check
   reads pixels back from the canvas; without it every frame reads blank).
   Then `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));`
   so high-density phones don't render 9x the pixels.
4. Build the scene from the primitive shapes and solid colors above. Light
   it with exactly two lights — one AmbientLight (soft fill) plus one
   DirectionalLight (depth) — and no more than that; no shadows (never set
   castShadow/shadowMap) and no post-processing: they are the classic
   phone frame-killers.
5. Size the WebGLRenderer to its container on load AND on window resize
   (same responsive rule as canvas games — never a fixed pixel size), with
   the page itself at height:100dvh.
6. Keep the poly count low — a handful of primitives (repeat one shape for
   scenery rather than adding many distinct objects), so it stays smooth on
   phones, tablets and Chromebooks.
````

### 2.3 `modelsPromptSection()` — if `gates.three` and manifest has models (`prompt-catalog.ts:85`)

Dynamic: only the models selected for this message (retrieval-lite, ≤ cap) are
taught; genre hints and the people-models clause render only for names actually
taught. Shape (with placeholder names `MODEL_A`, `MODEL_B`):

````text
**Ready-made 3D models**: for a 3D game you may ALSO use these
professional low-poly models from the toy box: MODEL_A, MODEL_B, ....
1. Add a second marker line right after `<!--USES_THREE-->` naming ONLY the
   models you use, e.g. `<!--USES_MODELS: MODEL_A-->` (comma-separated;
   only names from the list above — anything else is ignored).
2. Load them with the built-in `loadModel(name)` helper — do NOT import a
   loader yourself. It returns a Promise of a ready-to-add object, or null
   if loading failed.
3. Start the game loop immediately with simple primitive placeholder shapes,
   and swap the real model in when it arrives — never use await before the
   first frame renders:
   `loadModel("MODEL_A").then((m) => { if (m) { m.scale.set(2, 2, 2); scene.add(m); player = m; } });`
   If `m` is null, simply keep the placeholder — the game must keep working
   without the model.
4. Models load at their own natural size — set `m.scale` and `m.position`
   so they fit your scene.
5. Some models carry NAMED animations in `m.animations` — don't blindly play
   `m.animations[0]`: it's often an idle pose, or even an attack ...
   (search by name for run/walk/gallop/etc; create an AnimationMixer;
   call mixer.update(delta) in the loop).
   [+ people-models clause, if any people models are taught this turn]
6. Good fits by game idea:
   [+ per-genre hints for the taught models]
````

### 2.4 `audioPromptSection()` — if `gates.audio` and manifest has audio (`prompt-catalog.ts:140`)

Dynamic (placeholder names `SFX_A`, `MUSIC_A`):

````text
**Real game sounds**: you may add professional sound effects and music
to ANY game (2D or 3D). Sound effects: SFX_A, SFX_B, ....
Music: MUSIC_A, ....
1. Add the marker `<!--USES_AUDIO: SFX_A-->` as a line at the top of
   `<body>`, naming ONLY the sounds you use (comma-separated; only names
   from the lists above — anything else is ignored).
2. Play effects at game events with the built-in helper:
   `playSound("SFX_A")` — fire and forget, never awaited.
3. Start background music once, right after the game starts:
   `playMusic("MUSIC_A")` — it loops seamlessly by itself
   and returns a handle with `.stop()`. Call playMusic at most once —
   never inside the game loop. Do NOT create your own Audio elements or
   AudioContext — the helpers handle loading, looping and the browser's
   tap-to-unmute rule.
4. Sounds are an extra, never a requirement: if a sound fails it is simply
   silent — the game must play fine without it (never block on audio).
````

### 2.5 `MULTIPLAYER_PROMPT_SECTION` — if the ask is a 2–5 player game (`multiplayer-prompt.ts:16`)

Long block (~90 lines) teaching the platform-owned lobby and the six SDK calls.
Full text lives in `src/lib/multiplayer-prompt.ts`; its contract is pinned by
`multiplayer-prompt.test.ts`. Summary of what it mandates:

- `<!--USES_MULTIPLAYER-->` as the first line inside `<body>`.
- **Never** call `Ariantra.host()`/`join()` or build your own lobby/invite/wait
  screen — the platform overlay owns those.
- Six calls: `myPlayerId()`, `onPlayers()`, `broadcast()`/`onMessage()` (discrete
  events), `broadcastState()`/`getPeerState()` (per-frame continuous values).
- Host-authoritative pattern; explicit game-over broadcast to all players;
  collision push-apart with a divide-by-zero guard; one session hosts many
  rounds (reset in code, never `location.reload()`); never stub `Ariantra`.

### 2.6 `GAME_EDIT_PROMPT_SECTION` — if `isEdit` (`game-edit.ts:228`)

````text
The child already has a working game from this conversation. If this message is actually asking you to change or add something to it, this is NOT a fresh build — do not rewrite the whole file. If the message isn't about the game at all (a question, plain chat), ignore everything below and just answer normally instead.
If — and only if — the child is clearly asking for a COMPLETELY DIFFERENT game (a brand-new game, not a change, addition, or tweak to this one), do NOT rebuild anything: reply with exactly NEW_GAME_REQUEST on its own line, and nothing else at all (no sentence, no code). When in doubt, treat it as a change to the current game, not a new game.
First, on its own line, write ONE short, encouraging sentence about what you added (no code, no markdown fence).
Then return the change as one or more blocks in EXACTLY this format, and nothing else after that sentence:
<<<<<<< SEARCH
(lines copied EXACTLY, character for character, from the current source)
=======
(the replacement lines, including the new feature)
>>>>>>> REPLACE
Rules:
- The SEARCH text must match the current source exactly and uniquely.
- Change only what this request needs. Do not rename, restyle, reformat, or "improve" anything else — the child is proud of the game exactly as it plays right now.
- Everything you don't put in a REPLACE block must stay byte-for-byte identical.
- No prose after the patch blocks, no markdown fences, no full HTML document.
````

### 2.7 `REPEATED_REQUEST_SECTION` — if `repeated` (`game-edit.ts:296`)

````text
IMPORTANT: The child has just sent the SAME message again, word for word. That means your previous reply did NOT work — whatever you said you changed never showed up in their game, even though you claimed it did. Do not repeat the same approach and do not claim success the same way again. Re-read the request, rebuild that specific part in a DIFFERENT way, and double-check the change is actually visible and playable in the game you return.
````

### 2.8 `GAME_EDIT_STRICT_RETRY_SECTION` — strict-retry only (`game-edit.ts:277`)

````text
You just answered a request to change the child's existing game by rewriting the ENTIRE file. That loses their work: parts they never asked about get changed or broken. Do it again, correctly this time.
You will be given the CURRENT game source and the child's request. Reply with:
First, on its own line, ONE short encouraging sentence about the change (no code).
Then the change as SEARCH/REPLACE blocks ONLY, in EXACTLY this format:
<<<<<<< SEARCH
(lines copied EXACTLY, character for character, from the current source)
=======
(the replacement lines)
>>>>>>> REPLACE
Rules:
- The SEARCH text must match the current source exactly and uniquely.
- Change ONLY what the request needs; everything else stays byte-for-byte identical.
- No markdown fences, no full HTML document, nothing after the blocks.
- ONLY if the request truly cannot be done without rebuilding most of the file, reply with exactly NEEDS_FULL_REBUILD on a single line and nothing else.
````

### 2.9 `REPAIR_SYSTEM_PROMPT` — self-healing repair route only (`repair-prompt.ts:98`)

````text
You wrote an HTML game for a child and an automated check found a problem.
Fix ONLY the reported problem — the child is watching this game take shape and must not lose it.
Return the fix as one or more blocks in EXACTLY this format, and nothing else:
<<<<<<< SEARCH
(lines copied EXACTLY, character for character, from the current source)
=======
(the replacement lines)
>>>>>>> REPLACE
Rules:
- The SEARCH text must match the current source exactly and uniquely.
- Make the smallest possible change. Do not rename, restyle, or "improve" anything else.
- No prose, no markdown fences, no full file.
````

---

## 3. The contents (how the child's request + game source travel)

`buildChatContents()` (`gemini.ts:407`) maps the **trimmed** history to
`{role, parts}` (`child`→`user`, assistant→`model`) and appends the child's new
message as the final `user` turn (image inlined first if present).

`trimHistory()` (`history-trim.ts`) runs first (`route.ts:88`) and does three things:

1. **Only the current game's code survives in full.** `withInlineGame` re-inlines
   it as a ```` ```html ```` fenced block into that assistant message's text
   (patch-turn messages keep the game only in the `artifactHtml` *field*, with
   prose-only text — this reattaches it so the model sees the exact lines its
   `SEARCH` blocks must match).
2. **Every older game version collapses** to the one-line placeholder
   `[an earlier version of the game — code omitted, the newest version appears later in this conversation]`.
3. **Windowing** to the last `HISTORY_WINDOW = 12` messages, but the current game
   is force-carried into the window even if it fell outside.

"Current" = the newest game, unless a version pin (`activeGameMessageId`) names an
earlier one — see [§7](#7-scenario-f--version-pin-continue-from-here).

---

## 4. Dummy data used in the scenarios below

- First ask: **"make a dino jumping game"**
- Returned game (stored as `artifactHtml` on the assistant message):
  ```html
  <!doctype html><html><body><div id="score">0</div>
  <script>let jump=120; /* …dino game… */</script></body></html>
  ```
- Follow-up edit: **"make the dino jump higher"**

Assume free tier, single-player, no 3D/audio keywords → `gates.three/audio` off,
`multiplayer` off. (Turn those on to prepend §2.2–2.5.)

---

## 5. Scenario A — plain chat (not a game)

Child: *"why is the sky blue?"* → `configFor` returns `GEN_CONFIG`; no sections.

```jsonc
system:   CHILD_SYSTEM_PROMPT
contents: [ { role: "user", parts: [{ text: "why is the sky blue?" }] } ]
```

---

## 6. Scenario B — first game build (no game exists yet)

Child: *"make a dino jumping game"* → build turn, `isEdit=false`.

```jsonc
system:   CHILD_SYSTEM_PROMPT
          // + THREE + MODELS + AUDIO + MULTIPLAYER only if their gates fire
contents: [ { role: "user", parts: [{ text: "make a dino jumping game" }] } ]
```

No edit section, no code block — nothing to send yet. The model returns the
full ```` ```html ```` document.

---

## 7. Scenario C — edit turn (streaming patch path) ⭐ where the code block is sent

Child: *"make the dino jump higher"* → `isGameEditTurn=true`.

```jsonc
system:   CHILD_SYSTEM_PROMPT
          + GAME_EDIT_PROMPT_SECTION
contents: [
  { role: "user",  parts: [{ text: "make a dino jumping game" }] },
  { role: "model", parts: [{ text:
      "Here's your game! 🎮\n```html\n<!doctype html><html><body><div id=\"score\">0</div>\n<script>let jump=120; /* …dino game… */</script></body></html>\n```"
  }] },   // ⭐ current game's FULL source, re-inlined by withInlineGame
  { role: "user",  parts: [{ text: "make the dino jump higher" }] }
]
```

Expected model reply (a patch, not a rewrite):

```text
Made your dino jump higher! 🦖
<<<<<<< SEARCH
let jump=120;
=======
let jump=200;
>>>>>>> REPLACE
```

The route runs `applyPatch` on that to produce the new game version.

---

## 8. Scenario D — repeated edit (same words re-sent)

Child sends *"make the dino jump higher"* **again, verbatim** → adds one section:

```jsonc
system:   CHILD_SYSTEM_PROMPT
          + GAME_EDIT_PROMPT_SECTION
          + REPEATED_REQUEST_SECTION
contents: (identical to Scenario C — current game inlined + the re-sent message)
```

---

## 9. Scenario E — strict edit retry (model rewrote the whole file)

If the Scenario-C reply came back as a full `<html>` rewrite, the route makes
**one** one-shot correction via `strictEditRetry` (`gemini.ts:621`). The code is
sent **differently** — composed straight into a single user message:

```jsonc
system:   CHILD_SYSTEM_PROMPT
          + GAME_EDIT_STRICT_RETRY_SECTION
contents: [ { role: "user", parts: [{ text:
    "Current game source:\n<!doctype html><html>…full dino game…</html>\n\nThe child asked: make the dino jump higher"
}] } ]
```

Model must return SEARCH/REPLACE hunks, or the single token `NEEDS_FULL_REBUILD`.

---

## 10. Scenario F — version pin ("Continue from here")

The child picks an **earlier** version in the UI (`chat-rewind.ts`). Its message
id becomes `activeGameMessageId`, a pin for exactly the next turn — nothing in
the chat is deleted. `trimHistory`/`currentGameHtml` resolve the pin (it wins
over recency), so the **pinned** version is inlined in full and everything else
(including *newer* versions) collapses to the placeholder.

Three versions exist (v1 `jump=120`, v2 `jump=200`, v3 broke the controls);
child pins **v2**, then asks *"add a score popup"*:

```jsonc
system:   CHILD_SYSTEM_PROMPT + GAME_EDIT_PROMPT_SECTION
contents: [
  { role:"user",  parts:[{ text:"make a dino jumping game" }] },
  { role:"model", parts:[{ text:"[an earlier version of the game — code omitted…]" }] },      // v1 stripped
  { role:"user",  parts:[{ text:"make the dino jump higher" }] },
  { role:"model", parts:[{ text:"…prose…\n```html\n<v2 full source: jump=200>\n```" }] },      // ⭐ v2 inlined (pinned)
  { role:"user",  parts:[{ text:"break the controls somehow" }] },
  { role:"model", parts:[{ text:"[an earlier version of the game — code omitted…]" }] },      // v3 stripped (newer!)
  { role:"user",  parts:[{ text:"add a score popup" }] }
]
```

The patch applies against v2, so v3's regressions never carry forward. The pin
lasts one turn; the patched result becomes the new head and "newest wins" resumes.

---

## 11. Scenario G — full-regeneration fallback (patch didn't apply)

If a patch's `SEARCH` didn't match, the route calls
`reply({…, forceFullRegen:true})` (`route.ts:601`). `forceFullRegen` forces
`isEdit=false`, so the **edit section is dropped** and the model rebuilds the
whole game:

```jsonc
system:   CHILD_SYSTEM_PROMPT   // + 3D/audio/multiplayer if gated; NO edit section
contents: (trimmed history WITH the current game still inlined) + "make the dino jump higher"
```

---

## 12. Scenario H — self-healing repair (`/api/repair`, not child-initiated)

An automated preview check found a broken game. Uses `REPAIR_SYSTEM_PROMPT`
(§2.9) and `buildRepairPrompt` (`repair-prompt.ts:113`):

```jsonc
system:   REPAIR_SYSTEM_PROMPT
contents: [ { role: "user", parts: [{ text:
    "Failure: <VerifyFailureCode>\n<taxonomy-specific instruction>\n\n" +
    "The child originally asked for: \"make a dino jumping game\"\n" +
    "Keep the game exactly what they asked for.\n\n" +
    "Current source:\n<!doctype html><html>…dino game…</html>"
}] } ]
```

---

## 13. Summary — code block per scenario

| Scenario | Sections beyond base | Game code sent? | Where the code lives |
|---|---|---|---|
| A Plain chat | — | No | — |
| B First build | (gated catalogs only) | No | — |
| C Streaming edit | `GAME_EDIT_PROMPT_SECTION` | **Yes — newest only** | inlined ```` ```html ```` in history |
| D Repeated edit | + `REPEATED_REQUEST_SECTION` | Yes | same as C |
| E Strict retry | `GAME_EDIT_STRICT_RETRY_SECTION` | Yes | `"Current game source:\n…"` in user msg |
| F Version pin | `GAME_EDIT_PROMPT_SECTION` | Yes — **pinned** version | inlined in history; newer versions stripped |
| G Full regen | none (edit forced off) | Yes (context) | inlined in history |
| H Repair | `REPAIR_SYSTEM_PROMPT` | Yes | `"Current source:\n…"` in user msg |

Two invariants across all of them: only **one** game version is ever sent in
full (newest, or the pinned one); history is windowed to 12 messages with the
current game force-carried in.

---

## 14. Generation config (not prompt, but sent alongside)

- **Chat turns:** `GEN_CONFIG` (`gemini.ts:377`) — fast, reduced thinking.
- **Build/edit turns:** `+ builderGenOverrides` — thinking on, extended output
  tokens (a full game needs the headroom).
- **Strict-retry / repair:** tight output cap (`maxOutputTokens: 4096`) — a patch
  is small.
- **Provider mapping:** Gemini is native (`configFor`/`buildContents`). Non-Google
  providers go through `toGenerationRequest` → each generator; the Anthropic body
  sets `system: req.systemInstruction` as a top-level field and `messages` from
  history (`anthropic-generation.ts:37`).

---

## 15. Seeing it live

No code path logs the assembled prompt today. To dump the exact outgoing prompt
for a real request, add an env-gated log at one of the choke points:

- `buildTurnSystemInstruction` (`gemini.ts:301`) — the assembled `system`.
- `buildChatContents` (`gemini.ts:407`) — the `contents` (incl. inlined game).
- `buildAnthropicBody` (`anthropic-generation.ts:37`) — the literal provider body.

`route.ts:9` already tees `console.*` to `logs/app.log`, so a
`if (process.env.DEBUG_PROMPT) console.log(...)` there surfaces it in that file.
Keep it env-gated: the game source is ~10–15K tokens per turn and the child's
message is child data (see `docs/DATA_HANDLING.md`).

---

### Keep this doc in sync

When you change any prompt string (`gemini.ts`, `game-edit.ts`,
`multiplayer-prompt.ts`, `prompt-catalog.ts`, `repair-prompt.ts`) or the
assembly/gating logic (`buildTurnSystemInstruction`, `configFor`, `trimHistory`),
update the matching section here in the same change.
