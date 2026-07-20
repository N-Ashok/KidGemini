// Fatal-vs-pause split for SpeechRecognition error codes (BUG-FIX-LOG
// 2026-07-07: errors were swallowed → the mic just "did nothing" on phones).
// Pure function so it unit-tests plain.
//
// 2026-07-20: micErrorMessage() moved to mic-recovery.ts as device-aware
// recovery CARDS — one hardcoded string per code told a laptop to enable
// Siri ("laptop told to fix Siri" bug). This module now only answers "does
// this code end the session?".

/** True when the error means listening cannot continue (permission, hardware,
 *  network). Pauses in speech ("no-speech", "aborted") are NOT fatal — the
 *  recognizer should silently restart so the kid can keep talking. */
export function isFatalMicError(code: string): boolean {
  return ["not-allowed", "service-not-allowed", "audio-capture", "network"].includes(code);
}
