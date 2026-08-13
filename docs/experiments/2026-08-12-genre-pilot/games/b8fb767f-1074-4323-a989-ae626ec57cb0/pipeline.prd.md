**Product Requirements Document: First-Person Cricket Builder**

**Concept**
A simple, first-person 3D web game where children can design and play a simplified cricket match, experiencing both batting and bowling from the player's unique viewpoint.

**Core Loop**
The player chooses to be the bowler or the batsman.
1.  **Bowler's Turn**: The player aims their bowling action, selects ball type (e.g., fast, spin), and releases the ball.
2.  **Batsman's Turn**: The player watches the ball, times their shot (hit or defend) with a button press, and watches the outcome.
3.  **Scoring/Wicket**: Runs are added to the score or a wicket is taken based on the ball's trajectory and the batsman's action.
4.  **Next Ball**: The game proceeds to the next ball, switching roles after a set number of overs or wickets.

**Win/Lose Condition**
*   **Win Condition**: The player successfully scores more runs than the AI opponent after the AI completes its batting innings, or successfully defends the target score within the allotted overs.
*   **Lose Condition**: The player's team gets all 5 wickets dismissed before reaching the target score or before the overs are completed.

**Controls**
*   **Bowler View**:
    *   Mouse/Touch: Drag to aim the bowling direction (left/right, up/down).
    *   Click/Tap: Select ball type (Fast, Spin) and release the ball.
*   **Batsman View**:
    *   Mouse/Touch: Hold to charge, release to swing the bat. Button prompts appear for timing.
    *   Keyboard (PC): Arrow keys to aim swing direction; Spacebar to swing.
    *   Touchscreen: Tap button to swing bat.

**Visual Style**
Bright, cartoonish, and friendly 3D graphics with slightly exaggerated character models and environments, resembling a sunny backyard or park. Simple, clean UI elements.

**Features**
1.  Player can choose to be the batsman or the bowler at the start of a match.
2.  Bowlers can select between two distinct ball types: "Fast Ball" (travels at 80 km/h) and "Spin Ball" (travels at 60 km/h with curve).
3.  Batsmen can perform a "Defend" action (block the ball) or a "Hit" action (attempt to score runs) with timing-based input.
4.  A simplified scoring system awards 1 run for hitting the ball into the outfield and 4 runs for hitting it to the boundary.
5.  Outcomes include: scoring runs, the ball being caught by a fielder (resulting in a wicket), or the ball missing the bat and hitting the stumps (resulting in a wicket).
6.  Matches consist of a maximum of 10 overs, with 6 balls per over.
7.  A clear score display shows runs scored and wickets lost for both players.

**Scene Description**
The scene is a vibrant, grassy cricket pitch bathed in sunlight. A simple wooden fence or a line of trees marks the boundary of a medium-sized backyard. On the pitch, two cartoonish characters stand: one at the bowler's end, ready to deliver the ball, and another at the batsman's end, holding a brightly colored bat. The bowler's arm animates in a winding motion before releasing the ball, which travels in a straight or slightly curved arc towards the batsman. The batsman character performs a swinging animation when hitting or defending. Fielders, if present, are static or perform simple catch animations. The camera provides a first-person view from the bowler's eyes during bowling, and from the batsman's eyes during batting.