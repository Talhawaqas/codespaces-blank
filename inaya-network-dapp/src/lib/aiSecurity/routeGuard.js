// src/lib/aiSecurity/routeGuard.js
//
// AI Security Workflow SOW -- the two calls every AI chat route makes, in one
// place so wiring a route is a few lines and cannot drift between routes:
//
//   guardAiInput()   before the model runs: rate limit, model check,
//                    prompt-injection + PII detection, org policy. A BLOCK
//                    returns a ready 403 response and the model is never called.
//   guardAiOutput()  before the reply reaches the person: masks PII.
//
// Org-scoped routes pass an orgId (per-org policy, evidence in that org's audit
// chain and Evidence Graph). Public/wallet-scoped routes have no organization,
// so they run against the platform default policy, are rate-limited per
// identity (or client IP when anonymous), and their decisions are recorded in
// the AI security log without an org audit entry (there is no org to own it).

import { NextResponse } from "next/server";
import { checkInputSecurity, validateOutput } from "./gateway.js";
import { getClientIp } from "../ipAddress.js";

function latestUserText(messages) {
  const m = [...(messages || [])].reverse().find((x) => x?.role !== "assistant");
  return String(m?.content || "").slice(0, 4000);
}

export async function guardAiInput({ req, orgId = null, actor = null, surface, messages }) {
  const actorKey = actor || `ip:${getClientIp(req) || "unknown"}`;
  const security = await checkInputSecurity({ orgId, actorEmail: actorKey, surface, userInput: latestUserText(messages) });
  if (!security.allowed) {
    return { actorKey, security, response: NextResponse.json({ error: security.reason, security: { decision: security.decision, requestId: security.requestId } }, { status: 403 }) };
  }
  return { actorKey, security, response: null };
}

export async function guardAiOutput({ orgId = null, actorKey, surface, security, text }) {
  const v = await validateOutput({ orgId, actorEmail: actorKey, requestId: security?.requestId, surface, outputText: text });
  return { text: v.text, redacted: v.wasRedacted, security: { requestId: security?.requestId, redacted: v.wasRedacted } };
}
