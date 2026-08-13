Here is the BUILD SPEC for the AI code generator:

1.  **3D Environment Setup:** Create a 3D scene using three.js with a camera positioned slightly behind and above the player's boat, looking down a winding river.
2.  **River and Banks:** Implement a calm, bright blue river. The riverbanks should be lush green and decorated with simple 3D tree and bush models. The river path must gradually narrow and widen to create navigation challenges.
3.  **Player Boat:** Create a cheerful, cartoonish 3D boat model. The boat should bob gently on the water.
4.  **Oar Steering Control:** Implement boat steering by holding the left mouse button and dragging left or right. The boat's turning speed should be proportional to the drag distance.
5.  **Crocodile Spawning:** Crocodiles must appear from designated spots along the riverbanks. Crocodiles should spawn at random intervals between 5 and 15 seconds. Each crocodile should have a cartoonish design with visible but not frightening teeth.
6.  **Stick Attack Control:** Implement a stick attack by clicking the right mouse button. This action should only be effective when a crocodile is within 2 boat lengths.
7.  **Stick Attack Visual/Audio Feedback:** A successful stick push must trigger a "swish" visual effect originating from the boat and play a gentle "boink" sound effect.
8.  **Crocodile Interaction (Push):** When a crocodile is successfully pushed away by the stick, it should be reset to its spawn point or moved back towards the shore.
9.  **Scoring System:** Each successful stick push awards 50 strength points.
10. **Strength Points Display:** Display the current strength points clearly on the screen in large, readable numbers. This counter must be visible at the top-center of the screen and start at 0.
11. **Boat Lives:** The player starts with 3 boat lives.
12. **Crocodile Collision:** If a crocodile hits the boat without being pushed away, it should bounce off with a distinct splash effect, and the player loses 1 boat life.
13. **Lives Indicator:** Implement a visual indicator on the screen that clearly shows the remaining 3 boat lives. This indicator must decrease visually as lives are lost.
14. **Win Condition (Score):** The game is won if the player reaches a strength point score of 1000.
15. **Win Condition (Path):** The game is won if the player navigates the boat to a designated end point of the river path. (Assume a simple distance threshold or marker for the end of the path).
16. **Lose Condition:** The game is lost if the player loses all 3 boat lives.
17. **Game State Management:** Implement basic game states for playing, winning, and losing, including stopping boat movement and crocodile spawning upon game end.

Build ALL of the above in this one pass. Do not defer any item to a future version.