// Resumable generations (TECH_DEBT #23): the server-kept outcome of a chat
// turn, keyed by the client-generated replyId. Lets a disconnected client
// (screen lock, stall-guard abort under heavy load) collect the finished
// reply instead of paying for a re-generation.

export interface TurnResult {
  status: "running" | "done" | "error";
  /** The full reply text (done only). */
  text?: string;
  /** The injected game HTML (done only; null when the turn built no game). */
  artifactHtml: string | null;
}

export interface TurnResultStore {
  /** Mark a turn as generating. Also sweeps rows older than the 24h TTL. */
  start(replyId: string, userId: string, now: number): void;
  complete(replyId: string, userId: string, text: string, artifactHtml: string | null, now: number): void;
  fail(replyId: string, userId: string, now: number): void;
  /** Null when unknown OR owned by another identity (fail closed). */
  get(userId: string, replyId: string): TurnResult | null;
}
