**BUILD SPEC: My Awesome Pet Shop**

**Core Mechanics & Gameplay:**

1.  **3D Environment:** Implement a single, brightly lit, medium-sized 3D pet shop interior using three.js.
    *   **Acceptance:** The scene must contain at least 5 distinct animal enclosures/pens, a counter area, and a clear entrance/exit door.
2.  **Player Character:** Implement a controllable 3D player character (shopkeeper) that can move freely within the store.
    *   **Acceptance:** The player character must be controllable using WASD keys.
3.  **Pet Types & Animations:** Implement 5 distinct pet types: puppies, kittens, hamsters, parrots, and goldfish.
    *   **Acceptance:** Each pet type must have at least 2 simple, distinct animations (e.g., puppy wagging tail, kitten playing, hamster running, parrot perching, goldfish swimming). Pets must be placed in their appropriate enclosures.
4.  **Pet Happiness:** Each pet must have a visible, color-coded happiness meter.
    *   **Acceptance:** Happiness meters must decrease by 1% every 5 seconds and can be increased by player interaction. The meter must visibly update.
5.  **Pet Care Actions:** Implement at least 3 distinct care actions: feeding, grooming, and playing.
    *   **Acceptance:** Player must be able to initiate these actions by clicking/tapping on a pet or a relevant item. Each successful action must increase a pet's happiness by at least 15%.
6.  **Inventory & Item Interaction:** Implement an inventory panel displaying 15 distinct toy and food items.
    *   **Acceptance:** Items must be selectable via mouse click. Players must be able to drag and drop at least 10 unique item types (e.g., dog bone, catnip mouse, hamster wheel, birdseed, fish flakes) from the inventory panel to interact with pets. Successful interaction with an appropriate item must increase pet happiness.
7.  **Shop Decoration:** Implement 20 unique, placeable decoration items (e.g., pet beds, scratching posts, colorful wallpaper sections, plant pots).
    *   **Acceptance:** Decorations must be selectable from a separate UI panel. Players must be able to drag and drop decorations into designated areas of the store environment.
8.  **Customer System:** Implement 8 distinct customer types who visit the store.
    *   **Acceptance:** Customers must enter the store from the entrance door and have a visible preference cue (e.g., a thought bubble showing a picture of a specific pet type or a general trait like "fluffy" or "active").
9.  **Pet Adoption:** Implement a system where customers adopt pets.
    *   **Acceptance:** Customers must approach a pet enclosure. If the customer's preference matches an available pet and that pet's happiness is above 80%, the adoption can occur. A successful adoption must trigger a short animation of the pet leaving with the customer.
10. **Currency System:** Implement a coin currency.
    *   **Acceptance:** Successfully rehoming a pet must award the player with coins ranging from 50 to 200. The player must start with 100 coins.
11. **Item Purchasing:** Allow players to purchase food, toys, and decorations.
    *   **Acceptance:** Items in the inventory and decoration panels must have prices starting at 20 coins. Purchasing items must deduct coins from the player's total.
12. **Game Timer:** Implement a game session timer.
    *   **Acceptance:** A visible timer must display the remaining time, starting at 15 minutes (900 seconds).
13. **Adoption Counter:** Implement a counter for successfully rehomed pets.
    *   **Acceptance:** A visible counter must display the number of pets adopted, starting at 0.
14. **Win Condition:** Successfully rehome 10 pets within the 15-minute game session.
    *   **Acceptance:** Upon reaching 10 adoptions, a "You Win!" message must be displayed.
15. **Pet Sadness Mechanic:** Pets can become "sad" if their happiness meter drops below 20% for more than 60 seconds.
    *   **Acceptance:** A pet's visual state must change to indicate "sadness" if the condition is met. Sad pets cannot be adopted. A separate timer must track how long a pet has been below 20% happiness.
16. **Lose Condition:** The game ends if 3 pets become "sad."
    *   **Acceptance:** Upon reaching 3 sad pets, a "Game Over" message must be displayed.

Build ALL of the above in this one pass. Do not defer any item to a future version.