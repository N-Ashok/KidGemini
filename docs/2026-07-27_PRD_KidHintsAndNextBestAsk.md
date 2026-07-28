# PRD: Kid Hints & Next-Best-Ask in Ari Chat

**Status:** Next-ask chips built 2026-07-28, behind `NEXT_PUBLIC_ENABLE_KID_HINTS`
(default OFF) — see `docs/FEATURES.md`'s "Next-ask chips" entry for the as-built design,
which diverged from this PRD's original idle-timer trigger. As built: fires after every
BUILD and every EDIT; suggestions come from the model itself (contextual to the game on
screen) via a trailing sentinel line, with a static "change this game" pool
(`tweak-suggestions.ts`) only as the fallback.

Two bugs found during owner UAT and fixed the same day (BUG-FIX-LOG 2026-07-28): the
fallback originally served brand-new-game STARTERS after an edit ("Make me a flying game
with monkeys 🐵" under a turtle memory game — unrelated, and destructive when tapped),
and internal retry/regeneration calls could silently inherit the suggestion instruction.

Remaining PRD scope (post-build goal/controls hint, idle nudge, post-publish hint,
multiplayer-invite hint, returning-kid hint) is NOT built — still a design doc for
those. Owner UAT + flag flip still pending.
**Owner surface:** Ari chat panel + preview pane (`Game` repo — `ChatPanel.container.tsx`,
`preview-pane.ts`, `multiplayer-gate.ts`).

## 1. Problem

Ari gives a kid four starter-suggestion chips on the very first turn
(`ChatPanel.container.tsx:1401-1413`, pool in `game-suggestions.ts`) and then goes quiet.
Once a game is built and sitting in the preview pane, nothing in the chat tells the kid:

- what the goal of the game they just built actually is, or how to control it
- what to try next if they're just sitting there playing (or stuck)
- that they could publish it, or what happens if they do
- (once multiplayer ships) that they can invite a friend, or how
- how far they could actually push their own idea — kids tend to stop at the first
  working version instead of imagining a bigger or weirder one

Kids either give up, ask a parent, or churn. This PRD defines a **hints / next-best-ask
system**: short, in-chat, kid-friendly nudges that fire at specific moments, written in
Ari's voice.

## 2. Goals

1. A kid never faces a dead-end turn — there is always a next thing to try or tap.
2. Hint UI never overlaps or steals clicks from the standard SDK overlay buttons
   (leaderboard, high score, menu) that appear on the played game.
3. Works correctly on mobile, where chat and the live game are never on-screen together.
4. Multiplayer gets its own next-best-ask copy, designed now against the existing
   (unshipped) multiplayer detection so it's ready the moment Phase 0 (TURN) lands.
5. Ships dark by default behind a feature flag, so it can be soft-launched and tuned
   before every kid sees it.
6. Beyond mechanical next-steps ("add a power-up"), hints also spark **imagination** —
   open-ended "what if" prompts that invite a kid to reimagine or push their idea
   further, not just extend it.

## 3. Non-goals

- Not redesigning or touching the SDK overlay buttons themselves
  (`leaderboard-overlay.ts`, `menu-overlay.ts`) — those are out of scope; this PRD only
  guarantees the new hint UI stays out of their way.
- Not building multiplayer transport/matchmaking — that's `PRD-MULTIPLAYER.md`'s Phases
  0–4. This PRD only adds the *hint copy* that fires once a game is known to use it.
- Not a personalization/ML system — hints are a small, curated, rule-triggered copy
  pool, same spirit as `game-suggestions.ts` today.

## 4. Tech Feasibility

- **Rendering surface already exists.** Today's starter chips render as normal in-flow
  `<button>` pills inside the scrollable chat message list
  (`ChatPanel.container.tsx:1401-1413`, `flex flex-wrap gap-2 pt-2`) — not
  `position:fixed`, no z-index games. New hints reuse this exact pattern: they are chat
  content, not an overlay layer. This structurally rules out any collision with the SDK
  overlay buttons, which live at `position:fixed; right:14px; z-index:2147483000`
  (`Ariantra-Platform/src/lib/publish/seo.ts:257-280`, mirrored in the preview mock per
  `PRD-PREVIEW-WYSIWYG.md`) — different stacking context, different corner, never
  touched by chat-column content.
- **Multiplayer detection already exists.** `multiplayer-gate.ts`'s `multiplayerGate()`
  and `ensureMultiplayerMarker()` (called from `api/chat/route.ts`'s `toDeliverable`)
  already know, per delivered game, whether it genuinely uses the multiplayer SDK. The
  multiplayer hint reuses this signal — no new detection logic needed.
- **Mobile is already handled structurally, not incidentally.** `preview-pane.ts:35-38`
  makes the preview `fixed inset-0` (full-screen takeover) on mobile and a static
  440px side panel only at the `md:` breakpoint. Chat and the live game/overlays are
  **never visible at the same time on a phone.** Because hints are chat content, they
  simply appear in the chat view a kid sees whenever they're not full-screen on the
  game — no separate mobile design or breakpoint work required, but this must be
  called out explicitly so nobody later tries to draw a hint bubble on top of the
  full-screen mobile preview (that would need its own overlay stacking work and is
  out of scope here).
- **Feature flag.** A single boolean gates all hint rendering, added to
  `Game/.env.example` (not a real secret, just a rollout switch, so `NEXT_PUBLIC_` is
  fine — matches the existing `NEXT_PUBLIC_PREVIEW_REPAIR` pattern):

  ```
  # ── Kid hints / next-best-ask (2026-07-27 PRD) ───────────────────────────────
  # Gates the in-chat hint/next-best-ask chips (post-build, idle, imagination-spark,
  # post-publish, multiplayer-invite). Default OFF until copy is UAT'd with real kids.
  # NEXT_PUBLIC_ENABLE_KID_HINTS=0
  ```

  Every trigger point below checks this flag client-side before rendering; server-side
  logic (e.g. multiplayer marker detection) is unaffected by the flag either way, since
  it's cheap and already runs regardless.

## 5. Tech Plan

Five trigger points, all rendered as chat-column chips/messages (never as an overlay on
the preview iframe):

| Trigger | Fires when | Where the signal comes from |
|---|---|---|
| **Post-build hint** | A new game finishes building (first successful build of a chat session) | Existing build-completion event in `ChatPanel.container.tsx`; one-shot, not repeated on edits |
| **Idle hint** | Kid has been playing (preview open, no chat input) for ~45–60s with no new message | New client-side idle timer, reset on any chat send or preview reload |
| **Imagination-spark hint** | Every 2nd–3rd idle/post-build hint slot (alternates with the mechanical idle hint so it doesn't feel like a quiz) | Same idle timer as above; picks from a separate "what if" copy pool, not `game-suggestions.ts`'s mechanic pool |
| **Post-publish hint** | Kid publishes to Arcade (`PublishToArcade.tsx` success) | Existing publish-success callback |
| **Multiplayer-invite hint** | `ensureMultiplayerMarker`/`multiplayerGate` confirms the delivered game uses multiplayer | Existing marker check in `api/chat/route.ts`'s `toDeliverable` — surfaced to the client alongside the delivered message |

All five are additive: they render as extra chips/short assistant lines under the
feature flag, they don't replace or reflow the starter-suggestion chips, and they don't
touch anything inside the preview iframe.

**Imagination-spark pool is deliberately separate from the mechanic pool.** The idle
hint (6.2) offers a concrete, buildable next step ("add a boss"). The imagination-spark
hint instead asks an open "what if" question aimed at the game's *theme or story*, not
its mechanics — e.g. reskinning the world, giving the hero a personality quirk, or
imagining an ending. Keeping them in separate pools, alternating on each idle/post-build
slot, avoids two failure modes: an all-mechanical feed that trains kids to only ever ask
for feature bolt-ons, or an all-whimsical feed that never nudges them toward something
they can actually tap and get.

**Idle-timer tuning and copy-pool size** are the two scale ceilings for this feature
(CLAUDE.md rule #8): if the idle threshold is too short it'll nag kids mid-thought; if
the hint copy pool per trigger is too small (start with 3–5 variants per trigger,
matching `game-suggestions.ts`'s randomize-on-load pattern) it'll feel repetitive on
replay. The imagination-spark pool needs its own 3–5-variant minimum on top of the
mechanic pool (start with theme-swap, character-quirk, villain-twist, and "theme song"
prompts as in §6.7) so alternating idle slots don't start repeating within one play
session. Revisit both once UAT/analytics show real dwell times and repeat-session counts.

## 6. Use Cases

Each entry: **Trigger → what Ari shows → the kid's likely next tap.** Copy is draft —
final wording gets a kid-UAT pass before flag flip.

### 6.1 First build of a simple single-player game (goal + controls hint)
- **Trigger:** post-build, first successful build this session.
- **Ari shows** (as a short assistant line above the chip row, not a new bubble wall):
  > 🎮 Your game's ready! **Goal:** dodge the falling stars and grab the coins.
  > **Controls:** arrow keys (or swipe) to move.
  Chips: `"Make it faster"` · `"Add a power-up"` · `"Change the background"`
- **Kid action:** taps a chip, or just plays.

### 6.2 Idle mid-play, no changes requested (gentle nudge)
- **Trigger:** idle timer (~50s of play, no chat activity).
- **Ari shows:**
  > Having fun? Try asking me: **"Can you add a boss at the end?"** 🐉
- **Kid action:** taps the suggestion or types their own idea.

### 6.3 Vague/stuck message ("it's not working")
- **Trigger:** kid sends a low-signal message after a build (heuristic: short message,
  no specific noun/verb match, immediately following a build).
- **Ari shows:**
  > Tell me more so I can fix it! Is it: `"The game won't start"` ·
  > `"I can't move my character"` · `"It looks broken"`
- **Kid action:** picks the chip closest to the real problem, giving Ari a concrete
  next prompt instead of a dead-end reply.

### 6.4 Game published to Arcade (encouragement + share)
- **Trigger:** publish success.
- **Ari shows:**
  > 🌟 Nice work — your game is live! Want to `"Add a leaderboard message"` or
  > `"Make a poster for it"`?
- **Kid action:** taps a chip to keep building, or shares the published link (existing
  share flow, unchanged).

### 6.5 Multiplayer game detected (invite-a-friend) — forward-looking
- **Depends on:** multiplayer Phase 0 (Cloudflare TURN) and Phases 1–4 shipping; this
  copy is designed against the existing `multiplayer-gate.ts` marker so it's ready to
  wire up the moment multiplayer play is live. Do not enable this trigger until then.
- **Trigger:** `ensureMultiplayerMarker` confirms `USES_MULTIPLAYER` on the delivered
  game.
- **Ari shows:**
  > 🎉 This one's made for two! Want to `"Invite a friend to play"` or
  > `"Add a 2-player scoreboard"`?
- **Kid action:** taps invite, which hands off to the platform's lobby/invite flow
  (owned by the SDK overlay — Ari's hint only surfaces the option, never re-implements
  `host()/join()`).

### 6.6 Returning kid reopening an old game
- **Trigger:** kid reopens a chat session with existing build history (not a fresh
  session) and the preview loads an already-built game.
- **Ari shows:**
  > Welcome back! Last time you were working on your **[game name]**. Want to
  > `"Add something new"` or `"Just play it"`?
- **Kid action:** picks up editing, or dismisses into free play (no forced action).

### 6.7 Imagination spark (open-ended "what if")
- **Trigger:** alternates with the idle hint (6.2) on idle/post-build slots — every
  other firing uses the imagination pool instead of the mechanic pool.
- **Ari shows** (rotates across sessions, not the same one twice in a row):
  > What if your whole game happened **underwater**? 🌊
  >
  > What if your character had a secret power they didn't know about yet? ✨
  >
  > What if the "bad guy" wasn't bad at all — just misunderstood? What would that
  > change?
  >
  > If your game had a theme song, what would it sound like? Want to describe it to me?
- **Kid action:** replies with their own idea in free text (no chip needed — the point
  is to open up imagination, not funnel to one preset build), which Ari then turns into
  a concrete build the same way any other chat message does.

### 6.8 Bible-teacher persona variant
- **Trigger:** any of the above, when the active session is in the bible-teacher
  persona (separate suggestion pool already exists in `game-suggestions.ts`).
- **Ari shows** (tone matches persona, same trigger points):
  > 🕊️ Great job! **Goal:** guide David past the obstacles to reach Goliath.
  > Want to `"Add a Bible verse when you win"` or `"Make the hero jump higher"`?
- **Kid action:** same chip-tap pattern; only the copy/theme differs, not the mechanism.

## 7. Rollout

1. Build behind `NEXT_PUBLIC_ENABLE_KID_HINTS` (default `0`).
2. Enable in local/staging only; run through all use cases in §6 manually.
3. Kid-facing screenshot/UX pass per CLAUDE.md rule #9 before flipping the flag for any
   real traffic.
4. Flip to `1` only on an explicit go-ahead — this PRD does not authorize enabling it.

## 8. Open questions for owner review

- Exact idle-timer duration (starting guess: 45–60s) — needs real dwell-time data or a
  judgment call before UAT.
- Whether the "vague/stuck" heuristic (6.3) needs a lightweight classifier or a simple
  keyword/length rule is enough to start.
- Where multiplayer invite (6.5) actually hands off once the platform's invite/lobby UI
  exists — this PRD assumes it reuses the existing overlay-owned `host()/join()`, but
  the exact tap target isn't built yet.
