# Inaya AI Voice Assistant — Implementation Report

Per SOW §32's required format.

## 1. Files created

- `src/lib/ai-voice-session.js` — feature-flag check, live-config building (reuses `ai-business-tools.js` verbatim), ephemeral token minting (with retry), session lifecycle logging.
- `src/lib/voice-rate-limit.js` — session-start/tool-call sliding-window rate limiting, concurrent-session cap.
- `src/app/api/ai/voice-session/route.js` — mints a token for a new session.
- `src/app/api/ai/voice-session/end/route.js` — records a session's end, releases its concurrency slot.
- `src/app/api/ai/voice-tool-relay/route.js` — the only place any voice tool call actually executes.
- `src/app/api/ai/voice-capability/route.js` — tells the UI whether to render the mic control.
- `src/hooks/useVoiceSession.js` — client state machine (`voiceSessionReducer`, exported separately and unit-tested) + Gemini Live wiring (mic capture, audio playback, tool-call relay).
- `src/components/business/VoiceAssistantControl.js` — the shared mic-button UI used by both `AIWidget.js` and the full-page AI Assistant tab.
- `docs/inaya-voice-ai-assistant.md` — architecture/security/env-var documentation.
- `docs/voice-ai-assistant-implementation-report.md` — this report.
- Tests: `test/voice-rate-limit.test.mjs`, `test/ai-voice-session.test.mjs`, `test/ai-voice-token-mint.test.mjs`, `test/voice-usage.test.mjs`, `test/voice-session-reducer.test.mjs`.

## 2. Files modified

- `src/lib/orgs.js` — registered the new `voice_sessions` collection + 2 indexes.
- `src/lib/industry-config.js` — `DEFAULT_PROFILE.aiPolicy` extended with `voiceEnabled: false` (default off, opt-in).
- `src/app/api/orgs/settings/route.js` — GET/PATCH now include `aiPolicy` in the org profile response (it existed in the schema but wasn't serialized before this feature needed to read/write it from the client).
- `src/components/business/AIWidget.js` — added the mic control, a voice-capability check, and voice tool-call/transcript handlers.
- `src/app/business/page.js` — same additions to the full-page `AIAssistantView`, plus a new `VoiceAiSettings` toggle component rendered in the Settings tab.
- **Not modified**: `src/lib/ai-business-tools.js`, `src/app/api/ai/business-chat/route.js`. The existing text assistant is untouched by construction — voice imports and reuses its exports, it doesn't fork them.

## 3. Gemini API/model used

`@google/genai` v2.19.0 (already installed; `package.json` range `^2.13.0`), Gemini Developer API (API-key auth, not Vertex). Two real capabilities of this SDK are used:

- **`ai.live.connect()`** (browser build) — real-time bidirectional audio, called directly from the browser.
- **`ai.authTokens.create()`** — ephemeral token minting, called server-side only.

**Model**: `gemini-3.1-flash-live-preview`, overridable via `GEMINI_VOICE_MODEL`.

Important correction made during implementation: the SDK's own bundled example code (`Live.connect()`'s JSDoc) uses `gemini-live-2.5-flash-preview` for the Developer API path — but that model **does not exist** for this project's actual `GEMINI_API_KEY` (confirmed by querying `GET /v1beta/models` for real: 55 models returned, no such model among them). The real, currently available live-capable model for this project, `gemini-3.1-flash-live-preview`, was found the same way and is what's actually configured. This is exactly the kind of "verify the current supported audio/Live API interface... do not hard-code model assumptions" the SOW asked for (§7) — the generic SDK doc example was not trustworthy for this specific account without checking.

## 4. Authentication approach

Identical to the text assistant: `requireMembership(req, orgId)` (`src/lib/orgs.js`) on every route (`voice-session`, `voice-session/end`, `voice-tool-relay`, `voice-capability`). No new auth mechanism was introduced for AI specifically. The Gemini Live session itself is authorized by a short-lived (default 10 min, `GEMINI_VOICE_MAX_SESSION_SECONDS`-configurable), single-use (`uses: 1`) ephemeral token — never the real `GEMINI_API_KEY`, which is used only server-side to mint that token.

## 5. Voice session architecture

