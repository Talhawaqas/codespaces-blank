// src/lib/compliance/governmentProfile.js
//
// Government security profile (Competitive Expansion SOW P1, P5, P6: COMPLIANCE-001 and COMPLIANCE-005). It is a TECHNICAL READINESS profile, never a certification:
//
//   GENERAL                            the default
//   GOVERNMENT_READY                   a declared target. The product shows how many TECHNICAL CHECKS are currently met.
//   GOVERNMENT_HIGH_READINESS          a stricter declared target, same rule.
//   CUSTOMER_SPECIFIC_AUTHORIZATION    the customer records the authorization they hold or are pursuing (agency, reference, date, boundary). Inaya RECORDS it and does NOT verify it.
//
// No state implies FedRAMP, FISMA/ATO, FIPS or any other external certification or authorization; the label always says so. Choosing a state turns on the enhanced government audit
// profile (every read of a document is chain-logged with who, role, department, object, action, time, device, masked address, result, policy decision and authorization basis)
// and unlocks the government data-label preset. The checks are computed from live facts and are re-evaluated every time they are viewed.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg, hasAdminRole } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { collectAll } from "./collectors.js";

export class GovProfileError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new GovProfileError(status, message); };
const nowIso = () => new Date().toISOString();
export const STATES = ["GENERAL", "GOVERNMENT_READY", "GOVERNMENT_HIGH_READINESS", "CUSTOMER_SPECIFIC_AUTHORIZATION"];
export const STATE_LABELS = { GENERAL: "General", GOVERNMENT_READY: "Government-ready (technical profile)", GOVERNMENT_HIGH_READINESS: "Government high-readiness (technical profile)", CUSTOMER_SPECIFIC_AUTHORIZATION: "Customer-specific authorization (recorded by the customer)" };
export const NOT_A_CERTIFICATION = "This profile describes technical readiness only. It is not a FedRAMP, FISMA, ATO, FIPS or other certification or authorization, and choosing it does not make one true. Authorization decisions belong to the relevant agency and assessors.";
export const IP_POLICIES = ["masked", "full", "none"];
const canView = (m) => canManageOrg(m) || hasAdminRole(m, ["complianceAdmin", "securityAdmin"], { read: true });
const maskIp = (ip) => { const s = String(ip || ""); if (s.includes(".")) return s.split(".").slice(0, 3).join(".") + ".0"; if (s.includes(":")) return s.split(":").slice(0, 3).join(":") + "::"; return null; };

async function col() { const { db } = await getOrgCollections(); const c = db.collection("gov_security_profile"); if (!col.done) { await c.createIndex({ orgId: 1 }, { unique: true }); col.done = true; } return c; }

/** Technical checks for a state, from live facts. Each check says what it looked at and whether it holds, and `evaluated: false` when it could not tell. */
export async function evaluateChecks({ orgId, state, facts = null, extra = {} }) {
  const f = new Map((facts || (await collectAll(orgId))).map((x) => [x.id, x])); const ok = (id) => f.get(id)?.ok === true; const unk = (id) => f.get(id)?.ok === null || f.get(id)?.ok === undefined;
  const chk = (id, label, pass, detail, evaluated = true) => ({ id, label, met: !!pass, evaluated, detail });
  const base = [
    chk("audit_chain", "The audit trail verifies", ok("auditChain"), f.get("auditChain")?.summary, !unk("auditChain")),
    chk("mfa", "Every active member has a second factor", ok("mfa"), f.get("mfa")?.summary, !unk("mfa")),
    chk("residency", "A data residency policy is recorded", ok("residency"), f.get("residency")?.summary, !unk("residency")),
    chk("governance", "Governance or data-loss policies are published", ok("governance"), f.get("governance")?.summary, !unk("governance")),
    chk("backup", "Backups run and succeed", ok("backup"), f.get("backup")?.summary, !unk("backup")),
    chk("recovery", "A recent recovery test passed", ok("resilience"), f.get("resilience")?.summary, !unk("resilience")),
    chk("enhanced_audit", "The enhanced government audit profile is on", true, "Turned on automatically by choosing a government profile."),
  ];
  const high = [
    chk("customer_keys", "Encryption keys are customer-managed", extra.keyProvider && extra.keyProvider !== "platform", `Key provider: ${extra.keyProvider || "platform"}.`),
    chk("fips_runtime", "The cryptographic runtime reports FIPS mode with a recorded validation reference", extra.fips?.status === "FIPS_READY", extra.fips ? `FIPS status: ${extra.fips.status}.` : "FIPS status not available."),
    chk("replication", "A secondary site is in sync and failover has no blockers", ok("replication"), f.get("replication")?.summary, !unk("replication")),
    chk("devices", "Device control is on and devices are inventoried", ok("devices"), f.get("devices")?.summary, !unk("devices")),
    chk("monitoring", "Ransomware signals are on with no open items", ok("monitoring"), f.get("monitoring")?.summary, !unk("monitoring")),
    chk("exceptions", "No compliance exception has expired", (extra.expiredExceptions ?? 0) === 0, `${extra.expiredExceptions ?? 0} expired exception(s).`),
    chk("evidence", "Every control marked implemented has evidence", (extra.evidenceRequired ?? 0) === 0, `${extra.evidenceRequired ?? 0} control(s) still need evidence.`),
  ];
  if (state === "GOVERNMENT_READY") return base; if (state === "GOVERNMENT_HIGH_READINESS") return [...base, ...high]; return [];
}

