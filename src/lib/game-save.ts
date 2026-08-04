// Validation for client-submitted save states (docs/2026-08-01_PRD_SaveContinueBuilding.md
// §3e). Fail-closed: anything malformed returns null and the write is rejected —
// the store must never hold shapes the parent app can't inject back in. Pure, no deps.

import type { GameSaveArea, GameSaveObject, GameSaveState } from "@/types/game-save.types";
import { MAX_STATE_JSON_BYTES } from "./game-save.config";

function cleanObject(input: unknown): GameSaveObject | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as GameSaveObject;
}

function cleanArea(input: unknown): GameSaveArea | null {
  const a = input as Partial<GameSaveArea> | null;
  if (!a || typeof a !== "object") return null;
  if (typeof a.id !== "string" || !a.id) return null;
  if (typeof a.originX !== "number" || typeof a.originZ !== "number") return null;
  if (!Array.isArray(a.objects)) return null;
  const objects: GameSaveObject[] = [];
  for (const raw of a.objects) {
    const o = cleanObject(raw);
    if (!o) return null;
    objects.push(o);
  }
  return { id: a.id, originX: a.originX, originZ: a.originZ, objects };
}

/** Whitelist-validate a save payload. Null = reject the write (fail closed). */
export function sanitizeGameSaveState(input: unknown): GameSaveState | null {
  const s = input as Partial<GameSaveState> | null;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  if (!Array.isArray(s.areas)) return null;
  const areas: GameSaveArea[] = [];
  for (const raw of s.areas) {
    const a = cleanArea(raw);
    if (!a) return null;
    areas.push(a);
  }
  const state: GameSaveState = { areas };
  if (JSON.stringify(state).length > MAX_STATE_JSON_BYTES) return null;
  return state;
}
