// src/lib/identity/api.js
//
// SOW §21 (Rewst / automation actions) and §43 (API surface). ONE dispatcher for /api/integrations/identity/*; the route file only
// authenticates and hands over an ACTOR. Three kinds of actor, all organization-scoped:
//   human     a signed-in owner or admin of the organization (full access, including providers, credentials and MSP links);
//   msp       a signed-in member of a linked MSP: capabilities come from the delegated MSP role, re-verified on every request;
//   service   an identity service credential (idc_...): capabilities come from its scopes; org-bound or MSP-bound (customer verified).
// Providers, credentials and MSP links can only be managed by a human owner/admin of the organization itself: automation and MSP staff can
// never mint their own access. Nothing here returns a secret.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { fail, normEmail, isEmail } from "./common.js";
import * as P from "./providers.js";
import * as M from "./mapping.js";
import * as R from "./reconcile.js";
import * as RUN from "./runs.js";
import * as REV from "./revocation.js";
import * as G from "./grants.js";
import * as O from "./overrides.js";
import * as T from "./temporary.js";
import * as RV from "./reviews.js";
import * as OR from "./orphans.js";
import * as J from "./jobs.js";
import * as C from "./credentials.js";
import * as MSP from "./msp.js";
import * as OUT from "./outbound.js";
import { processEvent, restoreAccess } from "./engine.js";
import { normalizeEvent } from "./normalize.js";
import { newToken } from "./common.js";
import { previewAccessRemoval } from "./twin.js";
import { identityMetrics } from "./metrics.js";
import { runIdentityWorker, pullAndReconcile } from "./worker.js";
import { getIdentityCollections } from "./db.js";
import { canManageOrg } from "../orgGates.js";

export const SCOPE_CAPS = { "identity:read": "read", "identity:audit": "audit", "identity:provision": "provision", "identity:revoke": "revoke", "identity:reconcile": "reconcile", "identity:mapping": "mapping" };
const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };
const HEX24 = /^[0-9a-f]{24}$/i;

/** Resolves a user reference (email, Inaya external record id, or `ext:<providerId>:<externalId>`) to an email, org-scoped. */
async function userRef(orgId, ref) {
  const r = decodeURIComponent(String(ref || ""));
  if (isEmail(r)) return normEmail(r);
  const { identityExternalUsers } = await getIdentityCollections(); const oid = toObjectId(orgId);
  const ext = HEX24.test(r) ? await identityExternalUsers.findOne({ _id: toObjectId(r), orgId: oid }) : await identityExternalUsers.findOne({ orgId: oid, externalObjectId: r });
  return ext?.inayaEmail || null;
}

/** Text form of a dry run: exportable, always ends with LIVE MUTATION: NO. */
export function dryRunText(res) {
  const p = res.plan || {}; const ops = p.ops || []; const by = (...names) => ops.filter((o) => names.includes(o.op));
  const line = (o) => `- ${o.op === "GRANT" || o.op === "PROPOSE_PRIVILEGED_GRANT" ? `${o.kind}: ${o.label || o.value}${o.op === "PROPOSE_PRIVILEGED_GRANT" ? " (needs human approval)" : ""}` : o.op === "REVOKE_GRANT" ? `${o.kind}: ${o.label || o.value}` : o.detail ? `${o.op}: ${o.detail}` : o.email ? `${o.op} (${o.email})` : o.op}`;
  const section = (title, list) => `${title}:\n${list.length ? list.map(line).join("\n") : "- none"}`;
  return ["DRY RUN", "", `Lifecycle: ${p.klass || res.status}`, `Person: ${p.email || "unknown"}${p.identity ? ` (identity via ${p.identity.via})` : ""}`, "",
    section("Would create", by("CREATE_MEMBERSHIP", "LINK_MEMBERSHIP")), "", section("Would grant", by("GRANT", "PROPOSE_PRIVILEGED_GRANT")), "",
    section("Would revoke", [...by("REVOKE_GRANT"), ...by("REVOKE_ACCESS", "RESTRICT_ACCESS").map((o) => ({ ...o, detail: `steps ${o.steps.join(" > ")}` }))]), "",
    ...(by("QUEUE_RESTORE_REVIEW", "RESTORE_ACCESS", "IGNORE").length ? [section("Restore handling", by("QUEUE_RESTORE_REVIEW", "RESTORE_ACCESS", "IGNORE")), ""] : []),
    ...((p.warnings || []).length ? ["Warnings:", ...p.warnings.map((w) => `- ${w}`), ""] : []),
    ...(res.status !== "DRY_RUN" ? [`Result: ${res.status}${res.reason ? ` - ${res.reason}` : ""}`, ""] : []),
    "LIVE MUTATION: NO"].join("\n");
}

