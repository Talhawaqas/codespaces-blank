"use client";

// src/components/business/VoiceAssistantControl.js
//
// Inaya AI Voice Assistant SOW -- the mic button + every required UI state
// (SOW §6), shared by both AIWidget.js (compact) and the full-page
// AIAssistantView in business/page.js (compact=false). Built from the same
// Tailwind + --inaya-* token conventions those two already use, not a new
// visual language.
//
// Accessibility (SOW §21): text input remains available regardless (this
// component never replaces the existing input row, only sits beside it),
// accessible labels exactly as specified, a single aria-live region for
// screen-reader status, and visible focus rings via the app's default
// focus-visible styling.

import { useEffect, useRef } from "react";
import { useVoiceSession, VOICE_STATES } from "../../hooks/useVoiceSession";

const STATUS_LABEL = {
  [VOICE_STATES.IDLE]: "Talk to Inaya",
  [VOICE_STATES.REQUESTING_PERMISSION]: "Requesting microphone permission…",
  [VOICE_STATES.CONNECTING]: "Connecting…",
  [VOICE_STATES.LISTENING]: "Listening…",
  [VOICE_STATES.PROCESSING]: "Inaya is thinking…",
  [VOICE_STATES.SPEAKING]: "Inaya is responding…",
  [VOICE_STATES.ERROR]: "Voice error",
  [VOICE_STATES.PERMISSION_DENIED]: "Microphone permission denied",
  [VOICE_STATES.RECONNECTING]: "Connection lost — reconnecting…",
};

function MicIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
    </svg>
  );
}

function StopIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export default function VoiceAssistantControl({ orgId, currentView, onToolCall, onTranscriptEntry, compact = false, enabled = true }) {
  const { state, error, transcript, interimText, start, stop, stopPlayback, isSupported } = useVoiceSession({ orgId, currentView, onToolCall });
  const seenCountRef = useRef(0);

  // Voice turns render through the SAME message-bubble UI text already
  // uses (AIWidget.js's/AIAssistantView's own `messages` state) rather than
  // a second, separate transcript view -- this only forwards newly-
  // committed entries (final user speech / final assistant reply) up to
  // whichever surface is hosting this control, exactly once each.
  useEffect(() => {
    if (!onTranscriptEntry) return;
    for (let i = seenCountRef.current; i < transcript.length; i++) onTranscriptEntry(transcript[i]);
    seenCountRef.current = transcript.length;
  }, [transcript, onTranscriptEntry]);

  if (!enabled || !isSupported) return null; // text stays the only path -- no broken mic button ever renders (SOW §20)

  const isActive = state !== VOICE_STATES.IDLE && state !== VOICE_STATES.ERROR && state !== VOICE_STATES.PERMISSION_DENIED;
  const isSpeaking = state === VOICE_STATES.SPEAKING;
  const size = compact ? "w-9 h-9" : "w-11 h-11";

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => (isActive ? stop() : start())}
        aria-label={isActive ? "Stop voice recording" : "Start voice conversation"}
        title={isActive ? "Stop voice recording" : "Start voice conversation"}
        className={`shrink-0 ${size} min-w-11 min-h-11 rounded-xl flex items-center justify-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00f2fe] ${
          isActive
            ? "bg-red-500/15 border border-red-400/40 text-red-400 animate-pulse"
            : "bg-gradient-to-r from-violet-400 to-[#00f2fe] text-black"
        }`}
      >
        {isActive ? <StopIcon className="w-4 h-4" /> : <MicIcon className="w-4 h-4" />}
      </button>

      {isSpeaking && (
        <button
          onClick={stopPlayback}
          aria-label="Stop Inaya response"
          title="Stop Inaya response"
          className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] px-2 py-1 rounded-lg border border-[var(--inaya-overlay-10)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00f2fe]"
        >
          Stop
        </button>
      )}

      {!compact && (
        <span className="text-[12px] text-[var(--inaya-text-muted)] font-mono">
          {interimText ? `"${interimText}"` : STATUS_LABEL[state]}
        </span>
      )}

      {/* Single aria-live status region -- announces state changes to
          screen-reader users without needing separate visual UI per state. */}
      <span role="status" aria-live="polite" className="sr-only">
        {STATUS_LABEL[state]}{error ? `: ${error}` : ""}
      </span>

      {(state === VOICE_STATES.ERROR || state === VOICE_STATES.PERMISSION_DENIED) && error && (
        <span className="text-[11px] text-red-400">{error}</span>
      )}
    </div>
  );
}
