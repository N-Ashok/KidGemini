Here is the BUILD SPEC for Dino World Builder:

1.  **Environment Rendering:** Implement a 3D environment using three.js rendered within a single HTML file. The environment shall be stylized, bright, low-poly, with smooth, rounded edges.
2.  **Procedural World Generation:** The 3D world must be procedurally generated. It must feature 3 distinct biome types: grasslands, light forest, and rocky areas.
3.  **Player Avatar:** Implement a player-controlled 3D dinosaur avatar. The avatar must be friendly, cartoonish, and low-poly in style.
4.  **Avatar Movement:** Player avatar movement must be controlled via WASD keys (forward, backward, left, right). The avatar's walking speed must be precisely 3 units per second.
5.  **Camera Control:** Implement mouse-based camera look-around functionality. The camera must be able to zoom in and out, with a minimum distance of 1 meter and a maximum distance of 5 meters from the avatar.
6.  **Interactive Fruit-Bearing Plants:** Implement 10 distinct types of interactive 3D plants. Each plant type must bear a unique fruit asset.
7.  **Fruit Collection:** Player interaction (left-click) with fruit-bearing plants must result in collecting available fruit assets.
8.  **Fruit Replenishment:** When 5 fruits are collected from a specific plant, its fruit supply must be replenished after a cooldown period of exactly 30 seconds.
9.  **Non-Player Dinosaurs:** Implement two distinct types of non-player controlled, friendly, low-poly dinosaur entities. These entities must roam the environment at a slow pace of exactly 1 unit per second.
10. **Decorative World Elements:** Implement 15 different types of 3D decorative world assets (trees and bushes). These assets must be stylized, low-poly, and match the game's visual style.
11. **Building Palette:** Implement an in-game palette displaying the 15 decorative world assets.
12. **Placing World Elements:** Player interaction (left-click) must allow selection of decorative assets from the palette and placement into the 3D world at the player's cursor location.
13. **Player Avatar Shadows:** Each player-placed decorative world element must cast a unique, visible shadow.
14. **Win Condition Tracking:** Implement a counter that tracks the total number of *unique* fruits collected by the player. The win condition is met when the player collects exactly 50 unique fruits. A UI element must display this count.
15. **No Lose Condition:** No lose condition shall be implemented. The game must be open-ended.
16. **Sky Element:** Implement simple flying birds in the sky, moving in basic patterns.

Build ALL of the above in this one pass. Do not defer any item to a future version.