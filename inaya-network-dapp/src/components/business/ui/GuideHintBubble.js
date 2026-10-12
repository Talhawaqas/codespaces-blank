"use client";

// src/components/business/ui/GuideHintBubble.js
//
// Command Palette + Virtual Guide SOW. A small, dismissible, non-blocking
// hint popover shown when useStuckNavDetector decides the user keeps
// bouncing back to the same view. Deliberately NOT a chatbot and NOT
// Modal.js: typing a question is itself part of the friction being
// solved, and a full-screen modal would block the page it's meant to
// help with. Uses the same anchored-popover + click-outside pattern as
// NotificationsBell.js instead.
//
// Positioned at the OPPOSITE corner (bottom-5 LEFT-5) from the existing
// AIWidget's robot-emoji button (bottom-5 right-5) on purpose, so the two
// stay visually distinct: this is the ambient guide, not the chat
// assistant. Same violet-to-cyan "assistant" gradient AIWidget/
// GuidedTaskPanel already establish.
//
// Voice is strictly opt-in and reads the hint with the browser's native
// SpeechSynthesis, not useVoiceSession (src/hooks/useVoiceSession.js) --
// that hook wraps a live, two-way Gemini conversation with no capability
// to read a pre-written string verbatim; forcing a fit would mean opening
// a live session, a mic-permission prompt, and real risk of the model
// paraphrasing instead of reading the authored hint. SpeechSynthesis is
// the right-sized tool for "read this known string aloud."

import { useEffect, useRef, useState } from "react";
import { hintFor } from "../../../lib/guide/hints";

const AUTO_DISMISS_MS = 20_000;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function GuideHintBubble({ orgId, stuckView, onDismiss, onStartGuidedTask, orgVoiceEnabled }) {
  const containerRef = useRef(null);
  const [readAloud, setReadAloud] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // Load the per-user voice preference once a hint is actually about to show -- no need to fetch it
  // eagerly on every page load for a feature most visits will never trigger.
  useEffect(() => {
    if (!stuckView || prefsLoaded) return;
    api(`/api/orgs/guide/prefs?orgId=${orgId}`)
      .then((d) => setReadAloud(!!d.readHintsAloud))
      .catch(() => {})
      .finally(() => setPrefsLoaded(true));
  }, [stuckView, orgId, prefsLoaded]);

  useEffect(() => {
    if (!stuckView) return undefined;
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [stuckView, onDismiss]);

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) onDismiss();
    }
    if (stuckView) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [stuckView, onDismiss]);

  const hint = stuckView ? hintFor(stuckView) : null;
  const voiceActive = !!(orgVoiceEnabled && readAloud);

  useEffect(() => {
    if (!hint || !voiceActive || typeof window === "undefined" || !window.speechSynthesis) return undefined;
    const utterance = new window.SpeechSynthesisUtterance(hint.body);
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stuckView, voiceActive]);

  async function toggleReadAloud() {
    const next = !readAloud;
    setReadAloud(next); // optimistic; self-contained widget, matches NotificationsBell's own error-tolerant style
    try {
      await api("/api/orgs/guide/prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, readHintsAloud: next }) });
    } catch {
      setReadAloud(!next); // revert on failure
    }
  }

  if (!stuckView || !hint) return null;

  return (
    <div ref={containerRef} className="fixed bottom-5 left-5 z-[9998] w-80 max-w-[calc(100vw-2.5rem)]">
      <div className="bg-[var(--inaya-surface)] border border-violet-400/25 rounded-2xl shadow-2xl p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg shrink-0" aria-hidden="true">🤖</span>
            <span className="text-[11px] uppercase tracking-wide font-bold text-violet-300/80">Tip</span>
          </div>
          <button onClick={onDismiss} aria-label="Dismiss hint" className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0 min-w-[24px] min-h-[24px] flex items-center justify-center">
            ×
          </button>
        </div>

        <p className="text-xs text-[var(--inaya-text-primary)] leading-relaxed mb-3">{hint.body}</p>

        <div className="flex items-center justify-between gap-2">
          {hint.workflowKey ? (
            <button
              onClick={() => onStartGuidedTask?.(hint.workflowKey)}
              className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-gradient-to-r from-violet-400 to-[#00f2fe] text-[#060913]"
            >
              Walk me through it
            </button>
          ) : (
            <span />
          )}

          {orgVoiceEnabled && (
            <button
              onClick={toggleReadAloud}
              className={`text-[11px] px-2 py-1 rounded-md border ${readAloud ? "border-violet-400/40 text-violet-300 bg-violet-400/10" : "border-white/10 text-[var(--inaya-text-muted)] hover:bg-white/5"}`}
              title="Read hints aloud"
            >
              🔈 {readAloud ? "On" : "Off"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
