# PRD — Preview Perf Panel (per-model load, colour-coded)

**Date:** 2026-07-30 · **Owner ask:** debugging a 3D cricket game that heats up
a laptop as soon as preview turns on, with no way to tell which game
component is responsible. Owner decisions from this session: a debug-only
panel (same gate as the existing console tab) · shows overall FPS/draw calls
AND a per-model breakdown · colour-coded green/yellow/red by **load**, not
"cost" (cost implies money; this is compute load) · load = triangle count ×
live instance count × whether it's actively animated.

## 1. Problem

A kid's cricket game loads 24 separately-animated characters (3 principals +
9 fielders + 12 crowd) and the owner's laptop fan spins up the instant preview
opens. There is currently no way to see *which* part of a generated game is
expensive — the owner had to reason it out from reading the generated source
by hand (this session's own diagnosis). That doesn't scale past one game the
owner happens to read personally; every future heavy game (multiplayer
crowds, particle effects, big worlds) needs the same manual archaeology.

## 2. Tech Feasibility

The hard part isn't measuring — three.js already tracks draw calls and
triangles (`renderer.info`) — it's that the renderer, scene, and any
`AnimationMixer`s are **private variables inside the generated game's own
module script**. The parent preview panel (`ArtifactFrame.tsx`) can't see
them, and every game's code is different (that's the whole point of
generation), so we can't grep for a "scene" variable name.

The fix is the same pattern already used twice in this codebase
(`loadModelHelper()` in `runtime-helpers.ts`, and the console-capture /
verify-probe scripts in `game-console.ts` / `preview-verify.ts`):
**instrument the shared, injected runtime, not the generated game.**

1. **`loadModel()`** (already the ONE centralized place every game fetches a
   library model through) gets a small addition: after building `obj`, walk
   its meshes once, sum triangle counts, and record `{name, triangles}` in a
   `window.__arPerf` registry. This needs no change to any generated game —
   it's the existing helper in `runtime-helpers.ts`.
2. **The vendored `three.js` bundle** (`scripts/vendor-three.mjs`) gets two
   tiny wraps at build time: `WebGLRenderer`'s constructor registers the
   instance so the probe can read `.info.render.calls/.triangles`, and
   `AnimationMixer`'s constructor/`update()` register+count which roots are
   currently being animated (keyed against the same `window.__arPerf` model
   registry via a `WeakMap<Object3D, name>` populated by `loadModel`). Both
   wraps are additive — they call straight through to the real
   constructor/method, so behavior for every existing game is unchanged;
   only new bookkeeping is added.
