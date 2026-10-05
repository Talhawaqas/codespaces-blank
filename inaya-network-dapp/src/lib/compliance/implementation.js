// src/lib/compliance/implementation.js
//
// Control implementation tracking over the NIST SP 800-53 Rev. 5 internal catalog (Competitive Expansion SOW P2, COMPLIANCE-002 and -006). It EXTENDS the existing Regulatory Framework
// Engine and Evidence Vault rather than replacing them: the catalog is registered as a framework (compliance-frameworks.js); evidence can reference Evidence Vault rows
// (compliance-evidence.js) as well as live collector snapshots and external links; this module adds, per control, the implementation state, who is responsible, a named owner,
// an optional approved exception with a mandatory expiry, and a computed evidence state.
//
// STATES (SOW P2): implementation = implemented | partially_implemented | not_implemented | inherited | not_applicable | not_assessed;
//                  responsibility = provider | customer | shared | inherited;
//                  evidence       = available | required | none (computed, never typed in);   exception = approved (until it expires).
//
// DEFAULTS. Where Inaya itself provides a capability, a curated default says so and names the live collector(s) that supply facts. Everything else starts as NOT ASSESSED with
// the sensible default responsibility for its family. A default is a starting point a person confirms or overrides; it is labelled as a default until they do.
// Nothing here asserts that a control is "compliant", and no state implies an authorization or certification.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { canManageCompliance, canAccessCompliance, hasAdminRole } from "../orgGates.js";
import { REQUIREMENTS, BY_ID, FAMILIES, familyOf, CATALOG_ID, CATALOG_VERSION, BASELINE_NOTE } from "./nist80053.js";
import { collectAll, COLLECTOR_IDS, fingerprint } from "./collectors.js";

export class ComplianceError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ComplianceError(status, message); };
const nowIso = () => new Date().toISOString();
const DAY = 86400_000;
export const IMPLEMENTATION = ["implemented", "partially_implemented", "not_implemented", "inherited", "not_applicable", "not_assessed"];
export const RESPONSIBILITY = ["provider", "customer", "shared", "inherited"];
export const EVIDENCE_FRESH_DAYS = 90;
export const canManage = (m) => canManageCompliance(m) || hasAdminRole(m, "complianceAdmin");
export const canRead = (m) => canAccessCompliance(m) || hasAdminRole(m, "complianceAdmin", { read: true });

