# PRD — Motion playbook + rigid-body physics engine

**Date:** 2026-07-29 · **Owner ask:** *"need to incorporate other physics
engine. now it don't follow driving physics, rotating physics, jumping and so
on."* · **Owner decision (recorded from the 2026-07-29 session):** do **both** —
the prompt playbook now, plus a real engine for the games that need it.

## 1. Problem

The reported symptom is that cars, jumps and spins feel wrong. The cause turned
out **not** to be a missing engine:

> Before this change the prompt taught **nothing about motion anywhere**, except
> inside `SPORTS_PLAYBOOK`, which covers a football and explicitly says *"no
> physics engine"*.

So every driving, jumping and spinning game had its maths reinvented from
scratch per turn, and the quality varied with the model's mood. That is why the
fix is two-part: teach the rules first (they fix most of it and cost nothing),
then add an engine for the cases the rules genuinely cannot cover.

## 2. Tech Feasibility

Engines were measured, not googled — bundled through the same esbuild path
`vendor-three.mjs` uses:

| Engine | License | Bundled | Verdict |
|---|---|---|---|
| **cannon-es** 0.20.0 (curated, 10 exports) | **MIT** ✅ | **82 KB** | Chosen |
| cannon-es (full `export *`) | MIT | 120 KB | Curated list is enough |
| rapier3d-compat | Apache-2.0 ❌ | **1.53 MB** WASM | Rejected twice over: breaches the §8 2 MB first-load cap alone, and `manifest.ts` allows only CC0/MIT for `engine` |

First-load arithmetic with cannon: 618 KB three + 82 KB physics + 5 × 150 KB
models = **1.45 MB**, inside the 2 MB cap. A physics game that uses no models is
0.7 MB.

## 3. Tech Plan

**Phase 1 — the playbook (no new bytes).** `src/lib/assets/physics-playbook.ts`
exports `PHYSICS_PROMPT_SECTION`, wired into `buildTurnSystemInstruction`
behind the existing 3D gate. Covers the four things reported plus the two that
silently break games:

- delta-time integration, everything per-second, and `Math.min(delta, 0.05)` —
  an unclamped delta after a tab switch teleports the player through the floor;
- **jumping**: gravity integration + grounded check, then the three feel fixes
  (coyote time, variable height on key release, ~1.8× gravity while falling);
- **driving**: speed + heading, drag, reverse, and the rule that makes it read
  as driving — *turn rate scales with speed*, so a parked car cannot pirouette;
- **spinning/rolling**: angular velocity with decay, and roll tied to
  `distance / radius` so wheels don't skid;
- **bouncing**: restitution with a rest threshold, or the ball jitters forever.

**Phase 2 — the engine.** `scripts/vendor-cannon.mjs` (sibling of
`vendor-three.mjs`) publishes the curated bundle as `physics.{hash}.js`;
`physicsEnginePromptSection()` teaches it, `<!--USES_PHYSICS-->` opts a game in,
and `cannon-import-lint.ts` guards the import line.

### 3b. The structural change Phase 2 forced

`inject.ts` and `ensure-runtime.ts` both resolved the engine with
`assets.find(a => a.type === "engine")`. With a second engine row that returns
**whichever happens to be first in the manifest** — a 3D game could be handed
the physics bundle as its Three.js engine. Both lookups are now name-keyed
(`type === "engine" && name === "three" | "physics"`), and
`inject.physics.test.ts` builds its fixture manifest **physics-first** so a
regression fails loudly rather than passing by luck of ordering.

### 3c. Why the engine clause is gated on the manifest

`physicsEnginePromptSection()` returns `""` unless the manifest actually carries
the physics engine. Two reasons, both load-bearing:

1. **Honesty.** Teaching `import … from "cannon-es"` before the bundle exists
   hands the model an import that resolves to nothing — a game dead on its
   import line, which no self-healing pass can repair. Manifest-derivation makes
   that impossible by construction, exactly like the model catalog.
