# CLAUDE.md — KidGemini codebase guide

This is the single source of truth for **how we build** in this repo. Claude Code (and any
human) should read this before writing code. Product intent lives in `docs/PRD.md`; visual
language lives in `docs/DESIGN_SYSTEM.md`.

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
2. **The client never receives unvetted content.** The safety gate runs server-side before any token reaches the browser.
3. **Fail closed.** If the safety classifier errors or is unsure → block + log, never show.
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

## 7. Workflow

- `npm run dev` — local dev. `npm run typecheck` before considering anything done.
- Keep diffs focused. One concern per change.
- New module? Give it a type/interface in `src/types` first (Dependency Inversion).
- Touching safety? Add/extend a test in the mirrored `.test.ts`. Safety code is never untested.

## 8. Environment

Copy `.env.example` → `.env.local`. `GEMINI_API_KEY` is required and **server-only**.

⚠️ Per the **Hard rule** at the top of this file: never read or edit `.env*` or the `data/`
database. The human manages those. Only ever touch `.env.example`.
