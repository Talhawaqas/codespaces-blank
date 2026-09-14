"use client";

// src/hooks/useVoiceSession.js
//
// Inaya AI Voice Assistant SOW -- client-side voice session state machine
// and Gemini Live wiring. src/hooks/useCountUp.js already establishes
// src/hooks/ as this app's convention for shared custom hooks.
//
// voiceSessionReducer is exported separately, as a plain framework-free
// function, specifically so the state-machine logic (SOW §23's "unit
// tests: voice state transitions") is testable with this repo's existing
// node:test convention -- no @testing-library/react/jsdom dependency
// exists here (confirmed via package.json), so hook-internals testing
// isn't the established pattern; a pure reducer is.
//
// Audio format: Gemini Live API's fixed, documented raw-PCM convention --
// 16-bit signed PCM, mono, 16kHz for input; 24kHz for output. Not
// configurable; this is Gemini's own protocol requirement, not a choice
// made here.
//
// Security note: the token this hook receives from POST /api/ai/voice-session
// is a short-lived, single-use, config-LOCKED ephemeral token (see
// ai-voice-session.js's mintVoiceToken) -- never the real GEMINI_API_KEY.
// Every tool call Gemini emits is relayed to POST /api/ai/voice-tool-relay,
// which re-authorizes and re-executes it server-side; this hook never
// runs business logic itself.

import { useCallback, useReducer, useRef } from "react";

export const VOICE_STATES = {
  IDLE: "idle",
  REQUESTING_PERMISSION: "requesting_permission",
  CONNECTING: "connecting",
  LISTENING: "listening",
  PROCESSING: "processing",
  SPEAKING: "speaking",
  ERROR: "error",
  PERMISSION_DENIED: "permission_denied",
  RECONNECTING: "reconnecting",
};

const initialState = {
  status: VOICE_STATES.IDLE,
  error: null,
  transcript: [], // [{role: "user"|"assistant", text}]
};

export function voiceSessionReducer(state = initialState, action) {
  switch (action.type) {
    case "START_REQUESTED":
      return { ...state, status: VOICE_STATES.REQUESTING_PERMISSION, error: null };
    case "PERMISSION_GRANTED":
      return { ...state, status: VOICE_STATES.CONNECTING };
    case "PERMISSION_DENIED":
      return { ...state, status: VOICE_STATES.PERMISSION_DENIED, error: action.error || "Microphone permission was denied." };
    case "CONNECTED":
      return { ...state, status: VOICE_STATES.LISTENING };
    case "USER_SPEECH_FINAL":
      return { ...state, status: VOICE_STATES.PROCESSING, transcript: [...state.transcript, { role: "user", text: action.text }] };
    case "INTERIM_TRANSCRIPT":
      // Not persisted to the transcript array -- only ever surfaced live
      // via state.interimText, replaced wholesale on every update.
      return { ...state, interimText: action.text };
    case "ASSISTANT_SPEAKING":
      return { ...state, status: VOICE_STATES.SPEAKING };
    case "ASSISTANT_TURN_COMPLETE":
      return {
        ...state,
        status: VOICE_STATES.LISTENING,
        interimText: null,
        transcript: action.text ? [...state.transcript, { role: "assistant", text: action.text }] : state.transcript,
      };
    case "TOOL_CALL_STARTED":
      return { ...state, status: VOICE_STATES.PROCESSING };
    case "ERROR":
      return { ...state, status: VOICE_STATES.ERROR, error: action.error || "Something went wrong." };
    case "CONNECTION_LOST":
      return { ...state, status: VOICE_STATES.RECONNECTING, error: null };
    case "STOPPED":
      return { ...initialState, transcript: state.transcript };
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

// --- Audio helpers -----------------------------------------------------

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** True feature detection -- no voice UI should render unless every one
 *  of these is actually available (SOW §20/§21: text must remain the
 *  fallback, never a broken mic button). */
export function isVoiceSupported() {
  if (typeof window === "undefined") return false;
  return !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));
}

