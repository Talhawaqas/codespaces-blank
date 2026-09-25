// src/lib/aiSecurity/gateway.js
//
// Inaya AI Security Workflow 2026 SOW, Phase 1 (§6). The AI Security
// Gateway -- a reusable orchestration layer an AI route calls at two
// points: once before the model runs (checkInputSecurity) and once after
// (validateOutput). Deliberately NOT a single all-in-one middleware
// function wrapping the entire request (SOW §4's "not one giant
// middleware function" -- an AI route's own model-calling loop, retry/
// timeout budget, and tool-calling logic stay exactly where they are;
// this only owns the security decision at the two boundaries).
//
// What this gateway does NOT do, on purpose:
//   - authentication/authorization -- the caller already ran
//     requireMembership()/canAccessX() before this is invoked, same as
//     every other route in this codebase; this never re-derives identity
//   - execute AI actions -- REQUIRE_APPROVAL defers to the EXISTING
//     ai-action-requests.js PENDING_APPROVAL workflow verbatim
//   - decide model routing/fallback -- that's the calling route's own
//     concern (e.g. business-chat's Gemini->Groq fallback)
//
// Fail-closed behavior: checkInputSecurity's BLOCK/decision is computed
// synchronously from policy rules alone (regex + org policy lookup) --
// it never depends on the evidence-recording write succeeding. Evidence
// recording (recordAiSecurityEvent) is deliberately fire-and-forget
// (events.js's own header explains why) so a slow/failed DB write can
// never turn into a hung or wrongly-ALLOWed AI request.

import { randomUUID } from "node:crypto";
import { detectPromptInjection } from "./promptInjection.js";
import { detectPII, redactPII } from "./piiDetector.js";
import { evaluateInputPolicy, evaluateOutputPolicy, evaluateActionPolicy } from "./policyEngine.js";
import { getOrgAiPolicy } from "./orgPolicy.js";
import { checkModelIntegrity } from "./modelRegistry.js";
import { checkAiRateLimit } from "./rateLimiting.js";
import { recordAiSecurityEvent } from "./events.js";

/**
 * Runs before the model is called. Returns a decision the caller MUST
 * act on: if `allowed` is false, the route must return its own
 * appropriate error response and must NOT call the model.
 *
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.actorEmail
 * @param {string} params.surface - e.g. "business-chat", "os-chat"
 * @param {string} [params.vertical]
 * @param {string} [params.sessionId]
 * @param {string} params.userInput - the latest user message (not full history)
 * @param {string} [params.modelId] - defaults to the gateway's own default if omitted
 * @param {string} [params.requestedActionRisk] - "LOW"|"MEDIUM"|"HIGH" if this request also proposes an action
 */
export async function checkInputSecurity({ orgId, actorEmail, surface, vertical, sessionId, userInput, modelId = "gemini-3.5-flash-lite", requestedActionRisk }) {
  const requestId = randomUUID();

  // Rate limit first -- cheapest check, and the one most likely to be
  // hit by automated abuse, so it should never cost a policy/DB lookup
  // to reject.
  try {
    await checkAiRateLimit({ orgId, actorEmail, surface });
  } catch {
    const decisionResult = { decision: "BLOCK", severity: "MEDIUM", reasons: ["Rate limit exceeded for this surface."], controlsTriggered: ["AI-MON-001"], policyVersion: "n/a" };
    recordAiSecurityEvent({ orgId, requestId, actorEmail, sessionId, surface, vertical, category: "ABUSE", decisionResult, modelId, rawInput: userInput }).catch(() => {});
    return { requestId, allowed: false, decision: "BLOCK", reason: "You're sending requests too quickly. Please wait a moment and try again.", event: decisionResult };
  }

  const [orgPolicy, modelCheck] = await Promise.all([
    getOrgAiPolicy(orgId).catch(() => null),
    checkModelIntegrity({ provider: "google", modelId }),
  ]);

  if (!modelCheck.ok) {
    const decisionResult = { decision: "BLOCK", severity: "CRITICAL", reasons: [modelCheck.reason], controlsTriggered: ["AI-MODEL-001"], policyVersion: "n/a" };
    recordAiSecurityEvent({ orgId, requestId, actorEmail, sessionId, surface, vertical, category: "MODEL_INTEGRITY", decisionResult, modelId, rawInput: userInput }).catch(() => {});
    return { requestId, allowed: false, decision: "BLOCK", reason: "This AI model configuration is not recognized as approved. Please contact your administrator.", event: decisionResult };
  }

  const injectionResult = detectPromptInjection(userInput);
  const piiResult = detectPII(userInput);

  let decisionResult = evaluateInputPolicy({ injectionResult, piiResult, orgPolicy });
  if (requestedActionRisk) {
    const actionDecision = evaluateActionPolicy({ requestedActionRisk, orgPolicy });
    decisionResult = actionDecision.decision !== "ALLOW"
      ? { ...actionDecision, reasons: [...decisionResult.reasons, ...actionDecision.reasons], controlsTriggered: [...decisionResult.controlsTriggered, ...actionDecision.controlsTriggered] }
      : decisionResult;
  }

  const category = injectionResult.detected ? "PROMPT_INJECTION" : (piiResult.hasAny ? "PII" : "VALIDATION");
  recordAiSecurityEvent({ orgId, requestId, actorEmail, sessionId, surface, vertical, category, decisionResult, modelId, rawInput: userInput }).catch(() => {});

  const allowed = decisionResult.decision !== "BLOCK";
  return {
    requestId,
    allowed,
    decision: decisionResult.decision,
    reason: allowed ? null : (decisionResult.reasons[0] || "This request was blocked by an Inaya AI security policy."),
    event: decisionResult,
  };
}

/**
 * Runs after the model produces output, before it reaches the user.
 * Always returns text to show the caller -- redaction is applied
 * in-place, never a hard block on output (a BLOCK-worthy output would be
 * a validation/model-behavior problem, logged as such, but the user
 * still gets a safe, redacted answer rather than a confusing dead end).
 */
export async function validateOutput({ orgId, actorEmail, requestId, surface, vertical, sessionId, outputText, modelId = "gemini-3.5-flash-lite" }) {
  const orgPolicy = await getOrgAiPolicy(orgId).catch(() => null);
  const piiResult = detectPII(outputText);
  const decisionResult = evaluateOutputPolicy({ piiResult, orgPolicy });

  let finalText = outputText;
  if (decisionResult.decision === "REDACT") {
    finalText = redactPII(outputText).text;
  }

  if (decisionResult.decision !== "ALLOW") {
    recordAiSecurityEvent({
      orgId, requestId: requestId || randomUUID(), actorEmail, sessionId, surface, vertical,
      category: "OUTPUT_SECURITY", decisionResult, modelId, rawOutput: outputText,
    }).catch(() => {});
  }

  return { text: finalText, decision: decisionResult.decision, wasRedacted: finalText !== outputText };
}
