# PRD — Community Help: getting a stuck kid unstuck (Phases 1–3)

2026-07-28 · Status: **Phases 1 & 2 BUILT** (same day), behind
`NEXT_PUBLIC_ENABLE_HELP_BUTTON` / `NEXT_PUBLIC_ENABLE_HELP_NUDGE`, both default
OFF — owner UAT + flag flip pending; **Phase 3 design recorded, implementation
deliberately deferred** · Owner: kidgemini (P1/P2), platform (P3 moderation)

## As built — deviations from this plan, and why

The accuracy note below was right to be cautious: three of its proposals didn't
survive contact with the tree. Everything else was built as written.

| This plan said | What shipped | Why |
|---|---|---|
| `ownerType`/`ownerId` mirroring `alerts`, reusing `getActiveChildId()` (§3.5) | **Neither column.** `help_tickets.accountId` holds the same identity string `alerts.accountId` already stores (`user:<email>` / `guest:<uuid>`); guest-ness is the prefix (`isGuestAccount`) | Per-child scoping (`PRD-CHILD-SCOPING-PHASE2`) has **not** shipped — `getActiveChildId` exists nowhere. Adding speculative columns now would guess at a shape that phase will decide. When it lands, `help_tickets` takes the same PRAGMA-guarded `ALTER` as `alerts` |
| `src/content/help/*.json` + schema validation in CI (§4.3) | **`src/lib/help-cards.ts`**, a typed module | There is no `src/content/` and no JSON-schema CI step in this repo. `tsc` + `help-cards.test.ts` give the same guarantee with nothing new to maintain, and it matches `game-suggestions.ts` / `tweak-suggestions.ts` |
| A "want me to try fixing it first? 🔧" step before the sheet (§3.1) | **No such step.** The property it protected is satisfied structurally | The self-healing loop runs automatically on every generation and spends `MAX_REPAIR_ATTEMPTS` before a kid can tap 🆘 at all, so a manual repair button would re-run a loop that just finished, or do nothing. "Every ticket is something automation couldn't handle" still holds — see the comment block in `src/lib/stuck-signal.ts` |
| Nothing about reply latency (§3.9 said "no time promise") | **"By tomorrow"**, from `HELP_REPLY_TARGET_HOURS = 16` (`src/lib/help-sla.ts`) | Owner call, 2026-07-28: a reply can take up to 16 hours. 16h from any waking hour lands inside the next day, so it's the one promise that always holds — and a span a 7-year-old can picture, which "16 hours" is not. The same constant colours the admin queue, so promise and dashboard can't drift |
| — (not anticipated) | Server-derived waiting/📬 state, a cross-chat "answered about <game>" tap-through, and `sentAgoLabel` | A 16h wait means the child is normally away when the answer lands. Holding that state in memory would lose it across a reload — the same class of bug as the leave-and-come-back reply loss (`BUG-FIX-LOG.md` 2026-07-28) |

Also shipped as specified: reason codes, the mic path, the 4 000-char bounded
error report with no game source, the open-ticket cap + 10-minute dedupe, the
`ADMIN_SECRET`-in-a-POST-body admin queue at `/admin/help` (option A), canned
replies with screened free text, guest tickets as canned-only (§9.1's narrower
option), the one-`ParentAlert`-per-reply mirror, the one-way 👍/😕 card, the
`/help` gallery with `✨ Ask Ari this`, and the 30-day text prune (§7) — which
runs on every ticket write rather than from a scheduler, so there's nothing to
forget to run. Test coverage is catalogued in `docs/REGRESSION-TEST-CATALOG.md`.

**Open decisions from §9, as resolved:** guest tickets — yes, canned-only
replies (§9.1). Admin surface — kidgemini-local (§9.2). Nudge thresholds — the
guesses in §3.2 shipped as module constants and are still guesses (§9.3); the
nudge has its own flag so they can be tuned before it's ever on. Volume ceiling
(§9.4) — unchanged: nothing auto-answers, the lever is narrowing the nudge.
`/help` was free (§9.5).

Related: `PRD.md` §F2 (safety gate, `ALWAYS_HARD_BLOCK`), §F3 (parent alerting),
§6 (COPPA/DPDP posture); `DATA_HANDLING.md` (retention — open decision);
`PRD-IDEA-BUTTON.md` (the mic/bag pattern this reuses); `PRD-CHILD-SCOPING-PHASE2.md`
(child entity, active-child cookie); `FEATURES.md` § Admin moderation;
`BUG-FIX-LOG.md` 2026-07-17 (`src/lib/error-report.ts`); `DESIGN_SYSTEM.md` §8
(copy split by cause); `TECH_DEBT.md` #12 (single hardcoded admin), #19 (pause
doesn't take a game offline).

