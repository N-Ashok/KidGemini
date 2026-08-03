# PRD — Save & continue building (physics/building games)

**Status (2026-08-03): Phases 1 and 2 shipped — feature is live end-to-end.**

**Phase 1 (backend foundation):** types (`src/types/game-save.types.ts`), the
`game_saves` table + `SqliteGameSaveStore` (`src/lib/db.ts`), validation
(`src/lib/game-save.ts`), the `PUT`/`GET` `/api/game-save` route, and the
prompt clause (`src/lib/assets/save-state-playbook.ts`, §3a).

**Phase 2 (wiring):**
- **Gate:** `gates.save` in `src/lib/assets/catalog-gate.ts` — a new
  keyword/artifact gate (build/stack/place/inventory/world/city/base, or a
  prior artifact carrying the `SUPPORTS_SAVE` marker or the postMessage
  protocol strings), same shape as `gates.three`/`gates.audio`. Wired into
  `buildTurnSystemInstruction()`; `docs/PROMPT_MANAGEMENT.md` §2.5 and
  `docs/COST_TOKEN_BUDGET.md` updated in the same change.
- **Parent-side protocol:** `src/lib/game-save-channel.ts`
  (`GameSaveChannel`, modeled on `PreviewVerifyController`) + injection
  (`src/lib/game-save-inject.ts`, `injectInitialGameState`, reusing
  `escapeForInlineScript`/`insertEarly` extracted from `preview-runtime.ts`
  into `runtime-helpers.ts` for both to share).
- **React wiring:** `src/components/useGameSaveChannel.ts` (existing-save
  lookup, autosave interval, decision state) wired into `ArtifactFrame.tsx`,
  which gained a "Continue your build? [Start fresh] [Continue]" bar and
  `conversationId`/`messageId` props (keyed via the new
  `src/lib/current-game-message.ts`, shared with the Community Help ticket
  path).
