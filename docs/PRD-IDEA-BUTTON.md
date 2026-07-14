# PRD — Idea Button: speak-while-you-play feedback capture

Status: **implemented 2026-07-12** (this doc reviewed against code).
Mock + kid-experience narrative reviewed with owner before build.

## 1. Problem

Kids find bugs and get ideas WHILE playing a game in the preview — but the
personas (≈6–12, many pre-readers) can't type, and the chat composer is hidden
exactly when they play: ⤢ full screen on laptop, the game screen on mobile.
Today a kid must abandon the game to say anything; most just give up.

## 2. Solution (what shipped)

1. **🎤 Edge-docked mic tab** (`IdeaMicTab.tsx`) over the preview
   (`ArtifactFrame`). Docked near the TOP of the right edge, fully visible
   with a persistent "Idea" label (2026-07-14: a half-tucked, hover-only-tooltip
   version was effectively invisible on touch devices — kids never found it) —
   drag up/down to reposition if a game's own HUD needs that corner instead.
   First click slides it out,
   second click listens — a stray click is harmless (state machine in
   `src/lib/idea-mic.ts`, fully unit-tested). The game keeps running and keeps
   keyboard focus. Live interim words + pulsing red dot (pre-reader trust
   signal), 5s idle nudge, ✅ Got it! / 🗑 Never mind.
2. **🎒 Idea Bag** (`IdeaBag.tsx` + `src/lib/idea-bag.ts`). ✅ stores the
   transcript as an idea — **capture ≠ send**: no network, no generation, back
   to playing in seconds. Chip + count badge bottom-left; panel cards with 🔊
   read-aloud (`useTextToSpeech`) and ✕ discard.
3. **✨ Make my game better!** bundles ALL bagged ideas into ONE visible chat
   message (label: `IDEA_BUNDLE_LABEL`, bubble marked "🎒 From your Idea Bag"
   via `ChatMessage.fromIdeaBag`) through the normal `handleSend` → `/api/chat`
   loop — one generation for N ideas, full history context, regenerate works,
   parents can read exactly what was asked. Full screen collapses (desktop) /
   panel flips to chat (mobile) so the kid watches it land.
4. **↔ Pull-to-resize panel** (`PanelResizeHandle.tsx`): the fixed 440px
   desktop pane now resizes (min 360, max 70vw, persisted), CSS-var driven so
   the iframe never remounts.

**Rejected: wake-word invocation** ("call it by name"). Requires an always-on
microphone for the whole play session — a parent-trust regression (permanent
recording indicator), unreliable with kids shouting at games, and Web Speech
has no keyword-spotting mode (the iOS keep-alive battles in BUG-FIX-LOG are
hard enough for deliberate dictation). The buddy persona still answers by
name; the tab is the trigger. Revisit only as an opt-in, parent-approved mode
on Gemini Live / on-device keyword spotting.

## 3. Data (privacy stance first)

**Audio is never recorded or uploaded** — the browser's speech engine
transcribes live; only text exists.

| Data | Where | Notes |
|---|---|---|
| `IdeaRecord { id, gameConvoId, text, createdAt, source:"voice", status: bagged\|sent\|discarded, sentInMessageId? }` | localStorage `kidgemini:ideas:v1` (device-local, beside chats) | caps: 50 bagged/convo (oldest dropped), 400 total (oldest non-bagged pruned) |
| The sent bundle | normal chat history | `fromIdeaBag` flag renders the 🎒 label |
| Usage row per generation | server SQLite (`recordUsage`) | pre-existing, nothing new |