async function auditQuery({ orgId, email, action, limit = 100 }) {
  const { orgActivity } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), recordType: "IDENTITY_LIFECYCLE" };
  if (action) q.action = String(action).slice(0, 80);
  if (email) q["metadata.email"] = normEmail(email);
  const rows = await orgActivity.find(q).sort({ timestamp: -1 }).limit(Math.min(500, Math.max(1, Number(limit) || 100))).toArray();
  return { entries: rows.map((e) => ({ eventId: e.eventId, action: e.action, actor: e.actorEmail, at: e.timestamp, previousState: e.previousState, newState: e.newState, metadata: e.metadata, auditChain: e.auditChain ? { index: e.auditChain.index, hash: e.auditChain.hash } : null })) };
}

async function evidenceFor({ orgId, runId, membership, actorEmail }) {
  const run = await RUN.getRun({ orgId, runId }); if (!run) return fail("Run not found.", 404);
  const { businessEvents } = await getOrgCollections();
  const ev = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "IDENTITY_LIFECYCLE", subjectId: toObjectId(runId), deletedAt: null });
  const { buildBusinessEventPassport } = await import("../businessEventPassport.js");
  if (!ev) return { run: RUN.runView(run, true), evidence: null, note: "No Evidence Graph record exists for this run (evidence is written for lifecycle runs)." };
  const passport = await buildBusinessEventPassport({ orgId, eventId: String(ev._id), membership: membership || { role: "owner" }, actorEmail });
  return { run: RUN.runView(run, true), evidence: passport.error ? { error: passport.error } : passport };
}

async function syncStatus(orgId) {
  const { identityEvents, identityRevocations, identityExternalUsers } = await getIdentityCollections(); const oid = toObjectId(orgId);
  const providers = await P.listProviders({ orgId });
  const [pending, failed, stale, openRev, linked, disabled, reports] = await Promise.all([
    identityEvents.countDocuments({ orgId: oid, status: "PENDING" }), identityEvents.countDocuments({ orgId: oid, status: "FAILED" }), identityEvents.countDocuments({ orgId: oid, status: "STALE" }),
    identityRevocations.countDocuments({ orgId: oid, state: { $in: ["REVOCATION_PENDING", "REVOCATION_PARTIAL", "REVOCATION_FAILED"] } }),
    identityExternalUsers.countDocuments({ orgId: oid, lifecycleState: "ACTIVE" }), identityExternalUsers.countDocuments({ orgId: oid, lifecycleState: { $in: ["DISABLED", "REVOKED"] } }), R.listReports({ orgId, limit: 1 }),
  ]);
  return { providers: providers.providers || providers, events: { pending, failed, stale }, revocations: { unfinished: openRev }, identities: { active: linked, disabledOrRevoked: disabled }, lastDriftReport: reports.reports?.[0] ? { reportId: reports.reports[0].reportId, generatedAt: reports.reports[0].generatedAt, summary: reports.reports[0].summary } : null };
}

const need = (b, ...keys) => { for (const k of keys) if (b?.[k] === undefined || b?.[k] === null || b?.[k] === "") return `${k} is required.`; return null; };

/**
 * A = { orgId, kind: "human"|"msp"|"service", email, label, caps:Set, humanAdmin, membership, providerId }
 * Returns a result object; { error, status } on failure.
 */
