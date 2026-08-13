# Helicopter City Explorer - BUILD SPEC

This BUILD SPEC defines the features for a single, self-contained HTML file using three.js. The AI code generator MUST implement ALL of the following features in the first pass.

1.  **3D Helicopter Model**: Implement a navigable 3D helicopter model. It must be rounded, friendly in appearance, with visible main rotor blades that spin at a consistent speed.
2.  **Third-Person Camera**: The camera must be positioned slightly above and behind the helicopter, providing a clear third-person view.
3.  **Helicopter Controls**: Implement the following controls for helicopter movement:
    *   `W` or `Up Arrow`: Ascend (increase altitude).
    *   `S` or `Down Arrow`: Descend (decrease altitude).
    *   `A` or `Left Arrow`: Strafe Left (move sideways left).
    *   `D` or `Right Arrow`: Strafe Right (move sideways right).
    *   The helicopter must also have default forward movement enabled unless overridden by strafing.
4.  **Free Look Camera**: Allow the player to freely look around the environment using the mouse. The camera should pivot around the helicopter's position.
5.  **3D City Environment**: Create a 3D city environment with the following specifics:
    *   A total of 10 unique building models.
    *   Buildings should be colorful, blocky, and of varying heights.
    *   Implement 5 distinct street layout variations within the city.
    *   Include patches of green park areas.
    *   Include simple car models driving slowly on the streets.
6.  **Skybox**: Implement a clear, bright blue sky with static, puffy white clouds.
7.  **Objective Marker**: Display a visual objective marker (e.g., a blinking star icon) that hovers above the current objective location.
8.  **Collectible Items**: Implement 3 distinct types of floating collectible items. Examples include delivery packages, lost balloons, and rescue cats. These items should appear stationary or gently bobbing in the breeze.
9.  **Item Collection**: Players must be able to collect items by flying their helicopter over them. The helicopter must visually indicate when an item is successfully collected.
10. **Drop-off Zones**: Implement designated drop-off zones within the city. Each zone must be clearly marked on the ground with a visible circle.
11. **Interaction System**: Implement an interaction system using the `Spacebar` key. This system must allow the player to:
    *   Pick up a collectible item when near it (if not already carrying one).
    *   Drop off a collected item when inside a drop-off zone.
12. **Mission Completion**: A mission is considered complete when the player successfully drops off a collected item at a designated drop-off zone.
13. **Fuel Meter**: Implement a visible fuel meter HUD element that depletes over time. The meter should start full.
14. **Timer**: Implement a 15-minute in-game timer that runs concurrently with the fuel meter depletion. The fuel meter should deplete at a rate that makes the 15-minute timer the effective lose condition.
15. **Win Condition**: Implement a win condition where the player successfully completes 5 unique missions. Upon completion, a win state should be indicated.
16. **Lose Condition**: Implement a lose condition where the fuel meter depletes completely (or the 15-minute timer runs out). Upon depletion, a lose state should be indicated.
17. **Star Rewards**: Award 1 star for each successful mission completion. Display the current star count on the HUD.
18. **Celebration Animation**: Upon earning the 5th star, trigger a short, celebratory animation.

Build ALL of the above in this one pass. Do not defer any item to a future version.