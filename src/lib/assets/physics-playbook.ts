// The motion/physics playbook (2026-07-29, docs/2026-07-29_PRD_Physics.md).
//
// Owner report: "now it don't follow driving physics, rotating physics, jumping
// and so on". The cause was not a missing engine — it was that the prompt
// taught NOTHING about motion anywhere except SPORTS_PLAYBOOK's football, so
// every car, jump and spin had its maths reinvented per turn and the feel
// varied wildly. This clause teaches the small set of rules that separate
// "moves" from "feels right", and it is the reason most games will never need
// the rigid-body engine at all.
//
// CACHE CONTRACT: a plain constant with no interpolation — it cannot vary with
// the child's message, so the system prompt stays byte-identical per turn and
// Gemini prefix caching keeps hitting (COST_TOKEN_BUDGET.md waste-ledger #4;
// same rule as SPORTS_PLAYBOOK and the people clause). Pinned by test.
//
// Deliberately engine-agnostic and dimension-agnostic: every rule below works
// on a 2D canvas as well as in a Three.js scene (pinned by test).

import type { AssetManifest } from "./manifest";
import manifestJson from "./manifest.json";

export const PHYSICS_PROMPT_SECTION = `**Movement that feels right**: move by VELOCITY over time, never a fixed nudge
per frame. Every number below is per-second, multiplied by the frame's delta,
so it runs the same on a slow phone and a 120Hz laptop. Clamp it —
\`delta = Math.min(delta, 0.05)\` — or a backgrounded tab returns a huge delta
and one step teleports the player through the floor.

   JUMPING. Keep \`velocityY\`: each frame \`velocityY += gravity * delta\`, then
   \`y += velocityY * delta\`; on landing set \`grounded = true\`. Jump only when
   grounded, or kids get infinite mid-air jumps. Add all three feel fixes:
   (1) coyote time — still allow it ~0.1s after leaving an edge; (2) variable
   height — if the key is released while rising, halve velocityY so a tap hops
   and a hold leaps; (3) fall faster than you rise (~1.8x gravity while
   velocityY < 0).

   DRIVING. A car is not free x/y movement: it has \`speed\` and a \`heading\`
   angle. Accelerate toward a max, apply drag (\`speed *= 0.98\`) so it coasts,
   allow negative speed for reverse, and move along the heading
   (\`x += Math.sin(heading) * speed * delta\`, same with cos for z, or y in 2D).
   The rule that makes it read as driving: turn rate scales with speed —
   \`heading += steer * turnRate * (speed / maxSpeed) * delta\` — so a parked car
   cannot spin on the spot. Set the object's rotation to the heading.

   SPINNING + ROLLING. Give spinners an \`angularVelocity\`, do
   \`rotation += angularVelocity * delta\`, and decay it — not a fixed
   \`rotation.y += 0.01\`. A rolling ball or wheel spins by the distance it
   covered: \`rotation -= (speed * delta) / radius\`, or it skids.

   BOUNCING. Flip and lose energy on impact: \`velocityY = -velocityY * 0.6\`.
   Add a rest threshold — below a small speed set it to 0 and stop — or the
   ball jitters against the floor forever.`;

/**
 * The rigid-body clause — rendered ONLY when the manifest actually carries the
 * cannon engine (2026-07-29). Two reasons it is separate from the playbook
 * above rather than one constant:
 *
 * 1. Honesty. Teaching `import … from "cannon-es"` before the bundle is
 *    vendored would hand the model an import that resolves to nothing — a game
 *    dead on its import line. Deriving it from the manifest makes that
 *    impossible by construction, exactly like the model catalog.
 * 2. Cost. It is ~250 tokens on every 3D build turn, and most games should NOT
 *    use the engine (the hand-written maths above feels better for
 *    platformers, runners and driving). Gating keeps it at zero until vendored.
 *
 * CACHE CONTRACT: derived from the MANIFEST only, never the child's message —
 * so the section stays byte-identical per turn and Gemini prefix caching keeps
 * hitting (same rule as SPORTS_PLAYBOOK). Pinned by test.
 */
export function physicsEnginePromptSection(
  manifest: AssetManifest = manifestJson as AssetManifest,
): string {
  const hasEngine = manifest.assets.some((a) => a.type === "engine" && a.name === "physics");
  if (!hasEngine) return "";
  return `   REAL PHYSICS (only when the game is ABOUT it): for tumbling, stacking,
   toppling or things colliding with each other at angles, the rules above get
   fiddly — use the physics engine instead. Do NOT use it for a normal
   platformer, runner or driving game: the hand-written maths above feels
   better and costs nothing. To use it: put \`<!--USES_PHYSICS-->\` at the top of
   \`<body>\` and \`import { World, Body, Vec3, Box, Sphere, Plane, Cylinder,
   Quaternion, Material, ContactMaterial } from "cannon-es";\` — only those
   names exist. Make one \`new World({ gravity: new Vec3(0, -9.82, 0) })\`, give
   each object a \`Body\` with a matching shape (\`new Box(new Vec3(hx, hy, hz))\`
   takes HALF-extents, so a 2-unit cube is \`new Vec3(1, 1, 1)\`), a mass (0 =
   immovable ground), and \`world.addBody(body)\`. Each frame call
   \`world.step(1/60, delta, 3)\` and copy each body's \`position\` and
   \`quaternion\` onto its mesh. The shape MUST match what you drew, or objects
   float or sink through the floor.`;
}
