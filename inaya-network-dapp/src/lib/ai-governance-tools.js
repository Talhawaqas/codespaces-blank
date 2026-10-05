// src/lib/ai-governance-tools.js
//
// Read-only AI governance helpers (Competitive Expansion SOW workstream Z, AI-001), registered with the AI OS router exactly like the other tool sets and
// therefore running through the same guarded execution (the AI Security Gateway, the per-org policy, and the existing action-approval gate).
//
// 100% READ-ONLY, by construction: there is no propose_* tool here, so the assistant cannot publish a policy, change a classification, approve a DLP request,
// block a device, lift a containment or restore a file. A request that needs one gets a structured refusal pointing at the screen where a person does it.
// Every tool re-checks the caller's administrator role (owner/admin, the matching scoped role, or an auditor for read), returns only records the caller may
// read, and never returns file content (documents are client-side encrypted; these tools see names, states and counts).

import { Type } from "@google/genai";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { hasAdminRole } from "./orgGates.js";
import { listPolicies } from "./governance/policies.js";

export async function buildGovernanceContext({ orgId, membership, email }) { return { orgId, membership, email }; }

const WRITE_INTENT = [/\b(publish|approve|reject|retire|delete|remove|block|unblock|revoke|lift|restore|roll ?back|wipe|reclassify|classify (it|this|them) as|change the (policy|classification)|turn (on|off)|enable|disable)\b/i];
const CERT = [/\bcertif(y|ied|ication)\b/i, /\bguarantee/i, /\b(are we|is (this|the org(anization)?)) (secure|compliant|safe)\b/i];
const refusal = (q) => {
  if (q && WRITE_INTENT.some((p) => p.test(q))) return { refused: true, reason: "This assistant can read governance records but cannot change anything. Use the Governance, Devices, Ransomware Signals or Endpoint Backup screens to take that action yourself." };
  if (q && CERT.some((p) => p.test(q))) return { refused: true, reason: "This assistant cannot certify security or compliance or guarantee an outcome. It can summarize what the records show." };
  return null;
};
const need = (ctx, roles) => (hasAdminRole(ctx.membership, roles, { read: true }) ? null : { refused: true, reason: "You need an administrator role (or auditor access) for this area to ask about it." });
const week = () => new Date(Date.now() - 7 * 86400_000).toISOString();

