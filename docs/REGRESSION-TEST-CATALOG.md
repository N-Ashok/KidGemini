# Regression Test Catalog

> **Purpose:** Map test files to the production code they protect. When you touch a file in the
> left column, run the tests in the right column **before** committing. These are the *minimum* —
> the full suite still catches more. Maintained alongside `docs/BUG-FIX-LOG.md`: every bug-fix
> that adds a test adds a row here.

Commands:

```bash
npm run test                 # Vitest — full unit + integration suite (with coverage)
npm run test -- <pattern>    # Vitest — single file / pattern
npm run test:e2e             # Playwright — browser e2e / regression
npm run typecheck            # tsc --noEmit
```

---

## How to read this catalog

- **"When to run"** = trigger file paths. Touching any matching file ⇒ run that test before commit.
- **"What it pins"** = the contract / regression class the test locks in.
- **"Bug-fix ref"** = the `BUG-FIX-LOG.md` entry that created or last fortified the test.

---

## Safety & gate contracts

| When to run (file touched) | Test to run | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/safety.ts`, `src/lib/safety.rules.ts`, `src/lib/safety.config.ts` | _(to be written)_ `src/lib/safety.test.ts` | Fail-closed: classifier error/uncertain ⇒ block + log, never show. | — |
| `src/lib/safety.rules.ts` (`RulesClassifier`, `collapseSpelledOutLetters`) | **`src/lib/safety.rules.test.ts`** (8 tests, passing) | Profanity is matched per word-token (never the whole message concatenated) so two innocent real words can't collide into a blocked one at their boundary ("medic kit" ⊅ "dick"); letter-spaced ("f u c k"), punctuation-obfuscated, and leetspeak evasion of a single word still caught; self-harm phrases still caught across real word boundaries ("kill myself"). | 2026-07-18 ("medic kit" false hard-block) |
| `src/app/api/chat/route.ts` | **`src/app/api/chat/route.test.ts`** R.1 | Input rules block before streaming; a streamed game reaches `done` and is **never** followed by a `retract` (post-hoc retraction class — chess block). | 2026-07-09 (monitor removed) |
| `src/lib/gemini.ts` (`extractArtifact`), `src/app/api/chat/route.ts` (`done` event `text`), `src/components/Markdown.tsx` (`CodeBlock`) | **`src/lib/gemini.extract-artifact.test.ts`** (4 tests) + **`src/app/api/chat/route.test.ts`** F.1-F.3 | `wasFenced` distinguishes a clean closed fence from extractArtifact's tolerant fallbacks; the chat-bubble `text` is ALWAYS re-fenced when the model's reply wasn't cleanly fenced, or CommonMark reinterprets the raw HTML/CSS/JS's indentation as stray "indented code block" widgets (garbled chat bubble, production incident). F.3 re-parses with the real `remark-parse`/`remark-gfm` stack to confirm exactly one `html`-tagged code node. | 2026-07-14 (unfenced game code corrupts the chat bubble) |
| `src/lib/gemini.ts` (`CHILD_SYSTEM_PROMPT`, `GEN_CONFIG`) | **`src/lib/gemini.prompt.test.ts`** (3 tests, passing) | The child-safety system instruction (age 7–14, be-careful/be-cautious, never-refuse-a-game) exists — it REPLACED the Flash-Lite output monitor and must not silently disappear. | 2026-07-09 (monitor removed) |
| `src/lib/mic-errors.ts`, `src/components/useSpeechInput.ts` | **`src/lib/mic-errors.test.ts`** (5 tests, passing) | Kid-friendly message per error code; fatal/non-fatal split — pauses ("no-speech"/"aborted") keep the mic alive, only permission/hardware/network end the session. | 2026-07-07, 2026-07-09 (mic keep-alive) |
| `src/lib/speech-transcript.ts`, `src/components/useSpeechInput.ts` | **`src/lib/speech-transcript.test.ts`** (16 tests, passing) | Finals/interim split is self-tracked (`finalCount`/`alreadyCommitted`), never trusts the browser's `resultIndex` — a stuck/non-advancing index must not replay already-committed finals (repeat-mic bug, both Composer and IdeaMicTab). `committedCountAfterRestart` only resets the counter on a `rec.start()` that actually succeeded — a failed restart (old session still alive) must not replay already-committed finals either. | 2026-07-10 (interim flush), 2026-07-14 (repeat-mic), 2026-07-16 (repeat-mic take 2 — restart race) |
| `src/lib/stream-recovery.ts`, `src/components/ChatPanel.container.tsx` (`runStream`), `src/components/useWakeLock.ts` | **`src/lib/stream-recovery.test.ts`** (5 tests, passing) | Dropped/stalled streams auto-retry up to the limit; manual Stop and finalized replies never retry; retry limit stays ≤ 2 (each retry is a paid generation). | 2026-07-09 (wake lock + auto-retry) |
| `src/app/api/chat/route.ts`, `src/auth.ts`, `src/components/ChatPanel.container.tsx`, `src/components/SignInScreen.tsx` | **`src/app/api/chat/route.test.ts`** (2 tests, passing) | Force-login: unauthenticated POST ⇒ HTTP 401 `auth_required` and Gemini is **never** called (fail-closed, no anonymous cost); authenticated POST streams. | 2026-06-25 (force-login) |
| `src/app/api/chat/route.ts`, `src/lib/gate.config.ts`, `src/lib/db.ts` (`tokensUsedByUser`) | _(to be written)_ gate integration test | Guest blocked at ≥ `GUEST_TOKEN_LIMIT` (chat+safety tokens); signed-in unlimited; guest cookie issued; `auth()` failure fails safe to guest. | — |
| `src/lib/rate-limit.ts`, `src/lib/rate-limit.config.ts` | **`src/lib/rate-limit.test.ts`** (10 tests, passing) | Per-IP policy: allow ≤ limit; block (max+1) until next UTC day; window reset; strikes persist across days; `mustPay` at the strike cap; recovery next day. | SCALABILITY_ISSUES #3 |
| `src/lib/db.ts` (`SqliteRateLimitStore`, `ip_limits`), `src/app/api/chat/route.ts` (rate-limit wiring) | _(to be written)_ store + route integration test | Persistence round-trips the record; guests rate-limited, signed-in exempt; `rate_limited`/`paywall` events emitted. | SCALABILITY_ISSUES #3 |

> Rows marked _(to be written)_ are the retrofit owed per `docs/KNOWN_BUGS.md` #1. Replace the
> placeholder path with the real test file and add the bug-fix ref when each lands.

---

## Payment (Razorpay) contracts

| When to run (file touched) | Test to run | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/razorpay.ts` | **`src/lib/razorpay.test.ts`** (8 tests, passing) | Signature verification is the payment security boundary: valid ⇒ accept; tampered/empty ⇒ reject; **fail-closed** when no secret; `createOrder` POSTs with basic auth and propagates non-OK as an error. | KNOWN_BUGS #2 |
| `src/app/api/billing/order/route.ts`, `src/lib/auth-identity.ts`, `src/lib/billing.config.ts` | **`src/app/api/billing/order/route.test.ts`** (3 tests, passing) | Unauthenticated ⇒ 401 and Razorpay never called; unknown plan ⇒ 400; authed ⇒ order created + recorded. | KNOWN_BUGS #2 |
| `src/app/api/billing/webhook/route.ts`, `src/lib/db.ts` (`SqlitePaymentStore`) | **`src/app/api/billing/webhook/route.test.ts`** (3 tests, passing) | Invalid signature ⇒ 400 + no write (fail-closed); valid `payment.captured` ⇒ `markPaid`; duplicate event id ⇒ idempotent (not paid twice). | KNOWN_BUGS #2, SCALABILITY_ISSUES #6 |

