Here is the BUILD SPEC for the AI code generator:

1.  **3D Scene Setup:** Implement a fully self-contained HTML file using three.js that renders a 3D environment.
2.  **Airport Environment:** Create a detailed 3D airport with at least 2 distinct runways, multiple taxiways connecting them, terminal buildings, hangars, and a control tower. The environment should use clean, stylized graphics with bright, appealing colors.
3.  **Player Aircraft Model:** Include a single, recognizable but simplified 3D airplane model for the player.
4.  **Cockpit View:** Render the primary game view from inside the cockpit of the player's aircraft, displaying a dashboard with essential instruments.
5.  **Third-Person Camera Option:** Implement a toggleable third-person camera that follows the player's aircraft.
6.  **Physics Engine:** Integrate a physics system to simulate aircraft movement, including acceleration, deceleration, friction on the ground, and basic aerodynamic lift/drag.
7.  **Throttle Control:** Implement an on-screen slider UI element that allows the player to control engine throttle from 0% to 100%. This directly affects the aircraft's acceleration.
8.  **Ground Steering:** Implement an on-screen steering wheel UI element that allows the player to steer the aircraft on the ground. Steering sensitivity should be calibrated for taxiing.
9.  **Landing Gear Control:** Implement an on-screen button UI element to toggle the landing gear up/down. The UI button should visually indicate the current state, and the 3D aircraft model must have deployable/retractable landing gear synchronized with this control.
10. **Brake Control:** Implement an on-screen button UI element for applying brakes while the aircraft is on the ground.
11. **Flaps Control:** Implement an on-screen button UI element to cycle through flap states (e.g., off, half, full). The aircraft's visual model should reflect flap deployment, and flaps should affect lift/drag for landing.
12. **Yaw Control:** Implement on-screen buttons or a slider for air-based yaw control, supplementing or replacing rudder input for finer directional adjustments in flight.
13. **AI Traffic:** Populate the airport with at least 3 other AI-controlled aircraft that autonomously perform taxiing, take-off, and landing routines on designated paths.
14. **Air Traffic Control (ATC) System:**
    *   Implement a system to deliver instructions to the player.
    *   Provide pre-defined text prompts for taxi, take-off, and landing clearances (e.g., "Taxi to runway 27," "Line up and wait," "Cleared for take-off," "Cleared to land runway 09").
    *   Implement basic voice synthesis (Text-to-Speech) for these ATC prompts.
15. **Taxiway Guidance:** When ATC instructs taxiing, render glowing lines on the taxiways highlighting the correct path from the aircraft's current location to the specified destination (e.g., runway, gate).
16. **Runway Approach Indicator:** When the aircraft is aligned for landing and within a defined proximity to the runway, display a visual guide on the HUD indicating the runway centerline.
17. **HUD Instruments:** Display the following instruments on the Heads-Up Display:
    *   **Speedometer:** Show current airspeed in knots.
    *   **Altitude Indicator:** Show current height above ground level in feet.
18. **Mission System (Initial Set):** Implement a sequence for completing 5 distinct flight missions. Each mission must start with an ATC instruction (e.g., "Taxi to runway," "Take off and climb to 3000 feet," "Fly heading 270, maintain altitude").
19. **Take-off Mission Objective:** Design at least one mission that requires a successful take-off and reaching a specific waypoint (e.g., altitude and heading).
20. **Landing Mission Objective:** Design at least one mission that requires a successful landing on a designated runway.
21. **Win Condition (Mission Completion):** The game is won when the player successfully completes 5 sequential missions. Display a "You Win!" message.
22. **Lose Condition (Crash):** Implement crash detection. The player loses if:
    *   The aircraft exceeds 30 degrees of pitch or roll while on the ground or during landing approach.
    *   The aircraft remains off the designated runway surface for more than 5 seconds.
    *   The aircraft collides with another object (terrain, buildings, other aircraft).
    *   Display a "Crash!" or "Game Over" message.
23. **Lose Condition (ATC Instruction Failure):** Implement tracking of consecutive ATC instructions failed. The player loses if they fail to acknowledge or comply with 3 consecutive ATC instructions. Display a "Failed ATC Instructions" or "Game Over" message.
24. **UI Layout:** Ensure all UI elements (sliders, buttons, HUD) are clearly visible, well-spaced, and easy to interact with, suitable for a child audience.
25. **Clear Sky Weather:** The 3D environment should always depict clear, sunny weather conditions with a bright blue sky.

Build ALL of the above in this one pass. Do not defer any item to a future version.