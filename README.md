# Ari

*(Product name as of 2026-07-17 — formerly "KidGemini." Internal infra — the
pm2 process, EC2 paths, SQLite file — still uses "kidgemini"; see
[`CLAUDE.md`](./CLAUDE.md) §12.)*

A kids-safe, Gemini-quality chat app (text + voice) with a **server-enforced safety gate**,
**parent alerting**, **sandboxed HTML game artifacts**, and an **admin usage/cost dashboard**.

> Read [`CLAUDE.md`](./CLAUDE.md) before contributing — it's the codebase guide (stack,
> SOLID principles, file/folder naming system). Product intent: [`docs/PRD.md`](./docs/PRD.md).
> Visual language: [`docs/DESIGN_SYSTEM.md`](./docs/DESIGN_SYSTEM.md).

## Quick start

```bash
npm install
cp .env.example .env.local      # then set GEMINI_API_KEY
npm run dev                     # http://localhost:3000
```

- **`/`** — kid chat (type or 🎤 talk). Ask "make me a game" to see the artifact panel.
- **`/parent`** — PIN-gated safety alert log (`PARENT_PIN`, default `1234`).
- **`/admin`** — PIN-gated usage & cost dashboard (tokens, cost, geo, per-user, request log).

## How safety works

Every turn is gated **server-side** (`src/app/api/chat/route.ts`):

1. The child's message is classified by Flash-Lite **before** it reaches the main model.
2. The model's draft is classified **again before** the child sees it.
3. Anything not clearly safe is blocked, the child gets a gentle redirect, and the parent
   is alerted. The classifier **fails closed** — errors block.

The Gemini API key is **server-only**; the browser never receives unvetted content.

## Project map

```
docs/                 PRD + design system
src/app/              routes — page.tsx (kid), parent/, admin/, api/ (server boundary)
src/components/        React UI (Composer, ChatPanel.container, ArtifactFrame, useSpeechInput)
src/lib/              domain logic — gemini, safety, db, geo, pricing/config
src/types/            shared TS interfaces (safety, chat, alert, usage)
```

## Status

Scaffold / skeleton. Streaming, TTS, multi-profile, and real geo-IP enrichment are
follow-ups — see `docs/PRD.md` open questions.
