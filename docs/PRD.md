# PRD — KidGemini

A kids-safe conversational AI. It feels like talking to Gemini (text **and** voice), but
every response passes through a safety gate before a child sees it, and parents get
alerted to red flags. It can also generate small HTML games that render in a sandboxed
panel on the side — the way Claude renders artifacts.

- **Owner:** kohsa07@gmail.com
- **Status:** Draft v0.2 — business rules incorporated
- **Last updated:** 2026-06-24

---

## 1. Problem & goal

Kids want to use AI chat the way adults do, but general assistants can surface unsafe
content and give parents zero visibility. **Goal:** a delightful, Gemini-quality chat
experience that is safe by construction and keeps a parent in the loop.

### Non-goals (v1)
- No open internet browsing for the child.
- No account system / multi-tenant — single household, local-first.
- No image or video generation.
- Not a content marketplace; games are model-generated, not curated.

---

## 2. Users

| Persona | Needs |
|---------|-------|
| **Child (≈6–12)** | Friendly answers, voice input, fun games, simple UI, never sees scary/adult content. |
| **Parent** | Trust the filter, see what was flagged, set strictness, be alerted to red flags. |

---

## 3. Core experience

1. Child opens the app → big, friendly chat with a mic button.
2. Child types **or speaks** (speech-to-text). 
3. Request is checked by a fast **Flash-Lite classifier** for red flags.
4. The main model answers; the answer is checked **again** before display.
5. If safe → shown to child. If a game is requested → rendered in the **sandboxed artifact panel**.
6. If flagged → child sees a gentle, age-appropriate redirect; **parent is alerted**.

---

## 4. Features

### F1 — Kids-safe chat (must-have)
- Streaming responses, Gemini-quality, with a kid-appropriate system persona.
- Gemini built-in safety settings set to the strictest thresholds.

### F2 — Layered safety gate (must-have)
The gate is **defense-in-depth and fail-closed**, mixing deterministic and probabilistic
layers so most traffic is decided cheaply, predictably, and auditably:

- **Layer 0 — Deterministic rules (₹0, instant, 100% reproducible):** wordlist/normalization
  (profanity, slurs, leetspeak), **PII regex** (phone, address, email, school), known
  grooming-phrase patterns, and a trivially-safe allowlist. Unit-tested against a golden set.
- **Layer 1 — Verdict cache:** identical (normalized) inputs replay the same stored verdict —
  *deterministic by replay*, and a major cost lever.
- **Layer 2 — Flash-Lite classifier (the gray zone only):** `temperature: 0`, **pinned model
  version**, structured output. Reproducible in practice; **no formal determinism guarantee** —
  that's the accepted tradeoff for catching reworded/novel unsafe content.