// control -> default for what INAYA (the system provider) implements, with the live facts that support it. s = implementation, r = responsibility.
const I = "implemented", P = "partially_implemented", PR = "provider", SH = "shared", IN = "inherited";
const D = (s, r, collectors, statement) => ({ s, r, collectors, statement });
export const DEFAULTS = {
  "AC-2": D(P, SH, ["access", "mfa"], "Accounts are owner, admin or member, with additive scoped administrator roles and an auditor. Account reviews and removal on departure are the customer's process."),
  "AC-3": D(I, PR, ["access", "governance"], "Every record is scoped to its organization and permission-filtered; governance and data-loss rules can only restrict, never grant."),
  "AC-4": D(P, SH, ["governance"], "Sharing policies, data-loss rules and device and network limits control information flow out of the workspace; the customer defines the rules."),
  "AC-5": D(P, SH, ["access"], "Scoped administrator roles separate security, storage, compliance, governance, device and integration duties; assigning them is the customer's decision."),
  "AC-6": D(I, PR, ["access"], "Least privilege through document, department and project permissions, and scoped administrator roles."),
  "AC-7": D(P, PR, [], "Sign-in and verification attempts are rate limited per address and account."),
  "AC-12": D(I, PR, ["access"], "Sessions expire and can be revoked; gateway and edit sessions are short-lived."),
  "AC-14": D(I, PR, [], "Only share, file-request and portal pages are reachable without signing in, each limited to one item and protected by token, expiry and policy."),
  "AC-16": D(I, PR, ["governance"], "Documents carry classification labels and metadata that policies can act on."),
  "AC-17": D(P, SH, ["devices"], "All access is over TLS. Device inventory, trust and blocking are available; remote-access policy is the customer's."),
  "AC-19": D(P, SH, ["devices"], "Mobile devices appear in the device inventory and can be blocked or signed out; mobile device management is the customer's."),
  "AC-21": D(I, PR, ["governance"], "Secure sharing with expiry, passwords, network and domain limits, one-time use and an access log."),
  "AU-2": D(I, PR, ["auditChain"], "Security-relevant actions across the workspace are recorded as events in a tamper-evident chain."),
  "AU-3": D(I, PR, ["auditChain"], "Each record carries actor, action, object, time and relevant metadata (never file contents)."),
  "AU-5": D(P, PR, ["auditChain"], "Chain-append failures never block the action but are logged; alerting on log failure is partial."),
  "AU-6": D(P, SH, ["auditChain"], "Audit data can be reviewed and exported; review cadence is the customer's."),
  "AU-8": D(I, PR, [], "Timestamps are generated by the server clock in UTC ISO 8601."),
  "AU-9": D(I, PR, ["auditChain"], "Audit records are hash-chained; an edit or deletion breaks the chain and is detected by verification."),
  "AU-10": D(P, PR, ["auditChain"], "Hash-chained records attribute actions to authenticated identities; this is tamper evidence, not a qualified digital signature."),
  "AU-11": D(P, SH, ["auditChain"], "Audit records are retained in the organization's chain; the retention period is a customer decision."),
  "AU-12": D(I, PR, ["auditChain"], "Audit generation is built into the actions it records."),
  "CA-5": D(P, SH, [], "Findings and remediation tracking exists in the compliance workspace."),
  "CA-7": D(P, SH, ["monitoring", "auditChain"], "Continuous signals (integrity, ransomware, device, health) are collected; the monitoring program is the customer's."),
  "CM-8": D(P, SH, [], "A component inventory is generated for evidence exports; the customer's own asset inventory is theirs."),
  "CM-12": D(P, SH, ["residency", "encryption"], "Data location is governed by the residency policy and the storage providers in use."),
  "CP-2": D(P, SH, ["resilience"], "Recovery tests, policies and runbooks exist; the contingency plan itself is the customer's."),
  "CP-4": D(I, SH, ["resilience", "replication"], "Recovery tests read replicas back and verify them; failover tests are the operator's."),
  "CP-6": D(P, SH, ["replication"], "Replicas are held at independent storage providers (active-passive)."),
  "CP-9": D(I, SH, ["backup"], "Scheduled backups with read-back verification and restore drills."),
  "CP-10": D(P, SH, ["resilience"], "Recovery is exercised by resilience tests; full-site recovery time is not measured."),
  "IA-2": D(P, SH, ["mfa"], "Members sign in with a verified identity and may enroll a second factor; whether it is required is not enforced platform-wide."),
  "IA-4": D(I, PR, [], "Identifiers are unique and bound to one organization membership."),
  "IA-5": D(P, SH, ["mfa"], "Authenticators are one-time links, passkeys or codes, stored hashed; strength policy is partly the customer's."),
  "IA-8": D(P, PR, [], "External users act through single-purpose links with token, expiry and optional password or code."),
  "IA-9": D(I, PR, [], "Service credentials are scoped, hashed, expiring and revocable; gateways sign requests with a key that never leaves the customer."),
  "IR-4": D(P, SH, ["monitoring"], "Incident records and a response workflow exist; handling is the customer's process."),
  "IR-5": D(P, SH, ["monitoring"], "Open incidents and security signals are tracked."),
  "IR-6": D(P, SH, ["monitoring"], "Incidents can be recorded and notified; regulator reporting is the customer's."),
  "MP-6": D(P, SH, ["encryption"], "Deleting or destroying a key makes encrypted data unreadable (crypto-shredding); physical media sanitization is inherited from the storage providers."),
  "SC-4": D(I, PR, [], "Records are isolated per organization."),
  "SC-5": D(P, PR, [], "Rate limits and size limits protect the service; volumetric denial-of-service protection is inherited from the hosting platform."),
  "SC-8": D(I, SH, ["encryption"], "Traffic is over TLS with HSTS; gateways and clients sign or encrypt their own payloads."),
  "SC-12": D(P, SH, ["encryption"], "Key management is platform-held by default; customer-managed key providers are available behind a feature flag."),
  "SC-13": D(P, PR, ["encryption"], "Strong algorithms are used; the cryptography is NOT validated to FIPS 140. A FIPS-ready provider abstraction exists."),
  "SC-23": D(I, PR, [], "Sessions and links are random, hashed at rest and expire."),
  "SC-28": D(I, SH, ["encryption"], "Documents are encrypted on the client or server-managed (envelope encrypted). Disk encryption of the databases is inherited from the providers."),
  "SI-2": D(P, SH, [], "Dependencies are updated by the maintainers; customer-side patching of their own systems is theirs."),
  "SI-4": D(P, SH, ["monitoring", "governance"], "Ransomware signals, data-loss decisions and health checks monitor activity."),
  "SI-7": D(I, PR, ["auditChain"], "Content hashes and the audit chain detect tampering."),
  "SI-10": D(P, PR, [], "Inputs are validated at the service boundary."),
  "SI-12": D(P, SH, [], "Retention policies and lifecycle rules exist; the schedule is the customer's."),
};
const FAMILY_RESPONSIBILITY = { PE: IN, MA: IN, MP: SH, AT: "customer", PS: "customer", PM: "customer", PL: "customer", RA: "customer", CA: SH, SR: SH, SA: SH };
export const defaultFor = (controlId) => { const d = DEFAULTS[controlId]; if (d) return { implementation: d.s, responsibility: d.r, collectors: d.collectors, statement: d.statement, source: "default" }; const fam = familyOf(controlId); return { implementation: fam === "PE" || fam === "MA" ? "inherited" : "not_assessed", responsibility: FAMILY_RESPONSIBILITY[fam] || SH, collectors: [], statement: fam === "PE" || fam === "MA" ? "Physical and maintenance controls are inherited from the hosting and storage providers. Obtain and attach their attestations." : "Not assessed yet.", source: "default" }; };

