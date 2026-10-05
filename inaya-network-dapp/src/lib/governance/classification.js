// src/lib/governance/classification.js
//
// Classification service (Competitive Expansion SOW D2, CLASS-001..004) on top of the existing level model in src/lib/classification.js and the
// deterministic evaluator in classifyRules.js. Rules are published `classification` governance policies (versioned, immutable once published).
//
// PRIVACY: Inaya never decrypts private content just to classify it. Three honest paths:
//   metadata   server-side rules over file name, path, type, department, source, metadata. Always available.
//   server_text  only for objects the server legitimately holds in readable form (S3/Azure compatibility objects are server-managed); the
//                server fetches the bytes itself and runs the same rules.
//   client     the browser or a customer-controlled scanner/gateway evaluates content rules locally (the rules are fetched with
//                `rulesForClients`) and REPORTS the verdict. The server validates the rule ids against what is actually published, records
//                the source as "client", and never sees the text.
// AI assistance goes through the existing AI Security Gateway (docIntelligence classifyWithAi); it only ever SUGGESTS, with confidence capped.
// A manual classification always carries a reason and blocks later automatic changes; reclassification is an explicit action.
// Every change writes history and the org audit chain (the Evidence Graph's source).

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { requireDocumentAccess } from "../document-permissions.js";
import { logOrgActivity } from "../org-activity-log.js";
import { getOrgClassificationLevels } from "../classification.js";
import { effectivePolicies, GovError } from "./policies.js";
import { evaluateClassification } from "./classifyRules.js";
import { emitFileEvent } from "./events.js";

const fail = (status, message, extra) => { throw new GovError(status, message, extra); };
const nowIso = () => new Date().toISOString();
export const AI_CONFIDENCE_CAP = 0.9;

let indexed = false;
async function hist() { const c = await getOrgCollections(); const h = c.db.collection("classification_history"); if (!indexed) { await h.createIndex({ orgId: 1, documentId: 1, at: -1 }); indexed = true; } return { c, h }; }
const levelInfo = async (orgId) => { const levels = await getOrgClassificationLevels(orgId); const order = {}; levels.forEach((l, i) => { order[l.key] = l.sortOrder ?? i; }); return { levels, order, keys: new Set(levels.map((l) => l.key)) }; };

/** Effective classification rules for a context, flattened with their policy reference. Also what clients download to classify locally. */
export async function rulesForClients({ orgId, ctx = {} }) {
  const policies = await effectivePolicies({ orgId, type: "classification", ctx });
  return policies.flatMap((p) => (p.config.rules || []).map((r) => ({ ...r, policyKey: p.policyKey, policyVersion: p.version })));
}

const view = (e) => ({ historyId: String(e._id), documentId: String(e.documentId), at: e.at, from: e.from, to: e.to, source: e.source, status: e.status, confidence: e.confidence ?? null, explanation: e.explanation || null, matches: e.matches || [], reason: e.reason || null, by: e.by, ruleVersions: e.ruleVersions || [] });
async function writeHistory({ orgId, doc, from, to, source, status, confidence, explanation, matches, reason, by }) {
  const { h } = await hist();
  const e = { _id: new ObjectId(), orgId: toObjectId(orgId), documentId: doc._id, at: nowIso(), from: from ?? null, to, source, status, confidence: confidence ?? null, explanation: explanation ? String(explanation).slice(0, 1000) : null, matches: (matches || []).slice(0, 20).map((m) => ({ ruleId: m.ruleId, policyKey: m.policyKey, policyVersion: m.policyVersion, level: m.level, confidence: m.confidence, explanation: m.explanation })), ruleVersions: [...new Set((matches || []).map((m) => `${m.policyKey}@${m.policyVersion}`))], reason: reason || null, by };
  await h.insertOne(e);
  emitFileEvent(orgId, status === "applied" ? "classified" : "classification_suggested", { documentId: String(doc._id), level: to, source, confidence: confidence ?? null });
  await logOrgActivity({ orgId, recordType: "CLASSIFICATION", recordId: doc._id, actorEmail: by, action: status === "applied" ? "CLASSIFIED" : status === "suggested" ? "CLASSIFICATION_SUGGESTED" : "CLASSIFICATION_REJECTED", previousState: from ? { classification: from } : null, newState: { classification: to }, metadata: { source, confidence: confidence ?? null, ruleVersions: e.ruleVersions, reason: reason || null } }).catch(() => {});
  return e;
}
async function applyLevel({ c, doc, to, source, confidence }) {
  await c.orgDocuments.updateOne({ _id: doc._id }, { $set: { classification: to, classificationSource: source, classificationConfidence: confidence ?? null, classifiedAt: nowIso() }, $unset: { classificationSuggestion: "" } });
}

