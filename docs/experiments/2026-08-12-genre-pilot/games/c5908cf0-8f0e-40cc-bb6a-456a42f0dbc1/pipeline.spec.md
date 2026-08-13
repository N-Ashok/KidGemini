Here is the BUILD SPEC for the AI code generator:

1.  **Core Scene Setup:**
    *   Implement a single HTML file that uses three.js.
    *   Initialize a basic 3D scene with a skybox, ambient light, and a directional light.
    *   Implement a camera controlled by mouse look-around (yaw/pitch) and attached to the player character.

2.  **Player Character:**
    *   Implement 4 distinct playable characters. Each character must have a unique mesh and model.
    *   Each of the 4 characters must have a unique, looping idle animation.
    *   The player character must start with exactly 3 health points.
    *   Implement a user interface element to display player health using exactly 3 heart icons, positioned in the top-left corner of the screen.

3.  **World Selection:**
    *   Implement a system to select from 5 distinct themed worlds (e.g., Forest, Ice, Desert, Cloud, Cave). Each world must have unique environmental assets and textures.
    *   The initial scene should allow the player to choose one of the 5 worlds before starting gameplay.

4.  **Environment Design:**
    *   For the selected world, generate a playable level containing at least 20 distinct platforms.
    *   Platforms must vary in height and size to require jumping and precise movement.
    *   Implement at least 2 platforms that move horizontally at a speed of up to 2 units per second.
    *   Implement at least 1 platform that moves vertically at a speed of up to 2 units per second.
    *   The level must include a visible exit portal.

5.  **Player Controls:**
    *   Implement WASD keys for forward, backward, left, and right movement relative to the camera's facing direction.
    *   Implement the Spacebar key for player character jumping.
    *   Implement left-click mouse button for player character attacking.
    *   Implement number keys (1, 2, 3) and the mouse scroll wheel to cycle through and select available weapons.

6.  **Combat System:**
    *   Implement 3 distinct weapon types (e.g., basic sword, boomerang, bouncy ball launcher). Players start with the basic sword.
    *   Weapons must be pickable in the game world.
    *   Implement at least 3 enemy types (e.g., small slimes, walking robots). Each enemy must have a simple patrol path or static position.
    *   Each enemy must have exactly 1 or 2 health points.
    *   When an enemy is defeated, it must drop exactly one small collectible item.
    *   Player attacks must deal damage to enemies.

7.  **Level Objectives & Progression:**
    *   Implement a win condition: Successfully reaching the designated exit portal.
    *   Implement a lose condition: Player character's health drops to 0.
    *   Implement a visible timer counting down from exactly 300 seconds. If the timer reaches 0, the player loses. The timer must be displayed on the UI.

8.  **Collectibles:**
    *   Implement exactly 5 golden star collectibles scattered throughout the level. These are optional objectives.
    *   When a player character collects a golden star, it should be removed from the scene and its count updated on the UI.

Build ALL of the above in this one pass. Do not defer any item to a future version.