```
Browser (mic)
   |  POST /api/ai/voice-session  (requireMembership, feature-flag + rate-limit checks)
   v
Inaya server  --  ai.authTokens.create({ uses:1, expireTime, liveConnectConstraints:{ model, config } })
   |  returns a short-lived, single-use token
   v
Browser  --  ai.live.connect({ model, callbacks })  directly to Gemini over WSS
   |  sendRealtimeInput(audio) <-> onmessage(audio + transcript + tool calls)
   |
   |  on a tool-call message:
   +-- POST /api/ai/voice-tool-relay { orgId, toolName, args }  (requireMembership AGAIN)
   +-- session.sendToolResponse(result)
```

The browser talks to Gemini directly rather than through a persistent server-side relay, because this app deploys on Vercel serverless functions, which don't fit a long-lived WebSocket relay well; minting a short-lived token is a stateless HTTP call that fits serverless naturally. Audio format: 16-bit PCM mono, 16kHz in / 24kHz out (Gemini Live's fixed protocol requirement, not a configurable choice).

## 6. Rate-limiting approach

`src/lib/voice-rate-limit.js` generalizes the existing docs-bot rate limiter's exact shape (`src/app/api/ai/chat/route.js`, previously the *only* AI rate limiter in this codebase — `business-chat` has none) — in-memory sliding-window `Map`, keyed by `${orgId}:${email}` instead of IP (voice is always authenticated, unlike the public docs bot):

- `session_start`: 5/min per user per org (env `GEMINI_VOICE_RATE_LIMIT`).
- `tool_call`: 60/min per user per org.
- `concurrent_sessions`: 2 per user per org (a `Set`-based cap, not a sliding window).
- Session **duration** is enforced by Gemini itself via the ephemeral token's own `expireTime` — a real, server-side cap Google enforces, not a client-trusted countdown.

**Known limitation, stated plainly**: this state is in-memory, per server instance — on a multi-instance Vercel deployment the effective limit is `max × instance_count`, not a hard global cap. This is the exact same accepted trade-off the pre-existing docs-bot limiter already carries; not a new regression introduced by this feature.

## 7. Security measures

