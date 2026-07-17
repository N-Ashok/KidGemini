// Pure filesystem check for logger.ts's size-based rotation (2026-07-17) —
// split out because logger.ts itself imports "server-only", which isn't
// resolvable outside Next's build (vitest can't import it directly).

import fs from "node:fs";

/** If `filePath` is at or over `maxBytes`, rotate it: current content moves
 *  to `${filePath}.1` (overwriting any prior one) and the caller should open
 *  a fresh stream against `filePath`. */
export function rotateIfNeeded(filePath: string, maxBytes: number): boolean {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return false; // doesn't exist yet — nothing to rotate
  }
  if (size < maxBytes) return false;
  fs.renameSync(filePath, `${filePath}.1`);
  return true;
}