> **Accuracy note.** This plan was written against the docs in this folder, not
> against the source tree. File paths, exports, and route names below are
> proposals matched to existing conventions — please confirm each one against
> the repo before building. Anywhere the docs were ambiguous, it's flagged
> inline rather than asserted.

---

## 1. Problem

A child gets stuck and there is no human they can reach.

Today's help is either machine help or adult help routed somewhere a child
can't go:

| What exists | Who it actually serves |
|---|---|
| Self-healing verify/repair (`REPAIRABLE_CODES` only) | The machine fixes it, or nothing happens |
| 📋 **Copy error details** (only when `hasExtremeError` is true) | A grown-up, to paste somewhere else |
| `contact@ariantra.com` | Shown only on a *paused-game* notice |
| `/parent` alerts | Parent, PIN-gated |
| `/studio/admin` | One hardcoded admin account |
| 🎤 Idea Mic / 🎒 Idea Bag | Sends to the **model**, not to a person |

So the failure the personas actually hit — *"it won't move and I don't know
what to say to Ari"* — has no exit. A 6–12-year-old, many of them pre-readers,
abandons the game. The Idea Button PRD already established that this cohort
gives up rather than switching context to ask for help; the same finding
applies here.

Note the two readings of "can't move" collapse to the same need: the character
literally won't move (a build defect), or the *kid* can't move forward (a
know-how gap). Phase 1 handles the first, Phase 2 the second, and the kid
should not have to know which one they're in.

## 2. The constraint that shapes all three phases

`PRD.md` §F2 puts **contact-with-strangers** in `ALWAYS_HARD_BLOCK` — a
category that, by that document's own wording, can never be downgraded. §6 adds
a COPPA-minded posture (no third-party ad/analytics SDKs, no child PII beyond
local transcripts).

A "community" is, structurally, stranger contact. That does not make it wrong
to build — it makes the *amount of kid↔stranger surface* the primary axis this
PRD is organised on:

| Phase | Kid↔stranger surface | Runtime moderation load |
|---|---|---|
| **1 — Help queue** | Kid → one verified admin; replies are one-way and parent-mirrored | Bounded, async, ~0 |
| **2 — Help gallery** | None (content is repo-committed) | Zero |
| **3 — Community** | Kid ↔ other kids | Continuous — needs staffing |

Phases 1 and 2 do not require the safety posture to change at all. Phase 3
does, and that policy exception has to be written down and owner-approved
before any code — which is the main reason it's deferred (§6.1).

---

# Phase 1 — 🆘 "I'm stuck" → admin help queue

**Ships:** a kid-reachable way to ask a real person for help, an admin queue to
answer from, and a one-way reply path the parent can always read.

## 3.1 Try the machine first

The button must never become a human queue for something already automated. On
tap, the client checks the current verify state:

- Failure code **in** `REPAIRABLE_CODES` and repair not yet attempted → offer
  the existing repair ("Want me to try fixing it first? 🔧"). Ticket only if
  the kid declines or repair fails.
- Everything else → straight to the ticket sheet.

This also gives the queue a useful property: **every ticket that arrives is
something the automated path could not handle**, which makes the reason-code
histogram a real product signal rather than noise.

## 3.2 Where the button lives

- Docked on the preview (`ArtifactFrame`), **below** the existing 🎤 Idea tab
  and visually quieter than it — the Idea tab is the happy path and must stay
  the more prominent affordance.
- Same lesson as `PRD-IDEA-BUTTON.md` §2.1: **fully visible with a persistent
  label**, no hover-only tooltip. The half-tucked version of the Idea tab was
  invisible on touch and kids never found it; don't repeat it.
- Also surfaced in the §9.1 failure banner beside 📋 Copy error details, so an
  adult and a child each have their own affordance on a hard failure.

