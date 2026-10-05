// src/lib/governance/dlp.js
//
// Data loss prevention (Competitive Expansion SOW D3, DLP-001..004). Extends the idea of src/lib/policy-engine.js (a pure, table-driven
// evaluator, no fuzzy matching) with the richer context the SOW asks for, versioned `dlp` governance policies, structured events, and a
// human approval step. The older policy-engine.js is untouched and keeps serving export-center.
//
// ORDER OF OPERATIONS (important): callers run their normal permission check FIRST. DLP is only consulted after a request is already
// permitted, and its outcomes only ever RESTRICT: an explicit ALLOW rule means "stop evaluating DLP", never "grant access". No rule can
// bypass a permission check.
//
// Decisions: ALLOW, DENY, REQUIRE_APPROVAL, REQUIRE_STRONGER_AUTH, LOG_ONLY, QUARANTINE. Everything except a plain ALLOW writes a
// structured event to `dlp_events`.
// REQUIRE_STRONGER_AUTH: this platform has no step-up authentication primitive yet, so the decision is enforced as a refusal unless the
// caller supplies ctx.strongAuth === true (nothing does today). It is reported as such rather than pretending a second factor happened.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg, hasAdminRole } from "../orgGates.js";
import { ipMatchesAny, normalizeIp } from "../net/cidr.js";
import { getOrgClassificationLevels, DEFAULT_CLASSIFICATION_LEVELS } from "../classification.js";
import { effectivePolicies, GovError } from "./policies.js";
import { logOrgActivity } from "../org-activity-log.js";
import { emitFileEvent } from "./events.js";

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const lower = (v) => String(v ?? "").toLowerCase();
const nowIso = () => new Date().toISOString();

export class DlpBlocked extends Error {
  constructor(result) { super(result.message); this.name = "DlpBlocked"; this.code = result.code; this.status = result.status || 403; this.decision = result.decision; this.eventId = result.eventId; this.approvalId = result.approvalId; this.result = result; }
}

// ----------------------------------------------------------------------------------------------------- pure matching
const hit = (list, value, fn = lower) => arr(list).some((x) => fn(x) === fn(value));
const domainOf = (email) => lower(email).split("@")[1] || "";
const domainMatch = (pattern, domain) => { const p = lower(pattern).replace(/^\*\./, ""); const d = lower(domain); return !!d && (d === p || d.endsWith("." + p)); };
const extOf = (name) => (String(name).includes(".") ? lower(String(name).split(".").pop()) : "");

