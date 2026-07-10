/** A single console/error line captured from a sandboxed game preview.
 *  `level`/`text` are always present (the console view renders them); the
 *  structured fields ride along for runtime errors — the stack is a repair
 *  input for the self-healing preview (PRD §5.1), the flat text is not. */
export interface GameConsoleMessage {
  level: "log" | "warn" | "error";
  text: string;
  /** What produced this line. Absent = plain console.* output. */
  kind?: "error" | "rejection" | "resource";
  filename?: string;
  line?: number;
  col?: number;
  stack?: string;
  /** Failing URL for `kind: "resource"` (404'd script/img/CDN import). */
  url?: string;
}

/** Shape of the postMessage payload the injected capture script sends. */
export interface GameConsoleEvent {
  source: "kidgemini-game-console";
  message: GameConsoleMessage;
}
