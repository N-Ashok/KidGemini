# Build Spec: Super Weapon Platformer

Implementation target: a single self-contained HTML file using three.js. Every numbered requirement below is mandatory in the first pass. The word "must" is not optional.

## Application Flow, Modes, and Progression

1. Main Menu  
   Acceptance: The app must open to a main menu with three choices: Single Player, Local Multiplayer, and Options. Single Player starts a one-player match using P1 controls. Local Multiplayer must support 2, 3, or 4 players on the same keyboard.

2. Options Menu / World Select  
   Acceptance: The Options menu must contain a World Select list showing exactly three worlds: Candy Meadow, Robot Desert, and Lava Castle. Candy Meadow is unlocked and selected by default. Locked worlds must be visible but grayed out, showing the required star count to unlock.

3. World Unlock Rules  
   Acceptance: Robot Desert must remain locked until the player has collected at least 5 cumulative stars in Candy Meadow. Lava Castle must remain locked until the player has collected at least 10 cumulative stars in Candy Meadow and Robot Desert combined. Unlock progress must persist in browser storage across matches.

4. Character Select Screen  
   Acceptance: The character select screen must offer exactly four characters: Sora with a sword, Brutus with a hammer, Zara with a bow, and Pip with a magic staff. Each character must have a distinct visible color and model.

5. Unique Character Selection  
   Acceptance: In every match, each active player must select a different character. The game must reject a selection if another active player already chose that character.

6. Player Count Selection  
   Acceptance: Before a Local Multiplayer match starts, the game must ask for the number of players: 2, 3, or 4. Only the controls for the selected player count are active.

7. Single-Player Mode  
   Acceptance: Single-player mode uses P1 controls, one character, and the same 3D world, enemy, star, and timer rules as multiplayer. The single player loses if the timer reaches 0:00 with fewer than 10 stars.

## Controls

8. P1 Controls  
   Acceptance: P1 moves with W/A/S/D, jumps with Space, attacks with Left Mouse Button, and dashes with Shift.

9. P2 Controls  
   Acceptance: P2 moves with Arrow Keys, jumps with Enter, attacks with Right Mouse Button, and dashes with `/`.

10. P3 Controls  
    Acceptance: P3 moves with I/J/K/L, jumps with U, attacks with O, and dashes with H.

11. P4 Controls  
    Acceptance: P4 moves with Numpad 8/4/5/6, jumps with Numpad 0, attacks with Numpad +, and dashes with Numpad . (Decimal).

12. Simultaneous Input  
    Acceptance: All active players’ controls must work at the same time without blocking each other. Keyboard input for inactive players must be ignored.

## Characters, Movement, and Combat

13. Character Size and Style  
    Acceptance: All player characters are exactly 1 meter tall with visibly oversized heads and body colors that match their selected character. All character models must be low-poly and cartoon-styled.

14. Walk and Jump  
    Acceptance: Every player moves at a fixed walk speed of 4 meters per second. Jumping must be sufficient to reach a platform 2 meters above the current platform.

15. Dash  
    Acceptance: Pressing the dash key while holding a movement direction moves the player 3 meters in that direction over 0.25 seconds. Dash has a 1-second cooldown and does not deal damage.

16. Weapon Attack Types  
    Acceptance: Sora’s sword and Brutus’s hammer are melee attacks. Zara’s bow and Pip’s magic staff fire projectiles. Every successful weapon hit must apply the same damage, knockback, and invincibility rules.

17. Weapon Hit Effect  
    Acceptance: A successful weapon hit removes exactly 1 heart from the target, knocks the target 2 meters directly away from the attacker, and gives the target 1 second of blinking invincibility.

18. Heart Count  
    Acceptance: Every player has exactly 3 hearts. A hit reduces hearts by 1. Hearts are never gained during normal play.

19. Player Respawn  
    Acceptance: When a player’s hearts reach 0, they fall/are removed, and respawn after exactly 5 seconds with 2 hearts. The respawn occurs at a safe spawn platform. The respawning player keeps all stars they collected.

20. Falling Out of the World  
    Acceptance: If a player falls into the void, they are treated as having lost all remaining hearts and must respawn under the same 5-second, 2-heart rule.

21. Enemy Contact  
    Acceptance: Enemies do not attack and do not damage players on contact. Enemy patrol paths are purely ambient and enemies are destroyed only by weapon hits.

22. Enemy Health and Defeat  
    Acceptance: Each enemy is defeated by exactly 1 weapon hit. A defeated enemy drops 1 star pickup at its death location and does not respawn during that match.

## Enemies, Stars, and Power-Ups

23. Enemy Count and Patrol  
    Acceptance: Every world must contain exactly 15 enemies. Each enemy patrols a fixed straight-line path of 4 meters end-to-end at a speed of 2 meters per second, turning around at the ends.