async function cols() {
  const { db } = await getOrgCollections(); const rows = db.collection("compliance_control_status"); const snaps = db.collection("compliance_snapshots");
  if (!cols.done) { await Promise.all([rows.createIndex({ orgId: 1, controlId: 1 }, { unique: true }), snaps.createIndex({ orgId: 1, at: -1 })]); cols.done = true; } return { db, rows, snaps };
}

// ------------------------------------------------------------------------------------------------ evidence state
export function evidenceState({ implementation, refs, facts, exception, now = Date.now() }) {
  if (implementation === "not_applicable" || implementation === "not_implemented" || implementation === "not_assessed") return { state: "none", why: implementation === "not_assessed" ? "Not assessed yet." : null };
  const good = [];
  for (const r of refs || []) {
    if (r.kind === "vault") { if (r.reviewStatus === "approved" && (!r.validUntil || new Date(r.validUntil).getTime() > now)) good.push(r); }
    else if (r.kind === "snapshot") { if (now - new Date(r.at).getTime() <= EVIDENCE_FRESH_DAYS * DAY) good.push(r); }
    else if (r.kind === "link") { if (!r.validUntil || new Date(r.validUntil).getTime() > now) good.push(r); }
  }
  const liveOk = (facts || []).some((f) => f.ok === true);
  if (good.length || liveOk) return { state: "available", via: good.length ? "attached" : "live", count: good.length };
  if (exception && exception.state === "approved") return { state: "none", why: "Covered by an approved exception." };
  return { state: "required", why: (facts || []).length ? "Live facts do not show the condition holds, and no evidence is attached." : "No evidence is attached." };
}
const exceptionView = (e, now = Date.now()) => (!e ? null : { ...e, state: e.state === "approved" && new Date(e.expiresAt).getTime() <= now ? "expired" : e.state });

async function viewFor(controlId, saved, factsById, now = Date.now(), vaultById = new Map()) {
  const def = defaultFor(controlId); const req = BY_ID.get(controlId); const implementation = saved?.implementation || def.implementation; const responsibility = saved?.responsibility || def.responsibility;
  const refs = (saved?.evidenceRefs || []).map((r) => (r.kind === "vault" ? { ...r, ...(vaultById.get(String(r.evidenceId)) || { reviewStatus: "missing" }) } : r)); const facts = def.collectors.map((c) => factsById.get(c)).filter(Boolean); const exception = exceptionView(saved?.exception, now);
  const ev = evidenceState({ implementation, refs, facts, exception, now });
  return { controlId, family: familyOf(controlId), familyName: FAMILIES[familyOf(controlId)], title: req.title, implementation, responsibility, owner: saved?.ownerEmail || null, statement: saved?.statement || def.statement, source: saved?.implementation || saved?.responsibility ? "assessed" : "default", collectors: def.collectors, facts: facts.map((f) => ({ id: f.id, label: f.label, state: f.state, ok: f.ok, summary: f.summary })), evidence: { ...ev, refs: refs.map(refView) }, exception, updatedAt: saved?.updatedAt || null, updatedBy: saved?.updatedBy || null };
}
const refView = (r) => ({ refId: r.refId, kind: r.kind, label: r.label || null, ...(r.kind === "vault" ? { evidenceId: String(r.evidenceId), reviewStatus: r.reviewStatus || null, validUntil: r.validUntil || null } : {}), ...(r.kind === "snapshot" ? { snapshotId: String(r.snapshotId), at: r.at, fingerprint: r.fingerprint, collectorId: r.collectorId } : {}), ...(r.kind === "link" ? { url: r.url, sha256: r.sha256 || null, validUntil: r.validUntil || null } : {}), attachedBy: r.attachedBy, attachedAt: r.attachedAt });

