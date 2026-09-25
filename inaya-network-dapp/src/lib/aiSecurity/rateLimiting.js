// src/lib/aiSecurity/rateLimiting.js
//
// Inaya AI Security Workflow 2026 SOW, Phase 2 (§7.5) / Phase 12 (§17).
// The Phase 0 audit found rateLimit.js's checkRateLimit() already exists
// and is used by mfa.js/faucet.js/security.js -- but NO AI chat route
// calls it. This is a thin, AI-specific wrapper around that existing
// primitive, not a new rate-limiting engine.

import { checkRateLimit } from "../rateLimit.js";

// Per org+actor+surface. Deliberately generous (an AI-assisted business
// workflow can legitimately involve several requests in quick
// succession) -- this exists to catch genuine abuse/automation, not to
// throttle normal interactive use.
const AI_REQUEST_MAX = 40;
const AI_REQUEST_WINDOW_MS = 5 * 60 * 1000;

/** Throws (caller should treat as a RATE_LIMIT decision, not a 500) if
 *  this actor has exceeded the AI request budget for this surface. */
export async function checkAiRateLimit({ orgId, actorEmail, surface }) {
  await checkRateLimit({
    action: `ai:${surface}`,
    key: `${orgId || "anon"}:${actorEmail || "anon"}`,
    max: AI_REQUEST_MAX,
    windowMs: AI_REQUEST_WINDOW_MS,
  });
}