export function useVoiceSession({ orgId, currentView, onToolCall }) {
  const [state, dispatch] = useReducer(voiceSessionReducer, initialState);

  const sessionRef = useRef(null); // Gemini Live Session
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const playbackContextRef = useRef(null);
  const playbackTimeRef = useRef(0);
  const sessionMetaRef = useRef(null); // {sessionId, startedAt, requestCount, toolCallCount, errorCount}

  const cleanupAudio = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    playbackContextRef.current?.close().catch(() => {});
    playbackContextRef.current = null;
    playbackTimeRef.current = 0;
  }, []);

  const endSession = useCallback(async (endReason) => {
    const meta = sessionMetaRef.current;
    sessionRef.current?.close();
    sessionRef.current = null;
    cleanupAudio();
    if (meta) {
      const durationMs = Date.now() - meta.startedAt;
      fetch("/api/ai/voice-session/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId, sessionId: meta.sessionId, durationMs,
          requestCount: meta.requestCount, toolCallCount: meta.toolCallCount, errorCount: meta.errorCount,
          endReason,
        }),
      }).catch(() => {});
      sessionMetaRef.current = null;
    }
  }, [orgId, cleanupAudio]);

  const playAudioChunk = useCallback((base64Pcm) => {
    if (!playbackContextRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      playbackContextRef.current = new Ctx({ sampleRate: 24000 });
      playbackTimeRef.current = playbackContextRef.current.currentTime;
    }
    const ctx = playbackContextRef.current;
    const pcm = base64ToArrayBuffer(base64Pcm);
    const samples = new Int16Array(pcm);
    const audioBuffer = ctx.createBuffer(1, samples.length, 24000);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, playbackTimeRef.current);
    source.start(startAt);
    playbackTimeRef.current = startAt + audioBuffer.duration;
  }, []);

  const stopPlayback = useCallback(() => {
    playbackContextRef.current?.close().catch(() => {});
    playbackContextRef.current = null;
    playbackTimeRef.current = 0;
  }, []);

  const handleServerMessage = useCallback(async (message) => {
    if (message.toolCall?.functionCalls?.length) {
      dispatch({ type: "TOOL_CALL_STARTED" });
      for (const call of message.toolCall.functionCalls) {
        if (sessionMetaRef.current) sessionMetaRef.current.toolCallCount += 1;
        let result;
        try {
          result = await onToolCall(call.name, call.args || {});
        } catch (err) {
          if (sessionMetaRef.current) sessionMetaRef.current.errorCount += 1;
          result = { error: err.message || "This lookup failed unexpectedly." };
        }
        sessionRef.current?.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name, response: result }] });
      }
      return;
    }

    const interim = message.serverContent?.interimInputTranscription?.text;
    if (interim) dispatch({ type: "INTERIM_TRANSCRIPT", text: interim });

    const finalUserText = message.serverContent?.inputTranscription?.text;
    if (finalUserText && message.serverContent?.inputTranscription?.finished) {
      dispatch({ type: "USER_SPEECH_FINAL", text: finalUserText });
    }

    if (message.data) {
      dispatch({ type: "ASSISTANT_SPEAKING" });
      playAudioChunk(message.data);
    }

    if (message.serverContent?.turnComplete) {
      const spokenText = message.serverContent?.outputTranscription?.text || null;
      dispatch({ type: "ASSISTANT_TURN_COMPLETE", text: spokenText });
    }
  }, [onToolCall, playAudioChunk]);

  const start = useCallback(async () => {
    if (!isVoiceSupported()) {
      dispatch({ type: "ERROR", error: "Voice isn't supported in this browser." });
      return;
    }
    dispatch({ type: "START_REQUESTED" });

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      dispatch({ type: "PERMISSION_DENIED", error: err.message });
      return;
    }
    micStreamRef.current = stream;
    dispatch({ type: "PERMISSION_GRANTED" });

    let mintRes;
    try {
      const res = await fetch("/api/ai/voice-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, currentView }),
      });
      mintRes = await res.json();
      if (!res.ok) throw new Error(mintRes.error || "Could not start a voice session.");
    } catch (err) {
      cleanupAudio();
      dispatch({ type: "ERROR", error: err.message });
      return;
    }

    sessionMetaRef.current = { sessionId: mintRes.sessionId, startedAt: Date.now(), requestCount: 0, toolCallCount: 0, errorCount: 0 };

    try {
      const { GoogleGenAI, Modality } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: mintRes.token });
      const session = await ai.live.connect({
        model: mintRes.model,
        config: { responseModalities: [Modality.AUDIO] },
        callbacks: {
          onopen: () => dispatch({ type: "CONNECTED" }),
          onmessage: (message) => { handleServerMessage(message); },
          onerror: (e) => {
            if (sessionMetaRef.current) sessionMetaRef.current.errorCount += 1;
            dispatch({ type: "ERROR", error: e?.error?.message || "Voice connection error." });
          },
          onclose: () => dispatch({ type: "CONNECTION_LOST" }),
        },
      });
      sessionRef.current = session;

      const Ctx = window.AudioContext || window.webkitAudioContext;
      const audioContext = new Ctx({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        const pcm = floatTo16BitPCM(event.inputBuffer.getChannelData(0));
        if (sessionMetaRef.current) sessionMetaRef.current.requestCount += 1;
        sessionRef.current?.sendRealtimeInput({ audio: { data: arrayBufferToBase64(pcm), mimeType: "audio/pcm;rate=16000" } });
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (err) {
      cleanupAudio();
      dispatch({ type: "ERROR", error: err.message || "Could not connect to the voice assistant." });
      await endSession("error");
    }
  }, [orgId, currentView, cleanupAudio, endSession, handleServerMessage]);

  const stop = useCallback(async () => {
    dispatch({ type: "STOPPED" });
    stopPlayback();
    await endSession("user_stopped");
  }, [endSession, stopPlayback]);

  return {
    state: state.status,
    error: state.error,
    transcript: state.transcript,
    interimText: state.interimText || null,
    start,
    stop,
    stopPlayback,
    isSupported: isVoiceSupported(),
  };
}
