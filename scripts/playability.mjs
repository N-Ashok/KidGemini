// Is this game actually PLAYABLE? (BUG-FIX-LOG 2026-08-29 — the fairy puzzle.)
//
// A generated game can throw zero JavaScript errors, draw a canvas, resolve
// every asset — and be impossible to play. That game passed
// verify-game-html.mjs, passed three of Ari's own edit turns, and reached the
// owner, who found it in seconds. The defect was one character:
// `player.x` was committed only inside the RENDERER, behind
// `if (animProgress > 1)`, which is false when an accumulator lands on exactly
// 1.0 — so the fairy's logical position froze after one step and every later
// move recomputed the same destination.
//
// No string assertion can see that. The only instrument that can is one that
// PRESSES KEYS AND LOOKS. The browser half is in scripts/verify-game-html.mjs;
// the decision is pure and lives here so it is testable without a browser.

/** How many times bigger than the idle animation a real change must be. Games
 *  hover sprites and emit particles constantly, so "the screen changed" is not
 *  evidence on its own — it has to change MORE than it does when left alone. */
export const IDLE_MARGIN = 3;

/** Floor for a still game (no idle animation): a couple of stray pixels is not
 *  a moving player. Expressed as a fraction of sampled cells. */
export const MIN_CHANGED = 0.004;

/** Mean absolute difference between two downsampled frame signatures,
 *  normalised to 0..1. Mismatched or empty samples score 0 (no evidence),
 *  never NaN. */
export function sampleDistance(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / (a.length * 255);
}

/* PlaySamples:
   idle — how much the screen changes with NO input at all;
   afterFirstInput — baseline vs after pressing a direction several times;
   forwardVsBack — forward state vs opposite-direction state. THE one that
   catches a frozen logical position: the sprite is drawn somewhere, but no
   input can move it again. */

function significant(change, idle) {
  return change > Math.max(idle * IDLE_MARGIN, MIN_CHANGED);
}

export function judgePlayability(s) {
  if (!significant(s.afterFirstInput, s.idle)) {
    return { playable: false, reason: "no visible change from any input — the player never moves" };
  }
  if (!significant(s.forwardVsBack, s.idle)) {
    return {
      playable: false,
      reason: "the player is frozen after its first step — opposite inputs leave the screen identical (check that the logical position is committed OUTSIDE the renderer)",
    };
  }
  return { playable: true };
}

/** Static lint for the defect that shipped on 2026-08-29 (the fairy puzzle).
 *
 *  A float accumulator advanced by a fractional step and then gated by a
 *  STRICT `>` never fires on the value it is designed to reach:
 *    progress += 0.2   // 0.2 0.4 0.6 0.8 1.0
 *    if (progress > 1) { commitPosition(); }   // 1.0 > 1 is FALSE
 *  so the commit never runs and the player's logical position freezes after
 *  one step. The game throws no error and renders perfectly, which is why the
 *  browser probes could not see it — the pixel probe could not separate the
 *  broken game from the fixed one, because idle sparkle animation changed more
 *  pixels than the sprite's one-tile move.
 *
 *  Precision over recall on purpose: it fires only when the SAME identifier is
 *  both advanced by a fractional literal and compared with `> 1`.
 *  Returns human-readable findings; [] means nothing suspicious. */
export function findFrozenStateRisks(source) {
  const out = [];
  const seen = new Set();
  // `foo.bar += 0.2` / `t+=.05` — fractional step only (integers are fine).
  const stepRe = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\+=\s*(0?\.\d+)/g;
  let m;
  while ((m = stepRe.exec(source)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    // …later compared with a strict `> 1` (not >=, not > 1.5).
    const gate = new RegExp(`${name.replace(/[.$]/g, "\\$&")}\\s*>\\s*1\\s*[)&|]`);
    if (gate.test(source)) {
      seen.add(name);
      out.push(
        `\`${name}\` steps by ${m[2]} and is gated by \`${name} > 1\` — it lands on exactly 1 and the branch never runs. Use \`>= 1\`, and commit the logical state in the step function, not in the renderer.`,
      );
    }
  }
  return out;
}

/** Injected runtime globals a generated game must never REDEFINE.
 *  BUG-FIX-LOG 2026-08-29: a game wrote a defensive
 *  `function playMusic(name){ if (typeof window.playMusic === 'function')
 *  return window.playMusic(name); }`. In a classic script a top-level function
 *  declaration becomes a property of window, so it replaced our helper and
 *  called itself until the stack blew — killing the whole game. The intent was
 *  careful; the effect is fatal, and no error appears until it runs. */
const INJECTED_GLOBALS = ['playSound', 'playMusic', 'loadModel', 'placeModel', 'modelSize', 'modelParts'];

export function findShadowedHelpers(source) {
  const out = [];
  for (const name of INJECTED_GLOBALS) {
    // A DECLARATION (`function playMusic(`), not an assignment — our own
    // runtime defines these as `window.playMusic = function (...)`, which is
    // the legitimate definition and must not be flagged.
    const decl = new RegExp(`function\\s+${name}\\s*\\(`);
    if (!decl.test(source)) continue;
    out.push(
      `\`${name}\` is redefined with \`function ${name}(...)\`. In a classic script that REPLACES the injected window.${name}, so any call to window.${name} inside it recurses until the stack blows and the game dies. Delete the wrapper — ${name}() already exists globally; just call it.`,
    );
  }
  return out;
}

/** Is this artifact a game at all? BUG-FIX-LOG 2026-08-29: a build returned a
 *  ZERO-BYTE artifact and verify-game-html.mjs reported it clean — an empty
 *  file throws no errors, so every check passed. "Nothing" must never read as
 *  success. */
export function looksLikeAGame(html) {
  const s = (html || '').trim();
  if (s.length < 200) return { ok: false, reason: 'empty or near-empty — no game was produced' };
  const hasCanvas = /<canvas[\s>]/i.test(s);
  const hasScript = /<script[\s>]/i.test(s);
  const hasInteractive = /<button[\s>]|id=["']score["']|addEventListener/i.test(s);
  if (!hasScript) return { ok: false, reason: 'no <script> — nothing can run' };
  if (!hasCanvas && !hasInteractive) return { ok: false, reason: 'no canvas and nothing interactive — not a playable game' };
  return { ok: true };
}
