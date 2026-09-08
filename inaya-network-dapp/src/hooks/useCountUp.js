"use client";

// src/hooks/useCountUp.js
//
// UI Enhancement Specs v2, §6 -- a rapid count-up animation for metric
// tiles. No charting/animation dependency: requestAnimationFrame with a
// simple ease-out, same "hand-roll it, keep bundle small" convention this
// codebase already uses for its other decorative animations (AccentGraphic,
// NetworkVisualization). Respects prefers-reduced-motion by skipping the
// animation and returning the final value immediately, matching every
// CSS animation in globals.css that does the same.

import { useEffect, useRef, useState } from "react";

const DURATION_MS = 600;

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

/** `value` may be a number, null, or undefined (loading/unavailable) --
 *  only a real finite number is animated; anything else passes through
 *  unchanged so callers keep their existing "—" placeholder behavior. */
export function useCountUp(value) {
  const [display, setDisplay] = useState(value);
  const frameRef = useRef(null);
  const prevRef = useRef(value);

  useEffect(() => {
    const isNumber = typeof value === "number" && Number.isFinite(value);
    if (!isNumber) {
      setDisplay(value);
      prevRef.current = value;
      return;
    }

    const prefersReduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) {
      setDisplay(value);
      prevRef.current = value;
      return;
    }

    const from = typeof prevRef.current === "number" ? prevRef.current : 0;
    const to = value;
    if (from === to) {
      setDisplay(to);
      return;
    }

    const start = performance.now();
    function tick(now) {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / DURATION_MS);
      const eased = easeOutQuad(t);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        prevRef.current = to;
      }
    }
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return display;
}
