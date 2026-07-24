# PRD — Idea Queue (type your next idea while Ari builds)

> **SUPERSEDED same day by `PRD-IDEA-QUEUE-V2.md`** (owner decision 2026-07-24):
> one unified line for typed AND spoken ideas; the Idea Bag merged into it.
> Kept for the v1 decisions and rules v2 carries forward.

**Status:** shipped 2026-07-24, superseded by v2 · **Owner decisions:** 2026-07-24
**Code:** `src/lib/idea-queue.ts` (logic) · `src/components/IdeaQueue.tsx` (UI) ·
`src/components/Composer.tsx` · `src/components/ChatPanel.container.tsx` (wiring)
**Tests:** `src/lib/idea-queue.test.ts`, `src/lib/chat-store.test.ts` (persistence rows)

---

## 1. The problem

Ari worked on exactly one idea at a time. While a turn streamed, the composer was
literally dead — `<Composer disabled={busy} …>` — so a kid who thought of the next
thing (kids think of the next thing constantly, usually WHILE watching the game
appear) had nowhere to put it. They had to hold it in their head until the build
finished, and often lost it.

Owner framing: *"Ari should take ideas and queue them like Claude does in the
terminal. As a user I should see the queued idea and, if needed, take it and edit
it or discard it."*

## 2. What ships

A visible FIFO line, directly above the composer.

- The composer stays **alive** while Ari builds. Enter/↑ adds the idea to the line
  instead of sending it (and instead of interrupting the running build — ⏹ Stop is
  still the only interrupt).
- The line renders as a **"⏳ Next up (n)"** card: numbered rows, each row an
  always-editable textarea (✏️ commit-on-blur, same contract as the Idea Bag) and a
  **✕** to drop just that one.
- After each **clean** finish, the front of the line sends itself automatically.
  One at a time — never a burst.
- After a **stop or a failure**, the line **freezes** and asks: *"⏸ Still want
  these?"* → **Yes — keep going ▶** / **No thanks, drop them**.
- The line is **persisted with the conversation**, so a reload finds it intact.

## 3. Owner decisions (2026-07-24)

| Question | Decision | Why |
|---|---|---|
| Queue depth | **Multiple, FIFO** (cap 5) | Matches the terminal behaviour the owner asked for. Cap keeps the card glanceable for a 7-year-old and bounds unattended paid turns. |
| On stop / error | **Keep the queue, ask before continuing** | An edit auto-chained onto a half-built or broken game is worse than a question. |
| Persistence | **Yes, per chat** | Rides `Conversation.queuedIdeas` → `chat-store` (localStorage) + the once-per-finished-turn server write-through. |

## 4. Rules that must not regress

1. **An idea is never silently lost.** At the cap the composer *refuses* the new
   idea and says why — it never drops the oldest one (`enqueueIdea` returns the
   queue unchanged; `canQueue` drives the copy). An emptied ✏️ edit is a no-op, not
   a delete; ✕ is the only removal path.
2. **Only a clean finish drains the line.** `turnOk` in `runStream` is set by the
   `done` event and by a reply resumed from `turn_results` — NOT by `finalized`,
   which is also true for blocked/retracted/errored turns.
3. **Nothing generates unattended.** Opening or restoring a chat that still has a
   line starts **paused** (`useEffect(… , [activeId])`), so a reload or a chat
   switch always asks before spending a turn.
4. **One send at a time.** `busy` only flips on the next render, so the drain effect
   and the ✨ Idea-Bag queue effect could both fire in one flush. `sendingRef`
   closes that gap synchronously; the idea is removed from the line *before* the
   send, so a re-render can't fire it twice.
5. **Persisted queues are validated on load** (`sanitizeQueue` in `chat-store`) —
   a queued idea auto-sends, so hand-edited localStorage must not reach the model.

## 5. Decision table (`queueSendAction`)

| hasQueued | busy | paused | → |
|---|---|---|---|
| false | any | any | `wait` |
| true | any | **true** | `hold` (ask the kid) |
| true | true | false | `wait` |
| true | false | false | `send` |

Single place to reason about (and test) the race — same pattern as
`ideaQueueAction` in `idea-bag.ts`.

## 6. UI states

| State | Composer | Card |
|---|---|---|
| Idle | "Ask me anything…", ↑ neutral-800 | hidden (empty line) |
| Building | "Add your next idea…", ⏹ Stop **and** ⏳ brand-500 queue button | "⏳ Next up (n)" + "Ari does these one at a time" |
| Line full (5) | send refused: *"Ari can hold 5 ideas — send or drop one of those first."* | unchanged |
| Attachment while building | refused: *"Pictures and files need Ari's full attention…"* | unchanged |
| Stopped / failed | normal | "⏸ Still want these?" + Yes / No thanks |

Visual pass 2026-07-24 (1200px + 390px, real UI with a stubbed slow `/api/chat`):
the queueing placeholder was shortened after the long version wrapped and clipped
in the one-row box at 390px.

## 7. Known limits (see `../Ariantra-Platform/docs/TECH_DEBT.md`)

- **Text only.** A queued idea carries no attachment: images are base64 blobs that
  would blow the localStorage quota the moment they persisted with the chat (same
  reason `sessionImagesRef` is a ref). The composer refuses an attachment-send
  while busy and keeps the file staged for when Ari is free.
- **Cap 5, and it's a UX cap, not a cost control.** Every queued idea is a paid
  model turn that runs with the kid watching a card, not a bill. Revisit if kids
  routinely hit the refusal (signal: the "can hold 5" notice firing often).
- **Queue belongs to the active chat.** Switching chats mid-build inherits the
  container's existing "`patchActive` targets whatever is active" behaviour; the
  always-pause-on-switch rule keeps that from silently sending into the wrong
  thread, but it isn't a true per-chat turn scheduler.
