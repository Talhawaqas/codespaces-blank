"use client";

// src/components/business/ConfirmButton.js
//
// Shared two-step confirmation for destructive/high-consequence actions
// (Terminate, Cancel, Reject, Archive, Revoke) across every Business
// Workspace view — before this, every one of those fired immediately on
// a single click, the exact same treatment as a harmless "Advance"
// action. First click swaps the label to "Sure?" for a few seconds; a
// second click within that window actually fires onConfirm. Clicking
// anywhere else, or letting the window lapse, reverts to the normal
// label with no action taken.

import { useState, useRef, useEffect } from "react";

const ARM_WINDOW_MS = 3000;

export default function ConfirmButton({ onConfirm, disabled, className, confirmLabel = "Sure?", children }) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function handleClick(e) {
    e.stopPropagation();
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
      return;
    }
    clearTimeout(timerRef.current);
    setArmed(false);
    onConfirm();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={armed ? `${className} ring-2 ring-red-400/60` : className}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
