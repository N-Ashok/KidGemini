"use client";
// Pull-to-resize for the preview panel (docs/PRD-IDEA-BUTTON.md §resizable
// pane). The panel was a fixed 440px column; this handle on its left border
// lets the kid drag it to taste. CSS-var driven (--panel-w) so the subtree —
// and the running game's iframe — never remounts. Presentational; the clamp
// and persistence logic live in lib/preview-pane.ts.

import { useState } from "react";
import { clampPanelWidth } from "@/lib/preview-pane";

interface PanelResizeHandleProps {
  width: number;
  /** Live during the drag (drives --panel-w). */
  onResize: (w: number) => void;
  /** Drag finished / key released — persist the width. */
  onCommit: (w: number) => void;
}

const KEY_STEP_PX = 24;

export function PanelResizeHandle({ width, onResize, onCommit }: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false);

  function widthFromPointer(clientX: number): number {
    // The panel hugs the right edge — width is the distance from the pointer
    // to the right side of the window.
    return clampPanelWidth(window.innerWidth - clientX, window.innerWidth);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    onResize(widthFromPointer(e.clientX));
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setDragging(false);
    onCommit(widthFromPointer(e.clientX));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Panel is on the RIGHT: ← makes it wider, → narrower.
    const delta = e.key === "ArrowLeft" ? KEY_STEP_PX : e.key === "ArrowRight" ? -KEY_STEP_PX : 0;
    if (!delta) return;
    e.preventDefault();
    const w = clampPanelWidth(width + delta, window.innerWidth);
    onResize(w);
    onCommit(w);
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the game panel"
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        className="group absolute inset-y-0 left-0 z-20 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center focus-visible:outline-none md:flex"
      >
        {/* The visible grip — brand-tinted on hover/drag/focus so it reads as draggable. */}
        <span
          aria-hidden
          className={`h-10 w-1 rounded-full transition-colors ${
            dragging ? "bg-brand-500" : "bg-neutral-200 group-hover:bg-brand-300 group-focus-visible:bg-brand-500"
          }`}
        />
      </div>
      {/* While dragging, the game's iframe would swallow pointermove — a
          transparent shield keeps the drag smooth across the whole window. */}
      {dragging && <div className="fixed inset-0 z-[120] cursor-col-resize" aria-hidden />}
    </>
  );
}