24. Static Star Pickups  
    Acceptance: Every world must contain exactly 10 static star pickups placed on platforms. Collecting a static star adds 1 to the collector’s star count.

25. Star Respawn  
    Acceptance: A static star pickup disappears when collected and respawns at the same location after exactly 20 seconds.

26. Enemy-Dropped Stars  
    Acceptance: Enemy-dropped stars remain on the ground until collected. Once collected, they do not respawn.

27. Win by Stars  
    Acceptance: The first player to reach 10 stars wins immediately. The match ends at that moment and a victory result is shown.

28. Match Timer  
    Acceptance: Every match starts with a countdown timer at 3:00. The timer counts down in real time and is displayed at the top center of the screen.

29. Timer Expiry Result  
    Acceptance: If time reaches 0:00 before any player reaches 10 stars, the player with the highest star count wins. In single-player, if the player has fewer than 10 stars when time reaches 0:00, the player loses.

30. Multiplayer Tie at Timer Expiry  
    Acceptance: If two or more players are tied for the highest star count when time expires, the match is declared a draw and returns to the menu without declaring a winner.

31. Simultaneous Death Reset  
    Acceptance: In multiplayer, if all active players lose all hearts at the same frame, the entire match restarts from its initial state: star counts reset to 0, hearts reset to 3, timer resets to 3:00, enemies reset, static stars reset, and platforms reset.

## Worlds, Platforms, and Super Star

32. Worlds  
    Acceptance: The game must contain exactly three playable worlds: Candy Meadow, Robot Desert, and Lava Castle. Each world must have a distinct visual theme: Candy Meadow uses bright grass and pastel colors, Robot Desert uses sand and metallic robot colors, and Lava Castle uses dark stone and glowing lava colors.

33. Platform Count  
    Acceptance: Every world must contain exactly 15 platforms, including one large central arena platform.

34. Moving Platforms  
    Acceptance: Exactly 5 of the 15 platforms in every world move back and forth in a straight horizontal path at 1 meter per second, with an end-to-end travel distance of at least 4 meters.

35. Platform Carry  
    Acceptance: A moving platform must carry any player standing on it. When the player jumps off a moving platform, the player retains the platform’s horizontal velocity.

36. Super Star Spawn  
    Acceptance: A Super Star power-up must spawn at the center platform at match time 30.0 seconds. After it is collected, the next Super Star spawns at the center platform 30.0 seconds later. If active, it remains visible.

37. Super Star Effect  
    Acceptance: Collecting the Super Star grants the collector 5 seconds of invincibility and 1.5× movement speed. Picking up another Super Star while already affected resets the 5-second duration.

38. Super Star Visual  
    Acceptance: The Super Star must visibly pulse and glow so it is distinguishable from normal star pickups.

## Visual Feedback and HUD

39. Low-Poly Cartoon Style  
    Acceptance: All geometry in the game must be low-poly, bright, and cartoon-styled. No photoreal textures or dark/gritty rendering are allowed.

40. Glowing Toy Weapons  
    Acceptance: All character weapons must look like glowing plastic toys, with bright emissive materials and toy-like shapes.

41. Confetti Hits  
    Acceptance: Every damaging hit must create a confetti burst of bright colored particles at the impact point. There must be no blood or viscera anywhere in the game.

42. HUD  
    Acceptance: At the top of the screen, the game must show each active player’s character icon, 3 heart icons, and current star count. The match timer must be at the top center.

43. In-World Health Display  
    Acceptance: Above each player’s head, three star icons must represent that player’s current hearts. One icon disappears for each heart lost.

44. Star and Super Star Animation  
    Acceptance: Normal star pickups must spin continuously. The Super Star must pulse. Moving platforms must visibly slide, and enemies must visibly patrol their paths.

45. Background Animation  
    Acceptance: Every world must have animated clouds and slow-scrolling hills in the background. The background must be appropriate to the selected world.

46. Camera Follow  
    Acceptance: The camera must follow the current leader, defined as the active player with the most stars. If players are tied for the lead, the camera follows their average position.

47. Camera Zoom-Out  
    Acceptance: If the distance between any two active players is greater than 5 meters, the camera must zoom out enough to keep all active players visible on screen. When they move closer than 5 meters, the camera must zoom back in.

## Match End and Persistence

48. Result Screen  
    Acceptance: After a match ends, the game must display a result screen showing the winner’s character and star count, or a defeat/draw message where applicable. The player must be able to return to the main menu from this screen.

49. Unlock Persistence  
    Acceptance: Stars collected in all matches count toward world unlocks. Unlock progress must persist after leaving the game and reopening the HTML file. A match reset caused by simultaneous death must not erase cumulative unlock progress.

50. First-Pass Completeness  
    Acceptance: All 49 requirements above must exist in the final loaded page. None of them may be stubbed, hidden behind a settings flag, or marked as “future work.”

Build ALL of the above in this one pass. Do not defer any item to a future version.