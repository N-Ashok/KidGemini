// Whether a generated game implements the save contract
// (docs/2026-08-01_PRD_SaveContinueBuilding.md §3a). One-line, but named and
// shared (SRP/DRY) so ArtifactFrame's banner gate and useGameSaveChannel's
// autosave gate can never disagree about what "active" means.

import { SUPPORTS_SAVE_MARKER } from "./assets/markers";

export function gameSupportsSave(html: string): boolean {
  return html.includes(SUPPORTS_SAVE_MARKER);
}