/** Pure. Returns { matched: boolean, why: string[] } for one rule's `when` against a context. Every field present in `when` must match. */
export function matchWhen(when, ctx, { levelOrder = {} } = {}) {
  const why = []; const w = when || {}; const no = () => ({ matched: false, why: [] }); const ok = (s) => why.push(s);
  if (w.actions?.length) { if (!hit(w.actions, ctx.action)) return no(); ok(`action ${ctx.action}`); }
  if (w.users?.length) { if (!hit(w.users, ctx.email)) return no(); ok("user"); }
  if (w.userDomains?.length) { if (!w.userDomains.some((d) => domainMatch(d, domainOf(ctx.email)))) return no(); ok("user domain"); }
  if (w.roles?.length) { if (!hit(w.roles, ctx.role)) return no(); ok(`role ${ctx.role}`); }
  if (w.groups?.length) { if (!arr(ctx.groups).some((g) => hit(w.groups, g))) return no(); ok("group"); }
  if (w.departments?.length) { if (!hit(w.departments, ctx.departmentId, String)) return no(); ok("department"); }
  const ip = ctx.ip ? normalizeIp(ctx.ip) : null;
  if (w.ipIn?.length) { if (!ip || !ipMatchesAny(ip, w.ipIn)) return no(); ok("ip in range"); }
  if (w.ipNotIn?.length) { if (ip && ipMatchesAny(ip, w.ipNotIn)) return no(); if (!ip) return no(); ok("ip outside ranges"); }
  if (w.device) {
    const d = ctx.device || {};
    if (w.device.trusted !== undefined && !!d.trusted !== !!w.device.trusted) return no();
    if (w.device.unknown !== undefined && !d.id !== !!w.device.unknown) return no();
    if (w.device.postureIn?.length && !hit(w.device.postureIn, d.posture)) return no(); ok("device");
  }
  if (w.pathPrefix?.length) { if (!arr(w.pathPrefix).some((p) => String(ctx.path ?? "").startsWith(p))) return no(); ok("path"); }
  if (w.fileTypes?.length) { const e = extOf(ctx.filename ?? ctx.path ?? ""); if (!arr(w.fileTypes).some((t) => lower(t) === e || lower(t) === lower(ctx.contentType))) return no(); ok(`type ${e || ctx.contentType}`); }
  if (w.classification?.length) { if (!hit(w.classification, ctx.classification)) return no(); ok(`classification ${ctx.classification}`); }
  if (w.minClassification) {
    const need = levelOrder[w.minClassification]; const have = levelOrder[ctx.classification];
    if (need === undefined || have === undefined || have < need) return no(); ok(`classification at least ${w.minClassification}`);
  }
  if (w.sensitivity?.length) { if (!hit(w.sensitivity, ctx.sensitivity)) return no(); ok("sensitivity"); }
  if (w.destinationTypes?.length) { if (!hit(w.destinationTypes, ctx.destinationType)) return no(); ok(`destination ${ctx.destinationType}`); }
  if (w.destinationDomains?.length) { if (!w.destinationDomains.some((d) => domainMatch(d, ctx.destinationDomain))) return no(); ok("destination domain"); }
  if (w.notDestinationDomains?.length) { if (!ctx.destinationDomain || w.notDestinationDomains.some((d) => domainMatch(d, ctx.destinationDomain))) return no(); ok("destination domain not in allowed list"); }
  if (w.shareTypes?.length) { if (!hit(w.shareTypes, ctx.shareType)) return no(); ok(`share ${ctx.shareType}`); }
  if (w.link) {
    const l = ctx.link || {};
    if (w.link.noPassword && l.passwordProtected) return no();
    if (w.link.expiryHoursOver != null && !(Number(l.expiresInHours) > w.link.expiryHoursOver || l.expiresInHours == null)) return no();
    if (w.link.noUseLimit && l.maxUses) return no(); ok("link policy");
  }
  if (w.downloadCountAtLeast != null) { if (!(Number(ctx.downloadCount) >= w.downloadCountAtLeast)) return no(); ok("download count"); }
  if (w.sizeAtLeast != null) { if (!(Number(ctx.size) >= w.sizeAtLeast)) return no(); ok("size"); }
  if (w.time) {
    const t = ctx.now ? new Date(ctx.now) : new Date(); const day = t.getUTCDay(), hour = t.getUTCHours();
    if (w.time.days?.length && !w.time.days.includes(day)) return no();
    if (w.time.fromHour != null && w.time.toHour != null) { const inside = w.time.fromHour <= w.time.toHour ? hour >= w.time.fromHour && hour < w.time.toHour : hour >= w.time.fromHour || hour < w.time.toHour; if (!inside) return no(); }
    ok("time window (UTC)");
  }
  if (w.legalHold !== undefined) { if (!!ctx.legalHold !== !!w.legalHold) return no(); ok("legal hold"); }
  if (w.retentionActive !== undefined) { if (!!ctx.retentionActive !== !!w.retentionActive) return no(); ok("retention"); }
  return { matched: true, why };
}

/** Pure. `policies` = [{policyKey, version, config:{rules:[...]}}] already ordered. First matching rule wins. */
export function evaluateRules(policies, ctx, opts = {}) {
  for (const p of policies) {
    for (const [i, r] of (p.config?.rules || []).entries()) {
      const m = matchWhen(r.when, ctx, opts);
      if (m.matched) return { decision: r.action, ruleId: r.id || `${p.policyKey}:${i + 1}`, ruleName: r.name || null, policyKey: p.policyKey, policyVersion: p.version, reason: r.message || r.name || `Matched ${m.why.join(", ")}`, userMessage: r.message || null, matchedOn: m.why, log: !!r.log };
    }
  }
  return { decision: "ALLOW", ruleId: null, policyKey: null, policyVersion: null, reason: "No DLP rule matched.", matchedOn: [] };
}

// ------------------------------------------------------------------------------------------------------ persistence
let indexed = false;
async function cols() {
  const c = await getOrgCollections(); const events = c.db.collection("dlp_events"); const approvals = c.db.collection("dlp_approvals");
  if (!indexed) { await Promise.all([events.createIndex({ orgId: 1, at: -1 }), events.createIndex({ orgId: 1, decision: 1, at: -1 }), approvals.createIndex({ orgId: 1, status: 1, createdAt: -1 }), approvals.createIndex({ orgId: 1, actorEmail: 1, action: 1, resourceId: 1, status: 1 })]); indexed = true; }
  return { events, approvals };
}
const maskIp = (ip) => {
  const n = ip ? normalizeIp(ip) : null; if (!n) return null; if (n === "::1") return n;
  return n.includes(":") ? n.split(":").slice(0, 3).join(":").replace(/:+$/, "") + "::/48" : n.split(".").slice(0, 3).join(".") + ".0/24";
};
const levelOrderFor = async (orgId) => {
  // Seeding the default levels can race when several requests arrive together; fall back to the built-in order rather than failing a request.
  let levels; try { levels = await getOrgClassificationLevels(orgId); } catch { levels = DEFAULT_CLASSIFICATION_LEVELS; }
  const o = {}; levels.forEach((l, i) => { o[l.key] = l.sortOrder ?? i; }); return o;
};