## Gate funnel (guest trial + paid budget)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/app/api/chat/route.ts`, `src/lib/gate.config.ts`, `src/lib/db.ts` (usage store) | `src/app/api/chat/route.test.ts` | Guest 10K trial streams then 401-walls; IP cap defeats cookie-clearing; 429/402 statuses; signed-in budget OFF by default; Gemini never called on any blocked path; all blocks are HTTP statuses (silent-hang class); guest cookie's `Domain=.ariantra.com` in production (host-only in dev) so a canonical-domain rename doesn't mint a fresh guest identity (G.1c/G.1d) | BUG-FIX-LOG 2026-06-25 + follow-up 2026-07-03 + 2026-07-18 (guest→account merge gap) |

## Chat history trim (2026-07-08, re-introduced after the same-day revert)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/history-trim.ts`, `src/app/api/chat/route.ts` | **`src/lib/history-trim.test.ts`** (7 tests, passing) | Only the newest game's code reaches the model (older versions → placeholder, prose kept); child messages never touched; 12-message sliding window; the newest game is swapped INTO the window when it falls outside (cap still holds); empty history safe | — (token-cost optimization, not a bug fix) |

## Game preview console (2026-07-08, re-introduced after the same-day revert)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/game-console.ts`, `src/components/ArtifactFrame.tsx` | **`src/lib/game-console.test.ts`** (7 tests, passing; runs the injected script for real in `node:vm`, not just string matching) | Capture script is injected as early as possible (`<head>` → after `<html>` → doc start) and never double-injected; `console.log/warn/error`, `window.onerror`, and `unhandledrejection` all forward a `GameConsoleMessage` to the parent via `postMessage` | — (new feature, not a bug fix) |

## Starter suggestion chips (2026-07-08)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/game-suggestions.ts`, `src/components/ChatPanel.container.tsx` (chips) | **`src/lib/game-suggestions.test.ts`** (7 tests, passing) | Pool holds ≥500 unique non-empty game prompts; every entry starts a game ("Make me a … game"); `pickSuggestions` returns 4 distinct pool entries, is rand-injectable/deterministic, safe when count > pool | — (feature, not a bug fix) |

