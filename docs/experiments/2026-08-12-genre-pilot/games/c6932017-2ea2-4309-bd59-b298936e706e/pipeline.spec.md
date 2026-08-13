Here is the BUILD SPEC for the AI code generator:

1.  **Scene Setup:** Generate a single HTML file that uses three.js to render a 3D scene. The scene should be a vibrant, blocky 3D environment with rounded edges and bright, contrasting colors. The default environment should be a "Paintball Arena" template.
2.  **Player Character:** Implement a controllable player character. This character should be a stylized, friendly 3D model (e.g., a cartoonish robot or animal). The camera should be set to a first-person perspective by default.
3.  **Player Movement & Controls:**
    *   Implement WASD keys for forward, backward, left, and right movement.
    *   Implement mouse movement for looking around and aiming.
    *   Implement the Spacebar for jumping.
    *   Implement the Left Mouse Button to fire the character's weapon.
    *   Implement the Right Mouse Button for a secondary weapon action (if applicable, otherwise default to no action).
    *   Implement number keys (1, 2, 3) and mouse wheel for switching between equipped items/weapons.
4.  **Weapon System:** Implement a primary weapon for the player character. This weapon should be a projectile-based tool (e.g., "paint gun").
    *   The weapon should shoot colorful, non-threatening projectiles (e.g., red paintballs).
    *   The weapon's fire rate must be exactly 3 shots per second.
    *   The projectile speed must be exactly 20 units per second.
    *   Projectile impacts should create temporary visual effects (e.g., small paint splatters on surfaces or other players).
5.  **Environment Assets:** Populate the default "Paintball Arena" scene with at least 5 distinct interactive environment assets. These must include:
    *   Stacked crates (static).
    *   Ramps (for navigation).
    *   Bouncy pads (that launch the player upwards when landed on).
    *   A trigger zone (that activates a predefined event when entered).
    *   Destructible props (that disappear or break after a certain number of hits).
6.  **HUD Display:** Implement a Heads-Up Display (HUD) visible at all times. The HUD must display:
    *   Player's current score, labeled "Score: X".
    *   Player's remaining lives, displayed as "Lives: X/Y", where Y is the total lives.
    *   A basic mini-map showing the positions of other player avatars relative to the local player (if multiplayer is implemented).
7.  **Score Tracking:** Implement a score system where players gain points by hitting other players. The target score for winning a match must be exactly 15 elimination points.
8.  **Lives System:** Implement a lives system. Each player starts with exactly 5 lives. Losing all lives results in elimination from the current match.
9.  **Win/Lose Conditions:**
    *   A player wins the match by being the first to reach 15 elimination points.
    *   A player loses the match if they run out of lives (reach 0 lives remaining).
    *   If multiple players reach 15 points simultaneously, the player with the most points wins. If tied, it's a draw.
10. **Player Representation:** Implement at least 2 distinct player avatar models to represent other players in the scene. These avatars should be distinguishable (e.g., by unique colors or simple hats).
11. **Basic Multiplayer Simulation:** For the purpose of a single HTML file, simulate multiplayer by creating 2 player-controlled instances within the same scene, allowing for local interaction and testing of the score and lives system as if they were separate players. Do NOT implement network code. The "other player avatar" should be controllable by the second player on the same machine, perhaps via a shared input or a toggle. (Self-correction: The PRD implies networked multiplayer, but for a single HTML, local simulation is the only feasible interpretation for "multiplayer").
12. **Visual Style Consistency:** Ensure all 3D models, projectiles, and particle effects adhere to the bright, stylized, friendly visual style with rounded edges and vibrant colors described in the PRD.

Build ALL of the above in this one pass. Do not defer any item to a future version.