/**
 * Run the rules for one document and apply or suggest the result.
 *  - `text` (optional): content the caller is entitled to supply (server-managed objects only; see mode checks in the route).
 *  - `force`: reclassify even if the document was classified manually (needs MANAGE; the history records it).
 */
export async function classifyDocument({ orgId, documentId, membership, email, text = null, source = "rules", force = false, dryRun = false }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "EDIT" }); if (access.error) fail(access.status, access.error);
  const doc = access.doc; const { c } = await hist(); const { order, keys } = await levelInfo(orgId);
  const rules = (await rulesForClients({ orgId, ctx: { email, role: membership?.role, departmentId: doc.departmentId, path: doc.filename } })).filter((r) => keys.has(r.level));
  const meta = { ...(doc.metadata || {}) };
  const result = evaluateClassification(rules, { filename: doc.filename, path: doc.filename, departmentId: doc.departmentId, source: doc.source || (doc.encryptionMode === "server-managed" ? "s3" : "workspace"), metadata: meta }, text, order);
  const out = { documentId: String(doc._id), current: doc.classification || null, proposed: result.level, confidence: result.confidence, matches: result.matches, contentEvaluated: result.contentEvaluated, contentRulesSkipped: result.contentSkipped, applied: false, suggested: false };
  if (dryRun || !result.level || result.level === doc.classification) return out;
  const manual = doc.classificationSource === "manual";
  if (manual && !force) { out.blockedBy = "manual"; return out; }
  if (force && !(canManageOrg(membership) || access.accessLevel === "MANAGE")) fail(403, "Only someone with Manage access can reclassify over a manual classification.");
  const explanation = result.matches.filter((m) => m.level === result.level).map((m) => `${m.ruleName || m.ruleId}: ${m.explanation}`).join(" | ");
  if (result.apply === "apply") {
    await applyLevel({ c, doc, to: result.level, source, confidence: result.confidence });
    await writeHistory({ orgId, doc, from: doc.classification, to: result.level, source, status: "applied", confidence: result.confidence, explanation, matches: result.matches, by: email });
    out.applied = true;
  } else {
    await c.orgDocuments.updateOne({ _id: doc._id }, { $set: { classificationSuggestion: { level: result.level, confidence: result.confidence, source, at: nowIso() } } });
    await writeHistory({ orgId, doc, from: doc.classification, to: result.level, source, status: "suggested", confidence: result.confidence, explanation, matches: result.matches, by: email });
    out.suggested = true;
  }
  return out;
}

/** The verdict of a client-side or customer-controlled evaluation. The text never reaches the server; the rule ids must exist in published policy. */
export async function reportClientClassification({ orgId, documentId, membership, email, level, ruleIds, confidence = 0.8, scanner = "browser" }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "EDIT" }); if (access.error) fail(access.status, access.error);
  const doc = access.doc; const { c } = await hist(); const { keys } = await levelInfo(orgId);
  if (!keys.has(level)) fail(400, "Unknown classification level.");
  const rules = await rulesForClients({ orgId, ctx: { email, role: membership?.role, departmentId: doc.departmentId, path: doc.filename } }); const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  const ids = Array.isArray(ruleIds) ? ruleIds.map(String) : []; if (!ids.length || ids.some((i) => !byId[i])) fail(400, "The report cites a rule that is not in the published policy.");
  if (!ids.some((i) => byId[i].level === level)) fail(400, "None of the cited rules classifies at that level.");
  if (doc.classificationSource === "manual") return { applied: false, blockedBy: "manual" };
  const matches = ids.map((i) => ({ ruleId: i, ruleName: byId[i].name, policyKey: byId[i].policyKey, policyVersion: byId[i].policyVersion, level: byId[i].level, confidence: Math.min(Number(confidence) || 0.8, 0.95), explanation: `Reported by ${String(scanner).slice(0, 40)}` }));
  const conf = Math.min(Number(confidence) || 0.8, 0.95); const autoApply = ids.every((i) => byId[i].apply === "apply");
  if (autoApply && level !== doc.classification) { await applyLevel({ c, doc, to: level, source: "client", confidence: conf }); await writeHistory({ orgId, doc, from: doc.classification, to: level, source: "client", status: "applied", confidence: conf, explanation: `Evaluated by ${scanner}; content not seen by Inaya`, matches, by: email }); return { applied: true }; }
  await c.orgDocuments.updateOne({ _id: doc._id }, { $set: { classificationSuggestion: { level, confidence: conf, source: "client", at: nowIso() } } });
  await writeHistory({ orgId, doc, from: doc.classification, to: level, source: "client", status: "suggested", confidence: conf, explanation: `Evaluated by ${scanner}; content not seen by Inaya`, matches, by: email });
  return { applied: false, suggested: true };
}

