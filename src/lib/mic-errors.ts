// Kid-friendly messages for SpeechRecognition error codes (BUG-FIX-LOG
// 2026-07-07: errors were swallowed → the mic just "did nothing" on phones).
// Pure function so it unit-tests plain.

/** True when the error means listening cannot continue (permission, hardware,
 *  network). Pauses in speech ("no-speech", "aborted") are NOT fatal — the
 *  recognizer should silently restart so the kid can keep talking. */
export function isFatalMicError(code: string): boolean {
  return ["not-allowed", "service-not-allowed", "audio-capture", "network"].includes(code);
}

export function micErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
      return "Please allow the microphone for this site in your browser settings, then try again. 🎤";
    case "service-not-allowed":
      return "Your phone's dictation is switched off — ask a grown-up to enable Siri & Dictation in Settings. 🎤";
    case "no-speech":
      return "I didn't hear anything — tap the mic and try speaking again! 🎙️";
    case "audio-capture":
      return "I couldn't find a microphone on this device. 🎤";
    case "network":
      return "Voice needs the internet — check the connection and try again. 📶";
    default:
      return "The mic hiccuped — tap it and try again! 🎤";
  }
}
