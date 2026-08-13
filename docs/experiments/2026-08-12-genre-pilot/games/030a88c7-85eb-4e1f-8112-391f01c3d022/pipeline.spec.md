**BUILD SPEC: Teleport Runner**

1.  **Scene Initialization:** Create a 3D scene using three.js within a single HTML file. This scene must include a basic game loop to manage updates and rendering.
2.  **Player Character Model:** Implement a player character model that is visible and positioned within the 3-lane track.
3.  **Automatic Forward Movement:** The player character must automatically move forward along the track at a constant speed of 5.0 meters per second.
4.  **Lane System:** Implement exactly 3 distinct lanes for the player character to occupy.
5.  **Lane Switching:**
    *   Allow the player character to switch between the 3 lanes.
    *   Lane switching must be animated and take precisely 0.2 seconds to complete from the center of one lane to the center of an adjacent lane.
6.  **Obstacle Spawning:**
    *   Generate obstacles (e.g., stationary cubes, simple moving cubes) that appear in the player's lanes.
    *   Obstacles must spawn at randomized intervals between 1.0 and 5.0 seconds.
7.  **Obstacle Collision & Lives:**
    *   The player character has a maximum of 3 lives.
    *   Each collision between the player character and an obstacle must deduct 1 life.
    *   Implement a clear visual indicator for the number of remaining lives.
8.  **Game Over Condition:** The game must end when the player character's lives reach 0.
9.  **Collectible Coins:**
    *   Implement collectible coin models that appear on the track.
    *   Each coin collected must add exactly 10 points to the player's score.
10. **Scoring System:**
    *   Implement a score counter.
    *   The score must increase by 1 point for every 10.0 meters the player character travels forward.
    *   The current score must be visible on the screen.
11. **Teleport Ability:**
    *   Implement a distinct "Teleport" button that is visible on the screen.
    *   Tapping the Teleport button must instantly move the player character forward by exactly 5.0 meters.
    *   The Teleport button must have a cooldown of exactly 3.0 seconds after each use, indicated visually (e.g., disabled or red tint).
12. **Visual Environment:** Create a stylized 3D environment representing a 3-lane track stretching into the distance. Use bright, colorful graphics suitable for children.
13. **Character Animations:** Implement basic animations for the player character including running, jumping, and sliding.
14. **Teleport Visual Effect:** Implement a distinct visual effect that plays when the Teleport ability is used.
15. **Control Input:** Support lane switching via swipe gestures (left/right) and jumping/sliding via swipe gestures (up/down). The Teleport button is activated by a tap.
16. **Game Over Display:** Upon losing all lives, display a "Game Over" message along with the final score achieved.

Build ALL of the above in this one pass. Do not defer any item to a future version.