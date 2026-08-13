## Game Design PRD: Block Buster Tanks

**Concept:**
Players pilot a customizable 3D tank through vibrant environments, using strategy and aiming skill to blast enemy tanks concealed behind destructible block obstacles.

**Core Loop:**
Player navigates the 3D environment, spots hidden enemy tanks, aims their turret, fires projectiles to destroy enemies, and collects dropped power-ups.

**Win/Lose Condition:**
*   **Win:** Destroy all 8 enemy tanks in the arena.
*   **Lose:** Your player tank's health drops to 0.

**Controls:**
*   **Move Tank:** WASD keys (W=forward, S=backward, A=strafe left, D=strafe right).
*   **Aim Turret:** Mouse movement.
*   **Fire Projectile:** Left-click or Spacebar.

**Visual Style:**
Bright, friendly, and slightly cartoony 3D aesthetic with chunky, colorful tanks and simple, geometric environment pieces.

**Features:**
*   Player controls a single, upgradable 3D tank model with distinct visual parts.
*   The environment features 50 destructible 1x1 meter cube blocks providing cover for enemies.
*   Enemy tanks are stationary or move along simple patrol paths between 3 to 5 blocks away.
*   Each enemy tank must be hit by 3 player projectiles to be destroyed.
*   Destroyed enemy tanks drop a temporary speed boost or shield power-up lasting 10 seconds.
*   Player tank has 5 hit points, visually represented by armor plating that cracks with damage.
*   The game world is a 20x20 meter open arena with a skybox of fluffy clouds.

**Scene Description:**
The player sees a 3D top-down perspective of a colorful, flat arena floor dotted with scattered, large, brightly colored cubes (blocks). In the distance, various simple 3D tank models are partially or fully obscured behind these blocks. The player's own tank is visible in the foreground, its turret tracking the mouse cursor. Projectiles are visible as small, colorful spheres streaking through the air. When blocks are shot, they chip and eventually disappear in a small puff of smoke and particle effects. Destroyed enemy tanks briefly flash before vanishing, leaving behind a spinning icon for a power-up.