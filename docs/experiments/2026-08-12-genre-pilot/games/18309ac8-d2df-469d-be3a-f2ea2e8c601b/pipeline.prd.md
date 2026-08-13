**Game Design PRD: "Super Hero Arena Builder"**

**Concept**
This is a web-based 3D game builder designed for children to create their own superhero battle arenas and scenarios. Players can assemble characters, define powers, and build environments for epic showdowns between heroes and villains from popular universes.

**Core Loop**
1.  **Build Phase:** Drag and drop characters, terrain, and obstacles onto a 3D canvas.
2.  **Power Assign:** Select unique abilities for characters, like Spider-Man's teleportation or Hulk's ground pound.
3.  **Test Play:** Enter the arena to control a hero and test combat mechanics, movement, and power effectiveness.
4.  **Refine:** Adjust enemy AI, character stats (e.g., Hulk's health at 500 HP), or level layout based on playtesting.

**Win/Lose Condition**
*   **Win:** The player successfully defeats all designated enemy characters in the arena or completes a specific scenario objective (e.g., rescue 3 civilians).
*   **Lose:** The player's controlled hero's health drops to 0 HP, or a critical scenario objective fails.

**Controls**
*   **Builder Mode:** Mouse and keyboard for selecting, dragging, rotating, and scaling game objects.
*   **Play Mode (Example: Spider-Man):** WASD keys for movement, Spacebar for jump, Left Mouse Button for primary attack, Right Mouse Button + directional input for Teleport (e.g., press Right Mouse + Forward to teleport 15 meters forward).

**Visual Style**
Bright, slightly stylized 3D graphics with clear character silhouettes and vibrant, comic-book-inspired environmental textures. Environments range from cityscapes with 10-story buildings to alien landscapes with 20-meter tall rock formations.

**Features**
1.  Players can select up to 5 hero characters and 5 villain characters from a library of 30 pre-made models.
2.  The "Teleport" power allows a character to instantly move up to 15 meters in any cardinal direction by pressing the Right Mouse Button and a movement key.
3.  Each character has a visible health bar displaying their remaining HP, with a starting value of 100 HP for heroes and up to 500 HP for boss villains like Thanos.
4.  Players can place up to 10 environmental assets like cars, buildings, or crates, which can be destroyed after taking 20 damage.
5.  Enemy AI can be set to "Aggressive" (charges player within 30 meters) or "Defensive" (attacks when player is within 10 meters).
6.  The builder supports a play space of 200x200x100 units in 3D space, allowing for verticality in level design.
7.  Players can define specific "objective zones" of 5x5x5 units that trigger events when entered.

**Scene Description**
The scene is a 3D cityscape. Tall buildings with at least 5 floors rise around a central plaza. Hovering police cars (static) and damaged streetlights (static) litter the ground. Spider-Man (controlled by WASD + mouse actions) is in the plaza, facing Thanos and Hulk, who move with a walking speed of 5 units per second. Thanos has a glowing purple infinity gauntlet, and Hulk roars audibly when within 15 meters of Spider-Man. The sky is a bright blue with puffy white clouds.