3. **A new injected probe script** (`perf-probe.ts`, same shape as
   `preview-verify.ts`'s `buildVerifyScript()`): once a second, reads
   `window.__arPerf` + the registered renderer's `info`, computes an FPS
   estimate, buckets each named model into green/yellow/red by relative load,
   and `postMessage`s a snapshot to the parent — reusing the existing
   message-channel convention in `preview-messages.ts`.
4. **The parent panel**: a new debug-gated tab in `ArtifactFrame.tsx`
   (`tab: "perf"`), visible under the exact same `localStorage
   kidgemini:debug === "1"` flag that already hides the console tab from
   kids — this is owner/debug tooling, never kid-facing. Shows overall
   FPS/draw calls, then a sorted list (highest load first) of model name →
   instance count → triangle count → animated (yes/no) → colour chip.

**Why this reaches OLD games too, not just new ones:** `ensureAssetRuntime()`
already rewrites any 3D game's import map to point at the manifest's current
`"three"` engine entry on every render (repair/verify/delivery all pass
through it) — so shipping a new instrumented engine bundle (a new
content-hash URL) automatically upgrades every existing stored game the next
time its preview loads. No per-game migration needed, same as the frame
governor landed on old games automatically (2026-07-29 precedent).

**Scale ceilings:** the engine bundle budget is 650 KB (currently ~619 KB
after the 2026-07-29 Quaternion/Euler addition) — this instrumentation is a
few dozen lines of wrapping code, estimated **+1–2 KB**, comfortably inside
budget; must still be measured and stated at implementation time, not
assumed. The probe posts one small JSON snapshot per second — negligible
next to the render loop itself.

## 3. Tech Plan

- `src/lib/assets/runtime-helpers.ts`: extend `loadModelHelper()` to record
  `window.__arPerf.models[name] = { triangles, instances: [...roots] }` after
  each successful load (fail-soft: unchanged on load failure, matches the
  existing `return null` floor).
- `scripts/vendor-three.mjs`: wrap `WebGLRenderer` and `AnimationMixer` in the
  bundle entry (additive wraps, real behavior untouched); re-run `--upload`
  to publish a new hash-named engine bundle; update `manifest.json`'s
  `"three"` engine entry to the new URL (same upload-then-verify contract as
  every other asset).
- `src/lib/assets/perf-probe.ts` (new): `buildPerfProbeScript()` +
  `injectPerfProbe()`, mirroring `preview-verify.ts`'s shape exactly — pure,
  no DOM, no React, unit-tested as a string-builder.
- `src/lib/preview-messages.ts`: add `PERF_PROBE_SOURCE = "ari-perf-probe"`.
- `src/lib/assets/ensure-runtime.ts`: inject the perf probe alongside the
  frame governor, idempotent via its own marker, same as every other
  injected script here.
- `src/components/usePerfProbe.ts` (new): small hook, same shape as
  `usePreviewVerify.ts` minus the repair state machine — just listens for
  `PERF_PROBE_SOURCE` messages and holds the latest snapshot.
- `src/components/ArtifactFrame.tsx`: new `"perf"` tab, gated by the existing
  `debug` flag, listed next to (not replacing) the console tab. Renders
  overall FPS/draw-calls line + the sorted, colour-chipped model list.
- Docs same-change: `FEATURES.md`, `docs/PRD-SELF-HEALING-PREVIEW.md` (cross
  reference — this reuses its injection/message-channel pattern),
  `SCALABILITY_ISSUES.md` (crowd/character-count load class, so the next
  heavy generated game has a named precedent instead of a fresh
  investigation).
- Tests first: perf-probe.ts snapshot/threshold logic (pure functions,
  bucket assignment); runtime-helpers.ts model-registry recording;
  ensure-runtime.ts idempotent injection (byte-identical on double-injection,
  like every other floor here).

## 4. Use Cases

| # | Use case | How tackled |
|---|---|---|
| 1 | Owner suspects a game is heavy, wants to know which part | Perf tab shows a ranked list, worst offender first, colour-coded — no source reading required |
| 2 | Owner just fixed something (e.g. made fielders activate on demand) and wants to confirm it helped | Re-open the perf tab after the edit; the previously-red model's instance/animated count drops, chip changes to yellow/green |
| 3 | A totally different heavy game (e.g. a future multiplayer crowd scene) | Same instrumentation, zero per-game work — it's in the shared engine + shared loader, not the generated code |
| 4 | A kid opens the preview (no debug flag set) | Tab doesn't exist for them — same precedent as the console tab; zero kid-facing surface change |
| 5 | A game that doesn't call `loadModel` at all (pure procedural 2D/3D) | Probe still reports FPS/draw calls (from the renderer wrap), just an empty per-model list — never breaks on a model-free game |
| 6 | An old, already-stored game (built before this ships) | Gets the new engine bundle automatically next render via `ensureAssetRuntime`'s existing import-map rewrite — no migration step |

## 5. Test list

- `perf-probe.ts`: bucket thresholds (green/yellow/red) assign correctly for
  known triangle/instance/animated combinations; snapshot shape is stable;
  idempotent injection (double-inject → byte-identical, matching every other
  injected script's contract).
- `runtime-helpers.ts`: `loadModelHelper()` records triangle count once per
  loaded object; a failed load records nothing (fail-soft, unchanged
  contract); geometry with no index (non-indexed triangles) still counts
  correctly.
- `ensure-runtime.ts`: perf probe inserted alongside the frame governor on a
  3D game; absent on a plain 2D game (identity, same as today); marker makes
  re-injection idempotent.
- `usePerfProbe.ts` / `ArtifactFrame.tsx`: perf tab absent unless
  `kidgemini:debug === "1"`; renders a sorted list highest-load-first; a
  model with zero instances currently loaded doesn't show (no stale rows
  after a scene changes).
- Engine bundle: budget test still passes (≤650 KB) after the
  `WebGLRenderer`/`AnimationMixer` wraps; `--upload` verify step (re-hash the
  served bytes) passes before the manifest entry is written, per the existing
  contract.

## 6. Out of scope

Historical/graphed perf-over-time (this is a live snapshot, not a
timeline); automatic in-chat suggestions ("turn off the crowd") — the owner
reads the panel and asks the chat to fix it, same self-heal path as today;
memory-leak detection (JS heap growth) — this panel is compute-load only, not
memory; any kid-facing surface at all — this is owner/debug tooling
exclusively, gated the same as the console tab.

## 7. Addendum (2026-07-30, same day) — a second, kid-facing surface

**Owner feedback, in order:** the debug raw panel (§4-§6 above) is fine for
admins, but kids are the actual developers of these games and need something
too. NOT the technical per-model breakdown — kids don't know what
"triangles" means, and a raw model asset name like `grandpa` or `fielder`
means nothing to them. What a kid DOES already recognize is the SYMPTOM: the
game feels stuck, not smooth. So this ships as a **second surface**, not a
simplification of the first:

| | Debug Perf tab (§1-§6) | Kid-facing slowdown banner (this section) |
|---|---|---|
| Audience | Owner/admin | The kid |
| Gate | `localStorage kidgemini:debug === "1"` | None — always live |
| Shows | FPS, draw calls, per-model triangles/instances/animated/load, colour chips | "🐢 This game is running slow" — no numbers, no model names |
| Action | None (read-only diagnosis) | "Make it faster" button |
| Where it lives | New `perf` tab, same shell as Console | Floating banner over the live preview, top-center (mic/help tabs dock at the right edge, so this never collides with either) |

**Why raw model names were rejected for the kid surface:** the whole point
of the debug tab (§2) is that "which part is expensive" requires reading
triangle/instance/animation internals — exactly the vocabulary a kid
generating a game with natural language has no reason to know. Surfacing
`grandpa: 3 instances, animated, red` to a nine-year-old would read as a
bug report in a foreign language, not a nudge they can act on. The banner
instead reduces the entire diagnosis to the one bit a kid can already feel
firsthand (smooth vs. not) and pairs it with a single button that does the
technical part FOR them.

**Debounce, not a raw FPS check (`src/lib/slowdown-nudge.ts`, new, pure,
unit-tested):** a single dipped frame (GC pause, a one-off hitch) must never
flap the banner on/off. `nextSlowdownBannerState()` requires
`SUSTAINED_LOW_SAMPLES` (5) CONSECUTIVE samples below `LOW_FPS_THRESHOLD`
(30 fps) — at perf-probe.ts's own `PERF_SAMPLE_MS` (1s) cadence, roughly a
5-second sustained slowdown — before showing, and hides again the moment FPS
recovers (any healthy sample resets the streak to zero). After the kid taps
"Make it faster" the reducer hides the banner and starts a `COOLDOWN_MS`
(45s) window during which no amount of continued low FPS re-shows it — the
fix request is presumably in flight, so re-nagging immediately would read as
the button having done nothing. Framework-free, same house style as
`idea-mic.ts`/`stuck-signal.ts` — a small event-in/state-out reducer,
wired into React only by `ArtifactFrame.tsx`'s `useReducer` + two
`useEffect`s (one resets on a new `docKey`/generation, one feeds each
incoming `usePerfProbe` snapshot's `fps` into the reducer as a `"sample"`
event).

**The real technical fix request (`buildSlowdownHint()`, same file):** built
from the SAME `PerfSnapshot.models` list the debug tab renders — sorted by
`load` (defensively, not trusting the snapshot's own sort), taking the single
heaviest model and phrasing e.g. *"The game is running slow. The heaviest
thing in the scene right now is the 'grandpa' model (3 instances, animated).
Reduce its cost — fewer instances, remove animation, or a simpler version —
without changing what the game is about."* The kid NEVER sees this string —
it is sent straight into the ordinary chat pipeline
(`ChatPanel.container.tsx`'s `handleSend`, the same function next-ask hint
chips call) via a new `onFixSlowdown?: (hint: string) => void` prop on
`ArtifactFrame`, wired in the container exactly like `onCaptureIdea`/
`helpTab` (absent prop = feature hidden). A game with no heavy model on
record (a pure 2D/procedural game, or the registry simply empty) still gets
a generic, still-actionable fallback hint — the banner logic never depends
on `loadModel` having been called.

**Tests:** `src/lib/slowdown-nudge.test.ts` — the full debounce/cooldown
table (no false-positive on one dip, shows only after the sustained run,
hides on recovery, cooldown suppresses re-triggering, cooldown expiry allows
a fresh trigger, `reset` clears everything for a new generation) and the
hint builder (names the heaviest model, ignores lighter ones, singular vs.
plural instance phrasing, never leaks a triangle count, generic fallback
when no model is loaded, always keeps the fix in scope).

## 8. Addendum (2026-08-04) — server-visible reporting

**Gap:** an owner asking "is game X actually slow" had no way to check
without opening it themselves with `kidgemini:debug=1` set — neither the
debug Perf tab nor the kid-facing banner told anyone outside that one
browser tab that a slowdown happened.

**Fix:** the moment the kid-facing banner (§7) flips visible,
`ArtifactFrame.tsx` fires a fire-and-forget `POST /api/perf/slow-game`
(`lib/perf-report.ts`'s `buildSlowGameReport`/`reportSlowGame`) carrying
`{docKey, fps, heaviestModel: {name, instances, animated}, conversationId?,
chatId?, messageId?}` — the SAME `heaviestModel()` selection §7's
`buildSlowdownHint()` uses (extracted into a shared pure function so the log
and the kid's fix request can never disagree about which model is the
culprit). The route (`src/app/api/perf/slow-game/route.ts`) is unauthenticated
and fail-open (same shape as `/api/screen-time/heartbeat`): it only ever
`console.warn` a `[perf]`-tagged line and returns `{ok:true}`, never a
non-200 — this is best-effort diagnostic logging, not a path a kid's
session can ever be broken by. `logger.ts`'s existing console patch mirrors
it into `logs/app.log` and pm2 stdout, so `pm2 logs kidgemini | grep
"[perf]"` on the box surfaces every real slowdown as it happens.

**No new rate limit needed:** naturally throttled by §7's own existing
5-consecutive-sample debounce and 45s post-fix cooldown — a report can fire
at most once per debounce/cooldown cycle per session, same bound the banner
itself already has. See `docs/SCALABILITY_ISSUES.md` #7 for the updated
note on this making a filtered summary of perf data owner-visible in
production for every session, not just debug ones (the underlying
`window.__arPerf` registry itself is unchanged — still debug-tab-only).

**Tests:** `src/lib/perf-report.test.ts` (payload shape, fps rounding,
optional-id passthrough, truncation of an implausibly long id) and
`src/app/api/perf/slow-game/route.test.ts` (valid report logs and returns
ok, no-heaviest-model case, malformed/non-JSON body still fails open,
non-finite fps never crashes the route).