The bag **empties only on the `done` stream event** (`runStream`'s `onSuccess`)
— drops, blocks, gates, and errors keep every idea bagged.

**Phase 2 (not built, parent-PIN-consented only):** server `ideas` table for
cross-device sync + parent dashboard ("what did they dream up this week") and
aggregate signals: bug-vs-wish ratio (generation-quality + repair-taxonomy
gaps the probes can't see), ideas/session (engagement, Arcade ranking),
discard rate (child-speech ASR accuracy), bag-vs-typed share (feature proof).

## 3b. First-run coach ("meet the mic") — added 2026-07-12

A pre-reader can't learn from a tooltip, so the tab introduces itself with a
**silent bubble + demo animation** (`IdeaMicTab` coach overlay; policy in
`src/lib/idea-coach.ts`; animations in globals.css `idea-coach-*`). Voice is
**on request only** — the intro never auto-speaks (the 2026-07-12 auto
voice-over was UAT'd as intrusive/low-quality and removed; see BUG-FIX-LOG):

- **When (exactly three occasions, then never):**
  1. First quiet playable preview on the device — after the verify cover
     clears, never mid-generation (`shouldShowCoach`). ~8s: dim → tab slides
     out + wiggle + glow → bubble pops showing `COACH_LINE` → mini demo
     (pulsing dot, typewriter words, 💡 fly) → **🔊 Hear it** (reads the line
     via `useTextToSpeech`, toggles to ⏹ Stop while speaking) / OK.
  2. ONE wiggle-only re-nudge (no dim/bubble/voice) after
     `RENUDGE_AFTER_GAMES` (3) idea-less preview opens (`shouldRenudge`).
  3. Never again — not per game/chat/reload/full-screen.
- **Dismissal never blocks the feature:** OK, tap-anywhere, or tapping the tab
  itself — which dismisses AND goes straight to listening (no second click).
  Every dismissal path also cancels an in-flight Hear-it read-aloud.
- **Store:** `kidgemini:idea-coach:v1` `{ seen, gamesSinceCoach, everCaptured,
  renudged }` — device-local; garbage → defaults (fail OPEN: replaying the
  intro is harmless, losing it isn't). Capturing any idea sets `everCaptured`
  and kills all future nudges.
- **Gates:** mic unsupported → no tab → no coach (never advertise what can't
  work); `covered` enforced structurally (tab renders only under `!covered`).
- **Reduced motion:** no wiggle/typewriter/fly — static bubble; Hear it still
  works (still no auto voice).

## 4. Scale ceilings

localStorage shared with chats; idea records are short strings — negligible
next to game HTML. Trigger to revisit: bags routinely >50 ideas, or phase-2
sync (then records move server-side). ₹0 running cost (Web Speech, no audio).

## 5. Test coverage

- `src/lib/idea-bag.test.ts` — store CRUD, caps/prune, bundle composition,
  persistence never-throw, markSent-on-success-only semantics
- `src/lib/idea-mic.test.ts` — full tab state-machine transition table
- `src/lib/idea-coach.test.ts` — shouldShowCoach/shouldRenudge truth tables,
  store round-trip, fail-open defaults, never-throw
- `src/lib/preview-pane.test.ts` — resize clamp, width persistence, shell-class
  regressions
- `scripts/e2e-idea-coach.mjs` — real-browser pins: intro once and SILENT
  (no auto voice-over), 🔊 Hear it speaks the line / ⏹ Stop while speaking,
  dismissal cancels an in-flight read-aloud, all three dismissal paths
  persist, tab-tap goes straight to listening, re-nudge exactly once,
  reduced-motion static + silent with Hear it working
- Manual UAT script: §6

## 6. UAT script (localhost — secure context so the mic works)

U1. Generate a game → tab tucked + pulsing, bag chip faded/0
U2. Click tab → out; click → listening; game still runs, Space still jumps
U3. Speak → live words (grey interim firms up); 5s silence → nudge copy
U4. ✅ → badge +1; reload → count survives
U5. 🗑 → nothing added
U6. 3 ideas → bag panel: cards, 🔊 reads aloud, ✕ removes
U7. ✨ → full-screen collapses, ONE 🎒-labeled bundle in chat, reply streams,
    "updating" banner over old game, new game lands, bag empty
U8. Kill network mid-generation after ✨ → retries exhaust → ideas still bagged
U9. Deny mic permission → existing grown-up-help copy, no crash
U10. ⤢ full screen → tab + chip present and working; Esc returns
U11. Drag panel edge → clamped resize; reload → width remembered; mobile unaffected
U12. Mobile: tab mid-edge, bar at bottom; ✨ flips to the chat screen
U13. While busy: capture still works; ✨ disabled until done
U14. Fresh device (clear localStorage): first playable preview → dim + tab
     wiggle + bubble, NO voice; 🔊 Hear it reads the line (⏹ Stop while
     speaking); OK dismisses (and silences); reload → gone
U15. Fresh device again: tap the TAB during the intro → coach gone AND
     listening starts immediately (one tap, not two)
U16. Seed `kidgemini:idea-coach:v1` with seen+3 games unused → open a game →
     tab wiggles once (no dim/bubble); never wiggles again after
