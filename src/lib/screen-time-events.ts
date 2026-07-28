// Tiny in-memory pub/sub for the "nearing screen-time cap" signal (Feature
// 4, 2026-07-28). ScreenTimeHeartbeat.tsx is mounted globally in
// layout.tsx, but the nudge banner needs to live inside the chat page's own
// component tree — not a parent/child relationship, so props can't carry
// this. No external library: one event, one listener set, client-only.

type NearingCapListener = () => void;

const listeners = new Set<NearingCapListener>();

/** Subscribe to "nearing cap" signals. Returns an unsubscribe function —
 *  call it from a `useEffect` cleanup to avoid leaking listeners. */
export function onNearingCap(fn: NearingCapListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Internal — only ScreenTimeHeartbeat.tsx should call this. */
export function emitNearingCap(): void {
  for (const fn of listeners) fn();
}
