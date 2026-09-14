# Inaya AI Voice Assistant

A real-time voice interface for the existing Business AI Assistant
(`/api/ai/business-chat`, powering `AIWidget.js` and the full-page AI
Assistant tab). Voice is an additional transport onto the SAME assistant —
same business context, same tools, same permission boundaries, same
propose-then-approve mutation flow. Nothing about the text assistant
changed to build this.

## Architecture

```
Browser (mic)
   |  POST /api/ai/voice-session  (requireMembership, feature-flag + rate-limit checks)
   v
Inaya server  --  ai.authTokens.create({ uses:1, expireTime, liveConnectConstraints:{
                     model, config:{ systemInstruction, tools, responseModalities:[AUDIO],
                     inputAudioTranscription:{}, outputAudioTranscription:{} } } })
   |  returns a short-lived, single-use, config-LOCKED token (never the real API key)
   v
Browser  --  ai.live.connect({ model, callbacks })  directly to Gemini over WSS
   |  sendRealtimeInput(audio) <-> onmessage(audio + transcript + tool calls)
   |
   |  on a tool-call message:
   +-- POST /api/ai/voice-tool-relay { orgId, toolName, args }
   |      (requireMembership AGAIN + rebuilds ctx via buildBusinessContext + runBusinessTool)
   +-- session.sendToolResponse(result)   <- only place any tool logic ever executes
```

The browser talks to Gemini's Live API directly (a real, documented
capability of the installed `@google/genai` SDK, v2.19.0) rather than
through a persistent server-side relay, because this app deploys on
Vercel serverless functions, which don't fit a long-lived WebSocket relay
well. The permanent `GEMINI_API_KEY` is used only server-side, once, to
mint the ephemeral token.

## Why this is secure

- **The browser never holds `GEMINI_API_KEY`.** Only a short-lived
  (default 10-minute, `GEMINI_VOICE_MAX_SESSION_SECONDS`-configurable),
  single-use (`uses: 1`) token minted per session.
- **The token is config-locked.** `liveConnectConstraints` +
  `lockAdditionalFields` bake the system instruction, tool declarations,
  response modality, and transcription settings into the token itself at
  mint time — a client holding the token cannot reconnect with a
  different system prompt or tool set.
- **Every tool call is re-authorized on every single invocation.** The
  ephemeral token proves nothing about ongoing authorization by itself —
  `/api/ai/voice-tool-relay` re-runs `requireMembership()` and rebuilds
  the caller's permission-scoped context (`buildBusinessContext`) fresh
  on every call, then dispatches through the exact same `runBusinessTool()`
  the text assistant uses. Cross-workspace isolation is structurally
  identical to the text path, not separately re-implemented.
- **Mutating actions still only ever propose, never execute directly.**
  Every `propose_*` tool creates a pending-approval record (`ai-action-requests.js`);
  a human must approve it, and even then a 36-hour delay applies before
  it executes. This is unchanged by voice — there is no tool voice can
  call that skips this, regardless of what a spoken instruction claims.
  This is the real, structural defense against "prompt manipulation via
  speech" (SOW §22), not just the added system-prompt wording asking the
  model to refuse suspicious instructions (also present, but treated as
  a second layer, not the primary defense).

## Feature flag

Two layers, both required:
1. `VOICE_AI_ENABLED=true` — global kill switch, env-only, no deploy needed to flip.
2. `org.aiPolicy.voiceEnabled` — per-org opt-in, owner/admin-settable, defaults to `false` for every org (new and existing).

Both are re-checked server-side on every `/api/ai/voice-session` request
regardless of what the client UI shows.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes (already required by the existing text assistant) | — | Used server-side only, to mint ephemeral tokens. Never sent to the browser. |
| `VOICE_AI_ENABLED` | No | `false` (unset) | Global kill switch for the whole feature. |
| `GEMINI_VOICE_MODEL` | No | `gemini-live-2.5-flash-preview` | Live-capable model id. Live model availability changes on Google's side over time — override here if the default is retired. |
| `GEMINI_VOICE_MAX_SESSION_SECONDS` | No | `600` (10 min) | Server-enforced (via the ephemeral token's own `expireTime`) session length cap. |
| `GEMINI_VOICE_RATE_LIMIT` | No | `5` | Max voice sessions a single user can start per org per minute. |

No `.env.example` exists anywhere in this repository today (only real
`.env.local`/`env.local` files) — these are documented here rather than
inventing a new template file that would otherwise need to enumerate
every unrelated existing secret.

## Data stored

A `voice_sessions` collection (`src/lib/orgs.js`) holds one row per
session: org, user, model, start/end timestamps, duration, request/tool-
call/error counts, and end reason. **No raw microphone audio is ever
stored** — audio only ever exists in-memory in the browser and in transit
to/from Gemini. Session end is also written once to the existing
`org_activity` audit log, matching this app's once-per-lifecycle-event
audit granularity for other features (e.g. OAuth connect/disconnect).

## Known limitations

- **Rate limiting is in-memory, per server instance** (matching the
  existing docs-bot rate limiter's own accepted trade-off — no shared
  cache/Redis exists anywhere in this codebase). On a multi-instance
  deployment, the effective limit is `max × instance_count`, not a hard
  global cap.
- **No automatic reconnection/session-resumption is implemented.** The UI
  correctly shows a "Connection lost — reconnecting…" state and lets the
  user press the mic again to start a fresh session, but Gemini's own
  `sessionResumption` feature (transferring mid-conversation state across
  a reconnect) is not wired up — reliability-first, push-to-talk scope,
  matching the SOW's own stated Phase-1 priority. A good next step.
- **Barge-in/interruption is not implemented** — the SOW explicitly scopes
  this as optional/future once push-to-talk reliability is established.
- **Whether this Google Cloud project's `GEMINI_API_KEY` is provisioned
  for ephemeral tokens / Live API** is verified empirically by
  `test/ai-voice-token-mint.test.mjs` (the one test in this feature that
  calls the real Gemini API) rather than assumed — see the test run
  results in the final implementation report for the actual outcome.

## Files

- `src/lib/ai-voice-session.js` — feature flag check, live-config building, ephemeral token minting, session usage logging.
- `src/lib/voice-rate-limit.js` — session-start/tool-call rate limiting, concurrent-session cap.
- `src/app/api/ai/voice-session/route.js` — mints a token for a new session.
- `src/app/api/ai/voice-session/end/route.js` — records a session's end.
- `src/app/api/ai/voice-tool-relay/route.js` — the only place any tool actually executes for voice.
- `src/app/api/ai/voice-capability/route.js` — lets the UI know whether to show the mic control.
- `src/hooks/useVoiceSession.js` — client state machine (`voiceSessionReducer`, unit-tested separately) + Gemini Live wiring.
- `src/components/business/VoiceAssistantControl.js` — the shared mic-button UI, used by both `AIWidget.js` and the full-page AI Assistant tab.
