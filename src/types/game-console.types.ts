/** A single console/error line captured from a sandboxed game preview. */
export interface GameConsoleMessage {
  level: "log" | "warn" | "error";
  text: string;
}

/** Shape of the postMessage payload the injected capture script sends. */
export interface GameConsoleEvent {
  source: "kidgemini-game-console";
  message: GameConsoleMessage;
}
