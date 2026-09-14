// test/voice-session-reducer.test.mjs
//
// Pure state-machine tests (SOW §23: "unit tests: voice state transitions")
// -- voiceSessionReducer is a plain, framework-free function exported
// separately from the useVoiceSession hook specifically so it can be
// tested with this repo's existing node:test convention without needing
// @testing-library/react or jsdom (neither is a dependency here).
//
// Run with: node --env-file=.env.local --test test/voice-session-reducer.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceSessionReducer, VOICE_STATES } from "../src/hooks/useVoiceSession.js";

test("initial state is idle with no error and an empty transcript", () => {
  const state = voiceSessionReducer(undefined, { type: "@@INIT" });
  assert.equal(state.status, VOICE_STATES.IDLE);
  assert.equal(state.error, null);
  assert.deepEqual(state.transcript, []);
});

test("the full happy path: idle -> permission -> connecting -> listening -> processing -> speaking -> listening", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });

  state = voiceSessionReducer(state, { type: "START_REQUESTED" });
  assert.equal(state.status, VOICE_STATES.REQUESTING_PERMISSION);

  state = voiceSessionReducer(state, { type: "PERMISSION_GRANTED" });
  assert.equal(state.status, VOICE_STATES.CONNECTING);

  state = voiceSessionReducer(state, { type: "CONNECTED" });
  assert.equal(state.status, VOICE_STATES.LISTENING);

  state = voiceSessionReducer(state, { type: "USER_SPEECH_FINAL", text: "How many invoices are overdue?" });
  assert.equal(state.status, VOICE_STATES.PROCESSING);
  assert.deepEqual(state.transcript, [{ role: "user", text: "How many invoices are overdue?" }]);

  state = voiceSessionReducer(state, { type: "ASSISTANT_SPEAKING" });
  assert.equal(state.status, VOICE_STATES.SPEAKING);

  state = voiceSessionReducer(state, { type: "ASSISTANT_TURN_COMPLETE", text: "There are 7." });
  assert.equal(state.status, VOICE_STATES.LISTENING);
  assert.deepEqual(state.transcript, [
    { role: "user", text: "How many invoices are overdue?" },
    { role: "assistant", text: "There are 7." },
  ]);
});

test("multi-turn: a second user turn appends to the existing transcript, not replacing it", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });
  state = voiceSessionReducer(state, { type: "USER_SPEECH_FINAL", text: "How many invoices are overdue?" });
  state = voiceSessionReducer(state, { type: "ASSISTANT_TURN_COMPLETE", text: "There are 7." });
  state = voiceSessionReducer(state, { type: "USER_SPEECH_FINAL", text: "Which one is the largest?" });
  assert.equal(state.transcript.length, 3);
  assert.equal(state.transcript[2].text, "Which one is the largest?");
});

test("permission denied moves straight from requesting_permission to permission_denied with an error", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });
  state = voiceSessionReducer(state, { type: "START_REQUESTED" });
  state = voiceSessionReducer(state, { type: "PERMISSION_DENIED", error: "User denied microphone access." });
  assert.equal(state.status, VOICE_STATES.PERMISSION_DENIED);
  assert.equal(state.error, "User denied microphone access.");
});

test("permission denied with no explicit error still sets a safe, non-empty default message", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });
  state = voiceSessionReducer(state, { type: "PERMISSION_DENIED" });
  assert.equal(state.status, VOICE_STATES.PERMISSION_DENIED);
  assert.ok(state.error);
});

test("ERROR from any state moves to error with a message, and never a leaked internal object", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });
  state = voiceSessionReducer(state, { type: "CONNECTED" });
  state = voiceSessionReducer(state, { type: "ERROR", error: "Voice connection error." });
  assert.equal(state.status, VOICE_STATES.ERROR);
  assert.equal(typeof state.error, "string");
});

test("connection lost moves to reconnecting and clears any error", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });
  state = voiceSessionReducer(state, { type: "ERROR", error: "boom" });
  state = voiceSessionReducer(state, { type: "CONNECTION_LOST" });
  assert.equal(state.status, VOICE_STATES.RECONNECTING);
  assert.equal(state.error, null);
});

test("STOPPED resets to idle but preserves the transcript so far", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });
  state = voiceSessionReducer(state, { type: "USER_SPEECH_FINAL", text: "hi" });
  state = voiceSessionReducer(state, { type: "STOPPED" });
  assert.equal(state.status, VOICE_STATES.IDLE);
  assert.deepEqual(state.transcript, [{ role: "user", text: "hi" }]);
});

test("RESET fully clears state including transcript", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });
  state = voiceSessionReducer(state, { type: "USER_SPEECH_FINAL", text: "hi" });
  state = voiceSessionReducer(state, { type: "RESET" });
  assert.equal(state.status, VOICE_STATES.IDLE);
  assert.deepEqual(state.transcript, []);
});

test("interim transcripts do not get pushed into the persisted transcript array", () => {
  let state = voiceSessionReducer(undefined, { type: "@@INIT" });
  state = voiceSessionReducer(state, { type: "INTERIM_TRANSCRIPT", text: "how many..." });
  assert.equal(state.interimText, "how many...");
  assert.deepEqual(state.transcript, []);
});

test("an unknown action type is a no-op (returns the same state)", () => {
  const state = voiceSessionReducer(undefined, { type: "@@INIT" });
  const next = voiceSessionReducer(state, { type: "SOME_UNKNOWN_ACTION" });
  assert.deepEqual(next, state);
});
