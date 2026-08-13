**BUILD SPEC: Super Hero Arena Builder (MVP)**

This BUILD SPEC outlines the mandatory features for the initial release of the Super Hero Arena Builder, designed to be implemented as a single, self-contained HTML file using three.js.

**Mandatory Features Checklist:**

1.  **3D Scene Setup:**
    *   Initialize a three.js scene with a camera (perspective), renderer, and basic lighting (ambient and directional).
    *   Implement a skybox with a bright blue background and puffy white clouds.
    *   Define the play space as a 200x200 unit area on the XZ plane with a height of 100 units.
    *   **Acceptance:** A fully rendered 3D environment visible in the browser.

2.  **Environment Assets:**
    *   Populate the 200x200 play space with at least 5 distinct environment assets:
        *   At least 2 city-style buildings, each at least 5 floors tall.
        *   At least 2 static hovering police cars.
        *   At least 2 static damaged streetlights.
    *   Each environmental asset must be placeable by the player during the build phase.
    *   **Acceptance:** Player can select and place these assets onto the 3D canvas.

3.  **Character Models & Placement:**
    *   Implement models for Spider-Man (hero), Hulk (villain), and Thanos (villain).
    *   Spider-Man must have a visible model with a hero appearance.
    *   Hulk must have a visible model with a villainous appearance.
    *   Thanos must have a visible model with a villainous appearance and a glowing purple infinity gauntlet.
    *   Players must be able to select and place these characters onto the 3D canvas during the build phase.
    *   **Acceptance:** All three characters are loaded and can be placed in the scene.

4.  **Character Health System:**
    *   Each character must have a visible health bar positioned directly above their head.
    *   Spider-Man must start with 100 HP.
    *   Hulk must start with 500 HP.
    *   Thanos must start with 500 HP.
    *   Health bars must visually deplete as HP decreases.
    *   **Acceptance:** Health bars are displayed for all characters and update accurately with HP changes.

5.  **Character Combat Mechanics (Basic):**
    *   Implement a basic melee attack for Spider-Man, activated by Left Mouse Button (LMB). This attack should deal 10 damage to any enemy within 2 units.
    *   Implement basic movement for Hulk and Thanos:
        *   Walking speed of 5 units per second.
        *   They must move towards the player-controlled hero when within 30 meters (Aggressive AI).
    *   **Acceptance:** Spider-Man can attack. Hulk and Thanos move towards the player when nearby.

6.  **Special Power: Teleport:**
    *   Implement the Teleport power for Spider-Man.
    *   Activation: Press Right Mouse Button (RMB) plus a directional movement key (W, A, S, D).
    *   Effect: Spider-Man instantly moves 15 meters forward in the direction indicated by the directional key.
    *   **Acceptance:** Spider-Man can successfully teleport 15 meters in the specified direction upon correct input.

7.  **Player Control (Play Mode):**
    *   Implement character control for Spider-Man using standard WASD keys for movement on the XZ plane.
    *   Implement a jump action for Spider-Man using the Spacebar, with a consistent jump height.
    *   Player camera should follow Spider-Man.
    *   **Acceptance:** Spider-Man can be freely controlled via WASD and Spacebar.

8.  **Win/Lose Conditions:**
    *   **Win Condition:** The player wins if all enemy characters (Hulk and Thanos) reach 0 HP.
    *   **Lose Condition:** The player loses if Spider-Man reaches 0 HP.
    *   Upon winning or losing, a clear "Victory!" or "Defeat!" message must be displayed prominently on the screen.
    *   **Acceptance:** Game state changes correctly to Win or Lose based on character HP, and a corresponding message is displayed.

9.  **Audio Cues:**
    *   Implement an audible roar for Hulk when he is within 15 meters of Spider-Man.
    *   **Acceptance:** Hulk's roar plays when the specified proximity condition is met.

10. **Scene Logic for Play Mode:**
    *   Initialize the game in "Play Mode" with Spider-Man in a central plaza, facing Thanos and Hulk.
    *   Hulk and Thanos should start within attacking range (30 meters) of Spider-Man.
    *   **Acceptance:** The game starts with characters in their designated positions and ready for combat.

Build ALL of the above in this one pass. Do not defer any item to a future version.