/** Evaluate without recording or enforcing (the "simulate this rule set" path and tests). */
export async function evaluateDlp({ orgId, ctx }) {
  const policies = await effectivePolicies({ orgId, type: "dlp", ctx });
  if (!policies.length) return evaluateRules([], ctx);
  const needsOrder = policies.some((p) => (p.config?.rules || []).some((r) => r.when?.minClassification));
  return evaluateRules(policies, { ...ctx, now: ctx.now || nowIso() }, { levelOrder: needsOrder ? await levelOrderFor(orgId) : {} });
}

async function record({ orgId, ctx, result, enforced, extra = {} }) {
  const { events } = await cols();
  const doc = { _id: new ObjectId(), orgId: toObjectId(orgId), at: nowIso(), kind: ctx.kind || "dlp", actorEmail: lower(ctx.email), action: ctx.action, resourceType: ctx.resourceType || null, resourceId: ctx.resourceId ? String(ctx.resourceId) : null, path: ctx.path ? String(ctx.path).slice(0, 300) : null, decision: result.decision, ruleId: result.ruleId, ruleName: result.ruleName || null, policyKey: result.policyKey, policyVersion: result.policyVersion, reason: String(result.reason || "").slice(0, 300), matchedOn: result.matchedOn || [], enforced, context: { ip: maskIp(ctx.ip), classification: ctx.classification || null, destinationType: ctx.destinationType || null, destinationDomain: ctx.destinationDomain || null, shareType: ctx.shareType || null, fileType: extOf(ctx.filename ?? ctx.path ?? "") || null, size: ctx.size ?? null, source: ctx.source || null }, ...extra };
  await events.insertOne(doc);
  if (result.decision && result.decision !== "ALLOW" && result.decision !== "allow") import("../metrics/metrics.js").then((m) => m.metric("storage.dlp_decision", { orgId, label: String(result.decision).toUpperCase() })).catch(() => {});
  if (enforced) import("../metrics/metrics.js").then((m) => m.metric("storage.download_blocked", { orgId, label: "DLP" })).catch(() => {});
  import("../webhooks/registry.js").then((m) => m.emitWebhookEvent({ orgId, type: "dlp.decision", eventId: String(doc._id), data: { decision: result.decision, action: ctx.action, ruleId: result.ruleId, policyKey: result.policyKey, policyVersion: result.policyVersion, enforced, resourceId: doc.resourceId, actor: doc.actorEmail } })).catch(() => {});
  if (enforced) emitFileEvent(orgId, "dlp_blocked", { action: ctx.action, decision: result.decision, ruleId: result.ruleId, resourceId: doc.resourceId, eventId: String(doc._id) });
  return doc;
}

/**
 * Enforce DLP for one already-permitted action. Returns { allowed, decision, ... }; never throws for a decision (use `assertDlp` for that).
 * REQUIRE_APPROVAL: a pending approval is created once per actor+action+resource; an admin approves it; the approved record then lets ONE
 * matching request through (it is consumed) within 24 hours.
 */
export async function enforceDlp({ orgId, ctx }) {
  const result = await evaluateDlp({ orgId, ctx }); const { approvals } = await cols();
  if (result.decision === "ALLOW") { if (result.log) await record({ orgId, ctx, result, enforced: false }); return { allowed: true, ...result }; }
  if (result.decision === "LOG_ONLY") { const ev = await record({ orgId, ctx, result, enforced: false }); return { allowed: true, ...result, eventId: String(ev._id) }; }
  if (result.decision === "REQUIRE_APPROVAL") {
    const key = { orgId: toObjectId(orgId), actorEmail: lower(ctx.email), action: ctx.action, resourceId: ctx.resourceId ? String(ctx.resourceId) : null };
    const used = await approvals.findOneAndUpdate({ ...key, status: "approved", expiresAt: { $gt: nowIso() } }, { $set: { status: "used", usedAt: nowIso() } });
    if (used?.value ?? used) { const ev = await record({ orgId, ctx, result: { ...result, reason: "Approved by an administrator." }, enforced: false, extra: { approvalId: String((used.value ?? used)._id) } }); return { allowed: true, ...result, decision: "ALLOW", viaApproval: true, eventId: String(ev._id) }; }
    let ap = await approvals.findOne({ ...key, status: "pending" });
    if (!ap) { ap = { _id: new ObjectId(), ...key, status: "pending", createdAt: nowIso(), ruleId: result.ruleId, reason: result.reason, filename: ctx.filename ? String(ctx.filename).slice(0, 200) : null }; await approvals.insertOne(ap); }
    const ev = await record({ orgId, ctx, result, enforced: true, extra: { approvalId: String(ap._id) } });
    return { allowed: false, ...result, code: "APPROVAL_REQUIRED", status: 403, message: "An administrator must approve this action first. A request has been sent.", approvalId: String(ap._id), eventId: String(ev._id) };
  }
  if (result.decision === "REQUIRE_STRONGER_AUTH") {
    // Allowed while the person has confirmed a fresh authenticator code (src/lib/stepup.js), or when the caller already established strong authentication.
    const stepped = ctx.strongAuth === true || (ctx.email ? await (await import("../stepup.js")).hasStepUp(ctx.email) : false);
    if (stepped) { const ev = await record({ orgId, ctx, result: { ...result, reason: "Stronger authentication was confirmed." }, enforced: false }); return { allowed: true, ...result, eventId: String(ev._id) }; }
  }
  const ev = await record({ orgId, ctx, result, enforced: true });
  const msg = result.userMessage || (result.decision === "REQUIRE_STRONGER_AUTH" ? "This action needs stronger authentication. Confirm a code from your authenticator app (POST /api/orgs/step-up), then try again." : result.decision === "QUARANTINE" ? "This file was held back by your organization's data protection policy." : "Your organization's data protection policy does not allow this.");
  const code = { DENY: "DLP_DENIED", QUARANTINE: "DLP_QUARANTINE", REQUIRE_STRONGER_AUTH: "STRONGER_AUTH_REQUIRED" }[result.decision];
  return { allowed: false, ...result, code, status: 403, message: msg, eventId: String(ev._id) };
}
export async function assertDlp(args) { const r = await enforceDlp(args); if (!r.allowed) throw new DlpBlocked(r); return r; }