async function vaultMap(orgId, ids) {
  const want = ids.filter((x) => /^[0-9a-f]{24}$/.test(String(x))); if (!want.length) return new Map(); const { db } = await getOrgCollections();
  const rows = await db.collection("compliance_evidence").find({ orgId: toObjectId(orgId), _id: { $in: want.map((x) => new ObjectId(String(x))) } }).toArray().catch(() => []);
  return new Map(rows.map((r) => [String(r._id), { reviewStatus: r.reviewStatus || r.status || "pending", validUntil: r.validUntil || null, type: r.type || null }]));
}
export async function listControls({ orgId, membership, family = null, implementation = null, evidence = null, responsibility = null, owner = null, q = "", limit = 400 }) {
  if (!canRead(membership)) fail(403, "Only compliance staff, administrators and auditors can see control status.");
  const { rows } = await cols(); const saved = new Map((await rows.find({ orgId: toObjectId(orgId) }).toArray()).map((r) => [r.controlId, r]));
  const factsById = new Map((await collectAll(orgId)).map((f) => [f.id, f])); const vault = await vaultMap(orgId, [...saved.values()].flatMap((s) => (s.evidenceRefs || []).filter((r) => r.kind === "vault").map((r) => r.evidenceId)));
  const needle = String(q || "").trim().toLowerCase(); const now = Date.now(); const out = [];
  for (const r of REQUIREMENTS) {
    if (family && r.family !== family) continue; if (needle && !(r.id.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle))) continue;
    const v = await viewFor(r.id, saved.get(r.id), factsById, now, vault);
    if (implementation && v.implementation !== implementation) continue; if (responsibility && v.responsibility !== responsibility) continue; if (evidence && v.evidence.state !== evidence) continue; if (owner && String(v.owner || "").toLowerCase() !== String(owner).toLowerCase()) continue;
    out.push(v); if (out.length >= limit) break;
  }
  return { catalog: { id: CATALOG_ID, version: CATALOG_VERSION, note: BASELINE_NOTE, families: FAMILIES }, controls: out };
}
export async function getControl({ orgId, membership, controlId }) {
  if (!canRead(membership)) fail(403, "Only compliance staff, administrators and auditors can see control status.");
  if (!BY_ID.has(controlId)) fail(404, "Unknown control."); const { rows } = await cols(); const saved = await rows.findOne({ orgId: toObjectId(orgId), controlId }); const def = defaultFor(controlId);
  const factsById = new Map((await collectAll(orgId, def.collectors)).map((f) => [f.id, f])); const vault = await vaultMap(orgId, (saved?.evidenceRefs || []).filter((r) => r.kind === "vault").map((r) => r.evidenceId));
  return { control: { ...(await viewFor(controlId, saved, factsById, Date.now(), vault)), factsDetail: [...factsById.values()] } };
}

// ------------------------------------------------------------------------------------------------ changes
const audit = (orgId, controlId, actorEmail, action, metadata = {}) => logOrgActivity({ orgId, recordType: "COMPLIANCE_CONTROL", recordId: new ObjectId(), actorEmail, action, previousState: null, newState: null, metadata: { controlId, ...metadata } }).catch(() => {});
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, "").trim().slice(0, max);
const ensure = (id) => { if (!BY_ID.has(id)) fail(404, "Unknown control."); };

