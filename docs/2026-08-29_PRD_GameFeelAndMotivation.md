# PRD — Game feel and motivation: juice, choice, progress, ghosts

2026-08-29 · Status: **DEFERRED — researched and specified, not started.**
Owner: Ashok. Deferred by owner decision on 2026-08-29 in favour of
`2026-08-29_PRD_Audio.md`, which shares the same root cause (a keyword gate
that leaves most games without the guidance) and has a measured 93% failure
rate.

Companion docs: `2026-08-29_PRD_Audio.md` (started first), `FEATURES.md`,
`PROMPT_MANAGEMENT.md`, `assets/procgen-playbook.ts` (shipped 2026-08-29 —
the difficulty-curve half of "challenge" is already covered there).

## 0. One-paragraph summary

A child's game can be mechanically correct and still feel like nothing
happened. The owner's example: a turbo boost that changed a speed variable
with no whoosh, no shake, no speed lines — *"for a turbo boost, it was
pathetic."* This PRD collects the non-audio half of that gap: feedback juice,
a cosmetic choice at the start, live progress toward the goal, and a ghost of
the player's own best run. Each is cheap; each is evidenced; none is in the
prompt today.

## 1. Why now

Prompted by an owner question on 2026-08-29 listing features from a showcased
game (time loop, ghost system, custom UI and animations, Backrooms
environment, sound, cutscenes, story, two endings) and asking which of those
our build prompt covers. Audit of the fully-unlocked build prompt
(~10,900 tokens, every gate open): **gameplay mechanics YES** (physics
playbook), **sound YES** (gated), **everything else absent**. Three apparent
hits were false positives on inspection — "ghost" is multiplayer collision
wording, "story" matched `history-trim` in code, "tween" matched *between* in
"child aged between 7 and 14".

## 2. Evidence (external research, 2026-08-29)

- **Juice has a ceiling.** Medium and high juiciness outperform *both* no
  juice and **extreme** juice across player experience, intrinsic motivation,
  play time and in-game performance. A prompt that says "add lots of juice"
  would aim at the band that measurably under-performs. Techniques that
  matter: screen shake, particles, **hit-stop** (freeze 3–5 frames on impact),
  tweening between states.
- **For ages 7–12**: *challenge* is the single most important flow element for
  7–9 year olds; **task-irrelevant choice** (e.g. picking your spaceship —
  a choice with no gameplay effect) measurably raised intrinsic motivation and
  learning; feedback must indicate **distance to the goal**, not just score.
- **Self-competition**: racing your own past run beats racing a generic
  opponent — it preserves intrinsic motivation and personalises the benchmark,
  and gives "a multiplayer feel without actual multiplayer".

Caveat carried forward: most of the children's research is on educational /
serious games, not pure entertainment. Treat as strong priors, not proof.

## 3. Goals / non-goals

**Goals.** Make a correct game *feel* correct, using the cheapest evidenced
levers, without growing the always-on prompt materially.

**Non-goals.** Cutscenes (real camera work is expensive in output tokens; a
static intro/outro card gets most of the value and belongs with story).
Time-loop mechanics (complex, niche — *rewind one move* would serve kids
better). The Backrooms aesthetic — liminal horror conflicts with
`CHILD_SAFETY_CORE`; the technique underneath (endless generated interiors) is
already covered by the procgen playbook and only needs a wholesome skin
(endless candy factory, endless library, endless space station).

## 4. Design — four items, in priority order

### 4.1 Juice (P1, every game, ~250 tok)
Hit-stop of 3–5 frames on impact; screen shake scaled to event size;
particles on pickup/hit; tweened transitions between screens and levels;
buttons that visibly depress. **Must carry an explicit calibration clause** —
"enough to feel, not so much it distracts" — because extreme juice measurably
under-performs. Pairs with audio: a turbo boost needs whoosh AND shake AND
speed lines.

### 4.2 Let the child pick something (P1, every game, ~80 tok)
A cosmetic choice on the start screen — character, colour, hat, ship — with
**no gameplay effect**. ~10 lines of code. The best value-per-token item here
and entirely absent today.

### 4.3 Progress toward the goal (P1, every game with a goal, ~60 tok)
"12/50 coins", a progress bar, distance remaining. We already mandate stating
the win condition up front; this is the live counterpart the research requires.

### 4.4 Ghost / personal best (P2, racing · running · endless · time-trial, ~200 tok)
Record the player's best run as an array of positions; replay it as a
translucent racer. Pairs with the seeded procgen shipped 2026-08-29: the same
seed regenerates the same track, so the comparison is fair. Gate by
racing/running keywords. Not for quizzes or board games.

### 4.5 Story premise + two endings (P3, adventure/quest only, ~200 tok)
One line of premise up front, two payoffs at the end ("You escaped" vs "You
escaped AND saved every puppy") — a flag check at the win screen, extending
the existing WIN/GAME OVER rule. **Demoted** from an earlier draft: no
evidence found for this age band, and it costs more than 4.1–4.3.

## 5. Shape and cost

4.1–4.3 are all "every game" and all cheap — one combined playbook
(~350–400 tokens) rather than three sections, to keep the always-on prefix
from growing. Ghost gated separately (~200 tokens). The build prompt is
already ~10,900 tokens fully unlocked; all of this always-on would be ~+6%
per build, which is why the combined-and-gated shape matters.

## 6. Testing (test-first, when started)

Content pins per playbook (as `procgen-playbook.test.ts` does), a token
ceiling per section, gate tests including the silent cases (quiz/board must
not get ghost), and — the load-bearing one — a real generation check: build a
game, confirm it emits hit-stop/shake/particles and a start-screen choice, and
that it still runs in a browser. String assertions alone cannot see whether a
game feels like anything.

## 7. Decisions needed from the owner

1. **Always-on vs gated for 4.1–4.3.** Always-on is ~+400 tok on every build
   (~+1% cost) but reaches every game; gated is free when silent but misses
   the games whose asks do not name the feature — which is exactly the failure
   mode measured in the audio PRD (93% silent).
2. **Whether 4.5 (story/two endings) is wanted at all**, given the evidence
   is thin for 7–14.

## 8. What this does NOT do

It does not touch audio (separate PRD), does not add real multiplayer, and
does not attempt cutscenes, time loops or horror aesthetics. It cannot make a
bland game good — the research is explicit that juice augments an existing
foundation rather than rescuing one.
