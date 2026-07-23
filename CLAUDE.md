# CLAUDE.md — Ari (formerly KidGemini) codebase guide

> Renamed 2026-07-17: the product is now **Ari**. Internal infra — the pm2
> process name, EC2 directory, SQLite path, and this repo's own folder name
> (`Game`) — deliberately still says "kidgemini" (see §12); only the public
> brand and URL changed. Grepping for "kidgemini" in this repo will still
> find plenty of legitimate hits.

This is the single source of truth for **how we build** in this repo. Claude Code (and any
human) should read this before writing code. **Read the relevant docs BEFORE touching the
code**: product intent in `docs/PRD.md`; visual language in `docs/DESIGN_SYSTEM.md`; system
map and hosting in `docs/ARCHITECTURE.md`; feature overview in `docs/FEATURES.md`; the exact
LLM prompt sent on every child turn in `docs/PROMPT_MANAGEMENT.md` (read before changing any
prompt string or the assembly/gating logic); known
issues in `docs/KNOWN_BUGS.md` and `docs/SCALABILITY_ISSUES.md`; deferred work in
`../Ariantra-Platform/docs/TECH_DEBT.md` (cross-repo register — add to it when deferring).

---

## 🚫 Hard rule — never touch secrets or data

**At no point — for any task — read, open, print, edit, move, or delete these:**
- **Environment files:** `.env`, `.env.local`, `.env.*` (contain the Gemini API key + secrets).
- **The database:** `data/`, `*.db`, `*.db-journal`, `*.db-wal` (contain children's transcripts — privacy-sensitive).

This means: no `cat`/`Read`/`grep`/`sed` on them, no Edit/Write, no `sqlite3` queries, no
committing them. They are intentionally git-ignored. If a task seems to need their contents,
**stop and ask the human** instead of accessing them. To change configuration *shape*, edit
`.env.example` (the placeholder template) only. To change the DB schema, edit `src/lib/db.ts`
code — never the live `.db` file.

---

## 1. What this project is

A kids-safe, Gemini-quality chat app (text + voice) with a **server-enforced safety gate**,
**parent alerting**, and **sandboxed HTML game artifacts**. See `docs/PRD.md`.

## 2. Stack

- **Next.js 14 (App Router)** + **TypeScript (strict)** — frontend and secure backend in one repo.
- **Tailwind CSS** wired to design tokens (`docs/DESIGN_SYSTEM.md`).
- **@google/genai** for Gemini (chat model + Flash-Lite safety model).
- **openai** — cross-provider fallback, LIVE for streaming chat turns
  (2026-07-20, `docs/PRD-MODEL-FALLBACK.md` §7). Engages only when the Gemini
  primary fails; requires `OPENAI_API_KEY`. Every OpenAI call goes through
  `OpenAIGenerator`, which moderates input and output — that wrapper is what
  makes the `provider-enforced` claim in `MODEL_CATALOG` true. One-shot paths
  (`reply`/`repair`/`strictEditRetry`) remain Gemini-only.
- **better-sqlite3** for local storage (alerts, settings, transcripts).
- **Web Speech API** for speech-to-text (browser-native, no key).

## 3. Architecture (the safety boundary is the whole point)

```
src/app/(kid)/         kid-facing chat UI
src/app/parent/        PIN-gated parent dashboard
src/app/api/           server routes — the ONLY place the API key & safety logic live
src/lib/               domain logic (gemini, safety, db) — framework-agnostic
src/components/         presentational + container React components
src/types/             shared TypeScript types
```

**Rules that must never be broken:**
1. **The Gemini API key is server-only.** Never `NEXT_PUBLIC_`. All model calls go through `src/app/api/*`.
2. **All safety decisions are server-side.** Current posture (owner decision 2026-07-09):
   deterministic input rules (block + parent alert) → Gemini built-in safety thresholds →
   child-safety system prompt (age 7–14). The Flash-Lite output monitor is REMOVED from
   `/api/chat` — it retracted harmless games (chess); **games are never blocked or retracted**
   (`route.test.ts` R.1). Re-enable path: PRD §F2.
   **The middle layer is provider-specific.** It is Gemini's per-request
   `safetySettings`, which no other provider exposes — so cross-provider
   fallback (2026-07-20) may only route to a model that carries an equivalent
   guard. `SafetyPosture` in `src/types/model-provider.types.ts` makes each
   model declare this and `model-registry.ts` fails closed on it: a
   `prompt-only` model is excluded from every chain unless
   `ALLOW_PROMPT_ONLY_SAFETY_MODELS=1`. Never mark a model
   `provider-enforced` to unlock cheaper routing — that flag is a claim that a
   real guard runs, and the gate trusts it.
3. **Fail closed where a classifier decides.** The input rules block on match; `/api/safety`
   (which still uses the Flash-Lite classifier) blocks + logs on error, never shows.
4. **Generated HTML is sandboxed.** Always `<iframe srcdoc sandbox="allow-scripts">` — never inject into the parent DOM.

## 4. Coding principles

### SOLID (applies to every module we add)
- **S — Single Responsibility:** one file = one job. `safety.ts` only classifies; `gemini.ts` only talks to the model; `db.ts` only persists. A component either *fetches* (container) or *renders* (presentational), not both.
- **O — Open/Closed:** add new safety categories or models by extending config/types, not by editing call sites. New rules plug into the `SafetyClassifier` interface.
- **L — Liskov:** any `SafetyClassifier` (Flash-Lite, a future stricter one, a mock for tests) is swappable without callers knowing.
- **I — Interface Segregation:** small, focused interfaces (`ChatModel`, `SafetyClassifier`, `AlertStore`) over one giant service.
- **D — Dependency Inversion:** API routes depend on interfaces in `src/types`, not on concrete SDK classes. Concrete implementations are injected/constructed at the edge. This is what makes the safety logic testable.

### General
- TypeScript **strict**; no `any` — model it in `src/types`.
- Pure domain logic in `src/lib` stays free of React/Next imports.
- Small functions, early returns, no clever one-liners over clarity.
- Errors are typed and handled; user-facing failures degrade gently (and for safety, fail closed).
- Match the style of surrounding code; don't reformat unrelated lines.

## 5. Naming system (built for fast debugging)

The goal: from a name alone you can tell **what layer it's in, what it does, and where to look.**

### Folders — `kebab-case`, plural for collections
`components/`, `lib/`, `api/`, `parent/`, `safety-gate/`.

### Files — name encodes the layer with a suffix

| Kind | Convention | Example |
|------|-----------|---------|
| React component | `PascalCase.tsx` | `ChatPanel.tsx`, `ArtifactFrame.tsx` |
| Container (data-fetching) component | `PascalCase.container.tsx` | `ChatPanel.container.tsx` |
| Hook | `useThing.ts` (camelCase, `use` prefix) | `useSpeechInput.ts` |
| Domain/service module | `kebab-case.ts`, noun = its job | `safety.ts`, `gemini.ts`, `db.ts` |
| API route | `route.ts` in a `kebab-case` folder = the endpoint | `api/chat/route.ts` |
| Types | `kebab-case.types.ts` | `safety.types.ts` |
| Test | mirror file + `.test.ts` | `safety.test.ts` |
| Constants/config | `kebab-case.config.ts` | `safety.config.ts` |

### Symbols inside files
- Components & types: `PascalCase` (`SafetyVerdict`, `AlertSeverity`).
- Functions & variables: `camelCase` (`classifyMessage`, `chatModel`).
- Constants: `UPPER_SNAKE_CASE` (`HARD_BLOCK`, `DEFAULT_STRICTNESS`).
- Booleans read as questions: `isSafe`, `hasParentPin`, `shouldBlock`.
- Event handlers: `handleX`; props that pass them: `onX`.

### Debugging aids baked into names
- Every server route logs under a tag matching its folder: `[api/chat]`, `[api/alerts]`.
- Safety decisions log with a stable shape: `[safety] category=... severity=... action=...`.
- Error classes end in `Error` and carry the layer: `SafetyGateError`, `GeminiError`.

## 6. Front-end quality bar

Professional and polished **and** kid-friendly — not childish. Follow `docs/DESIGN_SYSTEM.md`:
tokens only (no ad-hoc hex), generous spacing, soft rounded shapes (`rounded-kid`), large
tap targets, accessible contrast, motion that's gentle. Components are presentational by
default; data lives in containers/hooks.

**Non-negotiable UX bar:** no blank screens (loading states), no silent failures (every
error tells the user what to do next — and travels as an HTTP status, never only an
in-band event), no dead ends, mobile-first checks, visual pass before "done".

**Non-negotiable SEO/AI-answer bar:** every public page ships with unique title +
meta description, OpenGraph, canonical URL, and SSR-readable content; keep
sitemap/robots current so search engines AND AI assistants represent Ari well.

## 7. Development process — **MANDATORY**

Every non-trivial change **must** follow this lifecycle, in order. Do not skip a step. Do not
write feature code before its tests. "It typechecks" and "it boots" are **not** done.

1. **Requirement gathering.** Restate the requirement before building. **If any requirement is
   unclear AND there is no clear winner among the options, STOP and ask the human** — present
   the choices and get an explicit decision. Never make a no-clear-winner call unilaterally
   (cookie strategy, auth model, UX pattern, data shape all count). Obvious defaults: just proceed.
2. **PRD & plan.** Capture the intent and approach in writing **before coding** — extend
   `docs/PRD.md` (product intent) and write a short implementation plan (files, interfaces,
   test list). One plan per feature; keep it in the PR/change description or `docs/`.
3. **Develop per the coding principles in §4** (SOLID, types-first in `src/types`, config not
   call-sites, server-only secrets, fail-closed safety). Keep diffs focused — one concern per change.
4. **Test-first — write tests BEFORE the implementation.** Required layers:
   - **Unit** — pure logic in `src/lib` (safety, gate, pricing, db queries). Mirror the file as `.test.ts`.
   - **Integration** — API routes end-to-end with collaborators (mock Gemini, in-memory SQLite):
     the safety gate, the guest token gate, auth identity resolution.
   - **Regression** — every fixed bug gets a test that fails before the fix and passes after.
   - **Safety code is NEVER untested** (it's the whole point of this app). Touching `safety.*`,
     `/api/chat`, or the gate ⇒ add/extend tests in the same change.
   - Stack: **Vitest** (unit/integration, `npm run test`), **Playwright** (browser e2e/regression,
     `npm run test:e2e`). `npm run test` **and** `npm run typecheck` must pass before anything is "done".
5. **UAT handoff.** Deliver the human a UAT package: a numbered list of user-facing test cases
   (steps → expected result) covering the change. Then **monitor and fix** reported bugs.
6. **Bug-solving.** Fixes follow the **Bug-Fix Protocol** in §9 — solve the *class*, not the
   symptom, and log it. Reproduce → write a failing regression test (step 4) → fix → confirm
   green → append a `docs/BUG-FIX-LOG.md` entry → note it in the UAT package.

New module? Give it a type/interface in `src/types` first (Dependency Inversion). `npm run dev` for local dev.

## 8. Checklists & quality gates

**Before starting a non-trivial task:**
1. Read the real code path end-to-end — don't build on assumptions.
2. List the files that will change; confirm scope with the human.
3. Have the plan (§7 step 2) approved before writing code.

**Before each commit:**
1. Self-audit against §4 (SRP, DRY, fail-closed safety, minimal change — don't refactor unrelated lines).
2. Run the tests for the impacted area, then the full suite; fix red before committing. Consult
   `docs/REGRESSION-TEST-CATALOG.md` for which tests must run when touching which files.
3. Scan the staged diff for secret patterns (`GEMINI_API_KEY`, `AUTH_SECRET`, `SECRET`, JWT, `-----BEGIN`).
4. For UI changes: start the dev server, verify the golden path **and** one edge case, at mobile width (375px) too.

**Quality gates — all must pass before "done"/merge:**

| # | Gate | How to verify |
|---|------|---------------|
| 1 | Typecheck clean | `npm run typecheck` |
| 2 | Unit + integration tests green | `npm run test` |
| 3 | E2e/regression green (UI changes) | `npm run test:e2e` |
| 4 | Coverage ≥ 70% on `src/lib/**` | included in `npm run test` |
| 5 | SOLID + fail-closed safety honored | self-review against §4 |
| 6 | No secrets / data files touched | the Hard rule at the top |
| 7 | **Scalability checked** — no new unbounded query / per-instance state, or it's an accepted, documented trade-off | §10 + `docs/SCALABILITY_ISSUES.md` |
| 8 | UAT sign-off | human confirms |

## 9. Bug-Fix Protocol — solve the class, not the symptom

When a bug is reported (UAT, user, log alert):

1. **Read `docs/BUG-FIX-LOG.md` BEFORE proposing a fix.** Scan for prior bugs in the **same
   surface area** (same file/route/module) and the **same signature** (silent failure, fail-open
   safety, stale state, count mismatch, swallowed error). Don't interrogate the user with
   diagnostics first — investigate the code path yourself (reproduce + root-cause).
2. **Name the class.** If the log shows repeats of this shape, it's a **class regression**, not a
   one-off. Highest-risk classes here: a **safety fail-open** (unvetted content reaching the
   client), a **silent block/drop** without logging, **closure stale state** (`setInterval`/
   `setTimeout` capturing `useState` instead of `useRef`), **secret leak** to the client bundle.
3. **Solve at the class level.** Fix the symptom at its layer **and** add a contract at the
   adjacent layer so the same class can't slip past via another path (e.g. a missed client guard
   also gets a server-side block; a silent drop also gets a log + alert). Safety fixes fail closed.
4. **Test the contract, not just the bug.** New tests pin the exact symptom (regression-locked)
   and cover each layer's assertion. Register them in `docs/REGRESSION-TEST-CATALOG.md` with
   *when to run* (which file paths invalidate which tests).
5. **Document.** Append a `docs/BUG-FIX-LOG.md` entry (newest first, template in that file);
   name the class and link prior repeats in **Related**. Move/close the row in `docs/KNOWN_BUGS.md`.

**Hard rule:** the BUG-FIX-LOG entry must exist *before* the commit. The entry IS the deliverable —
code without it is incomplete.

## 10. Always-on hard stops

Pause and surface to the human — in every mode, including autonomous:

- **Secrets / privacy** — any `.env*`, `data/`, `*.db`, or a string matching an API-key/JWT/private-key pattern about to be read, edited, or committed (this is the Hard rule at the top — it overrides everything).
- **Safety regression** — a change that could let unvetted model content reach the client, or makes the gate fail *open*.
- **Destructive git** — `reset --hard`, `checkout <ref> -- <path>`, `branch -D`, `clean -fd`, force-push.
- **Scalability issue** — a change that won't survive horizontal scale: an **unbounded query**
  (no `LIMIT`/index — e.g. a per-request `SUM`/scan that grows with history), **in-memory or
  file-local per-user state** (counters, sessions, the SQLite file, local log files) that diverges
  across instances/serverless, an append-only table/log with no rotation, or **no inbound
  rate-limit on an LLM-cost path**. → **STOP, document in `docs/SCALABILITY_ISSUES.md`**, and
  surface the trade-off in the plan before writing code.

  **Standing rule — compromise ⇒ limit + ready plan.** Whenever we deliberately trade scalability
  for cost or speed *now*, it ships only with BOTH: (a) the **limit and its trigger symptom**
  recorded in `docs/SCALABILITY_ISSUES.md`, and (b) a **ready scale-up/migration plan** (trigger →
  steps → rollback → effort) — inline for simple cases, or a runbook like
  `docs/SCALABILITY_MIGRATION_PLAN.md` for involved ones. "We'll figure it out later" is not allowed;
  the plan is part of the deliverable.
- **Scope creep** — work needs something outside the approved plan → stop and ask.
- **Unexplained regression** — a previously-green test fails for an unrelated reason.

## 11. Environment

Copy `.env.example` → `.env.local`. `GEMINI_API_KEY` (server-only) and
`AUTH_JWT_SECRET` (Ariantra SSO — MUST equal the platform's value; see
`docs/ARCHITECTURE.md` §Auth) are required. There is no local OAuth anymore.

Local dev convention: **Ari runs on :3001, the platform on :3000** (the
env-aware nav/login links assume this pairing). Start both with one command:
`npm run dev:all` in the platform repo. Ari alone is fine once you're
logged in (the browser cookie lasts 30 days); first login needs the platform up.

⚠️ Per the **Hard rule** at the top of this file: never read or edit `.env*` or the `data/`
database. The human manages those. Only ever touch `.env.example`.

## 12. Deployment & shared Ariantra brand

- **Prod host:** EC2, co-hosted with the Ariantra platform (`../Ariantra-Platform`) as a
  second Next app — pm2 name `kidgemini`, port **3001**, Caddy routes
  `ari.ariantra.com → 127.0.0.1:3001` (the legacy `kidgemini.ariantra.com` host
  still resolves during the rename transition — see
  `../Ariantra-Platform/docs/TECH_DEBT.md`). Deploy with `npm run deploy`
  (`scripts/deploy-rsync.sh`; config in gitignored `scripts/deploy.env`).
- **SQLite in prod** lives at `/var/lib/kidgemini/kidgemini.db` (absolute `DATABASE_PATH`,
  outside the app dir so deploys can't wipe it) with a daily WAL-safe `.backup` cron.
  Exactly ONE instance may run against the file. Full runbook:
  `../Ariantra-Platform/docs/DEPLOY_RUNBOOK.md` §7.
- **Memory:** the shared box is 1 GB — the deploy script enforces a 256 MB heap +
  350 MB pm2 restart cap. Don't remove them; budget and escalation triggers live in
  `../Ariantra-Platform/docs/MEMORY_BUDGET.md`.
- **Shared header:** `src/components/ArNav.tsx` renders the Ariantra nav on every page
  (mounted in `src/app/layout.tsx`). Its styles come from `public/brand/ariantra-brand.v1.css`
  — a LOCAL COPY generated in the platform repo from its `theme.ts`. Never hand-edit it;
  refresh with `npm run sync:brand` (deploy does this automatically). Page content sizes with
  `h-full` inside the `.ar-app-main` scroll area — don't reintroduce `h-screen` on screens.
