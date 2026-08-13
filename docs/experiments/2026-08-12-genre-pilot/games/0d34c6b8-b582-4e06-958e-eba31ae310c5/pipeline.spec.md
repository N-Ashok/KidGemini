**BUILD SPEC: Neon Mars Racers**

1.  **Initialize 3D Scene:** Create a three.js scene with a perspective camera, a WebGLRenderer that fits the browser window, and a basic game loop using `requestAnimationFrame`.
2.  **Player Car Implementation:**
    *   Implement a controllable 3D car model.
    *   The car must have a constant, visible neon glow effect.
    *   The car's base forward movement speed must be exactly 20 units per second.
3.  **Race Track Design:**
    *   Construct a winding 3D race track appropriate for a Martian environment.
    *   Define a clear start/finish line on the track.
4.  **Lap Counter UI:**
    *   Implement a visible lap counter in the user interface, displaying the current lap number.
    *   The lap counter must increment exactly by 1 when the player's car successfully crosses the start/finish line.
    *   The initial lap count must be 1.
5.  **Speed Booster Implementation:**
    *   Place at least 3 distinct blue, glowing speed booster objects along the track.
    *   When the player's car drives over a speed booster:
        *   Its speed must temporarily increase by 50% (i.e., new speed = base speed \* 1.5).
        *   This speed boost must last for exactly 3 seconds.
        *   The speed booster object must visually pulse with electric blue light while active.
6.  **Obstacle Implementation:**
    *   Scatter at least 5 large, textured Mars rock obstacles of varying sizes across the track.
    *   When the player's car collides with a large rock obstacle:
        *   The car must briefly stop its forward momentum.
        *   The car's speed must be reduced by 10 units per second for exactly 1 second.
7.  **Environment Visuals:**
    *   Create a red, dusty Martian landscape for the game environment.
    *   Implement a skybox with a dramatic gradient of purple and pink.
8.  **Controls Implementation:**
    *   **Accelerate:** 'W' key or Up Arrow key must increase forward movement speed up to a maximum.
    *   **Brake/Reverse:** 'S' key or Down Arrow key must decrease forward movement speed, and when stationary or moving forward slowly, must initiate reverse movement.
    *   **Steering:** 'A' key or Left Arrow key must steer the car left.
    *   **Steering:** 'D' key or Right Arrow key must steer the car right.
9.  **Win Condition:** The game must declare a "Win" state upon the player successfully completing 3 laps (i.e., crossing the start/finish line for the 3rd time).
10. **Lose Condition:** The game must declare a "Lose" state upon the player's car colliding with large rock obstacles a total of 3 times.
11. **Game State Management:** Implement basic logic to track current lap, car collision count, and display win/lose messages when conditions are met.

Build ALL of the above in this one pass. Do not defer any item to a future version.