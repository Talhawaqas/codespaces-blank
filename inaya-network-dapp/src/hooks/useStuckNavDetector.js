"use client";

// src/hooks/useStuckNavDetector.js
//
// Command Palette + Virtual Guide SOW. Listens for the existing
// "inaya:guided-nav" CustomEvent (already dispatched by
// src/app/business/page.js on every activeView change -- see its own
// comment near that dispatch; originally wired for GuidedTaskPanel's
// nav-based step completion, reused here rather than adding a second nav
// listener) and detects when the user keeps bouncing back to the same
// view: the real signal behind "going back and forth with docs."
//
// Definition of "stuck": the same view appears in 3 separate nav events
// within a trailing 45-second window. One return to a view is normal
// (check something, go back); a third inside under a minute is the
// pattern worth surfacing a hint for. A 3-minute per-view cooldown after
// a hint fires keeps it from nagging on every subsequent bounce.
//
// All per-event bookkeeping lives in refs, not state, so this hook only
// triggers a re-render on the rare occasion it actually has a hint to
// show -- not on every single navigation.

import { useEffect, useRef, useState } from "react";

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 45_000;
const DEFAULT_COOLDOWN_MS = 3 * 60_000;
const BUFFER_CAP = 20;

export function useStuckNavDetector({ threshold = DEFAULT_THRESHOLD, windowMs = DEFAULT_WINDOW_MS, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const [stuckView, setStuckView] = useState(null);
  const bufferRef = useRef([]); // [{ view, t }]
  const lastHintAtRef = useRef({}); // view -> timestamp

  useEffect(() => {
    function onNav(e) {
      const view = e.detail?.view;
      if (!view) return;
      const now = Date.now();
      const buf = bufferRef.current.filter((x) => now - x.t < windowMs);
      buf.push({ view, t: now });
      bufferRef.current = buf.slice(-BUFFER_CAP);

      const count = buf.filter((x) => x.view === view).length;
      const lastHintAt = lastHintAtRef.current[view];
      const cooledDown = lastHintAt === undefined || now - lastHintAt > cooldownMs;
      if (count >= threshold && cooledDown) {
        lastHintAtRef.current[view] = now;
        setStuckView(view);
      }
    }
    window.addEventListener("inaya:guided-nav", onNav);
    return () => window.removeEventListener("inaya:guided-nav", onNav);
  }, [threshold, windowMs, cooldownMs]);

  return { stuckView, dismiss: () => setStuckView(null) };
}
