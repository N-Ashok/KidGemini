// Idea Bag domain types (docs/PRD-IDEA-BUTTON.md).
// Privacy stance: `text` is the ONLY capture — the browser's speech engine
// transcribes on the fly and audio is never recorded or uploaded.

export type IdeaStatus = "bagged" | "sent" | "discarded";

/** One spoken thought captured while playing a game in the preview. */
export interface IdeaRecord {
  id: string;
  /** The conversation whose game the kid was playing when they spoke. */
  gameConvoId: string;
  /** The transcript, exactly as recognized (trimmed). */
  text: string;
  createdAt: number;
  /** How the idea arrived. Voice-only today; typed capture may come later. */
  source: "voice";
  status: IdeaStatus;
  /** When status="sent": the child chat message the bundle went out in. */
  sentInMessageId?: string;
}
