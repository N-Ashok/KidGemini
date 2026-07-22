# Design System — Ari (formerly KidGemini)

A documented, token-driven visual language. The aim: **professional, modern, and genuinely
aesthetic — while warm and easy for a child.** Polished, not childish. Tokens here map 1:1
to `tailwind.config.ts`; never hardcode values in components.

> This is the "codebase design document" — change the system here, then in `tailwind.config.ts`,
> then consume via Tailwind classes. One source of truth.

---

## 1. Principles

1. **Calm, not chaotic.** Lots of whitespace, one clear focal action at a time.
2. **Big & forgiving.** Large tap targets (min 44×44px), big readable type, generous radius.
3. **Soft & friendly geometry.** Rounded corners (`rounded-kid`), gentle shadows, no hard edges.
4. **Trust through clarity.** Safety states are always legible (safe/warn/danger have fixed colors).
5. **Accessible by default.** WCAG AA contrast minimum, focus rings always visible, motion gentle and reduceable.
6. **Professional polish.** Consistent spacing scale, restrained palette, real typographic hierarchy — looks like a quality product, not a toy.

## 2. Color (tokens)

| Token | Hex | Use |
|-------|-----|-----|
| `brand-500` | `#2f8bff` | primary actions, links, focus |
| `brand-600/700` | `#1f6fe0` / `#1957b0` | hover/active |
| `brand-50/100` | `#eef6ff` / `#d9ecff` | surfaces, chat bubbles (assistant) |
| `safe-500` | `#22c55e` | "safe / approved" status |
| `warn-500` | `#f59e0b` | soft-block / caution |
| `danger-500` | `#ef4444` | hard-block / parent alert |
| `ink-900/700/500` | text high/med/low |

Status colors are **semantic and fixed** — never reuse `danger` for decoration.

## 3. Typography

- **Display** (`font-display`): headings, the app name. Rounded, friendly sans.
- **Body** (`font-body`): chat + UI. High legibility, ≥16px base (kids + accessibility).
- Scale: `text-sm` (meta) · `text-base` (body) · `text-lg` (chat) · `text-2xl`/`text-3xl` (headings).
- Line length capped (~`max-w-prose`) for readability.

## 4. Spacing & shape

- Spacing on a 4px grid (Tailwind default scale). Prefer `gap-4 / p-6 / space-y-4`.
- Radius: `rounded-kid` (1.25rem) for cards, bubbles, buttons; `rounded-full` for the mic/avatar.
- Elevation: soft, low-spread shadows (`shadow-sm` / `shadow-md`). No harsh drop shadows.

## 5. Core components (visual contracts)

- **ChatBubble** — assistant: `brand-50` surface, ink-900 text; child: `brand-500` surface, white text. `rounded-kid`, comfy padding.
- **Composer** — large rounded input, prominent send, big circular **MicButton** (pulses gently while listening).
- **MicButton** — `rounded-full`, `brand-500`; listening state pulses with reduced-motion fallback.
- **ArtifactFrame** — the side panel hosting the sandboxed game iframe; titled header, clear "made by AI" label, soft border.
- **SafetyBadge** — small pill using `safe/warn/danger`; used in the parent dashboard.
- **ParentAlertCard** — clearly separated, `danger`/`warn` accent, shows category + the triggering text + action taken.

## 6. Layout

- **Kid view:** chat centered, `max-w-2xl`; artifact panel slides in on the right (desktop) or as a full-screen sheet (mobile). Two-pane on wide screens, single-pane stacked on narrow.
- **Parent view:** clean dashboard, list of alert cards, settings panel. More "admin/professional" tone but same tokens.

## 7. Motion & accessibility

- Transitions 150–250ms, ease-out. Respect `prefers-reduced-motion` (disable pulses/slides).
- Visible focus ring (`brand-500`) on every interactive element.
- All controls keyboard-reachable; mic and send have aria-labels; live region announces new messages.

## 8. Voice & tone (copy)

- Warm, simple, encouraging. Short sentences.
- Block/failure copy is split by CAUSE — never one message for all (source of truth: `src/lib/chat-copy.ts`):
  - **Genuine input block** (`KIND_REDIRECT`) — child typed something we won't engage with (profanity/self-harm/PII) → gentle topic change, never scary: *"Let's talk about something else! How about a fun fact, a story, or a game? 🌟"* — don't invite a rephrase of the blocked thing.
  - **Model false-positive** (`MODEL_GLITCH_RETRY`) — request was fine, the provider's own safety glitched mid-build → own the hiccup and give an *actionable* hint (adding "what it's about + who it's for" clears these), never a topic change: *"Hmm, that one tangled me up! Try telling me a bit more — what your game is about and who it's for — and I'll build it. ✨"*
  - **Build cut off** (`BUILD_INCOMPLETE_RETRY`) — the model returned "done" on a truncated game and the corrective retry couldn't finish it → never ship a blank/dead artifact; invite a retry and nudge toward a smaller, two-step ask.
- Parent-facing copy is plain and factual.

---

## 9. CSS architecture

- **Tailwind utility-first**, with a small set of `@layer components` primitives in
  `src/app/globals.css` for things reused everywhere (`.card`, `.btn`, `.bubble`).
- **Token flow:** value defined in `tailwind.config.ts` → consumed via utility class →
  never a raw hex in a component. Change the look in one place.
