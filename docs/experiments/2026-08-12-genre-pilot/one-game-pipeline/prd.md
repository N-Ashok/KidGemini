# PRD: Super Weapon Platformer

## Concept
A 3D platformer where 2–4 players pick from 4 weapon-wielding characters and battle across 3 colorful worlds, collecting stars to win.

## Core Loop
1. Open the Options menu and choose one of 3 worlds.
2. Each player picks one of 4 characters and a weapon.
3. Players jump between platforms, collect stars, and attack enemies and rival players.
4. The first player to collect 10 stars wins; if no one reaches 10 stars before 3 minutes, the player with the most stars wins.

## Win/Lose Condition
- Win: Collect 10 stars before the 3-minute timer ends, or have the most stars when time runs out.
- Lose: If a player loses all 3 hearts, they fall and respawn after 5 seconds with 2 hearts. If all players lose all hearts at the same time, the match restarts with all star counts reset to 0. In single-player, you lose if the timer reaches 0:00 with fewer than 10 stars.

## Controls
- P1: WASD to move, Space to jump, Left-click to attack, Shift to dash.
- P2: Arrow keys to move, Enter to jump, Right-click to attack, / to dash.
- P3: IJKL to move, U to jump, O to attack, H to dash.
- P4: Numpad 8/4/5/6 to move, Numpad 0 to jump, Numpad + to attack, Numpad . to dash.

## Visual Style
Bright, low-poly cartoon style. Characters have oversized heads and are 1 meter tall, each with a different color. Weapons look like glowing plastic toys, so hits create confetti bursts instead of blood. The 3 worlds are Candy Meadow, Robot Desert, and Lava Castle. Health bars are shown as 3 star icons above each player.

## Features
- The Options menu includes a World Select list showing 3 worlds, with Candy Meadow unlocked from the start and the other two worlds locked until the player collects 5 and 10 stars in previous worlds.
- The character select screen offers exactly 4 characters: Sora with a sword, Brutus with a hammer, Zara with a bow, and Pip with a magic staff.
- Local multiplayer supports 2–4 players on one keyboard, and each player must choose a different character color.
- Every character has 3 hearts; a weapon hit removes 1 heart and knocks the target 2 meters backward, followed by 1 second of blinking invincibility.
- The first player to collect 10 stars wins; stars are placed on platforms and dropped by defeated enemies, and pickup stars respawn after 20 seconds.
- Every world contains 15 enemies; each enemy patrols a fixed 4-meter path at 2 meters per second and drops 1 star when defeated.
- A Super Star power-up spawns at the center platform every 30 seconds and gives the collector 5 seconds of invincibility plus 1.5x movement speed.
- Each world has 15 platforms, and 5 of those platforms move back and forth at 1 meter per second, carrying any player standing on them.

## Scene Description
During a match, the selected world is visible: floating platforms, moving platforms, enemies, star pickups, and a central arena. At the top of the screen, each player’s character icon, 3 heart icons, and star count are shown, with the match timer at the top center. Moving elements include players running and jumping, enemies patrolling, moving platforms sliding, stars spinning, and the Super Star pulsing. The background has animated clouds and slow-scrolling hills. The camera follows the current leader and zooms out when players are more than 5 meters apart.