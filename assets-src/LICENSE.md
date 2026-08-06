# First-party asset dedication — CC0 1.0

The 3D models generated into this directory by
`scripts/author-first-party-models.mjs` (the sports batch — `soccer_ball`,
`soccer_goal`, `battle_top`, `blade_top`; the cricket batch — `cricket_bat`,
`cricket_ball`, `wicket`, `cricket_pitch`, `sight_screen`; the Indian-games
batch — carrom/ludo/kho-kho/badminton/marble/kabaddi sets; and the motorcycle
batch — `sport_bike`, `race_bike`, `dirt_bike`, `cruiser_bike`,
`chopper_bike`, `police_bike`, `scooter`, `moped`, `delivery_bike`,
`mini_bike`) are original works created for this project. To the extent possible under law, the Ariantra project waives all
copyright and related or neighboring rights to these models and dedicates them
to the public domain under the Creative Commons CC0 1.0 Universal dedication:
https://creativecommons.org/publicdomain/zero/1.0/

The `footballer` and `footballer_blue` models are derivative works of Kenney's
Blocky Characters kit (https://kenney.nl/assets/blocky-characters, CC0 1.0 —
License.txt inside the kit zip): the mesh, rig, and animations are Kenney's,
with a re-painted texture atlas (team jerseys) produced by
`scripts/retexture-footballer.py`. Our modifications are likewise dedicated
CC0 1.0, so the combined works remain CC0.

The `footballer`/`footballer_blue`/`cricketer`/`kabaddi_player`/
`kho_kho_player` re-skins follow the same pattern (Kenney mesh + our CC0
atlas).

Rationale and sourcing history: `docs/2026-07-26_PRD_SportsAssets.md`,
`docs/2026-07-29_PRD_CricketAssets.md`,
`docs/2026-07-30_PRD_IndianGamesAssets.md`, and
`docs/2026-08-06_PRD_MotorcycleAssets.md` (each batch documents why the CC0
pool couldn't supply it; branded meshes are deliberately avoided —
PRD-3D-GAMES-AND-ASSETS §4.2 "nothing branded").

Note this dedication covers only the FIRST-PARTY models above. Vendored
third-party models keep their own licenses, recorded per entry in
`src/lib/assets/manifest.json` — since 2026-08-06 that includes two CC-BY 3.0
motorcycles (`military_motorbike` by Zsky, `street_motorcycle` by jeremy),
whose attribution is discharged mechanically by the credits chip
(`src/lib/assets/runtime-helpers.ts` `creditsHelper`) in every game that uses
them, plus the gallery and prompt-catalog credit lines.
