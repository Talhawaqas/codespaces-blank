// src/lib/aiSecurity/modelRegistry.js
//
// Inaya AI Security Workflow 2026 SOW, Phase 5/15 (§10.1, §20). A real
// inventory of AI components, seeded from what the Phase 0 audit
// actually found configured in this repo -- ONE real provider (Google
// Gemini, GEMINI_API_KEY) and ONE real model literal
// ("gemini-3.5-flash-lite", currently hardcoded per-route in six AI
// routes with no shared constant). Groq (openai/gpt-oss-120b) exists as
// fallback code but GROQ_API_KEY is unset in this environment, so it's
// registered as "REVIEW" (present in code, not actually usable) rather
// than either omitted or falsely marked APPROVED.
//
// This becomes part of Evidence Graph / Trust provenance (SOW §10.2):
// every AI security event records which registry entry served the
// request, so "what model actually produced this output, and was it an
// approved one" is answerable later, not just assumed.

import { getOrgCollections } from "../orgs.js";

export const COMPONENT_TYPES = ["MODEL", "TOOL", "GUARDRAIL", "RETRIEVER", "PROVIDER"];
export const COMPONENT_STATUSES = ["APPROVED", "REVIEW", "BLOCKED"];
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

// Global (not org-scoped) -- which models exist and their base risk
// classification is a platform-level fact, not a per-org one. Per-org
// restriction (which of these an org is allowed to use) is
// orgPolicy.js's allowedProviders, evaluated separately.
const SEED_COMPONENTS = [
  {
    id: "google:gemini-3.5-flash-lite",
    type: "MODEL",
    provider: "google",
    version: "gemini-3.5-flash-lite",
    status: "APPROVED",
    riskLevel: "LOW",
    allowedVerticals: ["business", "security", "health", "legal", "government", "docs"],
    allowedDataClasses: ["general", "org-internal"],
    integrityHash: null,
    note: "The only model actually configured (GEMINI_API_KEY) and called across every AI route this pass audited.",
  },
  {
    id: "groq:openai/gpt-oss-120b",
    type: "MODEL",
    provider: "groq",
    version: "openai/gpt-oss-120b",
    status: "REVIEW",
    riskLevel: "MEDIUM",
    allowedVerticals: ["business"],
    allowedDataClasses: ["general"],
    integrityHash: null,
    note: "Fallback path exists in groqFallback.js but GROQ_API_KEY is unset in this environment -- code-present, not currently usable.",
  },
];

let seeded = false;
async function ensureSeeded() {
  if (seeded) return;
  const { aiModelRegistry } = await getOrgCollections();
  for (const component of SEED_COMPONENTS) {
    await aiModelRegistry.updateOne(
      { id: component.id },
      { $setOnInsert: { ...component, approvedBy: "system-seed", approvedAt: new Date().toISOString(), createdAt: new Date().toISOString() } },
      { upsert: true }
    );
  }
  seeded = true;
}

export async function listApprovedModels() {
  await ensureSeeded();
  const { aiModelRegistry } = await getOrgCollections();
  return aiModelRegistry.find({}).sort({ id: 1 }).toArray();
}

export async function getComponent(id) {
  await ensureSeeded();
  const { aiModelRegistry } = await getOrgCollections();
  return aiModelRegistry.findOne({ id });
}

/** Real, deterministic integrity check: is the model identifier a route
 *  actually calls the one this registry has on file as APPROVED? Called
 *  by the gateway before every model invocation (SOW §10.3 "detect
 *  unexpected changes to... model endpoint"). Returns a decision-shaped
 *  result so the caller can BLOCK on drift rather than silently
 *  proceeding with an unregistered model. */
export async function checkModelIntegrity({ provider, modelId }) {
  const component = await getComponent(`${provider}:${modelId}`);
  if (!component) {
    return { ok: false, reason: `Model "${provider}:${modelId}" is not in the approved registry.` };
  }
  if (component.status === "BLOCKED") {
    return { ok: false, reason: `Model "${provider}:${modelId}" is registered but BLOCKED.` };
  }
  if (component.status === "REVIEW") {
    return { ok: true, warning: `Model "${provider}:${modelId}" is registered as REVIEW, not yet APPROVED.` };
  }
  return { ok: true };
}