2. **Cost.** It is ~253 tokens on every 3D build turn, and most games should
   *not* use it. The clause says so explicitly ("Do NOT use it for a normal
   platformer, runner or driving game"), pinned by test.

Cache contract holds for both sections: the playbook is a plain constant, the
engine clause derives from the manifest only — never from the child's message —
so the system prompt stays byte-identical per turn and Gemini prefix caching
keeps hitting (`COST_TOKEN_BUDGET.md` waste-ledger #4).

**Token cost:** playbook **763** (pinned ≤770 — it grew twice the same day, see
§6b) + engine clause 253, on top of the ~1,712-token model catalog. Both have
their own budget tests.

## 4. Use Cases

| # | Use case | How tackled |
|---|---|---|
| 1 | "My car doesn't turn like a car" | Speed+heading model with turn rate scaled by speed; a parked car cannot spin on the spot |
| 2 | "Jumping feels floaty / wrong" | Coyote time + variable height + faster fall gravity, the three standard feel fixes, taught together |
| 3 | "It spins at a fixed rate and the wheels skid" | Angular velocity with decay; roll tied to `distance / radius` |
| 4 | Game runs fine on a laptop, is unplayable on a phone | Everything per-second × delta; frame-rate independence is the first rule in the clause |
| 5 | Player falls through the floor after switching tabs | `Math.min(delta, 0.05)` — the un-obvious one; invisible in dev, common in real use |
| 6 | "Make a tower of crates I can knock over" | Real rigid bodies: `<!--USES_PHYSICS-->` + cannon-es World/Body/Box |
| 7 | Model reaches for an un-vendored cannon name | `cannon-import-lint.ts` flags it server-side before a dead game reaches a kid — same guard the "DoubleSide" incident bought for three |
| 8 | Model wires a plain platformer through rigid bodies | The clause explicitly forbids it; the playbook maths is both cheaper and better-feeling |
| 9 | Physics game with no 3D (2D canvas) | `USES_PHYSICS` works standalone — the injector does not require the three bundle |

## 5. Test list

- `physics-playbook.test.ts` — every rule above pinned individually, plus:
  static/no-interpolation (cache contract), rides the 3D gate, actually reaches
  the built prompt, contains nothing Three.js-specific (2D games need it too),
  and its own token budget.
- `cannon-import-lint.test.ts` — three-way lockstep between what the bundle
  exports (scraped from `vendor-cannon.mjs`), what the lint allows, and what the
  prompt teaches; alias and namespace-import handling; edit-only violations.
- `inject.physics.test.ts` — name-keyed engine resolution (fixture is
  physics-first on purpose), both bare specifiers mapped, marker stripped like
  every other, physics-without-3D, and `ensureAssetRuntime` idempotence.
- `manifest.test.ts` — the new cross-type name-uniqueness invariant (§6).

## 6. The bug this work caused, and the guard added

`vendor-cannon.mjs` first named its entry `cannon` and upserted with
`findIndex(a => a.name === 'cannon')`. The military batch ships a **model**
called `cannon` (the wheeled artillery piece), so the engine row **replaced the
model** — it vanished from the manifest while its GLB sat perfectly fine on the
host. Caught within seconds by the taxonomy tests that stage 4 of the vendor
script runs, which is exactly why that gate exists.

Fixed three ways: the engine is named `physics`; vendor upserts are name+type
qualified; and `manifest.test.ts` now pins **asset names as unique across
types**, so any future `vendor-*.mjs` cannot silently delete an asset this way.
The orphaned `cannon.4eb81a.js` object stays on the append-only host forever,
unreferenced and harmless.

## 6b. Follow-ups shipped the same day (from live play)

The owner played a 3D tank game in the preview for about an hour, which
surfaced three things no test had:

1. **"My system got heated up."** The game obeyed every existing render-budget
   rule (pixel ratio capped at 2, no shadows) — it simply never stopped. Two new
   playbook rules: pause on `visibilitychange`/blur **with a clock reset on
   resume** (a naive pause teleports everything on the first frame back), and
   cap to 60fps. **Owner decision: 60 is the cap** — most of the Apple fleet
   (base iPad, iPad Air, MacBook Air) is 60Hz already, ProMotion devices are
   fanless and throttle under sustained 120 anyway, and the cap also fixes
   per-frame-movement games running literally twice as fast on 120Hz.

2. **"Once it is made, edits don't need to touch it?"** Correct, and it
   invalidated the prompt-only approach for the ~200 games that already exist:
   an edit is a minimal SEARCH/REPLACE patch and never retrofits a loop the
   child didn't ask about. So the pause + cap ALSO ship as an injected **frame
   governor** (`frameGovernor()` in runtime-helpers, wired into
   `ensureAssetRuntime`), which runs on every preview render — including stored
   HTML that long predates it. Measured on the owner's real tank game:

   | | visible | hidden |
   |---|---|---|
   | before | 54.0 fps | **53.3 fps** |
   | after | 46.5 fps | **0.0 fps** |

   Its design is dominated by failing safe across games we can no longer test
   individually: every skip re-requests (a governor that forgets to is a dead
   game), throttling is keyed per callback via a WeakMap so a two-loop game
   keeps both, an unkeyable callback is simply never throttled, and it pauses
   only on `document.hidden` — what browsers already do — so it introduces no
   new resume-delta behaviour for old games with no delta clamp.
   **Not reachable:** published arcade games are static S3 HTML under the
   immutability contract; there is no injection point for them.

3. **A silent spawn deadlock.** The tank game held crushed enemies in the
   `enemies` array until a level-up needing 1000 points, while spawning was
   gated on `enemies.length < 3`. Squash three tanks and no enemy ever spawns
   again — maximum reachable score 700, no error anywhere, and the child reports
   it as "constantly stuck". Now a playbook rule.

**Token cost after all three:** the playbook went 456 → 763. The budget test was
raised from the measured value each time (470 → 670 → 770) with the reason
recorded; the comment now says the section has stopped being cheap and the next
addition should displace something rather than extend it.

## 6c. Amendment 2026-08-06 — solidity is the default (SOLID THINGS)

Owner report: "3d objects should not pass through each other. but that is not
happening and we have to specifically tell." The playbook taught motion feel
but nowhere said solidity is a DEFAULT, so Gemini wrote collision only where
game logic obviously needed it (pickups, finish lines) and scenery stayed
ghost-permeable.

Fix: a new **SOLID THINGS** playbook clause — bounds on every solid, push
overlap out along the shortest axis so movers slide, pickups/triggers exempt
(overlap IS the event). The owner set a token cap of ~50 for it; it landed at
~63 by leaning on catalog rule 6 (`boundsAt`) for the how-to instead of
repeating it. Budget test raised 770 → 830 from the measured value (826).

Same reach caveat as every prompt rule: it applies to newly generated/edited
turns only. Existing games stay as-built until their next edit — there is no
healing floor for game logic, and an edit's minimal SEARCH/REPLACE patch will
not retrofit collision the child didn't ask about.

## 7. Out of scope

Vehicle raycast suspension (`RaycastVehicle` is deliberately not vendored — the
playbook's speed+heading model is better for kids' games and far easier for the
model to get right), cloth/soft bodies, continuous collision detection,
physics-driven character controllers, and any 2D physics engine.