// ------------------------------------------------------------------------------------------------ admin: events, approvals
const evView = (e) => ({ eventId: String(e._id), at: e.at, kind: e.kind, actor: e.actorEmail, action: e.action, resourceType: e.resourceType, resourceId: e.resourceId, path: e.path, decision: e.decision, ruleId: e.ruleId, ruleName: e.ruleName, policyKey: e.policyKey, policyVersion: e.policyVersion, reason: e.reason, matchedOn: e.matchedOn, enforced: e.enforced, context: e.context, approvalId: e.approvalId || null });
export async function listDlpEvents({ orgId, membership, decision = null, action = null, limit = 50, before = null }) {
  if (!hasAdminRole(membership, ["dataGovernanceAdmin", "securityAdmin"], { read: true })) throw new GovError(403, "Only an administrator with a security or governance role, or an auditor, can read DLP events.");
  const { events } = await cols(); const q = { orgId: toObjectId(orgId) }; if (decision) q.decision = decision; if (action) q.action = action; if (before) q.at = { $lt: before };
  const rows = await events.find(q).sort({ at: -1 }).limit(Math.min(Number(limit) || 50, 200)).toArray(); return { events: rows.map(evView), nextBefore: rows.length === Math.min(Number(limit) || 50, 200) ? rows[rows.length - 1].at : null };
}
export async function listApprovals({ orgId, membership, status = "pending" }) {
  if (!hasAdminRole(membership, ["dataGovernanceAdmin", "securityAdmin"], { read: true })) throw new GovError(403, "Only an administrator can see approvals.");
  const { approvals } = await cols(); const rows = await approvals.find({ orgId: toObjectId(orgId), ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(100).toArray();
  return { approvals: rows.map((a) => ({ approvalId: String(a._id), actor: a.actorEmail, action: a.action, resourceId: a.resourceId, filename: a.filename, reason: a.reason, status: a.status, createdAt: a.createdAt, decidedBy: a.decidedBy || null })) };
}
export async function decideDlpApproval({ orgId, approvalId, membership, approverEmail, approve }) {
  if (!hasAdminRole(membership, ["dataGovernanceAdmin", "securityAdmin"])) throw new GovError(403, "Only an administrator can decide approvals.");
  if (!/^[0-9a-f]{24}$/.test(String(approvalId))) throw new GovError(404, "Approval not found.");
  const { approvals } = await cols(); const a = await approvals.findOne({ _id: new ObjectId(approvalId), orgId: toObjectId(orgId), status: "pending" });
  if (!a) throw new GovError(404, "No pending approval with that id.");
  if (lower(a.actorEmail) === lower(approverEmail)) throw new GovError(403, "You cannot approve your own request.");
  await approvals.updateOne({ _id: a._id, status: "pending" }, { $set: { status: approve ? "approved" : "denied", decidedBy: lower(approverEmail), decidedAt: nowIso(), ...(approve ? { expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() } : {}) } });
  await logOrgActivity({ orgId, recordType: "DLP_APPROVAL", recordId: a._id, actorEmail: approverEmail, action: approve ? "APPROVED" : "DENIED", previousState: null, newState: null, metadata: { requester: a.actorEmail, action: a.action } }).catch(() => {});
  return { ok: true };
}
