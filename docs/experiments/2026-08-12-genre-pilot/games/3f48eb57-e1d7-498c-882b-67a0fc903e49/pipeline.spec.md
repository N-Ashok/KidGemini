Here is the BUILD SPEC for the AI code generator:

1.  **Core Scene Setup:** Implement a 3D scene using three.js with a bright, vibrant, and cartoony visual style. Include a skybox and basic lighting suitable for a race track environment.
2.  **Player Car Creation - Chassis:** Provide a selection of 10 distinct pre-designed 3D car chassis types. The player must be able to select one chassis as the base for their car.
3.  **Player Car Creation - Wheels:** Provide a selection of 20 distinct 3D wheel types. The player must be able to attach exactly 4 wheels to their selected chassis.
4.  **Player Car Creation - Body Parts:** Provide a selection of 15 distinct 3D body parts (e.g., spoilers, fenders, horns). The player must be able to attach a minimum of 3 and a maximum of 6 body parts to their selected chassis.
5.  **Player Car Creation - Paint Booth:** Implement a paint booth functionality allowing the player to select and apply colors.
    *   Players can choose from 20 distinct color options.
    *   Players can color the car body.
    *   Players can color the attached wheels.
6.  **Race Track Selection:** Provide 5 distinct pre-designed 3D race tracks. The player must be able to select one track for racing.
7.  **Race Start & Loading:** Once a track is selected and players are ready (assume 4 players for simulation), load the race session. The race session should load within 15 seconds.
8.  **Race Environment:** Render the selected 3D race track with colorful, exaggerated, and friendly aesthetics, including green hills and a blue sky. Ensure obstacles like bouncy mushrooms and ramps are present on the track.
9.  **Player Car Controls:** Implement responsive vehicle physics and controls for the player's custom car:
    *   **Acceleration:** 'W' or 'Up Arrow' keys increase forward speed.
    *   **Braking/Reversing:** 'S' or 'Down Arrow' keys decrease speed, and if stopped, enable reverse.
    *   **Steering:** 'A'/'Left Arrow' and 'D'/'Right Arrow' keys steer the car left and right.
    *   Maximum forward speed should reach at least 50 units per second.
10. **Third-Person Camera:** Implement a smooth third-person camera that follows the player's car during the race.
11. **Multiplayer Simulation:** Simulate 3 other AI-controlled opponent cars on the track. These cars should also be visually customized (using different combinations of chassis, wheels, and body parts from the available sets).
12. **Lap Counter & Race Progression:**
    *   Implement a lap counter display visible on the top-left of the screen.
    *   The race must consist of exactly 3 laps.
    *   The game must accurately track completed laps for all 4 cars.
13. **Win Condition:** The first player car to complete 3 laps is declared the winner.
14. **Lose Condition:** Any player car finishing 4th place or lower after 3 laps is declared a loser.
15. **End-of-Race Screen:** After all 4 cars have finished (or been disabled/timed out), display a race results screen indicating player positions and win/loss status.
16. **Race Currency & Rewards:** Upon completing *any* race (regardless of position, as per PRD), award players 50 in-game "Gears" currency.
17. **Car Health & Collisions:**
    *   Each car (player and AI) must have a simulated health pool starting at 100 HP.
    *   Implement basic collision detection between cars.
    *   Collisions between cars must reduce the struck car's HP by a variable amount (e.g., 5-15 HP per collision).
    *   If a car's HP reaches 0, it must be temporarily disabled (unable to move) for exactly 5 seconds before its health resets to 100 HP and it can resume racing.
18. **Visual Style Adherence:** Ensure all 3D models, textures, and animations (e.g., steering, acceleration) are bright, vibrant, cartoony, and feature exaggerated proportions and smooth movements.

Build ALL of the above in this one pass. Do not defer any item to a future version.