Applied at two points: **input check** (child's message before the main model) and
**output check** (the model's draft before the child). Categories: sexual, violence/gore,
self-harm, hate, dangerous acts, personal-info disclosure, contact-with-strangers, profanity.
Each → `allow | soft-block | hard-block`; the `ALWAYS_HARD_BLOCK` set (sexual, self-harm,
stranger-contact) can never be downgraded. The gate runs **server-side only** — the client
never receives unvetted text. See `CLAUDE.md` § 3 and `src/lib/safety*.ts`.

> **Status:** the Flash-Lite layer + fail-closed behavior are built; the deterministic rules
> layer, cache, and golden-test set are designed but **not yet implemented**.

### F3 — Parent alerting & dashboard (must-have)
- Every flag is logged with: timestamp, severity, category, the triggering text, the action taken.
- `/parent` dashboard (PIN-gated) shows the alert log + lets the parent tune strictness.
- Real red flags (e.g. self-harm, stranger-contact) raise a prominent alert.

### F4 — Speech to text (must-have)
Tiered by cost vs. accuracy, defaulting to the most private, ₹0 option:
- **Default — in-browser Whisper** (`transformers.js` / `whisper.cpp`, WASM/WebGPU):
  **₹0 at any scale** (compute runs on the child's device) and **audio never leaves the
  device** — the strongest COPPA/DPDP posture. Tradeoff: model download on first use, lower
  accuracy on weak phones.
- **₹0 fallback — Web Speech API:** browser-native; in Chrome it routes audio to Google under
  free-tier terms (may train on data — weaker privacy).
- **Accuracy upgrade (paid, opt-in) — Gemini native audio** (`gemini-2.5-flash` understands
  audio directly) or **Google Cloud Speech-to-Text (Chirp 2)** for best multilingual accuracy.
- **Real-time voice (future) — Gemini Live API.**

Note: children's speech has higher ASR error rates than adults'; closing that gap means
fine-tuning an open model on children's speech (data is the bottleneck, not code).

> **Status:** Web Speech API is built; in-browser Whisper and the Gemini-audio route are
> designed but **not yet implemented**.

### F5 — Game artifacts panel (must-have)
- When the child asks for a game, the model returns self-contained HTML.
- It renders in a **sandboxed `<iframe srcdoc>`** beside the chat (Claude-artifact style).
- The same safety gate runs on generated code/markup.

### F6 — Text to speech (nice-to-have, v1.1)
- Read answers aloud for early readers.

### F7 — Admin usage & cost dashboard (must-have)
- Single-page analytics at `/admin` (PIN-gated), windowed (default **last 30 days**).
- **Headline:** total requests, prompt/output tokens, estimated USD cost.
- **Per-user:** who uses more vs. less — requests, tokens, and cost per child/device.
- **Geo:** breakdown by country / state(region) / city, plus client IP, derived from
  request headers (populated by the CDN/proxy in production).
- **Request log:** each request mapped to its output, model, token split, blocked flag.
- Cost is estimated from a per-model price table (`src/lib/pricing.config.ts`) — update it
  to match current Gemini pricing before relying on the numbers.

---

## 5. Architecture (summary)

```
Browser (kid UI, on-device Whisper STT, artifact iframe)
        │  only ever receives VETTED content
        ▼
Next.js server  ──►  Layered safety gate  ──►  Chat model (Gemini / Vertex)
        │            (rules → cache → Flash-Lite)     │
        └──────────────►  Store (SQLite → Turso/Postgres at scale)
                          alerts · usage · transcripts
```

Full detail lives in `CLAUDE.md` (§ Architecture) and `docs/DESIGN_SYSTEM.md`.

---

## 6. Safety & privacy principles

- **Fail closed:** if the classifier errors or is uncertain, block and log — never show by default.
- **Server-enforced:** no safety decision happens in the browser.
- **Minimal data:** store only what parents need; transcripts stay local (SQLite), never logged to 3rd parties.
- **Transparency:** the child is told kindly when something can't be shown; the parent always sees why.
- **COPPA-minded:** no third-party ad/analytics SDKs, no child PII collection beyond local transcripts.
- **Free-tier-trains-on-data is a known conflict.** Google's *free* Gemini/Web-Speech tiers
  may use prompts/audio to improve their products — unacceptable for children's transcripts at
  production scale. **Decision:** build/demo on free tier; before real daily kid use, switch the
  API key to the **paid tier** (no training on data) and prefer **on-device STT (Whisper)**.
  This is a deliberate cost-vs-privacy tradeoff (see § 10).
- **Data residency:** at multi-region scale, store children's data per-jurisdiction
  (COPPA US, GDPR-K EU, India DPDP) with verifiable parental consent and audited deletion.

---

## 7. Success metrics

- 0 unsafe responses shown in red-team test set.
- Safety-gate added latency < 500 ms p50 (Flash-Lite).
- Parent can find why something was flagged in < 10 s.

---

## 8. Business model & pricing

**Model:** freemium. The paying minority funds the free majority *and* the platform.

**Working assumptions** (re-run with real data — small changes swing this a lot):
- 1,000,000 registered kids; **10% pay (100,000)**, and payers are the **power users**.
- Per chat turn ≈ **$0.0015** (chat + 2 safety calls, with caching). STT = **₹0** (on-device Whisper).
- Power user ≈ 1,800 turns/mo; free user ≈ 100 turns/mo (capped). FX ≈ ₹83/$.

**Cost to serve (monthly):**

| Line | Calc | Cost |
|------|------|------|
| Paying power users (100k) | 100k × 1,800 × $0.0015 | $270,000 |
| Free users (900k, capped) | 900k × 100 × $0.0015 | $135,000 |
| Infra (DB, hosting, cache, CDN) | — | ~$50,000 |
| Fixed opex (team, legal/compliance, support) | — | ~$150,000 |
| **Total** | | **~$605,000 (~₹5 crore)** |

**Break-even price** = total ÷ payers = $605k ÷ 100k = **$6.05 ≈ ₹500/payer/mo** (zero profit).

| Price/mo | Revenue (100k) | vs cost | Margin |
|----------|----------------|---------|--------|
| ₹500 (~$6) | ₹5 cr | break-even | ~0% |
| **₹699 (~$8.4)** | **₹7 cr** | **+$235k** | **~28%** |
| ₹899 (~$11) | ₹9 cr | +$475k | ~44% |

**Decision — list price ≈ ₹699/mo (or ~₹6,000/yr annual).** In line with kids ed-tech ($5–15/mo);
annual plan preferred for cash flow + churn. Re-runnable formula:

```
price ≥ (paying_inference + free_inference + infra + fixed_opex) / paying_users × 1.4
```

**Cost levers that lower the price** (most impactful first):
1. Tighten the **free tier** — it's ~half of variable cost.
2. **On-device Whisper STT** — keeps voice off the bill (already the F4 default).
3. **Safety caching + deterministic rules + smaller classifier** — $0.0015 → ~$0.0008/turn
   drops total ~40% and the floor toward **~₹300**.
4. **Usage tiers / fair-use caps** so extreme "whale" users don't break unit economics.

---

## 9. Scale & cost (architecture deltas)

Cost scales ~linearly: `DAU × turns/day × calls-per-turn × tokens`. The safety gate's two extra
calls are the biggest multiplier — hence the deterministic layers + caching in F2.

| At household scale (₹0) | At ~1M kids |
|-------------------------|-------------|
| SQLite / Turso free | **Managed Postgres** (Aurora / Cloud SQL / Neon) + read replicas |
| Gemini AI Studio free key | **Vertex AI** (enterprise quota, no-training, residency, SLA) |
| No cache | **Redis** cache for safety verdicts + common answers |
| No limits | **Per-user token budgets + rate limits** (built on existing usage tracking) |
| In-browser Whisper | unchanged — on-device compute = ₹0 to us at any scale |

The `UsageStore` / `AlertStore` / `SafetyClassifier` / `ChatModel` interfaces exist precisely so
these swaps are config-level, not rewrites.

---

## 10. Deployment & infrastructure

**₹0 build/demo path (recommended start):** **Vercel Hobby** (best Next.js DX, free geo
headers) + **Turso** free tier (SQLite-compatible → minimal `db.ts` change) + Gemini free-tier
key + on-device Whisper. Caveat: Vercel/Netlify serverless can't persist local SQLite — hence Turso.

**Privacy-first / data-control path:** **AWS** (Lightsail/ECS/EC2 + persistent volume) keeps
SQLite as-is and gives full data residency control — more ops effort. Middle ground:
Railway / Render / Fly.io (persistent disk, current code runs unchanged).

**Netlify:** no advantage over Vercel for this Next.js app — skip.

**Scale path:** Vercel Pro/Enterprise **or** AWS (autoscale) + Vertex AI + managed Postgres +
Redis + per-user limits. Treat **inference as the dominant cost of goods**.

---

## 10a. Authentication & access (force sign-in upfront)

**Decision (2026-06-25):** Chat requires a signed-in Google account. Unauthenticated visitors see
a full-screen `SignInScreen`; the composer is not rendered until authenticated. There is no guest
chatting.

- **Why:** the prior guest flow surfaced "sign in" only reactively (an in-band event over an HTTP
  200 stream) and silently hung on mobile when that event didn't arrive — see
  `docs/BUG-FIX-LOG.md` (2026-06-25). Forcing sign-in upfront makes access state explicit and
  closes the anonymous LLM-cost path.
- **Server contract (fail-closed):** `POST /api/chat` returns **HTTP 401 `auth_required`** for
  unauthenticated callers before any model call. Any future gate/limit must travel as an HTTP
  status the client checks — never only as an in-band stream event.
- **Retained-but-dormant:** the guest token gate (`GUEST_TOKEN_LIMIT`) and per-IP rate limit
  remain in the code but are unreachable while force-login is in force. Revisit if a guest/trial
  tier is reintroduced.

---

## 11. Open questions

- Multiple child profiles per household? (v2)
- Cloud sync vs. strictly local? (privacy trade-off)
- Curated vs. fully generated games?
- Fine-tune an open ASR model on children's speech — when is the accuracy gap worth the data effort?
- Exact free-tier caps that balance acquisition vs. cost.