- **CSS variables** hold fonts (`--font-display`, `--font-body`) so typography can be
  themed without touching components.
- **Naming of CSS classes:** semantic, `kebab-case`, variant via suffix
  (`btn`, `btn-primary`, `btn-ghost`; `bubble`, `bubble-child`, `bubble-assistant`).
- No CSS-in-JS, no inline styles except dynamic one-offs.

### Base layer (globals)
- `body` sets background (`brand-50`), base text color, and body font.
- Global `:focus-visible` ring — accessibility is on by default, not per-component.
- `prefers-reduced-motion` disables the mic pulse and slide transitions.

## 10. Layout structures

Two top-level shells, both token-driven:

```
Kid shell (/)                         Admin/Parent shell (/parent, /admin)
┌───────────────────────────┐        ┌───────────────────────────┐
│ header (logo · parent link)│        │ header (title · nav)       │
├───────────────┬───────────┤        ├───────────────────────────┤
│ chat (max-w-2xl)│ artifact │        │ cards / tables (max-w-6xl) │
│ scrolls         │ iframe   │        │                            │
│                 │ 420px    │        │                            │
├───────────────┴───────────┤        └───────────────────────────┘
│ composer (input·mic·send) │
└───────────────────────────┘
```

- **Kid view:** `h-screen` flex column; chat is the scroll region (`flex-1 overflow-y-auto`),
  composer pinned at the bottom. Artifact panel is a fixed `420px` right column on `md+`,
  a full-screen sheet on mobile (hidden until a game arrives).
- **Admin view:** centered `max-w-6xl`, stacked `.card` sections; tables scroll on overflow.

## 11. Component catalog & variations

| Component | File | Variants / states |
|-----------|------|-------------------|
| **Button** | `.btn-primary`, `.btn-ghost` | primary (brand fill) · ghost (soft brand) · disabled (auto via `:disabled`). Sizes via padding utilities; min 44px tap target built in. |
| **ChatBubble** | `.bubble-assistant`, `.bubble-child` | assistant (brand-50 / ink) · child (brand-500 / white) · thinking (assistant + `animate-pulse`). |
| **MicButton** | `Composer.tsx` | idle (brand-500) · listening (`mic-listening` pulse, danger-500) · unsupported (hidden). |
| **Composer** | `Composer.tsx` | enabled · disabled (while busy). Mic shown only if Web Speech is supported. |
| **ArtifactFrame** | `ArtifactFrame.tsx` | hidden (no game) · open (sandboxed iframe). Always shows the "Made by AI" label. Device pills (Fit/Laptop/Tablet/Phone) restyle the same iframe: `rounded-kid` device card, `shadow-md`, `bg-neutral-100` backdrop, scaled-to-fit via transform. A ⟳ rotate toggle (2026-07-16) appears only for orientable presets (Tablet/Phone), swapping width/height via `orientedSize()` for a landscape preview. |
| **IdeaMicTab** | `IdeaMicTab.tsx` | compact 44×44 circular icon in all states (2026-07-16 — replaced the old always-labeled wide pill): tucked/out (brand-500) · listening (`mic-listening` pulse, danger-500). An always-visible "Idea"/"On" caption sits BELOW the icon (dock-label style), not beside it, so the label stays discoverable (2026-07-14's fix) without widening the button · unsupported (hidden) · error (amber banner with `mic-errors` copy) · coaching (first-run: ink-900/30 dim + `idea-coach-wiggle/glow/pop/type/fly` from globals.css, voice-over via useTextToSpeech) · nudging (wiggle+glow only, once). Drags vertically along the preview edge; min 44px target. Listening bar includes a direct "✨ Make my game better!" CTA (2026-07-16, same bundle-send as IdeaBag's own button). |
| **IdeaBag** | `IdeaBag.tsx` | chip: empty (white, 50% opacity, disabled) · counted (white + danger-500 badge), `shadow-md`. Panel (2026-07-16 redesign — bottom sheet on mobile / centered 420px `rounded-kid` card on desktop, `shadow-lg`, own corner ✕): idea rows on `brand-50` are always-editable (`<textarea>`, commits on blur — no edit-mode toggle), 🔊 brand-500, ✨ CTA brand-500→600 `shadow-md`, "Keep playing" ghost. |
| **PanelResizeHandle** | `PanelResizeHandle.tsx` | idle (neutral-200 grip) · hover/focus (brand-300/500) · dragging (brand-500 + full-window col-resize shield). `role="separator"`, keyboard ←/→. |
| **Card** | `.card` | base surface. Variant by left accent border: `border-l-4 border-danger-500/warn-500/brand-300`. |
| **Stat** | `admin/page.tsx` | metric tile (label + big value). |
| **SafetyBadge / AlertCard** | `parent/page.tsx` | severity accent: high=danger · medium=warn · low=brand. |
| **Table** | `admin/page.tsx` | head + rows; empty state row when no data. |

### State conventions (apply to every interactive component)
- **Hover:** one step darker on the same token (`brand-500 → brand-600`).
- **Active:** two steps darker (`→ brand-700`).
- **Focus:** global `brand-500` ring (never removed).
- **Disabled:** reduced affordance via native `:disabled`; never remove focus ring.
- **Loading:** `animate-pulse` on the placeholder bubble/skeleton.