- **Cascade delete:** `SqliteChatHistoryStore.softDelete` now cascades into
  `game_saves` transactionally (docs/SCALABILITY_ISSUES.md #8) — landed with
  this phase rather than deferred again.
- **Verified live** in a real browser (`scripts/e2e-game-save.mjs`): banner
  visibility, Continue injecting `__ARIANTRA_INITIAL_STATE__`, Start Fresh
  leaving the running game untouched, and marker-gating (no API calls for a
  non-save game) — all pass. Screenshot taken for the visual pass.

**Not built:** the 30s autosave tick's live timing isn't exercised by an
automated test (mocking a real interval in a headless browser was out of
scope for this pass) — the request/response correlation it depends on
(`GameSaveChannel`) is fully unit-tested instead. Publish/Arcade save state
remains out of scope (§8).

**Date:** 2026-08-01 · **Owner ask:** *"presently a building game like physics
world don't have a way for a player to save and come back and continue
building."* · **Owner decisions (recorded from the 2026-08-01 session):**
autosave on an interval (no manual Save button required); state lives in a
new dedicated `game_saves` table, not on the conversation's message blob;
scope for this PRD is the **in-chat draft** (Ari's own sandboxed preview,
`ArtifactFrame.tsx`) — the **published/Arcade** case is a related but
separate concern, noted as out of scope below.

## 1. Problem

A kid building something stateful — a physics building/stacking game, a
world with placed blocks, a score/inventory — has no way to leave and come
back to the same in-progress state. Reopening a chat re-renders the same
`artifactHtml` from scratch: the generated game boots fresh every time.
Nothing captures runtime state (object positions, placed pieces, score)
anywhere; only the generated *source code* is durable today.

## 2. Tech Feasibility

**The generated game's document lives in an iframe with `sandbox="allow-scripts"`
and no `allow-same-origin`** (`ArtifactFrame.tsx`, deliberate — see file's own
top comment). That means the document's origin is opaque: `localStorage`,
`sessionStorage`, `indexedDB`, and cookies are all unavailable *inside* the
game itself. The only channel out of the sandbox today is one-way
`postMessage` to the parent (already used for console capture, perf probes,
and preview self-verification — `game-console.ts`, `preview-verify.ts`,
`assets/perf-probe.ts`). So state cannot be saved by the game; it must be
**requested out** via `postMessage`, held by the parent app, and **injected
back in** as a global before the game's own script runs next time — the same
injection pattern `preview-runtime.ts` already uses for the preview SDK
bundle and theme global. No new engine, no schema-breaking change; this is a
new small protocol plus one new table.

**Not every generated game will implement the contract.** The LLM must be
taught it, the same way `physics-playbook.ts` teaches motion rules and gates
the physics-engine clause behind a manifest marker
(`docs/2026-07-29_PRD_Physics.md`). We reuse that shape: a prompt clause
teaches the save contract, and a literal marker comment in the generated HTML
(`<!--SUPPORTS_SAVE-->`) tells the parent, deterministically, whether to show
any save/continue UI at all — no runtime guessing, no silent timeouts.

## 3. Tech Plan

**3a. Prompt contract** (`src/lib/assets/save-state-playbook.ts`, new,
mirrors `physics-playbook.ts`'s shape) — teaches the model, when a game has
meaningful build/world state worth persisting:

- Implement `window.addEventListener("message", ...)` handling a
  `{type: "ariantra:request-save"}` request from the parent, and reply with
  `parent.postMessage({type: "ariantra:save-state", payload: <JSON-safe object>}, "*")`.
- **The payload must represent the whole persistent world, not the player's
  current position or viewport.** For a game with a single build area this is
  a flat list of placed objects; for a game where the player can travel and
  build in multiple distinct areas (a "build your universe" style game), the
  payload must include every area the player has built in, each keyed by its
  own world coordinates or an area ID — not just whichever area the player
  happens to be standing in when autosave fires. Each object in that list
  carries its own position (and rotation/type/color/whatever else defines it)
  so the restore step can place it back exactly, e.g.:
  ```json
  { "areas": [
      { "id": "city-1", "originX": 100, "originZ": 200,
        "objects": [{ "type": "block", "x": 12, "y": 0, "z": 4, "rotation": 0 }, ...] },
      { "id": "city-2", "originX": 5000, "originZ": 8000, "objects": [...] }
  ] }
  ```
  The prompt clause states this rule explicitly (with the two-area example
  above) so the model doesn't default to a narrower "save what's on screen"
  implementation, which would silently lose every area other than the last
  one visited.
- On boot, check `window.__ARIANTRA_INITIAL_STATE__` (injected by the parent
  before the game's own script tag, same slot `preview-runtime.ts` uses) and
  restore **every** area from it if present — not just the closest one to
  spawn — instead of starting from defaults.
- Emit the literal marker `<!--SUPPORTS_SAVE-->` in the HTML if (and only if)
  both handlers are actually implemented — this is what turns the feature on
  client-side; it is never inferred by keyword-matching generated code.
- Clause is only added to the system prompt for games the existing
  prompt-gating logic already classifies as build/world/inventory-style (not
  a runner or a quiz) — cost-gated the same way the physics engine clause is
  gated on the 3D marker, so it doesn't tax every turn's token budget.

**3b. Parent-side protocol** (`src/lib/game-save-channel.ts`, new) —
request/response wrapper around `postMessage`, modeled on
`preview-verify-controller.ts`. `ArtifactFrame.tsx` only activates it when the
rendered HTML contains `<!--SUPPORTS_SAVE-->`.

**3c. Autosave scheduling** — while the artifact is mounted **and** the tab
is visible (reuse the existing frame-governor visibility signal that already
pauses rendering when hidden), request state every 30s. A response is
debounced server-side to at most one write per 15s per message, to guard
against a misbehaving client hammering the write path.

**3d. Storage — new `game_saves` table** (`src/lib/db.ts`):

```
CREATE TABLE game_saves (
  id           TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  messageId    TEXT NOT NULL,
  userId       TEXT NOT NULL,
  stateJson    TEXT NOT NULL,      -- capped, see §6
  createdAt    INTEGER NOT NULL,
  updatedAt    INTEGER NOT NULL,
  UNIQUE(conversationId, messageId)
)
```

One save slot per artifact message — autosave overwrites in place, no
versioned history. Regenerating the game (a new message, e.g. via "Continue
from here") naturally starts a fresh slot; it never inherits or clobbers an
older message's save.

**3e. API** — `src/app/api/game-save/route.ts` (new): `PUT` upserts
`{conversationId, messageId, stateJson}` (auth-scoped to the session's
`userId`, same identity resolution every other API route uses); `GET
?messageId=` returns the saved state or 404. Size-capped (see §6); oversized
payloads are rejected with a typed error, not silently truncated.

**3f. Resume flow** — when `ArtifactFrame` renders a message whose HTML
carries `<!--SUPPORTS_SAVE-->`, it checks for an existing save. If found, it
does **not** silently resume (a kid reopening a game to unexpectedly-full
build state is a surprise, against the house UX bar) — it shows a small
"Continue your build?" banner with **Continue** / **Start fresh** actions.
Continue injects `__ARIANTRA_INITIAL_STATE__` before the srcDoc script runs;
Start fresh boots normally and leaves the old save row untouched (next
autosave overwrites it).

## 4. Use Cases

| # | Use case | How tackled |
|---|---|---|
| 1 | Kid stacks blocks in a physics tower game, closes the tab, reopens the chat later | Autosave captured state within the last 30s; "Continue your build?" banner restores it |
| 1b | Kid builds a small city, travels elsewhere in the world, builds a second city | Save payload holds every area (each object's own position, keyed to its area), not just the area the kid is currently standing in; restore recreates all areas, not just the last one visited |
| 2 | Kid regenerates the game via "Continue from here" (new source code) | New message = new save slot; old save is orphaned, not applied to the new code |
| 3 | Game doesn't implement the save contract (LLM didn't emit `SUPPORTS_SAVE`) | No banner, no autosave requests fired — feature is invisible, not broken |
| 4 | Kid wants to discard progress and start over | "Start fresh" ignores the existing save; old row is silently overwritten on next autosave |
| 5 | A kid's build state is huge (thousands of placed objects) | `stateJson` capped (§6); oversized saves are rejected server-side with a typed error, game keeps playing, just stops persisting until state shrinks |
| 6 | Published/Arcade game — a friend plays a launched building game and wants their progress saved | **Out of scope for this PRD.** The published game is served by the sibling `Ariantra-Platform` repo, not this one — see §7 |

## 5. Test list

- `save-state-playbook.test.ts` — contract clause is pinned, gated correctly
  (only build/world-style games), static/no-interpolation (cache contract),
  own token budget test.
- `game-save-channel.test.ts` — request/response postMessage wrapper, timeout
  handling when a game never replies, marker-gating (`SUPPORTS_SAVE` absent
  ⇒ channel never activates).
- `game-save.route.test.ts` (integration) — auth scoping (can't read/write
  another user's save), upsert semantics, size-cap rejection, 404 on missing
  save.
- `db.game-saves.test.ts` (unit) — schema, unique constraint on
  `(conversationId, messageId)`, cascade/cleanup on conversation soft-delete.
- Regression: `ArtifactFrame` injection-order test confirming
  `__ARIANTRA_INITIAL_STATE__` injection doesn't disturb the existing
  preview-runtime SDK/theme-global injection it sits alongside.

## 6. Scalability note (§10 hard-stop, addressed inline)

One row per artifact message that both implements the contract and has
autosaved at least once — bounded by usage, not unbounded by construction,
but **not currently cleaned up** when a conversation is soft-deleted or ages
out. Cap `stateJson` at **1.5 MB**, not the 200 KB first floated earlier in
this session — a single-area game might need a few KB, but a multi-area
"build your universe" world (§3a) accumulates one entry per object across
every area the kid has ever built, and undercapping it means a kid's second
or third city silently stops saving while the first one keeps working, which
is a worse and more confusing failure than a single clear limit. On a
same-origin write rejection (cap exceeded), the game keeps playing — the
error surfaces as a friendly, kid-facing "your world got too big to save
more, but everything so far is safe" message, never a silent drop. Add a
`game_saves` row-count **and** average-row-size metric to watch. **Trigger to
revisit:** table exceeds ~5% of DB file size, or a support ticket reports a
save being rejected near the cap for a normal-sized build. **Plan:** add a
cascade delete on `conversations` soft-delete (same transaction), and a
nightly GC sweep for `game_saves` rows whose parent conversation no longer
exists — both are additive, no migration risk, deferred out of this PRD's
first cut and logged in `docs/SCALABILITY_ISSUES.md`.

## 7. Server load on the autosave write path

**Architectural facts (verified in this repo, not estimated):** this app runs
as a single Node process on a shared 1GB EC2 box; `better-sqlite3` executes
writes **synchronously** on that process's one JS thread; per the deploy
runbook, exactly one instance may run against the SQLite file — there is no
horizontal scaling to spread writes across. A large payload landing on this
path blocks that same thread that's serving `/api/chat`, `/api/*` and every
other request for the duration of the write.

**No current-scale traffic numbers are used here on purpose.** This app's
real concurrent-usage figures are not something to look up as part of this
PRD — the owner has asked that the database and logs not be inspected for
this. So this section makes no claim about how many kids build concurrently
today or at any future date; sizing this from a guessed number would be
worse than not sizing it at all.

**What follows from the architecture alone, independent of traffic volume:**
throughput (writes/sec) is very unlikely to be the bottleneck at any scale —
SQLite handles far more small writes/sec than this feature could plausibly
generate given the 15s per-message debounce (§3c). The actual risk is
**payload size**, because a synchronous write's blocking duration scales with
how much JSON it's serializing — many small concurrent writes are cheap;
frequent large ones (approaching the 1.5MB cap, §6) are the failure mode that
would compete with chat latency on the shared thread.

**What ships instead of a numeric sizing:** a metric, not a guess.
Instrument `game_saves` writes with latency (and correlate against
`/api/chat` p95 latency) once this is live. **Trigger to revisit:** if
autosave write latency or its correlation with chat-latency degradation
crosses a noticeable threshold in real production metrics — at that point,
move writes off the synchronous hot path (e.g. an in-memory debounce/queue
that flushes on its own timer instead of per-request, or a dedicated
write-behind connection) rather than doing it speculatively now.

## 8. Out of scope — published/Arcade game save state

A **published** game is a frozen, permanent static snapshot served by the
sibling `Ariantra-Platform` repo (`games.ariantra.com`) — this repo only
holds a pointer (`Conversation.editSlug`). That platform may not even be
constrained by the sandboxed-iframe restriction documented here (it's a
separate service, possibly full-page, not `srcdoc sandbox`), so its save
mechanism could look completely different (e.g. real `localStorage`, or its
own DB-backed save). Implementing that is a change to `../Ariantra-Platform`,
not this repo — flagged in that repo's `docs/TECH_DEBT.md` as a follow-up,
not built here.
