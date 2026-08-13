Here is the BUILD SPEC for the AI code generator:

1.  **Game Arena:** Implement a 20x20 meter flat arena floor.
2.  **Skybox:** Add a fluffy cloud skybox.
3.  **Player Tank Model:** Create and render a controllable 3D player tank model.
4.  **Player Tank Movement:** Player tank moves forward (W), backward (S), strafes left (A), and strafes right (D). Movement speed should be consistent.
5.  **Turret Aiming:** The player tank's turret must rotate to face the mouse cursor's horizontal position.
6.  **Firing Mechanism:** Player can fire a projectile by pressing Left-click or Spacebar. Projectiles should originate from the tank's turret.
7.  **Projectile Visuals:** Projectiles appear as small, colorful spheres streaking through the air.
8.  **Environment Blocks:** Place exactly 50 destructible 1x1 meter cube blocks scattered within the arena. Blocks should be brightly colored.
9.  **Block Destructibility:** Player projectiles hitting blocks cause them to chip and eventually disappear in a small puff of smoke and particle effects.
10. **Enemy Tanks:** Place exactly 8 enemy tank models within the arena, positioned to be partially or fully obscured by blocks.
11. **Enemy Tank Behavior:** Enemy tanks must be either stationary OR move along simple, predefined patrol paths between 3 to 5 blocks away from their starting position.
12. **Enemy Tank Health:** Each enemy tank must be hit by exactly 3 player projectiles to be destroyed.
13. **Enemy Destruction:** Destroyed enemy tanks briefly flash before vanishing.
14. **Power-up Drop:** Destroyed enemy tanks drop one of two power-up types: a temporary speed boost OR a temporary shield.
15. **Power-up Visuals:** Power-ups appear as a spinning icon.
16. **Power-up Duration:** Any collected power-up lasts for exactly 10 seconds.
17. **Power-up Collection:** Player tank automatically collects a power-up when it drives over the icon.
18. **Player Tank Health:** Player tank starts with 5 hit points.
19. **Player Damage Visuals:** Player tank's armor plating visually cracks or changes appearance as it takes damage.
20. **Win Condition:** The game is won when all 8 enemy tanks are destroyed. Display a "Victory!" message.
21. **Lose Condition:** The game is lost if the player tank's health drops to 0. Display a "Defeat!" message.
22. **Camera Perspective:** Implement a 3D top-down camera perspective.

Build ALL of the above in this one pass. Do not defer any item to a future version.