## Preview pane: full-screen + old-game-during-update (2026-07-11)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/preview-pane.ts`, `src/components/ArtifactFrame.tsx`, `src/components/ChatPanel.container.tsx` (artifact swap, expand state) | **`src/lib/preview-pane.test.ts`** (24 tests, passing) | Panel shell classes for split/full-screen incl. the z-[110]-above-nav pin; Esc collapses only when expanded; `nextArtifact` policy (done-with-html swaps, done-without/regenerate/send keep the OLD game, safety retract blanks); `previewDocKey` never collides across game generations; `nextExpandOnManualToggle` — expand/collapse is a deliberate kid action only | BUG-FIX-LOG 2026-07-11 ×2 (round collision; verify restart on new ask); 2026-07-14 (auto-expand-while-loading added); **2026-07-15: removed entirely** — auto-expanding into full screen the instant a fresh game started testing broke the continuity of "I generated this, and here's the game"; the verify cover now shows inline in the normal split view |
| `src/lib/pending-message.ts`, `src/components/ChatPanel.container.tsx` (`runStream`'s 401/`gate` handling, auth-resume effect) | **`src/lib/pending-message.test.ts`** (9 tests, passing) | A sign-in-wall interruption saves the kid's message (text-only); round-trips; 10-min TTL (shorter than `pending-turn.ts`'s 24h — this resumes a keystroke, not a generation); never-throws; malformed/missing-field JSON treated as absent | 2026-07-14 (sign-in wall silently dropped the message) |
| Same files — anything touching the update/verify flow end-to-end | **`scripts/e2e-preview-pane.mjs`** (real browser; needs `npm run dev` + playwright-core, see script header) | Expand/collapse without iframe remount and back to the same width; old game visible + uncovered + updating strip while a change streams; the NEW game actually reaches the iframe after `done` (round-collision class) | BUG-FIX-LOG 2026-07-11 |

## Idea Button + pull-to-resize (2026-07-12, docs/PRD-IDEA-BUTTON.md)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/idea-bag.ts`, `src/components/IdeaBag.tsx`, `src/components/ChatPanel.container.tsx` (ideas state / handleMakeBetter / runStream onSuccess) | **`src/lib/idea-bag.test.ts`** (14) | Store CRUD + caps (50 bagged/convo drops oldest; 400 total prunes non-bagged first); `markSent` flips ONLY that convo's bagged ideas — the bag empties on `done` alone, a failed generation never eats ideas; bundle composition; persistence never-throws | — (feature) |
| `src/lib/idea-mic.ts`, `src/components/IdeaMicTab.tsx` | **`src/lib/idea-mic.test.ts`** (16) | Full tab transition table: stray clicks only slide the tab out; ending a session is always the explicit 🏁 Done/🗑 Never mind (no toggle — kids double-tap); "got" keeps listening (➡️ Next idea, chains a 2nd/3rd idea without re-tapping the tab); fatal mic errors stay visible with the friendly copy. Presentational-only (no test harness): the 2026-07-15 corner ✕ close and the already-saved-ideas preview list. | — (feature) |
| `src/lib/preview-pane.ts` (resize), `src/components/PanelResizeHandle.tsx` | **`src/lib/preview-pane.test.ts`** (23) | `clampPanelWidth` min 360 / max 70vw; width persistence round-trip + never-throw; collapsed shell class carries the `--panel-w` var + `md:relative` | — (feature) |
| `src/lib/idea-coach.ts`, `IdeaMicTab.tsx` (coach/nudge), container coach wiring, globals.css `idea-coach-*` | **`src/lib/idea-coach.test.ts`** (12) + **`scripts/e2e-idea-coach.mjs`** (real browser; needs `npm run dev`) | Intro shows once ever (fail-open on garbage flags) with the voice-over; all three dismissal paths persist `seen`; tab-tap during the intro goes STRAIGHT to listening; wiggle-only re-nudge after 3 idea-less games, exactly once, never after any capture; reduced-motion static + voiced | — (feature) |
| `src/components/ArtifactFrame.tsx` (`panelSize` `ResizeObserver`, Idea Button/Bag overlay sizing) | _(no test harness — the file has no unit tests at all; verify manually: open a fresh game preview in the DEFAULT view — no Tablet/Phone/Laptop frame selected — and confirm the 🎤 mic tab and 🎒 bag chip are visible, not just present in the DOM)_ | The overlay's width/height fall back to JS-measured `panelSize` whenever no device frame is active (the default "fit" mode, reset on every new game) — the `ResizeObserver` populating it must run in EVERY device mode, not only while a frame is shown, or `panelSize` stays `{0,0}` forever and the overlay is invisible | 2026-07-18 ("the idea mic button is not visible") |

## Thinking UX + Gemini 503 fallback (2026-07-11)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/kid-thought.ts`, `src/app/api/chat/route.ts` (thinking events) | **`src/lib/kid-thought.test.ts`** (5) + route T.1/T.2 | Thought summaries pass to the kid ONLY as short clean prose (code/markdown/degenerate → dropped, fail closed); thinking events never leak into the reply text | — (feature; safety-relevant filter) |
| `src/lib/gemini.ts` (replyStream), `src/lib/model-fallback.ts`, `src/lib/builder-mode.ts` | **`src/lib/model-fallback.test.ts`** + **`src/lib/gemini.fallback.test.ts`** (F.1–F.9) + **route R.1** + builder-mode includeThoughts pin | 4-deep fallback chain: capacity errors (503/429), retired ids (404), transient 5xx (500 INTERNAL/502/504) and network drops walk DOWN the chain, one attempt per fallback, primary never in its own chain; a MID-ANSWER death keeps walking and emits one `restart` chunk before the next model's first output (client wipes the partial chat bubble; route resets the accumulator so done/usage never carry wiped text); real defects throw at once and stop the walk; builder turns request thought summaries | BUG-FIX-LOG 2026-07-11 (503 fallback), 2026-07-13 (transient taxonomy + mid-answer restart) |

## Optional 3D via the asset host (2026-07-12, Phase B — re-introduced after the Phase-0 revert; PRD-3D-GAMES-AND-ASSETS)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/assets/inject.ts`, `src/lib/assets/manifest.json` | **`src/lib/assets/inject.test.ts`** (10) | Unmarked games pass through byte-identical; `USES_THREE` → import map maps `three` to the engine's immutable asset-host URL (no base64/data:, Phase-0 embed gone); marker stripped; head/html/prepend placement fallbacks; no-engine manifest throws (route serves raw); reference-ledger URLs reported; STRUCTURAL zero-I/O assertion on the module source (readFileSync-of-unshipped-file class) | BUG-FIX-LOG 2026-07-08 (ENOENT class) |
| `src/lib/assets/prompt-catalog.ts`, `scripts/vendor-three.mjs` (export list), `src/lib/gemini.ts` (prompt) | **`src/lib/assets/prompt-catalog.test.ts`** (11) | 3D prompt teaches EXACTLY the names the vendored bundle exports (lockstep scrape of `THREE_EXPORTS`); `preserveDrawingBuffer: true` renderer rule (§10b R1 — pixel probe reads blank without it); §7 render budget (pixel-ratio cap 2, no shadows/post-processing, 2 lights, low poly); 100dvh + safe-area rules in the base prompt; build turns send base + 3D section | BUG-FIX-LOG 2026-07-12 (dvh regression) |
| `src/app/api/chat/route.ts` (injection block) | **route P.1–P.3** in `src/app/api/chat/route.test.ts` | Injector throws → `done` still carries the RAW artifact (post-processing can never cost the child the game); success → injected html; no artifact → injector never called | BUG-FIX-LOG 2026-07-08 (lost done-event class) |

## Library models + gallery (2026-07-12, Phase C — PRD-3D-GAMES-AND-ASSETS)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/assets/inject.ts` (models path) | **`src/lib/assets/inject.models.test.ts`** (8) | `USES_MODELS` → AR_ASSETS table with exactly the requested urls; loadModel helper injected once and wires setMeshoptDecoder; unknown names drop fail-soft into `result.dropped`; models WITHOUT `USES_THREE` still get the import map (the loader lives in the engine); first-load ≤ 2 MB enforced by dropping overflow assets; no-marker games byte-identical | — (feature; budget = Decision J) |
| `src/lib/assets/prompt-catalog.ts` (models), `src/lib/gemini.ts` | **`prompt-catalog.test.ts`** models describes | Catalog names generated FROM the manifest (lockstep by construction); `USES_MODELS` syntax matches the injector's parser; background `.then` loading taught (async-loop class); null fail-soft taught; AnimationMixer taught; **picks a clip by NAME (run/walk preferred) instead of blindly `animations[0]`** — the dino's clip[0] is an Attack pounce, not Run, so a naively-coded "running" dino hopped/attacked instead (owner report 2026-07-15); empty manifest → empty section (zero tokens); §14 cap: manifest models ≤ 25 | PRD-3D-GAMES-AND-ASSETS.md 2026-07-15 gap note (also flags the internal gallery's own liveliest-clip heuristic never actually fixed this — it picks by array order too, "attack" matches its regex ahead of "run") |
| `src/lib/assets/gallery.ts`, `src/app/assets/page.tsx` | **`src/lib/assets/gallery.test.ts`** (6) | Manifest → cards with kid-readable names; every model card teaches a trigger containing "3d" + the model name; engine never becomes a card; empty manifest → empty lists (page shows its no-blank-screen empty state); every card has an emoji fallback | — |

## Library audio (2026-07-12, Phase D — PRD-3D-GAMES-AND-ASSETS)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/assets/inject.ts` (audio path) | **`src/lib/assets/inject.audio.test.ts`** (9) | `USES_AUDIO` → AR_ASSETS urls + playSound/playMusic helper injected once; audio-only games carry NO import map and NO loadModel (2D games get sound); playMusic is Web-Audio (decodeAudioData + loopStart) and never `new Audio(` (§10b R2 gapless class); unknown names drop fail-soft; per-game audio ≤ 500 KB AND first-load ≤ 2 MB enforced by drops; audio + 3D + models compose into one table | — (R2 = designed-in prevention) |
| `src/lib/assets/prompt-catalog.ts` (audio) | **`prompt-catalog.test.ts`** audio describes | Audio catalog generated FROM the manifest; `USES_AUDIO` syntax matches the injector; playSound-on-events + playMusic-once (never in the loop) taught; hand-rolled Audio/AudioContext forbidden (the helper owns autoplay + looping); fail-soft taught; empty manifest → zero tokens | — |

## Tiered catalog gates (2026-07-12, Phase E — PRD-3D-GAMES-AND-ASSETS §9)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/assets/catalog-gate.ts`, `src/lib/builder-mode.ts` | **`src/lib/assets/catalog-gate.test.ts`** (12) | The §9 decision tree: chit-chat → both catalogs locked on EVERY tier (zero catalog tokens); paid build turn → both unlocked with no keywords; free build turn → `\b3d\b` unlocks 3D only, `\b(sounds?\|music\|songs?\|sfx)\b` unlocks audio only, both independent; word-bounded (no "grade3d"/"musical" false fires); iteration turns keep the catalog via history scan of child messages AND prior artifacts' `USES_*` markers; plain 2D iteration stays locked | — |
| `src/lib/gemini.ts` (`buildTurnSystemInstruction`) | **`prompt-catalog.test.ts`** gate describes | Both gates closed → byte-identical bare child prompt (free + no keyword ≡ today's product); 3D-only → no audio catalog; audio-only → no engine/3D section; default (no gates arg) = fully unlocked paid shape | — |

## Model library fill-out + genre hints (2026-07-12, Phase F — PRD-3D-GAMES-AND-ASSETS)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/assets/prompt-catalog.ts` (GENRE_HINTS), manifest changes | **`prompt-catalog.test.ts`** genre-hint describes | Hints name ONLY models the manifest carries (a hint can never teach a missing model); a genre with no available models disappears; no hints block when nothing matches | — |
| `scripts/vendor-models.mjs` (adding models), `src/lib/assets/gallery.ts` | **`gallery.test.ts`** emoji lockstep + plural | Every curated model name in vendor-models.mjs has its own gallery emoji (scraped, ≥ 20); uncountable names skip the bolted-on s ("3d police") | — |

## Retrieval-lite model selection + 50-model library (2026-07-13 — PRD §14)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/assets/model-select.ts`, GENRES data, manifest growth | **`src/lib/assets/model-select.test.ts`** (10) | Libraries ≤ 30 skip selection (all models, today's behavior); genre keywords pick the subset (city ≠ sea); no match → core set only; explicit name mentions always included; the iterated game's `USES_MODELS` names ALWAYS kept (dropping one breaks the kid's own game); child-history keywords count; hard ≤ 30 per prompt whatever matches; only manifest names ever returned | — |
| `src/lib/gemini.ts`, `prompt-catalog.ts` (context wiring) | **`prompt-catalog.test.ts`** scale-ceiling describes | Context-aware section over the committed manifest ≤ 30 names; manifest sanity ceiling 120 (forces a conscious decision at the next doubling) | 2026-07-14 (50→100 catalog doubling) |

## Multiplayer generation + invite-to-test (2026-07-14 — ../Ariantra-Platform/docs/PRD-MULTIPLAYER.md Phase 4)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/multiplayer-gate.ts`, `src/lib/builder-mode.ts` | **`src/lib/multiplayer-gate.test.ts`** (13) | Independent of `assets/catalog-gate.ts` on purpose (a multiplayer game can be plain 2D/silent): chit-chat locks it on any turn; build-turn keyword triggers (`multiplayer`, `2-player`/`two player`, `co-op`, `versus`/`vs`, "with a/my friend", "play together") unlock it, word-bounded; iteration turns keep it via history scan + a prior `USES_MULTIPLAYER` artifact marker | — |
| `src/lib/multiplayer-prompt.ts` | **`src/lib/multiplayer-prompt.test.ts`** (6) | Teaches the exact `MULTIPLAYER_MARKER` (`<!--USES_MULTIPLAYER-->`); **forbids the model from calling `Ariantra.host()`/`Ariantra.join()` itself** — the injected platform overlay owns those (Phase 3 correction) — and from building its own lobby; teaches ONLY `broadcast()`/`onMessage()`/`onPlayers()` + the host-authoritative pattern; requires the game to work alone before a friend joins | — |
| `src/lib/gemini.ts` (`buildTurnSystemInstruction` multiplayer param) | **`src/lib/gemini.multiplayer-prompt.test.ts`** (4) | The multiplayer gate is a THIRD independent axis alongside `CatalogGates` (three/audio) — defaults true (fully-unlocked/test shape); off + both catalog gates off ⇒ bare child prompt; a plain 2D multiplayer game gets the section with no 3D/audio catalog; a 3D multiplayer game gets both | — |
| `src/components/ArtifactFrame.tsx` (Invite button gating), `src/components/InviteToTest.tsx` | _(component, no dedicated test yet — see KNOWN_BUGS-style note below)_ | The "🎮 Invite" button only renders when `state.currentHtml` contains `MULTIPLAYER_MARKER` — showing it on an ordinary single-player game would be a dead end (no friend session to join) | — |
| `src/app/api/arcade/test-link/route.ts` | **`src/app/api/arcade/test-link/route.test.ts`** (4) | Signed-out ⇒ 401, platform never called; happy path forwards the SSO session + html (**no parent-PIN gate** — deliberately lower-stakes than `/api/arcade/publish`, nothing is published); empty/missing html ⇒ 422; partner secret mismatch ⇒ 502 (not confused with our own error shapes, mirrors BUG-FIX-LOG 2026-07-11's publish-route fix) | — |
| `src/app/api/parent/games/route.ts`, `src/app/parent/page.tsx` (multiplayer toggle) | **`src/app/api/parent/games/route.test.ts`** (6) | List mode is SSO-session-only; the `toggleMultiplayer` mutation additionally requires a PIN-verified parent of THIS family (ownership match — a parent session from another family can never toggle a different family's game, same fix class as `/api/arcade/publish`'s G.3b) | — |

## Server-side chat history (2026-07-13, TECH_DEBT #26)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/db.ts` (SqliteChatHistoryStore), `src/app/api/chats/**`, `src/lib/chat-sync.ts`, `src/lib/chat-history.ts`, `src/components/ChatPanel.container.tsx` (bootstrap effect) | **`db.chat-history.test.ts`** (H.1–H.9) + **`chats.route.test.ts`** (C.1–C.10) + **`chat-sync.test.ts`** (9 tests) | Ownership fail-closed at SQL (foreign id: 404 on read, ignored on write); guest keyed by device cookie; composite (updatedAt,id) cursor never skips same-ms rows; bulk migration idempotent + skips malformed rows; sidebar merge dedupes local vs server entries; `chatToAutoRestore` opens the newest server chat when a device has no local chats at all, never overrides a device's own existing local chats (2026-07-16 — chat history looked lost across browsers); `claim()` reassigns a guest's rows to the account the instant both identities appear on one request (GET `/api/chats`), skips ids the account already owns, no-ops once already claimed, never fires for a guest-only request (2026-07-18 — guest→account merge gap) | 2026-07-16 (cross-browser restore) + 2026-07-18 (guest→account merge gap) |
| `src/lib/chat-store.ts` | **`chat-store.test.ts`** | No arbitrary convo cap; real quota trims oldest-first and never the active chat | BUG-FIX-LOG 2026-07-13 (silent 20-cap eviction) |

## Desktop sidebar collapse + Recents fetch failure (2026-07-17)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/sidebar-pane.ts`, `src/components/Sidebar.tsx`, `src/components/ChatPanel.container.tsx` (`loadMoreRemote`, `sidebarCollapsed`) | **`sidebar-pane.test.ts`** | Collapsed-state persistence round-trips; defaults to expanded on absent/garbage storage; save/load never throw (quota/private mode) | BUG-FIX-LOG 2026-07-17 (Recents "not seen" — silent fetch failure) |

## Resumable generations (2026-07-13, TECH_DEBT #23)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/db.ts` (SqliteTurnResultStore), `src/app/api/chat/route.ts` (turn bookkeeping), `src/app/api/chat/result/route.ts`, `src/lib/turn-resume.ts`, `ChatPanel.container.tsx` (retry path) | **`db.turn-results.test.ts`** (T.1–T.5) + **route RT.1–RT.3** + **`turn-resume.test.ts`** | start→running / done-with-full-reply / error lifecycle; ownership fail-closed; 24h TTL sweep; no bookkeeping without a replyId (old clients); client polls `running` patiently, applies `done` without re-generating, re-generates only on error/404/budget | — (feature; cost + heavy-load resilience) |

## Hedged generation + tab-close recovery (2026-07-13)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/gemini.ts` (hedge race/watchdog), `src/lib/wait-line.ts`, `src/lib/pending-turn.ts`, container bootstrap recovery | **`gemini.fallback.test.ts`** F.10–F.13 + **`wait-line.test.ts`** | Silent model → hedge race (slow model may still win, no restart); first answer token commits, loser abandoned; ONE hedge per turn, both-silent walks the chain; wait line escalates and never freezes; pending-turn bookmark round-trips, 24h TTL, corrupt-safe | — (feature; kid-wait ceiling) |

## Daily screen-time cap + alert (2026-07-15, docs/PRD-SCREEN-TIME-CAP-MVP.md)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/screen-time.ts` | **`screen-time.test.ts`** (9) | `deriveActiveMinutes`: empty→0, single event→tail only, gaps capped at GAP_CAP_MINUTES, an overnight gap doesn't inflate beyond the cap; `utcDayStart` snaps to UTC midnight regardless of time-of-day | — |
| `src/lib/db.ts` (SqliteScreenTimeStore) | **`db.screen-time.test.ts`** (10, in-memory SQLite + fake timers) | Settings round-trip incl. clearing to null; recompute derives minutes from recorded pings (`screen_time_pings`, not `usage_events` — changed same-day, see below); a single ping (short session) still counts; pure-gameplay pings with no chat accrue the same way; crossing the cap alerts exactly once (spy on injected AlertStore); a second same-day recompute doesn't re-alert; a new UTC day resets alert eligibility; no cap set never alerts; a ping from a prior day never counts toward today; `recordPing` prunes past the retention window | 2026-07-15 (real-usage UAT: playing an already-built game showed 0 min — chat-only derivation undercounted pure gameplay to zero, not just "some") |
| `src/app/api/screen-time/heartbeat/route.ts` (new) | **route.test.ts** (4) | Guest → 200 no-op, no tracking; signed-in → records a ping + triggers recompute for that account; falls back to email when no display name; a thrown store error fails OPEN (still 200) | — |
| `src/app/api/chat/route.ts` (screen-time hook after recordUsage) | **route.test.ts SC.1–SC.3** | Signed-in completion records a ping AND triggers recompute with the account id; guest completion does neither; a thrown error from the store fails OPEN (chat response still succeeds) | — |
| `src/components/ScreenTimeHeartbeat.tsx` (new) | _(no component-test harness in this repo — manual UAT only, see PRD §6)_ | Pings every 60s while the tab is open and `visibilityState === "visible"`; an immediate ping on mount so a short session counts before the first tick; a `visibilitychange` back to visible re-pings immediately rather than waiting out the interval; signed-in only | — |
| `src/app/api/parent/screen-time/route.ts` | **route.test.ts** (9) | Parent-session gated (401 unauthenticated) on both GET and POST; GET reflects saved cap + today's tally; POST validates (400 missing field, 422 out-of-range/non-integer), accepts null to clear, round-trips through GET | — |
| `src/app/parent/page.tsx` (cap card) | _(no test harness — manual UAT)_ | "✓ Saved" confirmation appears after a successful save and clears the moment the cap input is edited again; "Current cap: N min/day" always visible, separate from the (possibly unsaved) edit field | 2026-07-15 (UAT: save had no confirmation at all — no way to tell it worked) |
| `Ariantra-Platform/src/lib/auth/return-to.ts` (`isKidgeminiReturnTo`) | **`return-to.test.ts` K.1–K.7** | True for `kidgemini.ariantra.com` (prod) and `localhost:3001`/`127.0.0.1:3001` (dev, kidgemini's own port); false for every other platform host, relative paths, and dev :3000 (the platform's own port); false for garbage input | — |

## Patch-based feature edits (2026-07-18, BUG-FIX-LOG class fix)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/history-trim.ts` (`findLastGameIndex`) | **`history-trim.test.ts`** (new cases, 10 total) | The exported "which message holds the current game" rule: -1 with no game, the newest index when several exist, child-pasted HTML never counts. Pure refactor of existing private logic — `trimHistory`'s own behavior unchanged | 2026-07-18 |
| `src/lib/game-edit.ts` (`isGameEditTurn`, `currentGameHtml`, `editReplyProse`, `GAME_EDIT_PROMPT_SECTION`, `looksLikeAttemptedEdit`, `looksLikeCompleteDocument`) | **`game-edit.test.ts`** (21 tests, passing) | Edit detection is false with no prior game, true (deliberately as over-inclusive as `isGameBuildTurn`) once one exists, and follows an active "Continue from here" pin over the newest game; locates the (possibly pinned) game's source; splits the kid-facing sentence from the raw hunks, defaulting to a friendly line when the model left none; the prompt section carries the SEARCH/REPLACE format, the "change only what's needed" preserve rule, and the off-topic hedge; `looksLikeAttemptedEdit` tells a malformed/truncated patch attempt apart from genuine off-topic chat; `looksLikeCompleteDocument` rejects a partial snippet masquerading as a full game | 2026-07-18 ("medic kit" regressed unrelated game parts); 2026-07-18 follow-up ("multiple blocks and not working code") |
| `src/lib/gemini.ts` (`buildTurnSystemInstruction` isEdit param, `configFor`) | **`gemini.edit-config.test.ts`** (6 tests, passing) | `isEdit=true` appends `GAME_EDIT_PROMPT_SECTION` without dropping the base child-safety prompt; a fresh build (no game in history) never gets it; a follow-up on an existing game does, verified against the real mocked Gemini call's `systemInstruction` | 2026-07-18 |
| `src/lib/gemini.ts` (`GeminiChatModel.reply` `forceFullRegen`, usage, `oneShotWithFallback`) | **`gemini.reply.test.ts`** (4 tests) + **`gemini.oneshot-fallback.test.ts`** (5 tests) | `forceFullRegen:true` bypasses the edit instruction even with a game in history (the patch-fallback path must get a full file back); real billed usage is returned when Gemini reports it, same pattern as `repair()`; `reply()`/`repair()` walk the same model-fallback chain `replyStream()` already has, so a bad/unavailable primary model doesn't dead-end the patch-fallback or self-heal path | 2026-07-18; 2026-07-18 follow-up (fallback dead-end on misconfigured model) |
| `src/app/api/chat/route.ts` (patch branch, `applyPatch` from `repair-prompt.ts`, `looksLikeAttemptedEdit`/`looksLikeCompleteDocument` guards) | **`route.test.ts`** "patch-based feature edits" (7 tests, passing) | A clean SEARCH/REPLACE reply patches ONLY the matched hunk — the rest of the source is byte-for-byte identical (the actual regression test for the reported bug); a "Continue from here" pin targets an earlier game version even with a newer one in history; an off-topic reply (no patch, no full doc) passes through as ordinary chat with the game untouched and **no** fallback call wasted; a truncated/malformed patch attempt never leaks raw `<<<<<<<` markers into the chat; a partial snippet mistaken for a full document never becomes the new game; a genuinely mismatched patch attempt falls back to exactly ONE full-regeneration call (`forceFullRegen: true`), never a dead end; a fresh build with no prior game never touches the patch/fallback path at all | 2026-07-18 ("medic kit" regressed unrelated game parts); 2026-07-18 follow-up ("multiple blocks and not working code") |
| `src/app/api/chat/route.ts` (strict-retry branch, honest rebuild lines) + `src/lib/gemini.ts` (`strictEditRetry`) | **`route.test.ts`** "patch-based feature edits" (5 more tests, 12 total) | A full-rewrite reply on an edit turn triggers exactly ONE hunks-only retry — a clean retry patch wins and the rewrite is discarded; `NEEDS_FULL_REBUILD` accepts the rewrite with the model's own prose (never raw code in the chat); a retry failure/throw never dead-ends — the rewrite is delivered with the honest `REBUILT_GAME_LINE`; the fallback regeneration substitutes `REBUILT_GAME_LINE` for the bare fresh-build default; `GAME_EDIT_PATCH=off` restores exact pre-patch routing (no patch machinery, no retry, no fallback) | 2026-07-18 penguin-maze session (17 of 18 edit turns silently rewrote the whole game) |
| `src/lib/game-edit.ts` (`patchEditsEnabled`, `isRepeatedRequest`, `regenReplyProse`, `REBUILT_GAME_LINE`/`FRESH_GAME_LINE`, `GAME_EDIT_STRICT_RETRY_SECTION`, `REPEATED_REQUEST_SECTION`) | **`game-edit.test.ts`** (13 more tests, 34 total) | Kill switch: default-on, disabled only by the literal `off`, and `GAME_EDIT_PATCH=off` makes `isGameEditTurn` false even with a game in history; repeat detection is whitespace/case-insensitive against the last child message, never true for blank input; the strict-retry contract demands hunks-only, forbids a full document, and carries the `NEEDS_FULL_REBUILD` honest-out; `regenReplyProse` keeps the model's prose, never leaks fences/HTML, and falls back to the honest rebuilt-game line for code-only replies | 2026-07-18 penguin-maze session |
| `src/lib/history-trim.ts` (`hasGame` field-first, `withInlineGame`) | **`history-trim.test.ts`** (5 more cases, 19 total) | A prose-only assistant message carrying `artifactHtml` counts as the current game; its source is re-inlined into the text the model sees (byte-identical to `applyPatch`'s target); stale prose-only versions still collapse to the placeholder; a pin on a prose-only message wins and re-inlines; code already in text is never double-inlined | 2026-07-18 (`search_not_found` on every edit turn; 3D game regenerated as 2D from a stale version) |
| `src/lib/game-edit.ts` (`streamingDisplayText`, `EDIT_STREAM_WORKING_LINE`) + every partial `setReply` in `ChatPanel.container.tsx` | **`game-edit.test.ts`** (4 more cases, 38 total) | Plain prose streams through unchanged; text is cut at the first `<<<<`-run with prose kept plus the friendly working line; a PARTIAL marker at the stream tail is hidden; a hunks-first reply shows only the working line | 2026-07-18 (raw SEARCH/REPLACE hunks streamed live into the chat bubble) |
| `src/lib/speech-transcript.ts` (`dropReplayedPrefix`, `freshSegments`) + `useSpeechInput.ts` committed-texts record | **`speech-transcript.test.ts`** (5 more cases, 21 total) + **`scripts/e2e-mic-dictation.mjs`** (14 real-browser checks: supported detection, listening states, live interim, final commits, both replay classes, interim flush, auto-restart, restart race, stop, error banner) | A ≥2-segment replay of already-committed finals after a counter reset is dropped; a single repeated phrase is NOT deduped (kids repeat themselves); fresh speech passes untouched; omitted committed-texts keeps old behavior; the onend interim flush is recorded so a stale list can't re-deliver it | 2026-07-18 repeat-mic take 3 ("mic is not good", Chrome/HP laptop) |