export async function getProfile({ orgId, membership }) {
  if (!canView(membership)) fail(403, "Only an owner, admin, compliance administrator, security administrator or auditor can see the government profile.");
  const row = await (await col()).findOne({ orgId: toObjectId(orgId) }); const state = row?.state || "GENERAL"; const { keyProvider, fips, expiredExceptions, evidenceRequired } = await context(orgId);
  const checks = await evaluateChecks({ orgId, state, extra: { keyProvider, fips, expiredExceptions, evidenceRequired } });
  return { state, label: STATE_LABELS[state], notice: NOT_A_CERTIFICATION, states: STATES.map((s) => ({ key: s, label: STATE_LABELS[s] })), ipPolicy: row?.ipPolicy || "masked", authorization: row?.authorization || null, setAt: row?.setAt || null, setBy: row?.setBy || null, technicalChecks: { met: checks.filter((c) => c.met).length, total: checks.length, unevaluated: checks.filter((c) => !c.evaluated).length, checks }, enhancedAudit: state !== "GENERAL" };
}
async function context(orgId) {
  const { db } = await getOrgCollections(); const cfg = await db.collection("org_key_config").findOne({ orgId: toObjectId(orgId) }).catch(() => null); let fips = null; try { fips = (await import("../crypto/policy.js")).fipsStatus(); } catch { /* optional */ }
  let expiredExceptions = 0, evidenceRequired = 0; try { const { summary } = await import("./implementation.js"); const s = await summary({ orgId, membership: { role: "owner" } }); expiredExceptions = s.totals.exceptionsExpired; evidenceRequired = s.totals.evidence.required; } catch { /* optional */ }
  return { keyProvider: cfg?.provider || "platform", fips, expiredExceptions, evidenceRequired };
}

export async function setProfile({ orgId, membership, actorEmail, state, ipPolicy, authorization }) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can change the government profile."); if (!STATES.includes(state)) fail(400, `state must be one of ${STATES.join(", ")}.`);
  const set = { state, setAt: nowIso(), setBy: actorEmail }; if (ipPolicy !== undefined) { if (!IP_POLICIES.includes(ipPolicy)) fail(400, `ipPolicy must be one of ${IP_POLICIES.join(", ")}.`); set.ipPolicy = ipPolicy; }
  if (state === "CUSTOMER_SPECIFIC_AUTHORIZATION") {
    const a = authorization || {}; const txt = (v, n) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n); const rec = { authority: txt(a.authority, 160), reference: txt(a.reference, 160), grantedOn: a.grantedOn ? new Date(a.grantedOn).toISOString().slice(0, 10) : null, boundary: txt(a.boundary, 1000), recordedBy: actorEmail, verifiedByInaya: false };
    if (!rec.authority || !rec.reference || !rec.boundary) fail(400, "Record the authorizing body, the reference and the system boundary. Inaya stores them but does not verify them."); if (a.grantedOn && Number.isNaN(Date.parse(a.grantedOn))) fail(400, "grantedOn is not a date."); set.authorization = rec;
  }
  const c = await col(); const prev = (await c.findOne({ orgId: toObjectId(orgId) }))?.state || "GENERAL";
  await c.updateOne({ orgId: toObjectId(orgId) }, { $set: set }, { upsert: true }); await logOrgActivity({ orgId, recordType: "GOV_PROFILE", recordId: new ObjectId(), actorEmail, action: "STATE_SET", previousState: prev, newState: state, metadata: { ipPolicy: set.ipPolicy || null, authorizationRecorded: !!set.authorization } }).catch(() => {});
  return getProfile({ orgId, membership });
}

// ------------------------------------------------------------------------------------------------ enhanced audit (P5)
export async function profileState(orgId) { try { const r = await (await col()).findOne({ orgId: toObjectId(orgId) }, { projection: { state: 1, ipPolicy: 1 } }); return { state: r?.state || "GENERAL", ipPolicy: r?.ipPolicy || "masked" }; } catch { return { state: "GENERAL", ipPolicy: "masked" }; } }

