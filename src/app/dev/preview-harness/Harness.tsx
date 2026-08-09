"use client";
// The real components, in the real split layout. Nothing here is mocked: the
// verify controller runs its actual probes against the actual iframes, so the
// pane reaches shadow-verify the same way it does for a child mid-edit.

import { useState } from "react";
import { ArtifactFrame } from "@/components/ArtifactFrame";
import { Composer } from "@/components/Composer";

export function Harness({ gameA, gameB }: { gameA: string; gameB: string }) {
  const [html, setHtml] = useState(gameA);
  const [sent, setSent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [queueFull, setQueueFull] = useState(false);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
      {/* Left: the chat column, with the REAL composer at its foot. */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ padding: 12, borderBottom: "1px solid #eee" }}>
          <button data-testid="swap" onClick={() => setHtml((h) => (h === gameA ? gameB : gameA))}>
            Swap game (triggers a new verify → shadow)
          </button>
          <span data-testid="sent-count" style={{ marginLeft: 12 }}>
            sent:{sent.length}
          </span>
          <label style={{ marginLeft: 12 }}>
            <input data-testid="busy" type="checkbox" checked={busy} onChange={(e) => setBusy(e.target.checked)} /> busy
          </label>
          <label style={{ marginLeft: 8 }}>
            <input
              data-testid="queuefull"
              type="checkbox"
              checked={queueFull}
              onChange={(e) => setQueueFull(e.target.checked)}
            />{" "}
            queueFull
          </label>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          {sent.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </div>
        {/* Production wires these: ChatPanel.container renders
            <Composer busy={busy} queueing={busy} queueFull={!canQueue(...)} />.
            A repair that runs to the 60s timeout keeps `busy` true for the
            whole edit, so the harness must be able to hold that state. */}
        <Composer
          busy={busy}
          queueing={busy}
          queueFull={queueFull}
          onSend={(t) => setSent((v) => [...v, t])}
          onStop={() => setBusy(false)}
        />
      </main>

      {/* Right: the preview panel, same relationship as production. */}
      <div style={{ width: 440, borderLeft: "1px solid #e5e5e5", position: "relative" }}>
        {/* The props production passes. Without conversationId/messageId the
            save channel is inert, and without onCaptureIdea the Idea mic tab
            never mounts — which is exactly why the first version of this
            harness ran green while production was broken. */}
        <ArtifactFrame
          html={html}
          originalRequest="a jungle river game"
          onClose={() => {}}
          conversationId="harness-conv"
          messageId="harness-msg"
          onCaptureIdea={() => true}
          helpTab={<div data-testid="help-tab">help</div>}
        />
      </div>
    </div>
  );
}