/** AI-assisted suggestion through the AI Security Gateway. Never applies by itself; only for text the caller may legitimately supply to the server. */
export async function suggestWithAi({ orgId, documentId, membership, email, text, ai }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "EDIT" }); if (access.error) fail(access.status, access.error);
  if (!text || typeof text !== "string") fail(400, "AI assistance needs readable text.");
  const doc = access.doc; const { c } = await hist(); const { keys } = await levelInfo(orgId);
  const classify = ai || (await import("../docIntelligence/extract.js")).classifyWithAi;
  const r = await classify({ orgId, actorEmail: email, text: text.slice(0, 20_000), labels: [...keys] });
  if (!r?.ok) return { suggested: false, reason: r?.error || "The AI service did not return a usable answer.", configured: r?.error !== "not_configured" };
  const level = r.value.label; const conf = Math.min(Number(r.value.confidence) || 0.5, AI_CONFIDENCE_CAP);
  if (!keys.has(level)) return { suggested: false, reason: "The AI proposed an unknown level." };
  await c.orgDocuments.updateOne({ _id: doc._id }, { $set: { classificationSuggestion: { level, confidence: conf, source: "ai", at: nowIso() } } });
  await writeHistory({ orgId, doc, from: doc.classification, to: level, source: "ai", status: "suggested", confidence: conf, explanation: "Suggested by the AI classifier through the AI Security Gateway. Review before accepting.", matches: [], by: email });
  return { suggested: true, level, confidence: conf };
}

/** Accept or reject a pending suggestion (needs MANAGE). Accepting records who accepted it. */
export async function decideSuggestion({ orgId, documentId, membership, email, accept, reason }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "MANAGE" }); if (access.error) fail(access.status, access.error);
  const doc = access.doc; const s = doc.classificationSuggestion; if (!s) fail(409, "There is no pending suggestion.");
  const { c } = await hist();
  if (accept) { await applyLevel({ c, doc, to: s.level, source: `accepted_${s.source}`, confidence: s.confidence }); await writeHistory({ orgId, doc, from: doc.classification, to: s.level, source: `accepted_${s.source}`, status: "applied", confidence: s.confidence, explanation: "Suggestion accepted.", matches: [], reason: reason || null, by: email }); return { applied: true, level: s.level }; }
  await c.orgDocuments.updateOne({ _id: doc._id }, { $unset: { classificationSuggestion: "" } });
  await writeHistory({ orgId, doc, from: doc.classification, to: s.level, source: s.source, status: "rejected", confidence: s.confidence, explanation: "Suggestion rejected.", matches: [], reason: reason || null, by: email }); return { applied: false };
}

/** Manual classification. A reason is mandatory; it blocks later automatic changes. Setting null clears it (also with a reason). */
export async function overrideClassification({ orgId, documentId, membership, email, level, reason }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "MANAGE" }); if (access.error) fail(access.status, access.error);
  const why = String(reason || "").trim(); if (why.length < 5) fail(400, "A reason of at least 5 characters is required.");
  const { keys } = await levelInfo(orgId); if (level !== null && !keys.has(level)) fail(400, "Unknown classification level.");
  const doc = access.doc; const { c } = await hist();
  if (level === null) { await c.orgDocuments.updateOne({ _id: doc._id }, { $unset: { classification: "", classificationSource: "", classificationConfidence: "", classificationSuggestion: "" } }); }
  else await applyLevel({ c, doc, to: level, source: "manual", confidence: 1 });
  await writeHistory({ orgId, doc, from: doc.classification, to: level, source: "manual", status: "applied", confidence: 1, explanation: "Set by a person.", matches: [], reason: why, by: email });
  return { ok: true, level };
}

export async function classificationHistory({ orgId, documentId, membership, email, limit = 50 }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "VIEW" }); if (access.error) fail(access.status, access.error);
  const { h } = await hist(); const rows = await h.find({ orgId: toObjectId(orgId), documentId: access.doc._id }).sort({ at: -1 }).limit(Math.min(Number(limit) || 50, 200)).toArray();
  return { current: access.doc.classification || null, source: access.doc.classificationSource || null, confidence: access.doc.classificationConfidence ?? null, suggestion: access.doc.classificationSuggestion || null, history: rows.map(view) };
}