async function listGovernancePolicies(args, ctx) {
  const r = refusal(args?.query) || need(ctx, ["dataGovernanceAdmin", "securityAdmin"]); if (r) return r;
  const rows = await listPolicies({ orgId: ctx.orgId, membership: { ...ctx.membership, role: "owner" }, type: args?.type || null, status: args?.status || null });
  return { policies: rows.slice(0, args?.limit || 25).map((p) => ({ name: p.name, type: p.type, version: p.version, status: p.status, precedence: p.precedence, approvalRequired: p.approvalRequired, effectiveAt: p.effectiveAt, expiresAt: p.expiresAt })), note: "Policy settings are not included here. Open Governance to read or change them." };
}
async function dlpSummary(args, ctx) {
  const r = refusal(args?.query) || need(ctx, ["dataGovernanceAdmin", "securityAdmin"]); if (r) return r;
  const { db } = await getOrgCollections(); const rows = await db.collection("dlp_events").aggregate([{ $match: { orgId: toObjectId(ctx.orgId), at: { $gt: week() } } }, { $group: { _id: { d: "$decision", a: "$action" }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }]).toArray();
  const pending = await db.collection("dlp_approvals").countDocuments({ orgId: toObjectId(ctx.orgId), status: "pending" });
  return { last7Days: rows.map((x) => ({ decision: x._id.d, action: x._id.a, count: x.n })), approvalsWaiting: pending, note: rows.length ? "Only decisions other than a plain allow are recorded." : "No restrictions were applied in the last 7 days (or DLP is not enabled)." };
}
async function explainDlpEvent(args, ctx) {
  const r = refusal(args?.query) || need(ctx, ["dataGovernanceAdmin", "securityAdmin"]); if (r) return r;
  if (!/^[0-9a-f]{24}$/.test(String(args?.eventId || ""))) return { error: "eventId must be a DLP event id." };
  const { db } = await getOrgCollections(); const e = await db.collection("dlp_events").findOne({ _id: toObjectId(args.eventId), orgId: toObjectId(ctx.orgId) }); if (!e) return { notFound: true };
  return { decision: e.decision, action: e.action, by: e.actorEmail, at: e.at, ruleId: e.ruleId, ruleName: e.ruleName, policy: e.policyKey ? `${e.policyKey} version ${e.policyVersion}` : null, matchedOn: e.matchedOn, reason: e.reason, enforced: e.enforced, explanation: `The ${e.action} was ${e.enforced ? "stopped or held" : "allowed but recorded"} because ${e.reason || "a rule matched"}${e.matchedOn?.length ? ` (matched: ${e.matchedOn.join(", ")})` : ""}.` };
}
async function classificationOverview(args, ctx) {
  const r = refusal(args?.query) || need(ctx, ["dataGovernanceAdmin"]); if (r) return r;
  const { orgDocuments, db } = await getOrgCollections(); const oid = toObjectId(ctx.orgId);
  const by = await orgDocuments.aggregate([{ $match: { orgId: oid, deletedAt: null } }, { $group: { _id: "$classification", n: { $sum: 1 } } }]).toArray();
  const suggestions = await orgDocuments.countDocuments({ orgId: oid, deletedAt: null, classificationSuggestion: { $exists: true } }); const recent = await db.collection("classification_history").countDocuments({ orgId: oid, at: { $gt: week() } });
  return { byLevel: by.map((x) => ({ level: x._id || "UNCLASSIFIED", count: x.n })), suggestionsWaiting: suggestions, changesLast7Days: recent };
}
async function ransomwareStatus(args, ctx) {
  const r = refusal(args?.query) || need(ctx, ["securityAdmin"]); if (r) return r;
  const { db } = await getOrgCollections(); const oid = toObjectId(ctx.orgId); const open = await db.collection("security_signals").find({ orgId: oid, state: "open" }).sort({ at: -1 }).limit(10).toArray(); const paused = await db.collection("ransomware_containments").countDocuments({ orgId: oid, liftedAt: null, until: { $gt: new Date().toISOString() } });
  return { openSignals: open.map((s) => ({ level: s.level, at: s.at, rules: s.rules, contained: !!s.contained, confidence: s.confidence })), credentialsPaused: paused, caveat: "Signals are heuristics with a recorded rule and confidence, not proof of an attack." };
}
async function deviceSummary(args, ctx) {
  const r = refusal(args?.query) || need(ctx, ["deviceAdmin", "securityAdmin"]); if (r) return r;
  const { db } = await getOrgCollections(); const rows = await db.collection("org_devices").find({ orgId: toObjectId(ctx.orgId) }).project({ platform: 1, trust: 1, blockedAt: 1, revokedAt: 1, lastSeenAt: 1 }).toArray(); const stale = new Date(Date.now() - 30 * 86400_000).toISOString();
  return { total: rows.length, trusted: rows.filter((x) => x.trust === "trusted").length, blocked: rows.filter((x) => x.blockedAt).length, removed: rows.filter((x) => x.revokedAt).length, notSeen30Days: rows.filter((x) => x.lastSeenAt < stale && !x.revokedAt).length, note: "Only devices that have checked in are counted." };
}
async function backupHealth(args, ctx) {
  const r = refusal(args?.query) || need(ctx, ["storageAdmin"]); if (r) return r;
  const { healthOverview } = await import("./endpoint/backup.js"); return healthOverview({ orgId: ctx.orgId, membership: { ...ctx.membership, role: "owner" } });
}

export const GOVERNANCE_TOOL_DECLARATIONS = [
  { name: "list_governance_policies", description: "List governance policies (name, type, version, status). Read-only; settings are not returned.", parameters: { type: Type.OBJECT, properties: { type: { type: Type.STRING }, status: { type: Type.STRING }, limit: { type: Type.INTEGER } } } },
  { name: "dlp_summary", description: "Summarize data-loss-prevention decisions in the last 7 days and how many approvals are waiting. Read-only.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "explain_dlp_event", description: "Explain why one DLP event happened (rule, policy version, what matched). Read-only.", parameters: { type: Type.OBJECT, properties: { eventId: { type: Type.STRING } }, required: ["eventId"] } },
  { name: "classification_overview", description: "Count documents by classification level, suggestions waiting and changes in the last 7 days. Never returns file content.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "ransomware_status", description: "Open ransomware signals (heuristics, not proof) and credentials currently paused. Read-only.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "device_summary", description: "Counts of devices by trust, blocked, removed and not seen in 30 days. Read-only.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "backup_health_summary", description: "Endpoint backup health across the organization. Read-only.", parameters: { type: Type.OBJECT, properties: {} } },
];
const IMPL = { list_governance_policies: listGovernancePolicies, dlp_summary: dlpSummary, explain_dlp_event: explainDlpEvent, classification_overview: classificationOverview, ransomware_status: ransomwareStatus, device_summary: deviceSummary, backup_health_summary: backupHealth };
export async function runGovernanceTool(name, args, ctx) { const impl = IMPL[name]; if (!impl) return { error: `Unknown tool: ${name}` }; try { return await impl(args || {}, ctx); } catch (e) { return { error: "That information could not be read right now." }; } }
export function governanceSystemInstruction() {
  return "You are the Inaya governance assistant. You can READ governance policies, data-protection decisions, classification counts, ransomware signals, device and backup health, and explain them in plain language. You can NOT change anything: you cannot publish or retire policies, approve requests, classify files, block devices, lift containments or restore files; tell the person which screen to use. Ground every statement in what a tool returned. Never certify security or compliance and never guarantee an outcome. Ransomware signals are heuristics, not proof. You never see file content.";
}