export async function handleIdentityApi({ A, method, path, query = {}, body = {} }) {
  const [a, b, c, d] = path; const orgId = A.orgId; const actor = A.label;
  const has = (cap) => A.caps.has(cap);
  const deny = (cap) => fail(`This request needs the ${cap} capability.`, 403, { reasonCode: "CAPABILITY_MISSING" });
  const needCap = (cap) => (has(cap) ? null : deny(cap));
  const humanOnly = () => (A.humanAdmin ? null : fail("Only a signed-in owner or admin of this organization can do that.", 403, { reasonCode: "HUMAN_ADMIN_REQUIRED" }));
  const m = method.toUpperCase();
  const ctxProvider = async (id) => { const p = id ? await P.getProvider({ orgId, providerId: id }) : null; return p; };

  // ------------------------------------------------------------------------------------------------------------------ providers
  if (a === "providers") {
    if (!b && m === "GET") return needCap("read") || P.listProviders({ orgId });
    if (!b && m === "POST") return humanOnly() || P.createProvider({ orgId, kind: body.kind, providerTenantId: body.providerTenantId, name: body.name, policy: body.policy, actorEmail: actor });
    if (b && !c && m === "GET") { const e = needCap("read"); if (e) return e; const p = await ctxProvider(b); return p ? { provider: P.providerView(p) } : fail("Provider not found.", 404); }
    if (b && !c && m === "PATCH") { const e = has("admin") ? null : humanOnly(); return e || P.updateProvider({ orgId, providerId: b, patch: body, actorEmail: actor }); }
    if (b && !c && m === "DELETE") return humanOnly() || P.deleteProvider({ orgId, providerId: b });
    if (b && c === "rotate-secret" && m === "POST") return humanOnly() || P.rotateSigningSecret({ orgId, providerId: b, actorEmail: actor });
    if (b && c === "pull" && m === "POST") { const e = needCap("reconcile"); if (e) return e; const p = await ctxProvider(b); if (!p) return fail("Provider not found.", 404); if (!p.graph) return fail("Microsoft Graph credentials are not configured on this provider.", 409); try { return await pullAndReconcile({ provider: p, actor }); } catch (err) { return fail(err.message, err.klass === "AUTHORIZATION" || err.klass === "AUTHENTICATION" ? 502 : 500, { class: err.klass }); } }
  }

  // ------------------------------------------------------------------------------------------------------------------ users / actions
  if (a === "users") {
    if (b === "provision" && m === "POST") {
      const e = needCap("provision"); if (e) return e;
      const p = await ctxProvider(body.providerId); if (!p) return fail("providerId is required and must belong to this organization.", 400);
      const raw = body.event || body; const n = normalizeEvent(p.kind === "scim" ? "generic" : p.kind, { type: "user.created", eventId: `api-${newToken(8)}`, occurredAt: new Date().toISOString(), ...raw, tenantId: raw.tenantId || p.providerTenantId });
      if (n.error) return fail(n.error);
      const r = await processEvent({ provider: p, event: n.event, dryRun: body.dryRun === true, actor });
      return r.status === "REJECTED" ? fail(r.reason, r.reasonCode === "TENANT_MISMATCH" ? 403 : 400, { reasonCode: r.reasonCode }) : r;
    }
    if (b === "reconcile" && m === "POST") {
      const e = needCap("reconcile"); if (e) return e;
      const p = await ctxProvider(body.providerId); if (!p) return fail("providerId is required.", 400);
      if (!Array.isArray(body.subjects)) return fail("subjects must be a list of directory users.");
      if (body.subjects.length > 1000) return fail("At most 1000 subjects per request; use snapshot chunks for a full directory.", 413);
      return R.reconcileSubjects({ orgId, provider: p, subjects: body.subjects, complete: false, actor, source: "api", remediate: body.remediate === true });
    }
    if (b === "by-external" && m === "GET") {
      const e = needCap("read"); if (e) return e; const email = await userRef(orgId, query.externalId); return email ? handleIdentityApi({ A, method: "GET", path: ["users", email], query: {} }) : fail("No identity with that external id in this organization.", 404);
    }
    if (b && !c && m === "GET") {
      const e = needCap("read"); if (e) return e; const email = await userRef(orgId, b); if (!email) return fail("User not found.", 404);
      const { orgMembers } = await getOrgCollections(); const { identityExternalUsers } = await getIdentityCollections();
      const mem = await orgMembers.findOne({ orgId: toObjectId(orgId), email }); if (!mem) return fail("User not found.", 404);
      const ext = await identityExternalUsers.find({ orgId: toObjectId(orgId), inayaEmail: email }).toArray();
      const ex = await G.explainAccess({ orgId, email });
      return { user: { email, membership: { status: mem.status, role: mem.role, departmentIds: (mem.departmentIds || []).map(String), temporary: !!mem.temporary }, externalIdentities: ext.map((x) => ({ providerId: String(x.providerId), kind: x.kind, externalId: x.externalObjectId, lifecycleState: x.lifecycleState, accountEnabled: x.accountEnabled !== false, lastSeenAt: x.lastSeenAt })), access: ex } };
    }
    if (b && c === "access" && m === "GET") { const e = needCap("read"); if (e) return e; const email = await userRef(orgId, b); return email ? G.explainAccess({ orgId, email }) : fail("User not found.", 404); }
    if (b && c === "preview-removal" && (m === "GET" || m === "POST")) { const e = needCap("read"); if (e) return e; const email = await userRef(orgId, b); return email ? previewAccessRemoval({ orgId, email, membership: A.membership || { role: "owner" }, actorEmail: A.email || actor }) : fail("User not found.", 404); }
    if (b && c === "revoke" && m === "POST") {
      const e = needCap("revoke"); if (e) return e; const email = await userRef(orgId, b); if (!email) return fail("User not found.", 404);
      if (!(await (await getOrgCollections()).orgMembers.findOne({ orgId: toObjectId(orgId), email }))) return fail("User not found.", 404);
      if (body.dryRun === true) { const pv = await previewAccessRemoval({ orgId, email, membership: A.membership || { role: "owner" }, actorEmail: A.email || actor }); return pv; }
      const r = await REV.revokeAccess({ orgId, email, trigger: "api", reason: body.reason || "Revoked through the identity API", actor, mode: body.mode === "restrict" ? "restrict" : "full" });
      if (r.error) return r;
      await RUN.recordRun({ orgId, type: body.mode === "restrict" ? "INCIDENT_RESTRICT" : "MANUAL_REVOKE", email, actor, state: r.revocation.state === "REVOCATION_COMPLETE" ? "COMPLETED" : "PARTIAL", plan: { ops: [{ op: body.mode === "restrict" ? "RESTRICT_ACCESS" : "REVOKE_ACCESS", email }] }, result: { revocation: r.revocation }, reasonNote: body.reason, notify: { title: `Access ${body.mode === "restrict" ? "restricted" : "revoked"}: ${email}`, body: `Revocation state ${r.revocation.state}.`, severity: r.revocation.state === "REVOCATION_COMPLETE" ? "info" : "critical" } });
      return r;
    }
    if (b && c === "restore" && m === "POST") {
      const e = A.humanAdmin || A.caps.has("admin") ? null : fail("Restoring access needs a signed-in owner/admin (or an MSP admin). Automation cannot restore a revoked person.", 403, { reasonCode: "HUMAN_ADMIN_REQUIRED" }); if (e) return e;
      const email = await userRef(orgId, b); if (!email) return fail("User not found.", 404);
      const r = await restoreAccess({ orgId, email, actor, reason: body.reason || "Restored through the identity API" }); if (r.error) return r;
      await RUN.recordRun({ orgId, type: "RESTORE", email, actor, plan: { ops: [{ op: "RESTORE_ACCESS", email }] }, result: r, reasonNote: body.reason, notify: { title: `Access restored: ${email}`, body: `By ${actor}.` } });
      return r;
    }
    if (b && c === "reconcile" && m === "POST") {
      const e = needCap("reconcile"); if (e) return e; const p = await ctxProvider(body.providerId); if (!p) return fail("providerId is required.", 400);
      if (!body.subject) return fail("subject (the directory user) is required.");
      return R.reconcileSubjects({ orgId, provider: p, subjects: [body.subject], complete: false, actor, source: "api-user", remediate: body.remediate === true });
    }
    // assignRole / removeRole / assignDepartment / removeDepartment / assignProject / removeProject  -> manual override baseline
    if (b && ["roles", "departments", "projects"].includes(c) && (m === "POST" || m === "DELETE")) {
      const e = needCap("provision"); if (e) return e; const email = await userRef(orgId, b); if (!email) return fail("User not found.", 404);
      const kind = c === "departments" ? "department" : c === "projects" ? "project" : (body.kind && body.kind !== "role" ? body.kind : "role");
      const value = c === "roles" ? body.role ?? body.value : body.departmentId ?? body.projectId ?? body.value;
      if (value === undefined) return fail(c === "roles" ? "role is required." : `${c === "departments" ? "departmentId" : "projectId"} is required.`);
      return O.applyOverride({ orgId, email, op: m === "POST" ? "add" : "remove", kind, value: String(value), reason: body.reason, expiresAt: body.expiresAt ?? null, actor, actorType: A.kind === "human" ? "human" : "automation" });
    }
  }

  // ------------------------------------------------------------------------------------------------------------------ mappings
  if (a === "mappings") {
    if (!b && m === "GET") return needCap("read") || M.listMappings({ orgId, providerId: query.providerId || null });
    if (!b && m === "POST") return needCap("mapping") || M.createMapping({ orgId, providerId: body.providerId || null, body, actorEmail: actor });
    if (b && m === "PATCH") return needCap("mapping") || M.updateMapping({ orgId, mappingId: b, patch: body, actorEmail: actor });
    if (b && m === "DELETE") return needCap("mapping") || M.deleteMapping({ orgId, mappingId: b, actor });
  }

  // ------------------------------------------------------------------------------------------------------------------ dry run, reconcile, status, audit, evidence
  if (a === "dry-run" && m === "POST") {
    const e = needCap("read"); if (e) return e;
    const p = await ctxProvider(body.providerId); if (!p) return fail("providerId is required.", 400);
    const raw = body.event || body; const n = normalizeEvent(p.kind === "scim" ? "generic" : p.kind, { type: "user.updated", eventId: `dry-${newToken(8)}`, occurredAt: new Date().toISOString(), ...raw, tenantId: raw.tenantId || p.providerTenantId });
    if (n.error) return fail(n.error);
    const r = await processEvent({ provider: p, event: n.event, dryRun: true, actor });
    const out = { ...r, liveMutation: false, text: dryRunText(r) };
    return out;
  }
  if (a === "reconcile") {
    if (!b && m === "POST") {
      const e = needCap("reconcile"); if (e) return e; const p = await ctxProvider(body.providerId); if (!p) return fail("providerId is required.", 400);
      if (body.snapshotId) return R.ingestSnapshot({ orgId, provider: p, snapshotId: body.snapshotId, users: body.users, last: body.last === true, actor });
      if (body.mode === "graph") { if (!p.graph) return fail("Microsoft Graph credentials are not configured on this provider.", 409); try { return await pullAndReconcile({ provider: p, actor }); } catch (err) { return fail(err.message, 502, { class: err.klass }); } }
      return fail("Send a snapshot chunk (snapshotId, users, last), or mode \"graph\" to pull from Microsoft Graph.");
    }
    if (b === "reports" && !c && m === "GET") return needCap("read") || R.listReports({ orgId });
    if (b === "reports" && c && m === "GET") { const e = needCap("read"); if (e) return e; const r = await R.getReport({ orgId, reportId: c }); return r ? { report: r } : fail("Report not found.", 404); }
    if (b === "remediate" && m === "POST") { const e = needCap("revoke"); if (e) return e; const p = await ctxProvider(body.providerId); if (!p) return fail("providerId is required.", 400); const rep = await R.getReport({ orgId, reportId: body.reportId }); if (!rep) return fail("Report not found.", 404); return R.remediateFindings({ orgId, provider: p, report: rep, kinds: body.kinds || null, actor }); }
  }
  if (a === "status" && m === "GET") return needCap("read") || syncStatus(orgId);
  if (a === "metrics" && m === "GET") return needCap("read") || identityMetrics({ orgId, windowDays: Number(query.windowDays) || 30 });
  if (a === "audit" && m === "GET") return needCap("audit") || auditQuery({ orgId, email: query.email, action: query.action, limit: query.limit });
  if (a === "evidence" && m === "GET") { const e = needCap("audit"); if (e) return e; if (!query.runId) return fail("runId is required."); return evidenceFor({ orgId, runId: query.runId, membership: A.membership, actorEmail: A.email || actor }); }
  if (a === "organization" && m === "GET") { const e = needCap("read"); if (e) return e; const { orgs } = await getOrgCollections(); const o = await orgs.findOne({ _id: toObjectId(orgId) }); return { organization: { organizationId: String(orgId), name: o?.name || null }, providers: (await P.listProviders({ orgId })).providers, capabilities: [...A.caps].sort(), actorKind: A.kind }; }

  // ------------------------------------------------------------------------------------------------------------------ runs, revocations
  if (a === "runs") {
    if (!b && m === "GET") return needCap("read") || RUN.listRuns({ orgId, type: query.type || null, state: query.state || null, email: query.email ? normEmail(query.email) : null, limit: Math.min(200, Number(query.limit) || 50), skip: Number(query.skip) || 0 });
    if (b && !c && m === "GET") { const e = needCap("read"); if (e) return e; const r = await RUN.getRun({ orgId, runId: b }); return r ? { run: RUN.runView(r, true) } : fail("Run not found.", 404); }
    if (b && c === "retry" && m === "POST") {
      const e = needCap("provision"); if (e) return e; const r = await RUN.getRun({ orgId, runId: b }); if (!r) return fail("Run not found.", 404);
      if (!["FAILED", "PARTIAL"].includes(r.state)) return fail("Only a failed or partial run can be retried.", 409);
      if (r.eventId && r.providerId) { const { identityEvents } = await getIdentityCollections(); const ev = await identityEvents.findOne({ orgId: toObjectId(orgId), eventId: r.eventId, providerId: oidOf(r.providerId) }); const p = await ctxProvider(r.providerId); if (ev?.event && p) return processEvent({ provider: p, event: ev.event, actor, origin: "retry", retry: true }); }
      return r.email ? REV.retryRevocation({ orgId, email: r.email, actor }) : fail("Nothing to retry for this run.", 409);
    }
  }
  if (a === "revocations") {
    if (!b && m === "GET") return needCap("read") || REV.listRevocations({ orgId, state: query.state || null });
    if (b === "retry" && m === "POST") { const e = needCap("revoke"); if (e) return e; const email = await userRef(orgId, body.email); return email ? REV.retryRevocation({ orgId, email, actor }) : fail("email is required.", 400); }
  }
  if (a === "incident") {
    if (b === "restrict" && m === "POST") { const e = needCap("revoke"); if (e) return e; const bad = need(body, "email", "reason"); if (bad) return fail(bad); return handleIdentityApi({ A, method: "POST", path: ["users", body.email, "revoke"], query, body: { reason: body.reason, mode: "restrict" } }); }
    if (b === "restore" && m === "POST") { const bad = need(body, "email"); if (bad) return fail(bad); return handleIdentityApi({ A, method: "POST", path: ["users", body.email, "restore"], query, body: { reason: body.reason || "Incident review: restored" } }); }
  }

  // ------------------------------------------------------------------------------------------------------------------ temporary access, reviews, orphans, jobs
  if (a === "temporary") {
    if (!b && m === "GET") return needCap("read") || T.listTemporary({ orgId, includeExpired: query.includeExpired === "true" });
    if (!b && m === "POST") return needCap("provision") || T.grantTemporary({ orgId, ...body, owner: body.owner || A.email, actor });
    if (b && c === "revoke" && m === "POST") return needCap("revoke") || T.revokeTemporary({ orgId, grantSetId: b, actor });
  }
  if (a === "reviews") {
    if (!b && m === "GET") return needCap("read") || RV.listCampaigns({ orgId });
    if (!b && m === "POST") { const e = humanOnly(); return e || RV.createCampaign({ orgId, name: body.name, scope: body.scope || {}, dueInDays: body.dueInDays, actorEmail: actor }); }
    if (b && !c && m === "GET") { const e = needCap("read"); if (e) return e; const r = await RV.getCampaign({ orgId, reviewId: b }); return r || fail("Review not found.", 404); }
    if (b && c === "items" && d && m === "POST") { const e = humanOnly(); return e || RV.decide({ orgId, reviewId: b, itemId: d, decision: body.decision, removeGrantIds: body.removeGrantIds, note: body.note, actorEmail: A.email, membership: A.membership }); }
  }
  if (a === "orphans") {
    if (!b && m === "GET") return needCap("read") || OR.listRemediations({ orgId, status: query.status === "all" ? null : query.status || "OPEN" });
    if (b === "detect" && m === "POST") return needCap("read") || OR.detectOrphans({ orgId, email: body.email || null, actor });
    if (b === "manager-analysis" && m === "GET") { const e = needCap("read"); if (e) return e; const email = await userRef(orgId, query.email); return email ? OR.analyzeManagerReplacement({ orgId, email }) : fail("email is required.", 400); }
    if (b === "tasks" && m === "POST") { const e = humanOnly(); return e || OR.createRemediationTasks({ orgId, projectId: body.projectId, reviewer: body.reviewer, actor }); }
    if (b && c === "resolve" && m === "POST") { const e = humanOnly(); return e || OR.resolveRemediation({ orgId, remediationId: b, newOwner: body.newOwner, note: body.note, actor }); }
  }
  if (a === "jobs") {
    if (!b && m === "GET") return needCap("read") || J.listJobs({ orgId });
    if (!b && m === "POST") { const need2 = { PROVISION: "provision", DISABLE: "revoke", RESTRICT: "revoke", RESTORE: "admin", GRANT_TEMPORARY: "provision" }[body.kind]; if (need2 === "admin") { const e = A.humanAdmin || has("admin") ? null : deny("admin"); if (e) return e; } else if (need2) { const e = needCap(need2); if (e) return e; } return J.createJob({ orgId, kind: body.kind, items: body.items, providerId: body.providerId || null, dryRun: body.dryRun === true, actor, note: body.note }); }
    if (b === "process" && m === "POST") return needCap("provision") || J.processJobs({ orgId, budget: 50 });
    if (b && !c && m === "GET") { const e = needCap("read"); if (e) return e; const j = await J.getJob({ orgId, jobId: b }); return j ? { job: j } : fail("Job not found.", 404); }
    if (b && c === "cancel" && m === "POST") return needCap("revoke") || J.cancelJob({ orgId, jobId: b, actor });
  }

  // ------------------------------------------------------------------------------------------------------------------ credentials, MSP, outbound
  if (a === "credentials") {
    const e = humanOnly(); if (e) return e;
    if (!b && m === "GET") return C.listCredentials({ orgId });
    if (!b && m === "POST") return C.createCredential({ orgId, ...body, actorEmail: actor });
    if (b && c === "revoke" && m === "POST") return C.revokeCredential({ orgId, credentialId: b, actorEmail: actor });
    if (b && c === "rotate" && m === "POST") return C.rotateCredential({ orgId, credentialId: b, actorEmail: actor });
  }
  if (a === "msp") {
    if (b === "links" && !c && m === "GET") return needCap("read") || MSP.listLinks({ orgId });
    const e = humanOnly();
    if (b === "invites" && m === "POST") return e || MSP.createLinkInvite({ customerOrgId: orgId, actorEmail: actor });
    if (b === "accept" && m === "POST") return e || MSP.acceptLinkInvite({ mspOrgId: orgId, token: body.token, actorEmail: actor });
    if (b === "links" && c && m === "DELETE") { if (e) return e; const link = (await MSP.listLinks({ orgId })).links.find((x) => x.status === "ACTIVE" && (x.mspOrgId === c || x.customerOrgId === c)); return link ? MSP.revokeLink({ orgId, mspOrgId: link.mspOrgId, customerOrgId: link.customerOrgId, actorEmail: actor }) : fail("Link not found.", 404); }
    if (b === "assignments" && !c && m === "GET") return e || MSP.listAssignments({ mspOrgId: orgId });
    if (b === "assignments" && !c && m === "POST") return e || MSP.assignTechnician({ mspOrgId: orgId, email: body.email, role: body.role, customerOrgIds: body.customerOrgIds, actorEmail: actor });
  }
  if (a === "outbound") {
    if (b === "webhooks" && !c && m === "GET") return needCap("read") || OUT.listSubscriptions({ orgId });
    if (b === "webhooks" && !c && m === "POST") return humanOnly() || OUT.createSubscription({ orgId, url: body.url, events: body.events, description: body.description, actorEmail: actor });
    if (b === "webhooks" && c && m === "DELETE") return humanOnly() || OUT.deleteSubscription({ orgId, webhookId: c });
    if (b === "deliveries" && m === "GET") return needCap("read") || OUT.listDeliveries({ orgId, status: query.status || null });
    if (b === "deliver" && m === "POST") return humanOnly() || OUT.processDeliveries({ orgId });
  }
  if (a === "worker" && b === "run" && m === "POST") return humanOnly() || runIdentityWorker({ orgId });
  if (a === "openapi" && m === "GET") return { note: "See docs/identity-integration/api-reference.md" };
  return fail("Unknown identity endpoint.", 404);
}

/** Capability set for a signed-in human: owners/admins get everything; an MSP technician gets the delegated role's capabilities. */
export function capsForHuman(membership) { return canManageOrg(membership) ? new Set(["read", "audit", "provision", "revoke", "reconcile", "mapping", "admin"]) : new Set(); }
export const capsForMsp = (role) => new Set(MSP.MSP_CAPABILITIES[role] || []);
export const capsForScopes = (scopes) => new Set((scopes || []).map((s) => SCOPE_CAPS[s]).filter(Boolean));
