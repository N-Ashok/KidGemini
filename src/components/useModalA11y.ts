"use client";
// Focus management for a modal dialog — the half `role="dialog" aria-modal`
// only CLAIMS (code review 2026-08-09).
//
// Several overlays in this app (ShareChat, PublishToArcade, InviteToTest, the
// Sidebar menu) declared the ARIA roles and stopped there: no initial focus,
// no trap, no restore, no Escape, no scroll lock. For a keyboard user that
// means opening a dialog leaves focus on the card BEHIND it, Tab walks the
// whole page underneath, and there is no way out except the mouse. Screen
// readers announce a dialog that the user then cannot reach.
//
// One hook rather than the same twenty lines in five components — the pattern
// was already implemented correctly once (ArNav's mobile sheet), and copying
// it by hand a fifth time is how the versions drift apart.

import { useEffect, useRef } from "react";

/** Elements that can hold focus. `[tabindex="-1"]` is deliberately excluded:
 *  it means "focusable by script, not by Tab", so it must not be a trap stop. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The tabbable elements inside `root`, in DOM order, skipping hidden ones. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Which element Tab should land on next, wrapping at both ends.
 *
 * Pure so the wrap-around is testable without a DOM harness — the off-by-one
 * at the boundaries is the whole point of a trap, and it's exactly what an
 * inline implementation gets wrong.
 *
 * @returns the index to focus, or -1 when the browser's own default is fine.
 */
export function nextFocusIndex(count: number, current: number, shift: boolean): number {
  if (count === 0) return -1;
  if (current === -1) return shift ? count - 1 : 0; // focus escaped the dialog
  if (shift) return current === 0 ? count - 1 : -1; // wrap backwards off the first
  return current === count - 1 ? 0 : -1; // wrap forwards off the last
}

export interface ModalA11yOptions {
  /** Called on Escape and on a trap-exit that should dismiss. */
  onClose: () => void;
  /** Set false for a non-dismissible step (e.g. mid-payment). Default true. */
  closeOnEscape?: boolean;
  /** Whether the dialog is currently OPEN. Components that mount and unmount
   *  with their dialog can leave this true; a host that stays mounted and
   *  toggles the dialog (a catalog page with a play overlay) must pass the
   *  open flag, or the effect runs once against a null ref and never again. */
  enabled?: boolean;
}

/**
 * Wire a dialog element for keyboard use. Returns the ref to put on the
 * dialog's own box — NOT on the backdrop, which is a click-to-dismiss target
 * and must not be what the role/focus attach to.
 */
export function useModalA11y({ onClose, closeOnEscape = true, enabled = true }: ModalA11yOptions) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Captured in a ref so the restore isn't affected by re-renders.
  const returnFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!enabled || !box) return;

    returnFocusRef.current = document.activeElement;
    // Move focus INTO the dialog: its first control, or the box itself when
    // it has none (a message-only dialog is still where the user is).
    const first = focusableWithin(box)[0];
    if (first) first.focus();
    else {
      box.setAttribute("tabindex", "-1");
      box.focus();
    }

    // Scroll lock — a page that scrolls behind an open dialog is the mobile
    // version of "Tab walks the page underneath".
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeOnEscape) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableWithin(box);
      const target = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (target === -1) return; // let the browser move focus normally
      e.preventDefault();
      items[target]?.focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // Put focus back where the user left it, so closing a dialog doesn't
      // dump them at the top of the document.
      const back = returnFocusRef.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [onClose, closeOnEscape, enabled]);

  return boxRef;
}