- **No credential leakage** — verified empirically, not assumed: ran a real production build (`npm run build`) and grepped the compiled client bundle (`.next/static/`) for the literal `GEMINI_API_KEY` value. Not found anywhere.
- **Tool calls are independently re-authorized on every invocation** — `/api/ai/voice-tool-relay` re-runs `requireMembership()` and rebuilds the caller's permission-scoped context fresh (`buildBusinessContext`) on every single call, then dispatches through the exact same `runBusinessTool()` the text assistant uses. Cross-workspace isolation is structurally identical to the already-tested text path, not a separate implementation.
- **Mutations still only ever propose, never execute directly** — every `propose_*` tool creates a pending-approval record; nothing voice can call skips this, regardless of what a spoken instruction claims. This is the real, structural defense against "prompt manipulation via speech" (SOW §22) — the system-prompt wording asking the model to refuse suspicious instructions is a second layer, not the primary one.
- **Ephemeral tokens are locked to a model + full config at mint time** (`liveConnectConstraints`) — confirmed working via a real API call (see §9). **Honest gap**: the additional, stricter `lockAdditionalFields` field-mask (which would make the client provably unable to override `systemInstruction`/`tools` even in principle) was attempted with two plausible syntaxes and rejected both times by the real API (`"field_mask is invalid for BidiGenerateContentSetup"`, 400). It was removed rather than shipped broken or guessed indefinitely against a live, billed API. **Why this residual gap is low-risk in practice**: the token is single-use, short-lived, and only ever issued to an already-authenticated legitimate org member; even in the worst case where a custom client somehow got a different system prompt applied, every tool call still independently re-authorizes through the unchanged `/api/ai/voice-tool-relay` path — a compromised prompt cannot make voice reach data or actions the caller's real permissions don't already allow.
- **Generic, safe error messages only** — no stack traces, tokens, or internal details returned to the client on any failure path (matching `business-chat/route.js`'s existing error style).
- **No raw microphone audio is ever stored** — `voice_sessions` records session-level metadata only.

## 8. Tests executed and results

All new tests pass; full pre-existing suite re-run for regression (see below).

| File | Tests | Result |
|---|---|---|
| `test/voice-rate-limit.test.mjs` | 9 | ✅ pass |
| `test/voice-session-reducer.test.mjs` | 11 | ✅ pass |
| `test/ai-voice-session.test.mjs` | 4 | ✅ pass |
| `test/voice-usage.test.mjs` | 3 | ✅ pass |
| `test/ai-voice-token-mint.test.mjs` | 1 | ✅ pass (real Gemini API call) |

**`test/ai-voice-token-mint.test.mjs` is the load-bearing test in this whole feature** — it calls the real `ai.authTokens.create()` against the real, configured `GEMINI_API_KEY`. It failed twice during development (once against a network hiccup, once against the wrong default model name) before passing — both real problems were found and fixed, not worked around:
1. The SDK's own documented example model doesn't exist for this account → fixed by discovering and switching to the real available model via a live `GET /v1beta/models` query.
2. Intermittent "fetch failed" network errors calling this specific endpoint (same class of Gemini-under-load flakiness `business-chat/route.js` already documents) → fixed by adding a retry-once, matching that existing file's own pattern.

**Manual QA performed** (live in the Browser pane, with a real fixture org/session created via the same wallet/magic-link technique used elsewhere in this session — not mocked):
- Mic button renders correctly, with the exact accessible label from SOW §21 (`"Start voice conversation"`).
- Clicking it correctly triggers a real `getUserMedia()` call; the sandboxed browser pane has no real microphone hardware and blocks device capture, so it correctly surfaced the **Permission denied** state — a real, if partial, exercise of that flow (SOW §24's "Deny microphone permission" checklist item).
- The Settings tab's new Voice AI toggle was clicked for real and confirmed to persist to the database (`aiPolicy.voiceEnabled` flipped `true → false` in Atlas after the click, with no page reload).
- **Not testable in this environment**: an actual spoken question and audio reply (needs real microphone hardware and a human speaker), reconnection after a real network drop, and the full multi-turn voice conversation flow. These need a real device test, which the SOW itself anticipates isn't always automatable.

## 9. Known limitations

- `lockAdditionalFields`' exact field-mask syntax is unresolved (see §7) — the core `liveConnectConstraints` lock works and was verified for real; this is an additional hardening layer, not the primary security boundary.
- Rate limiting is in-memory/per-instance (pre-existing accepted trade-off in this codebase, not new).
- No automatic reconnection/session-resumption — the UI correctly shows "Connection lost — reconnecting…" and lets the user restart, but Gemini's own `sessionResumption` (mid-conversation state transfer across a reconnect) isn't wired up. Reliability-first, push-to-talk scope, matching the SOW's own Phase-1 priority.
- Barge-in/interruption not implemented — explicitly scoped as optional/future by the SOW itself.
- Real end-to-end audio (a human asking a question and hearing a spoken reply) could not be tested in this development environment (no microphone hardware); needs a real-device pass before wide rollout.
- Mic capture uses `ScriptProcessorNode` (deprecated but still supported in the SOW's required browser list) rather than `AudioWorkletNode`, for simplicity in this first pass — a reasonable future hardening, not a functional issue.

## 10. Environment variables

| Variable | Required | Default |
|---|---|---|
| `GEMINI_API_KEY` | Yes (already required by the existing text assistant) | — |
| `VOICE_AI_ENABLED` | No | `false` (unset) |
| `GEMINI_VOICE_MODEL` | No | `gemini-3.1-flash-live-preview` |
| `GEMINI_VOICE_MAX_SESSION_SECONDS` | No | `600` |
| `GEMINI_VOICE_RATE_LIMIT` | No | `5` |

No `.env.example` exists anywhere in this repository (confirmed before adding anything, per SOW §28) — these are documented in `docs/inaya-voice-ai-assistant.md` instead of inventing a new template file. `VOICE_AI_ENABLED=true` was added to the local `.env.local` for manual QA during this implementation — left in place since it's a local-only dev file; per-org opt-in still defaults off regardless.

## 11. Recommended next steps

1. A real-device pass (actual microphone, actual speaker) before enabling for any real users — this environment could not exercise that path.
2. Resolve `lockAdditionalFields`' correct syntax with Google (support ticket or updated docs), then re-add it for defense-in-depth.
3. Add Gemini's `sessionResumption` for real reconnect-without-losing-context.
4. Consider `AudioWorkletNode` over `ScriptProcessorNode` for the mic pipeline.
5. Pilot with `VOICE_AI_ENABLED=true` + the per-org toggle for a small set of test workspaces first, watching the `voice_sessions` collection for real error rates and latency before a wider rollout, per SOW §29 Phase 5.
