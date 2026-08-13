Here is the BUILD SPEC for the AI code generator:

1.  **Player Character:** Implement a 3D player character model visible in the scene, controllable via WASD keys for movement at a speed of 3 units per second.
2.  **Environment:** Render a 3D scene representing a farm and market area, including distinct sections for farming plots, animal pens, a processing station, and the market stall. The scene should have a bright, friendly, and slightly cartoonish visual style with clear shapes and vibrant colors.
3.  **Camera Controls:** Implement camera functionality allowing mouse movement to rotate the camera and mouse wheel to zoom in and out.
4.  **Tomato Plants:** Implement visible tomato plants. The player character must be able to interact with them using a left-click to harvest tomatoes, which are then added to the player's inventory (maximum capacity of 10 tomatoes).
5.  **Chicken Coop & Eggs:** Implement a visible chicken coop containing 3 chicken models. The player character must be able to interact with the coop using a left-click to collect eggs, which are automatically added to the player's inventory (maximum capacity of 10 eggs).
6.  **Jelly Machine:** Implement a visible "Jelly Machine" model. The player must be able to use the Jelly Machine to combine 2 tomatoes and 1 sugar from their inventory to produce 1 jelly jar item, which is added to the player's inventory (maximum capacity of 10 jelly jars).
7.  **Sugarcane Plot & Sugar:** Implement a visible sugarcane plot. The player character must be able to interact with it using a left-click to harvest sugar, which is then added to the player's inventory (maximum capacity of 10 sugar items).
8.  **Market Stall:** Implement a market stall with shelves. These shelves must be able to display up to 20 items placed by the player.
9.  **Item Placement:** Player must be able to pick up harvested tomatoes, collected eggs, jelly jars, and harvested sugar from their inventory using a left-click and place them onto the market stall shelves using a left-click.
10. **Customer Behavior:** Implement 3D customer models that appear at the edge of the scene, walk to the market stall at a speed of 2 units per second, and interact with the market shelves.
11. **Customer Purchasing:** Customers must select items from the market stall shelves and complete a purchase.
12. **Coin System:** Each successful customer transaction must award the player 5 coins. Implement a visible coin counter, displayed in the top-left corner of the screen, showing the current coin total.
13. **Upgrade Shop:** Implement a functional upgrade shop area where players can spend coins.
14. **Faster Watering Can Upgrade:** The upgrade shop must offer a "Faster Watering Can" upgrade for purchase. Upon purchase, this upgrade must increase the crop growth speed of tomato plants by 25%.
15. **Inventory System:** Implement a player inventory system that can hold a maximum of 10 tomatoes, 10 eggs, 10 jelly jars, and 10 sugar items. Inventory items should be visually represented when held by the player character before placement.
16. **Interaction Prompts:** Basic visual feedback for interaction (e.g., picking up, placing, using machines) should be present.

Build ALL of the above in this one pass. Do not defer any item to a future version.