export async function updateControl({ orgId, membership, actorEmail, controlId, patch }) {
  if (!canManage(membership)) fail(403, "Only a compliance manager, administrator or compliance administrator can change control status."); ensure(controlId); const { rows } = await cols(); const set = {};
  if (patch.implementation !== undefined) { if (!IMPLEMENTATION.includes(patch.implementation)) fail(400, `implementation must be one of ${IMPLEMENTATION.join(", ")}.`); set.implementation = patch.implementation; }
  if (patch.responsibility !== undefined) { if (!RESPONSIBILITY.includes(patch.responsibility)) fail(400, `responsibility must be one of ${RESPONSIBILITY.join(", ")}.`); set.responsibility = patch.responsibility; }
  if (patch.ownerEmail !== undefined) { const e = String(patch.ownerEmail || "").trim().toLowerCase(); if (e) { const { orgMembers } = await getOrgCollections(); if (!(await orgMembers.findOne({ orgId: toObjectId(orgId), email: e, status: "active" }))) fail(400, "The owner must be an active member of the organization."); } set.ownerEmail = e || null; }
  if (patch.statement !== undefined) set.statement = clean(patch.statement, 2000) || null;
  if (!Object.keys(set).length) fail(400, "Nothing to change.");
  await rows.updateOne({ orgId: toObjectId(orgId), controlId }, { $set: { ...set, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { evidenceRefs: [], exception: null } }, { upsert: true });
  await audit(orgId, controlId, actorEmail, "UPDATED", { fields: Object.keys(set) }); return getControl({ orgId, membership, controlId });
}
export async function attachEvidence({ orgId, membership, actorEmail, controlId, ref }) {
  if (!canManage(membership)) fail(403, "Only a compliance manager, administrator or compliance administrator can attach evidence."); ensure(controlId); const { rows, snaps } = await cols(); const oid = toObjectId(orgId); let r;
  if (ref?.kind === "vault") { if (!/^[0-9a-f]{24}$/.test(String(ref.evidenceId))) fail(400, "evidenceId is not valid."); const m = await vaultMap(orgId, [ref.evidenceId]); if (!m.has(String(ref.evidenceId))) fail(404, "That evidence is not in this organization's Evidence Vault."); r = { kind: "vault", evidenceId: String(ref.evidenceId), label: clean(ref.label, 120) || null }; }
  else if (ref?.kind === "snapshot") { if (!/^[0-9a-f]{24}$/.test(String(ref.snapshotId))) fail(400, "snapshotId is not valid."); const s = await snaps.findOne({ _id: new ObjectId(ref.snapshotId), orgId: oid }); if (!s) fail(404, "That snapshot was not found."); const f = s.results.find((x) => x.id === ref.collectorId); if (!f) fail(400, "That collector is not in the snapshot."); r = { kind: "snapshot", snapshotId: String(s._id), collectorId: f.id, at: s.at, fingerprint: fingerprint(f), label: clean(ref.label, 120) || f.label }; }
  else if (ref?.kind === "link") { let u; try { u = new URL(String(ref.url)); } catch { fail(400, "The link is not a valid URL."); } if (u.protocol !== "https:" || u.username || u.password) fail(400, "The link must be https with no credentials."); if (ref.sha256 && !/^[0-9a-f]{64}$/i.test(ref.sha256)) fail(400, "sha256 must be 64 hex characters."); const vu = ref.validUntil ? new Date(ref.validUntil) : null; if (ref.validUntil && Number.isNaN(vu.getTime())) fail(400, "validUntil is not a date."); r = { kind: "link", url: u.href, label: clean(ref.label, 120) || u.hostname, sha256: ref.sha256 ? String(ref.sha256).toLowerCase() : null, validUntil: vu ? vu.toISOString() : null }; }
  else fail(400, "kind must be vault, snapshot or link.");
  r.refId = new ObjectId().toHexString(); r.attachedBy = actorEmail; r.attachedAt = nowIso();
  await rows.updateOne({ orgId: oid, controlId }, { $push: { evidenceRefs: r }, $set: { updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { exception: null } }, { upsert: true });
  await audit(orgId, controlId, actorEmail, "EVIDENCE_ATTACHED", { kind: r.kind, refId: r.refId }); return getControl({ orgId, membership, controlId });
}
export async function removeEvidence({ orgId, membership, actorEmail, controlId, refId }) {
  if (!canManage(membership)) fail(403, "Only a compliance manager, administrator or compliance administrator can remove evidence."); ensure(controlId); const { rows } = await cols();
  const r = await rows.updateOne({ orgId: toObjectId(orgId), controlId, "evidenceRefs.refId": String(refId) }, { $pull: { evidenceRefs: { refId: String(refId) } }, $set: { updatedAt: nowIso(), updatedBy: actorEmail } }); if (!r.modifiedCount) fail(404, "Evidence reference not found.");
  await audit(orgId, controlId, actorEmail, "EVIDENCE_REMOVED", { refId }); return getControl({ orgId, membership, controlId });
}
/** An exception always has a reason, a compensating measure and an expiry within a year. It is never permanent and never silent: it expires on its own date and the dashboard counts expired ones. */
export async function setException({ orgId, membership, actorEmail, controlId, reason, compensating, expiresAt }) {
  if (!canManage(membership)) fail(403, "Only a compliance manager, administrator or compliance administrator can approve an exception."); ensure(controlId);
  const why = clean(reason, 1000), comp = clean(compensating, 1000); if (why.length < 20) fail(400, "Explain the reason in at least 20 characters."); if (comp.length < 10) fail(400, "Describe the compensating measure.");
  const ms = Date.parse(expiresAt); if (Number.isNaN(ms) || ms <= Date.now() || ms - Date.now() > 366 * DAY) fail(400, "An exception must expire in the future and within one year.");
  const { rows } = await cols(); await rows.updateOne({ orgId: toObjectId(orgId), controlId }, { $set: { exception: { state: "approved", reason: why, compensating: comp, approvedBy: actorEmail, approvedAt: nowIso(), expiresAt: new Date(ms).toISOString() }, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { evidenceRefs: [] } }, { upsert: true });
  await audit(orgId, controlId, actorEmail, "EXCEPTION_APPROVED", { expiresAt: new Date(ms).toISOString() }); return getControl({ orgId, membership, controlId });
}
export async function closeException({ orgId, membership, actorEmail, controlId }) {
  if (!canManage(membership)) fail(403, "Only a compliance manager, administrator or compliance administrator can close an exception."); ensure(controlId); const { rows } = await cols();
  const r = await rows.updateOne({ orgId: toObjectId(orgId), controlId, "exception.state": "approved" }, { $set: { "exception.state": "closed", "exception.closedAt": nowIso(), "exception.closedBy": actorEmail, updatedAt: nowIso(), updatedBy: actorEmail } }); if (!r.modifiedCount) fail(404, "There is no open exception on this control.");
  await audit(orgId, controlId, actorEmail, "EXCEPTION_CLOSED", {}); return getControl({ orgId, membership, controlId });
}

// ------------------------------------------------------------------------------------------------ snapshots and summary
export async function takeSnapshot({ orgId, membership, actorEmail }) {
  if (!canManage(membership)) fail(403, "Only a compliance manager, administrator or compliance administrator can take a snapshot."); const { snaps } = await cols(); const results = await collectAll(orgId);
  const doc = { _id: new ObjectId(), orgId: toObjectId(orgId), at: nowIso(), by: actorEmail, results }; await snaps.insertOne(doc); import("../metrics/metrics.js").then((m) => m.metric("compliance.snapshot", { orgId })).catch(() => {}); await audit(orgId, "ALL", actorEmail, "SNAPSHOT_TAKEN", { snapshotId: String(doc._id), collectors: results.length });
  return { snapshotId: String(doc._id), at: doc.at, results: results.map((r) => ({ id: r.id, label: r.label, state: r.state, ok: r.ok, fingerprint: fingerprint(r) })) };
}
export async function summary({ orgId, membership }) {
  const { controls, catalog } = await listControls({ orgId, membership, limit: 1000 }); const fam = {}; const total = { controls: controls.length, byImplementation: {}, byResponsibility: {}, evidence: { available: 0, required: 0, none: 0 }, exceptionsApproved: 0, exceptionsExpired: 0, owned: 0, assessed: 0 };
  for (const c of controls) {
    const f = (fam[c.family] ||= { family: c.family, name: c.familyName, controls: 0, implemented: 0, partial: 0, notImplemented: 0, inherited: 0, notApplicable: 0, notAssessed: 0, evidenceRequired: 0 }); f.controls++;
    ({ implemented: () => f.implemented++, partially_implemented: () => f.partial++, not_implemented: () => f.notImplemented++, inherited: () => f.inherited++, not_applicable: () => f.notApplicable++, not_assessed: () => f.notAssessed++ })[c.implementation](); if (c.evidence.state === "required") f.evidenceRequired++;
    total.byImplementation[c.implementation] = (total.byImplementation[c.implementation] || 0) + 1; total.byResponsibility[c.responsibility] = (total.byResponsibility[c.responsibility] || 0) + 1; total.evidence[c.evidence.state]++; if (c.exception?.state === "approved") total.exceptionsApproved++; if (c.exception?.state === "expired") total.exceptionsExpired++; if (c.owner) total.owned++; if (c.source === "assessed") total.assessed++;
  }
  return { catalog: { id: catalog.id, version: catalog.version, note: catalog.note }, totals: total, families: Object.values(fam), generatedAt: nowIso(), disclaimer: "These states describe how controls are being tracked. They are not a statement of compliance, authorization or certification." };
}
export { COLLECTOR_IDS };
