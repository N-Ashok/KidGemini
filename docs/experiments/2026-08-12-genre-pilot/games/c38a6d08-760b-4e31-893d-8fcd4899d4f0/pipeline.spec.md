Here is the BUILD SPEC for the AI code generator:

1.  **Render a 3D Soccer Stadium Scene:**
    *   **Environment:** Create a vibrant 3D soccer stadium environment.
    *   **Field:** Include a perfectly green, marked soccer field with white goal nets at either end.
    *   **Spectator Stands:** Populate surrounding spectator stands with simple, cheering 3D character models.
    *   **Lighting:** Implement bright, clear stadium lighting that casts gentle shadows.

2.  **Place Game Objects:**
    *   **Soccer Ball:** Position one 3D soccer ball in the center of the field.
    *   **Player Characters:** Place two player characters on the field, one blue and one red, positioned ready to start a match.

3.  **Implement Player Controls:**
    *   **Movement:** Allow the player character controlled by the user to move using WASD keys.
    *   **Camera:** Implement a mouse-controlled camera system for looking around the 3D scene.
    *   **Action (Optional but recommended):** A basic action control (e.g., kick/pass button) for the ball interaction, if feasible within single pass.

4.  **Implement Basic Game Logic (Soccer Template Focus):**
    *   **Ball Physics:** Enable realistic physics for the soccer ball, including bouncing and gravity.
    *   **Goal Detection:** Implement logic to detect when the ball enters either goal.
    *   **Scoring System:** Display a score counter, updating when the ball enters a goal. A goal scored by the blue player adds to their score, and a goal scored by the red player adds to their score.
    *   **Win Condition:** The first player (blue or red) to score 3 goals wins the match.
    *   **Lose Condition:** The opponent scoring 3 goals first results in a loss.
    *   **Game Reset:** Upon a win or loss, reset the ball to the center and the score to 0-0, allowing the game to restart immediately.

5.  **Implement Simple AI Opponent Behavior:**
    *   **Red Player AI:** Assign the red player character a simple AI behavior to attempt to kick the ball towards the blue player's goal. The AI should react to the ball's position.

6.  **Visual Customization (Applied to Scene):**
    *   **Character Appearance:** Ensure the two player characters are distinct (e.g., one blue, one red).

7.  **Play & Test Functionality:**
    *   The generated HTML file must be immediately playable without external dependencies or build steps. Users should be able to control one player and observe the AI.

Build ALL of the above in this one pass. Do not defer any item to a future version.