/** The enhanced record. `evidenceRef` points at the audit chain entry the base log wrote. Never contains file content. */
export function buildEnhancedRecord({ actorEmail, role, departmentId = null, object, action, result = "ALLOWED", policyDecision = null, authorizationBasis = null, deviceId = null, ip = null, ipPolicy = "masked", evidenceRef = "organization audit chain" }) {
  return { user: String(actorEmail || "").toLowerCase(), role: role || null, department: departmentId ? String(departmentId) : null, object: { type: object?.type || null, id: object?.id ? String(object.id) : null }, action, at: nowIso(), device: deviceId || null, ip: ipPolicy === "none" ? null : ipPolicy === "full" ? String(ip || "") || null : maskIp(ip), result, policyDecision, authorizationBasis, evidenceRef };
}
/** Non-blocking: a failure to write the enhanced record never fails the request it describes. Only runs when a government profile is chosen. */
export async function recordAccess({ orgId, actorEmail, membership, documentId, filename = null, departmentId = null, action = "READ", result = "ALLOWED", policyDecision = null, authorizationBasis = "document permission", deviceId = null, ip = null }) {
  try {
    const p = await profileState(orgId); if (p.state === "GENERAL") return null; const rec = buildEnhancedRecord({ actorEmail, role: membership?.role, departmentId, object: { type: "document", id: documentId }, action, result, policyDecision, authorizationBasis, deviceId, ip, ipPolicy: p.ipPolicy });
    await logOrgActivity({ orgId, recordType: "GOV_ACCESS", recordId: documentId ? new ObjectId(String(documentId)) : new ObjectId(), actorEmail, action, previousState: null, newState: null, metadata: { ...rec, profile: p.state, filename: filename ? String(filename).slice(0, 120) : null } }); return rec;
  } catch { return null; }
}
export async function listAccess({ orgId, membership, limit = 100 }) {
  if (!canView(membership)) fail(403, "Only an owner, admin, compliance administrator, security administrator or auditor can read the government access log.");
  const { orgActivity } = await getOrgCollections(); const rows = await orgActivity.find({ orgId: toObjectId(orgId), recordType: "GOV_ACCESS" }).sort({ timestamp: -1 }).limit(Math.min(Number(limit) || 100, 500)).toArray();
  return { events: rows.map((r) => ({ ...r.metadata, at: r.timestamp })) };
}

// ------------------------------------------------------------------------------------------------ government data labels (P6)
export const GOVERNMENT_LABELS = [
  { key: "PUBLIC", label: "Public", restricted: false }, { key: "INTERNAL", label: "Internal", restricted: false }, { key: "CONFIDENTIAL", label: "Confidential", restricted: false }, { key: "SENSITIVE", label: "Sensitive", restricted: true },
  { key: "CONTROLLED_CLASS_A", label: "Controlled class A (customer-defined)", restricted: true }, { key: "EXPORT_CONTROLLED_CLASS", label: "Export-controlled class (customer-defined)", restricted: true },
  { key: "RESTRICTED", label: "Restricted", restricted: true }, { key: "LEGAL_HOLD", label: "Legal Hold", restricted: true }, { key: "MISSION_CRITICAL", label: "Mission Critical", restricted: true },
];
/** Adds the label set the organization does not already have. Existing labels are never changed. The two "customer-defined" classes carry neutral names on purpose: the customer defines
 *  what they cover, and a label here does not by itself mean any legal marking regime is being applied. */
export async function applyGovernmentLabels({ orgId, membership, actorEmail }) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can apply the government label set.");
  const { getOrgClassificationLevels } = await import("../classification.js"); await getOrgClassificationLevels(orgId); const { dataClassifications } = await getOrgCollections(); const oid = toObjectId(orgId);
  const have = new Set((await dataClassifications.find({ orgId: oid }).toArray()).map((l) => l.key)); const added = []; let order = (await dataClassifications.countDocuments({ orgId: oid })) + 1;
  for (const l of GOVERNMENT_LABELS) if (!have.has(l.key)) { await dataClassifications.insertOne({ orgId: oid, key: l.key, label: l.label, restricted: l.restricted, sortOrder: order++, createdAt: nowIso(), source: "government-preset" }); added.push(l.key); }
  await logOrgActivity({ orgId, recordType: "GOV_PROFILE", recordId: new ObjectId(), actorEmail, action: "LABELS_APPLIED", previousState: null, newState: null, metadata: { added } }).catch(() => {}); return { added, total: have.size + added.length };
}
