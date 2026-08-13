Here is the BUILD SPEC for the AI code generator:

1.  **Game Initialization:**
    *   Initialize a 3D scene using three.js.
    *   Create a brightly lit, cartoonish 3D environment representing a sunny backyard cricket pitch.
    *   Include basic environmental elements: a grassy ground, a simple boundary (e.g., a wooden fence or line of trees), and a cricket pitch marking.
    *   Render the scene within a single HTML file.

2.  **Player Role Selection:**
    *   At the start of the game, present a clear, simple UI prompt for the player to choose to be either the "Batsman" or the "Bowler".
    *   The game state must reflect the chosen role, controlling camera perspective and available actions.

3.  **Bowler Gameplay:**
    *   Implement a first-person camera view from the bowler's perspective when it is the bowler's turn.
    *   **Aiming:** Allow the player to aim the bowling direction using mouse/touch drag (controlling horizontal and vertical angle). Visual feedback for aiming should be present.
    *   **Ball Selection:** Before releasing the ball, allow selection between "Fast Ball" and "Spin Ball" via a click/tap input.
        *   Fast Ball: Speed of 80 km/h, minimal curve.
        *   Spin Ball: Speed of 60 km/h, with a noticeable curve applied during flight.
    *   **Ball Release:** Implement a click/tap input to release the ball with the selected type and aiming direction.
    *   **Bowling Animation:** Include a simple animated arm winding motion before ball release.

4.  **Batsman Gameplay:**
    *   Implement a first-person camera view from the batsman's perspective when it is the batsman's turn.
    *   **Ball Watching:** The batsman character should stand ready, facing the bowler.
    *   **Batting Input:** Implement timing-based input for swinging the bat.
        *   On PC: Arrow keys to influence swing direction, Spacebar to swing.
        *   On Touchscreen: A button prompt appears; tap to swing.
        *   The timing of the swing input relative to the ball's arrival dictates the outcome.
    *   **Batting Actions:** The batsman can perform two actions based on input:
        *   "Defend": A block action with the bat.
        *   "Hit": An aggressive swing to score runs.
    *   **Batting Animation:** Include an animation of the batsman swinging the bat when the input is triggered.

5.  **Ball Physics and Interaction:**
    *   Simulate ball physics for accurate trajectory and speed based on the bowler's input.
    *   Implement collision detection between the ball and the bat.
    *   Implement collision detection between the ball and the stumps.
    *   Implement collision detection between the ball and the ground.
    *   If the ball hits the boundary (e.g., a pre-defined distance/zone), it should result in 4 runs.

6.  **Scoring System:**
    *   Award 1 run if the ball is hit by the bat into the outfield (not a boundary).
    *   Award 4 runs if the ball is hit by the bat and reaches the boundary.
    *   Implement logic for a wicket to be taken (see Item 7).

7.  **Wicket Conditions:**
    *   A wicket is taken if the ball, after being bowled, hits the batsman's stumps without being hit by the bat first.
    *   A wicket is taken if the ball is hit by the bat and is then caught by a fielder before it touches the ground. For this pass, fielders can be static objects positioned strategically around the boundary or infield, and a simple "catch zone" check is sufficient.

8.  **Match Structure and Progression:**
    *   A match consists of a maximum of 10 overs.
    *   Each over contains exactly 6 balls.
    *   After each ball, the game should automatically proceed to the next ball.
    *   After 6 balls, an over should be completed, and the game should proceed to the next over.
    *   The player must alternate between batting and bowling roles for each full innings. The AI will control the opposing team (bowling when the player bats, batting when the player bowls). The AI's actions should be basic (e.g., standard bowling, basic fielding, hitting/defending simple shots).

9.  **User Interface (UI) Display:**
    *   Display the current score prominently on the screen. This must include:
        *   Runs scored by the player's team.
        *   Wickets lost by the player's team.
        *   Runs scored by the AI team.
        *   Wickets lost by the AI team.
    *   Clearly indicate the current over and ball number (e.g., "Over 3, Ball 4").
    *   Display active prompts for batting actions (e.g., "Press Space to Swing").

Build ALL of the above in this one pass. Do not defer any item to a future version.