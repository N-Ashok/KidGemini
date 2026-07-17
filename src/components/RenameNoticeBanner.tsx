"use client";
// One-time "KidGemini is now Ari" notice (2026-07-17 rename). Self-contained:
// does its own mount-time localStorage check (see rename-notice.ts for why
// this is deliberately decoupled from ChatPanel.container.tsx's own chat
// hydration) rather than taking props from the parent, so dropping it
// anywhere in the tree is a one-line addition with no wiring required.

import { useEffect, useState } from "react";
import {
  RENAME_NOTICE_LINE,
  loadRenameNotice,
  saveRenameNotice,
  shouldShowRenameNotice,
} from "@/lib/rename-notice";

export function RenameNoticeBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const store = loadRenameNotice(window.localStorage);
    if (shouldShowRenameNotice(window.localStorage, store)) setVisible(true);
  }, []);

  function dismiss() {
    setVisible(false);
    saveRenameNotice(window.localStorage, { seen: true });
  }

  if (!visible) return null;

  return (
    <div
      role="status"
      className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-3 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm"
    >
      <span aria-hidden className="text-xl">🎉</span>
      <p className="flex-1 font-medium text-orange-800">{RENAME_NOTICE_LINE}</p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="rounded-full px-2 py-1 text-orange-700 hover:bg-orange-100"
      >
        ✕
      </button>
    </div>
  );
}
