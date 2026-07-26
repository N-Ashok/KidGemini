// Delete-a-chat client logic (owner ask 2026-07-26): pure state transition —
// the fetch + React wiring stay in the container.
import { describe, it, expect } from "vitest";
import { stateAfterDelete } from "./chat-delete";
import type { Conversation } from "@/types/chat.types";

const convo = (id: string): Conversation => ({ id, title: `Chat ${id}`, messages: [] });

describe("stateAfterDelete", () => {
  const convos = [convo("a"), convo("b"), convo("c")];
  const remote = [
    { id: "a", title: "Chat a", updatedAt: 3 },
    { id: "z", title: "Server-only", updatedAt: 1 },
  ];

  it("CD.1 removes the chat from both the local list and the server index", () => {
    const next = stateAfterDelete(convos, remote, "a", "b");
    expect(next.convos.map((c) => c.id)).toEqual(["b", "c"]);
    expect(next.remoteIndex.map((r) => r.id)).toEqual(["z"]);
  });

  it("CD.2 deleting a non-active chat keeps the active one", () => {
    expect(stateAfterDelete(convos, remote, "c", "a").nextActiveId).toBe("a");
  });

  it("CD.3 deleting the ACTIVE chat moves to the first remaining chat", () => {
    expect(stateAfterDelete(convos, remote, "a", "a").nextActiveId).toBe("b");
  });

  it("CD.4 deleting the last local chat signals the caller to open a fresh one (null)", () => {
    const next = stateAfterDelete([convo("only")], [], "only", "only");
    expect(next.convos).toEqual([]);
    expect(next.nextActiveId).toBeNull();
  });

  it("CD.5 a server-only chat (not loaded locally) deletes cleanly from the index alone", () => {
    const next = stateAfterDelete(convos, remote, "z", "a");
    expect(next.convos.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(next.remoteIndex.map((r) => r.id)).toEqual(["a"]);
    expect(next.nextActiveId).toBe("a");
  });
});