**Proactive offer.** The signals for "this kid is stuck" already exist —
repeated repair calls on one artifact, a `restart` chain, verify ending
failed/bailed, or N consecutive asks with no artifact swap. After a threshold
(suggest: 2 failed repairs on the same generation, or 3 asks in ~5 minutes with
no successful swap), the button gets a gentle one-time nudge ("Want a grown-up
from Ariantra to look at this? 🆘"). Decision logic goes in a pure, unit-tested
helper (`src/lib/stuck-signal.ts`, `shouldOfferHelp(state)`) — same pattern as
`makeBetterOnClick`/`ideaQueueAction`, so the class "busy-gated action silently
blocks" can't recur here. One nudge per generation, dismissible, never modal.

## 3.3 The sheet — no typing required

Tap → a `rounded-kid` sheet with **picture reasons**, not a text box:

| Chip | `reasonCode` |
|---|---|
| 🕹️ It won't move | `wont_move` |
| ⬜ The screen is blank | `blank` |
| 🎨 It looks wrong | `looks_wrong` |
| 🔇 No sound | `no_sound` |
| 🤷 I don't know what to ask | `dont_know` |
| 🎤 Something else | `other` (opens the mic) |

`other` reuses the Idea Mic's state machine (`src/lib/idea-mic.ts`) and the same
STT path — live interim words, pulsing dot, ✅ / 🗑. Every reason card gets 🔊
read-aloud via `useTextToSpeech`, so a pre-reader can use this unassisted.

Capture ≠ send is preserved from the Idea Bag: the ticket is stored locally
first, then POSTed; a failed POST retries rather than surfacing an error.

## 3.4 What the ticket carries — and what it does not

| Carried | Rationale |
|---|---|
| `reasonCode` + optional transcript | The kid's own words |
| `buildErrorReport()` output | Already bounded to 4 000 chars, already excludes game source |
| Verify verdict + classification codes | The diagnosis the admin would otherwise ask for |
| `conversationId` + `messageId` (an **artifact ref**) | Points at the game |
| Account/child owner, per §3.5 | Tenancy |

| **Not** carried | Rationale |
|---|---|
| The generated game HTML | `buildErrorReport` deliberately excludes source (reports get pasted into chats/tickets). Keep that property. |
| Full chat history | Same reason |

The admin can pull the source, but only through a **separate, explicitly logged
action** (§3.7). `DATA_HANDLING.md` already flags that raw request/output text is
retained indefinitely and bulk-readable by anyone holding `ADMIN_SECRET`; a new
surface should not widen that by default.

## 3.5 Data model

kidgemini SQLite (`src/lib/db.ts`), same migration style as `screen_time_*` —
`CREATE TABLE IF NOT EXISTS` plus `PRAGMA table_info`-guarded `ALTER TABLE`,
idempotent on every boot:

```sql
CREATE TABLE IF NOT EXISTS help_tickets (
  id             TEXT PRIMARY KEY,
  accountId      TEXT,              -- NULL for guests
  guestId        TEXT,              -- NULL when signed in
  ownerType      TEXT NOT NULL,     -- 'child' | 'device' | 'legacy' — mirrors alerts
  ownerId        TEXT NOT NULL DEFAULT '',
  reasonCode     TEXT NOT NULL,
  transcript     TEXT,              -- optional, from the mic
  errorReport    TEXT,              -- bounded 4000 chars
  verifyVerdict  TEXT,
  conversationId TEXT,
  messageId      TEXT,
  status         TEXT NOT NULL DEFAULT 'open',   -- open | answered | closed
  createdAt      INTEGER NOT NULL,
  updatedAt      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_help_status  ON help_tickets(status, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_help_owner   ON help_tickets(ownerType, ownerId, createdAt DESC);

CREATE TABLE IF NOT EXISTS help_replies (
  id         TEXT PRIMARY KEY,
  ticketId   TEXT NOT NULL,
  cannedId   TEXT,               -- non-NULL = a library reply, not free text
  body       TEXT NOT NULL,
  authorRef  TEXT NOT NULL,      -- which admin identity answered
  createdAt  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_help_replies_ticket ON help_replies(ticketId, createdAt);
```

`ownerType`/`ownerId` intentionally mirror the shape `PRD-CHILD-SCOPING-PHASE2.md`
adds to `alerts`. **Please confirm whether that phase has shipped** — if it has,
reuse `getActiveChildId()` verbatim; if not, write `'legacy'`/`''` now so a
later backfill matches the alerts one exactly.

## 3.6 API (kidgemini)

- `POST /api/help` → `{ reasonCode, transcript?, errorReport?, verifyVerdict?, conversationId?, messageId? }` → `{ id }`.
  Works for guests (the guest wall shouldn't block asking for help).
  **Rate limit:** ≤3 open tickets per identity; dedupe on
  `(identity, messageId, reasonCode)` within 10 minutes → returns the existing
  ticket id rather than an error.
- `GET /api/help` → the caller's own tickets + replies. Scoped by identity
  server-side; never takes an id from the client as authorisation.
- `GET /api/parent/help` → every ticket and reply for the signed-in parent's
  account, behind the same PIN-verified parent-session cookie `/api/alerts`
  uses. No freshness requirement (reading is not a credential change) — same
  posture the screen-time PRD settled on.

## 3.7 Admin side

Recommendation: build it **kidgemini-local** (`/admin/help`, gated by the
existing `ADMIN_SECRET` + `timingSafeEqual` pattern from `/api/usage`), not on
the platform's `/studio/admin`.

| Option | Verdict |
|---|---|
| **A — kidgemini `/admin/help`** | ✅ The data (tickets, error reports, artifacts) is all in kidgemini's SQLite; no cross-repo bridge, no new partner endpoint |
| B — platform `/studio/admin` | ❌ Would need a partner bridge purely to read kidgemini rows; also inherits TECH_DEBT #13 (no silent token refresh) |
| C — email only | ❌ No structure, no reply path back into the product, no audit |

Queue view: reason code, age of ticket, verify verdict, the error report, and a
**"load game source"** button that fetches the artifact by ref and writes an
audit row. Source is never loaded implicitly with the ticket.

## 3.8 The reply path — the part that needs the most care

An adult typing free text to a child is exactly the shape the safety posture
exists to prevent. Four constraints make it defensible:

1. **Canned-first.** A library of pre-approved replies (`src/lib/help-canned.ts`,
   repo-committed, one per common `reasonCode`) covers the majority. A canned
   reply carries `cannedId` and needs no review. Free text is the exception and
   is visibly marked as such in the admin UI.
2. **One-way.** The kid cannot free-text back. The reply card offers exactly
   two taps: **👍 That helped** (closes) and **😕 Still stuck** (reopens, no new
   text). No open channel is created.
3. **Parent-mirrored, always.** Every reply writes a `ParentAlert`
   (`origin: "system"`, `severity: "low"`, `action: "allow"` — the same
   non-blocking shape screen-time uses) so it lands in the existing `/parent`
   alerts list. A parent can read every word any adult said to their child,
   without opting in to anything.
4. **Attributed honestly.** The card reads *"A helper at Ariantra"* with a
   distinct visual treatment — never styled as Ari, never as another kid. Kids
   should learn the difference between the AI, a helper, and a stranger; the UI
   should teach it rather than blur it.

Replies pass through the same profanity/length moderation already used for
display names before storage. Cheap, and it guards against a compromised admin
session as much as against a typo.

## 3.9 Kid-facing copy

`DESIGN_SYSTEM.md` §8 requires copy split by cause and forbids one message for
all failures. Add to `src/lib/chat-copy.ts`:

- **Ticket sent:** *"Sent! A helper at Ariantra will look at your game. 🌟
  While you wait, want to try something else?"* — followed by two live
  suggestions. **No time promise** (no "soon", no "shortly"): we cannot keep it
  with one admin, and a broken promise is worse than none.
- **Reply arrived:** a 📬 badge on the sidebar; the card opens on tap.
- **Send failed:** silent local retry — the kid sees nothing. Only after
  exhausted retries: *"I'll send this as soon as you're back online."*

## 3.10 Testing (Phase 1)

- `shouldOfferHelp` truth table — pure, node-level: fires after 2 failed
  repairs on one generation; does **not** fire on a healthy game; at most one
  nudge per generation.
- Repairable code → repair offered before ticketing; non-repairable → sheet
  opens directly.
- The ticket never contains the game HTML (regression pin on the same class
  `error-report.test.ts` already guards for source leakage).
- Dedupe: two identical taps within 10 minutes produce one row.
- Tenancy: `GET /api/help` on identity A never returns identity B's tickets, by
  any parameter manipulation. `GET /api/parent/help` rejects a call with no
  verified parent session (401).
- Every reply writes exactly one `ParentAlert`; a reply with no alert row is a
  test failure (this is the accountability guarantee, so pin it).
- Free-text reply containing blocked words is rejected at write time.
- Guest can file a ticket; a guest ticket is never attributed to an account.
- Offline: POST failure keeps the ticket locally and re-sends on reconnect.
- Migration idempotency: booting twice against a pre-Phase-1 DB doesn't error.

---

# Phase 2 — 📚 Help Gallery (read-only, moderated, zero runtime moderation)

**Ships:** a place a kid can browse for "how do I…" answers, where every card
ends in a one-tap action rather than a paragraph to read.

## 4.1 Shape

New route `/help` in kidgemini (please verify nothing already occupies it), plus
an entry point in the sidebar and from the 🆘 sheet's `dont_know` chip — which
is the highest-value link in the whole feature, since "I don't know what to ask"
is a content problem, not a defect.

A card is: a title, a short animated example (an inline `<video>`/GIF or a
tiny sandboxed iframe — the same `sandbox="allow-scripts"` rule applies), 🔊
read-aloud, and one primary button.

## 4.2 "Ask Ari this" is the whole feature

Each card carries a pre-written prompt. Tapping **✨ Ask Ari this** drops it
into the composer and sends it through the normal `handleSend` → `/api/chat`
loop. Nothing bypasses the safety path; nothing new is generated server-side.

This is what makes the gallery usable by a pre-reader: they never have to
compose the sentence, only recognise the picture. It's also the same lesson the
Idea Bag proved — capture and action have to be one tap apart or the cohort
gives up.

## 4.3 Content, and why it needs no moderation

Cards are a repo-committed file (`src/content/help/*.json`), authored by the
team, shipped with the build. No user-generated content, therefore **no runtime
moderation, no reporting flow, no queue.** That property is the entire reason
this phase is cheap.

**Authoring loop:** Phase 1's `reasonCode` histogram and the `preview_verify`
telemetry say which cards to write next. Ship Phase 1 first and Phase 2's
backlog writes itself from real data instead of guesses.

## 4.4 Remixable examples — deliberately deferred within Phase 2

Showing other kids' published games as teaching examples is tempting and mostly
safe (the catalog is already public), but it needs its own consent decision. The
family sharing flag (`shareEnabled`) was designed for *the family's own voice
pushing their kid's identity forward* — "your game may be used as a teaching
example for other children" is a different thing, and silently overloading one
flag with two meanings is how consent decisions get lost.

Ship the gallery with team-authored examples. Treat remixing as a separate,
small proposal with its own opt-in.

## 4.5 Testing (Phase 2)

- Every card's prompt round-trips through `handleSend` and produces a normal
  generation (one integration test per card is overkill; one parameterised test
  over the content file is right).
- Content-file schema validation runs in CI — a malformed card fails the build
  rather than rendering broken to a child.
- No card renders raw HTML from content (XSS pin).
- `/help` is reachable while offline for already-cached content, or degrades to
  a plain message — never a blank screen.
- Read-aloud present on every card; keyboard-reachable; `prefers-reduced-motion`
  respected on the animated examples (`DESIGN_SYSTEM.md` §7).

---

# Phase 3 — Two-way community (**deferred — design recorded, not scheduled**)

This section exists so the decision is documented and Phases 1–2 don't
accidentally foreclose it. **It is not a build plan and should not be picked up
as one.**

## 5.1 Why it's deferred

Six gates, each concrete and checkable. Phase 3 does not start until all clear:

1. **The stranger-contact exception is written and owner-approved.** `PRD.md`
   §F2 says the category can never be downgraded. Either that sentence changes
   deliberately, in that document, with the reasoning recorded — or Phase 3
   doesn't happen. It should not be resolved by a code change quietly
   contradicting the PRD.
2. **More than one moderator, with roles.** TECH_DEBT #12: admin is a single
   hardcoded email with no roles and no audit trail beyond logs. A UGC surface
   cannot rest on that.
3. **Moderation actually works.** TECH_DEBT #19: pausing a game doesn't take it
   offline, because CloudFront serves S3 directly. A moderation lever that
   doesn't remove content is a blocker for shipping any surface that needs one.
4. **Retention decided.** `DATA_HANDLING.md` leaves retention explicitly open.
   User-generated posts by children, kept forever, with no purge and bulk admin
   read, is not a defensible starting position.
5. **Per-jurisdiction consent exists.** `PRD.md` §6 names COPPA / GDPR-K / DPDP
   and verifiable parental consent. Phase 3 is the feature that actually
   requires it.
6. **Staffing is funded.** `PRD.md` §8 carries ~$150k/mo fixed opex including
   support. Continuous pre-moderation for a kid community is a line item inside
   that, not an assumption around it.

Gates 2 and 3 are already on the register and will likely clear for unrelated
reasons. Gates 1, 4, 5, 6 are decisions, not work — and they are the ones that
should be made calmly, before code, rather than under launch pressure.

## 5.2 The shape, if and when it's built

- **No free text kid→kid at v1.** Reactions plus a fixed phrase palette ("Cool
  game!", "How did you do that?"). A palette needs no runtime moderation and
  still delivers most of the social value.
- **Pre-moderation, then post-moderation** — never the reverse. Free text, if it
  ever ships, is queued before it's visible.
- **Ask-and-answer, not chat.** Threads attached to a *game* or a *question*,
  never person-to-person. No DMs, no follows, no profiles-as-destinations.
- **Identity minimised.** Worth checking before this phase: the catalog's search
  already surfaces makers as "by Agilan, 10 · Delhi" (`FEATURES.md`). That is
  presumably behind the existing credit opt-in — but a community that links
  those profiles to posts should re-open the question of whether a child's
  name + age + city belongs in a public, searchable index at all.
- **Parent-visible by construction**, the same way Phase 1's replies are.

## 5.3 What Phases 1–2 must not foreclose

- Keep `reasonCode` and canned-reply ids **structured**. The ticket/reply corpus
  is the seed content for any future public Q&A, and free-text-only tickets
  would make that corpus unusable.
- Keep the `help_tickets` owner columns aligned with `alerts` so a future
  per-child community view reuses one tenancy helper rather than inventing a
  second.
- Don't ship anything in Phase 1–2 that implies a community is coming. No
  "coming soon", no empty social tab. If Phase 3 never ships, nothing in the
  product should look unfinished.

---

## 6. Non-goals (all phases)

- No change to the safety gate, the sandbox flags, the publish flow, or the
  verify/repair loop.
- No new credential and no new PIN — Phase 1 rides on the existing SSO session
  (kid side), the parent-session cookie (parent side), and `ADMIN_SECRET` (admin
  side).
- No SLA and no promise of response time to a child.
- No email or notification to the parent's inbox; the parent area is the surface.
- No kid↔kid contact of any kind in Phases 1–2.

## 7. Privacy & retention

`help_tickets` and `help_replies` inherit the indefinite-retention posture
`DATA_HANDLING.md` documents, which means this feature slightly enlarges the
open question rather than answering it. Two things worth doing inside this
phase, cheaply:

- Prune `errorReport` and `transcript` on ticket close + 30 days, keeping the
  structured row (reason code, timing, resolution). The analytics value is in
  the codes, not the text — so the text can go early without losing anything.
- Add the new tables to `DATA_HANDLING.md` in the same commit. A data-handling
  doc that lags the schema stops being useful quickly.

Register the wider retention decision as a new row in `TECH_DEBT.md` (the
highest number visible in this copy is 22, but other docs reference entries in
the fifties and sixties, so please take the next free number from the live
register rather than this one).

## 8. Rollout

1. Schema + stores + `POST/GET /api/help`, no UI. Deployable alone; nothing
   changes for anyone.
2. Admin queue `/admin/help` + canned library. Internal-only; the team can
   answer tickets before kids can file them, so the first real ticket doesn't
   land in an empty room.
3. Kid-facing 🆘 button, **behind a flag**, enabled for a small set of accounts
   first. Watch ticket volume against the one-admin capacity before widening.
4. Proactive nudge (§3.2) — separately flagged, because it's the change most
   likely to spike volume.
5. Phase 2 `/help` gallery, authored from the reason codes step 3–4 produced.

Steps 1–2 are safe to ship in any order relative to the rest of the roadmap.
Step 3 is the one that creates an obligation: once a child can ask a person for
help, someone has to be there. Don't enable it during a week nobody is watching
the queue.

## 9. Open decisions

1. **Guest tickets** — recommended yes (§3.6), but a guest has no parent to
   mirror a reply to, which weakens constraint 3 in §3.8. Options: canned-only
   replies for guests, or no replies to guests at all (ticket still recorded for
   the team). Needs an owner call.
2. **Admin surface placement** — §3.7 recommends kidgemini-local; revisit if a
   second moderator arrives and platform roles land first (TECH_DEBT #12).
3. **Nudge thresholds** — the numbers in §3.2 are guesses. Set them from real
   `preview_verify` telemetry before enabling step 4.
4. **Ticket volume ceiling** — no estimate exists. If the nudge produces more
   tickets than one admin can answer, the honest response is to narrow the
   nudge, not to auto-reply with something that pretends to be a person.
5. **Does `/help` collide with an existing route?** Not verified from the docs.
