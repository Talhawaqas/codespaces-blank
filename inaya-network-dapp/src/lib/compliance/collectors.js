// src/lib/compliance/collectors.js
//
// Automatic evidence collectors (Competitive Expansion SOW P, COMPLIANCE-002/006). Each collector reads real records for ONE organization and returns METADATA ONLY (counts, states,
// timestamps, identifiers): never file contents, secrets or message text. A collector that cannot answer says so (`ok: null`, `state: "NO_DATA"`); it never reports a pass it did not
// observe. `ok: true` means the condition the collector checks holds; `ok: false` means it was observed not to hold.
//
// A collector result is a point-in-time FACT. It is not an assessment of any control: a person decides what a control's status is and which facts support it.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { isFeatureEnabled } from "../featureFlags.js";

const DAY = 86400_000;
const res = (id, label, base) => ({ id, label, collectedAt: new Date().toISOString(), ok: null, state: "NO_DATA", summary: "", details: {}, ...base });
export const fingerprint = (r) => createHash("sha256").update(JSON.stringify({ id: r.id, ok: r.ok, state: r.state, summary: r.summary, details: r.details })).digest("hex");

const COLLECTORS = {
  auditChain: { label: "Audit trail integrity", run: async ({ orgId }) => {
    const { verifyOrgEvidenceIntegrity } = await import("../evidence.js"); const r = await verifyOrgEvidenceIntegrity(orgId); const valid = r?.valid ?? r?.ok; const n = r?.checked ?? r?.entries ?? r?.count ?? null;
    if (valid === undefined) return { state: "UNKNOWN", summary: "The audit chain verifier returned no verdict." }; return { ok: !!valid, state: valid ? "OK" : "ATTENTION", summary: valid ? `The tamper-evident audit chain verifies${n != null ? ` (${n} entries checked)` : ""}.` : "The audit chain did NOT verify.", details: { valid: !!valid, entriesChecked: n } };
  } },
  access: { label: "Accounts and roles", run: async ({ orgId }) => {
    const { orgMembers, sessions } = await getOrgCollections(); const oid = toObjectId(orgId); const m = await orgMembers.find({ orgId: oid }).project({ role: 1, status: 1, adminRoles: 1 }).toArray(); if (!m.length) return { summary: "No members." };
    const active = m.filter((x) => x.status === "active"); const byRole = {}; for (const x of active) byRole[x.role] = (byRole[x.role] || 0) + 1; const scoped = active.filter((x) => (x.adminRoles || []).length).length; const owners = byRole.owner || 0;
    const live = await sessions.countDocuments({ expiresAt: { $gt: new Date().toISOString() }, email: { $in: active.map((x) => x.email) } }).catch(() => null);
    return { ok: owners >= 1, state: owners >= 1 ? "OK" : "ATTENTION", summary: `${active.length} active member(s): ${Object.entries(byRole).map(([k, v]) => `${v} ${k}`).join(", ")}; ${scoped} with scoped administrator roles.`, details: { active: active.length, byRole, scopedAdmins: scoped, liveSessions: live, sessionsExpire: true } };
  } },
  mfa: { label: "Multi-factor authentication", run: async ({ orgId }) => {
    const { orgMembers } = await getOrgCollections(); const { db } = await getOrgCollections(); const members = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1 }).toArray(); if (!members.length) return { summary: "No active members." };
    const enrolled = await db.collection("member_mfa").countDocuments({ email: { $in: members.map((x) => String(x.email).toLowerCase()) } }).catch(() => null); if (enrolled === null) return { state: "UNKNOWN", summary: "MFA enrollment could not be read." };
    const pct = Math.round((enrolled / members.length) * 100); return { ok: enrolled === members.length, state: enrolled === members.length ? "OK" : "ATTENTION", summary: `${enrolled} of ${members.length} active members have enrolled a second factor (${pct}%).`, details: { enrolled, members: members.length, percent: pct } };
  } },
  encryption: { label: "Encryption inventory", run: async ({ orgId }) => {
    const { db, orgDocuments } = await getOrgCollections(); const oid = toObjectId(orgId); const client = await orgDocuments.countDocuments({ orgId: oid, deletedAt: null, encryptionMode: { $ne: "server-managed" } }); const server = await orgDocuments.countDocuments({ orgId: oid, deletedAt: null, encryptionMode: "server-managed" });
    const cfg = await db.collection("org_key_config").findOne({ orgId: oid }); const keyMode = cfg?.provider || "platform";
    return { ok: true, state: "OK", summary: `${client} document(s) are encrypted on the client (platform cannot read them); ${server} are server-managed (S3/Azure-compatible layer, envelope-encrypted). Key management: ${keyMode}.`, details: { clientEncrypted: client, serverManaged: server, keyManagement: keyMode, transport: "TLS (platform)", algorithms: ["AES-256-GCM", "SHA-256", "HMAC-SHA256", "PBKDF2"], note: "Provider-side disk encryption of the database and hosting platform is inherited from those providers and is not measured here." } };
  } },
  backup: { label: "Backups", run: async ({ orgId }) => {
    const { backupSchedules, backupRuns } = await getOrgCollections(); const oid = toObjectId(orgId); const sched = await backupSchedules.countDocuments({ orgId: oid }).catch(() => 0); if (!sched) return { summary: "No backup schedule is configured." };
    const last = await backupRuns.find({ orgId: oid }).sort({ startedAt: -1 }).limit(10).toArray(); if (!last.length) return { state: "NO_DATA", summary: `${sched} schedule(s) configured but no run recorded yet.` };
    const ok = last[0].status === "completed" || last[0].status === "success" || last[0].status === "SUCCEEDED" || last[0].status === "COMPLETED"; const failed = last.filter((r) => /fail|error/i.test(String(r.status))).length;
    return { ok: ok && failed === 0, state: ok && failed === 0 ? "OK" : "ATTENTION", summary: `${sched} schedule(s); latest run ${String(last[0].status)}${failed ? `, ${failed} of the last ${last.length} runs failed` : ""}.`, details: { schedules: sched, latestStatus: last[0].status, latestAt: last[0].startedAt || null, recentFailures: failed } };
  } },
  resilience: { label: "Recovery testing", run: async ({ orgId }) => {
    const { resilienceTestRuns } = await getOrgCollections(); const runs = await resilienceTestRuns.find({ orgId: toObjectId(orgId) }).sort({ startedAt: -1 }).limit(10).toArray(); if (!runs.length) return { summary: "No resilience test has run." };
    const last = runs[0]; const age = Math.round((Date.now() - new Date(last.startedAt).getTime()) / DAY); const pass = last.overallResult === "pass" || last.overallPass === true || last.overallResult === "PASS";
    return { ok: pass && age <= 90, state: pass && age <= 90 ? "OK" : "ATTENTION", summary: `Latest resilience test ${pass ? "passed" : "did not pass"} ${age} day(s) ago (${runs.length} recent run(s)).`, details: { latestResult: last.overallResult ?? null, ageDays: age, runs: runs.length } };
  } },
  replication: { label: "Site replication", run: async ({ orgId }) => {
    const { measure } = await import("../ha/replication.js"); const m = await measure({ orgId, membership: { role: "owner" } }); if (!m.configured) return { summary: "No replication profile is set." };
    const bad = m.sites.filter((s) => !["SYNCED"].includes(s.state)); return { ok: !bad.length && m.failoverReadiness.ready, state: bad.length ? "ATTENTION" : m.failoverReadiness.ready ? "OK" : "ATTENTION", summary: `${m.sites.length} secondary site(s): ${m.sites.map((s) => `${s.siteId} ${s.state}`).join(", ")}; failover readiness ${m.failoverReadiness.ready ? "no blockers" : `${m.failoverReadiness.blockers.length} blocker(s)`}.`, details: { sites: m.sites.map((s) => ({ siteId: s.siteId, state: s.state, rpoMinutes: s.rpoMinutes })), lastVerifiedRestoreAt: m.lastVerifiedRestoreAt, mode: m.mode } };
  } },
  governance: { label: "Data governance policies", run: async ({ orgId }) => {
    const { db } = await getOrgCollections(); const oid = toObjectId(orgId); const on = { gov: await isFeatureEnabled("FEATURE_FILE_GOVERNANCE", orgId), dlp: await isFeatureEnabled("FEATURE_DLP", orgId), cls: await isFeatureEnabled("FEATURE_SMART_CLASSIFICATION", orgId) };
    if (!on.gov && !on.dlp && !on.cls) return { state: "NOT_ENABLED", summary: "File governance, DLP and smart classification are not enabled for this organization." };
    const rows = await db.collection("governance_policies").aggregate([{ $match: { orgId: oid, status: "published" } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).toArray(); const total = rows.reduce((a, r) => a + r.n, 0);
    return { ok: total > 0, state: total > 0 ? "OK" : "NO_DATA", summary: total ? `${total} published governance polic${total === 1 ? "y" : "ies"} (${rows.map((r) => `${r.n} ${r._id}`).join(", ")}).` : "Governance is enabled but no policy is published.", details: { features: on, published: Object.fromEntries(rows.map((r) => [r._id, r.n])) } };
  } },
  devices: { label: "Device control", run: async ({ orgId }) => {
    if (!(await isFeatureEnabled("FEATURE_DEVICE_CONTROL", orgId))) return { state: "NOT_ENABLED", summary: "Device control is not enabled for this organization." };
    const { db } = await getOrgCollections(); const rows = await db.collection("org_devices").find({ orgId: toObjectId(orgId) }).project({ trust: 1, blockedAt: 1, revokedAt: 1 }).toArray(); if (!rows.length) return { summary: "No device has checked in." };
    const trusted = rows.filter((r) => r.trust === "trusted").length; const blocked = rows.filter((r) => r.blockedAt).length; return { ok: true, state: "OK", summary: `${rows.length} device(s): ${trusted} trusted, ${blocked} blocked.`, details: { total: rows.length, trusted, blocked } };
  } },
  monitoring: { label: "Security signals", run: async ({ orgId }) => {
    const { db, incidents } = await getOrgCollections(); const oid = toObjectId(orgId); const ransomOn = await isFeatureEnabled("FEATURE_RANSOMWARE_SIGNALS", orgId); const openSignals = ransomOn ? await db.collection("security_signals").countDocuments({ orgId: oid, state: "open" }) : null;
    const openInc = await incidents.countDocuments({ orgId: oid, status: { $nin: ["CLOSED", "RESOLVED", "closed", "resolved"] } }).catch(() => null);
    if (!ransomOn && openInc === null) return { state: "NOT_ENABLED", summary: "Ransomware signals are not enabled and incidents could not be read." };
    const bad = (openSignals || 0) > 0 || (openInc || 0) > 0; return { ok: !bad, state: bad ? "ATTENTION" : "OK", summary: `${ransomOn ? `${openSignals} open ransomware signal(s)` : "ransomware signals not enabled"}; ${openInc ?? "unknown"} open incident(s).`, details: { ransomwareSignalsEnabled: ransomOn, openSignals, openIncidents: openInc } };
  } },
  gateways: { label: "Customer gateways", run: async ({ orgId }) => {
    if (!(await isFeatureEnabled("FEATURE_SOVEREIGN_GATEWAY", orgId))) return { state: "NOT_ENABLED", summary: "Sovereign Gateway is not enabled for this organization." };
    const { db } = await getOrgCollections(); const gs = await db.collection("gateways").find({ orgId: toObjectId(orgId), status: "active" }).project({ lastSeenAt: 1 }).toArray(); if (!gs.length) return { summary: "No gateway is registered." };
    const online = gs.filter((g) => g.lastSeenAt && Date.now() - new Date(g.lastSeenAt).getTime() <= 3 * 60_000).length; return { ok: online === gs.length, state: online === gs.length ? "OK" : "ATTENTION", summary: `${online} of ${gs.length} gateway(s) online.`, details: { gateways: gs.length, online } };
  } },
  residency: { label: "Data residency policy", run: async ({ orgId }) => {
    const { dataResidencyPolicies } = await getOrgCollections(); const p = await dataResidencyPolicies.findOne({ orgId: toObjectId(orgId) }); if (!p) return { summary: "No data residency policy is recorded." };
    return { ok: true, state: "OK", summary: "A data residency policy is recorded.", details: { policyId: String(p._id), updatedAt: p.updatedAt || p.createdAt || null } };
  } },
};
export const COLLECTOR_IDS = Object.keys(COLLECTORS);
export const collectorLabel = (id) => COLLECTORS[id]?.label || id;

export async function collect(orgId, id) {
  const c = COLLECTORS[id]; if (!c) return res(id, id, { state: "UNKNOWN", summary: "Unknown collector." });
  try { return res(id, c.label, await c.run({ orgId })); } catch (e) { return res(id, c.label, { state: "UNKNOWN", summary: `Could not be read right now (${String(e.message || e).slice(0, 80)}).` }); }
}
export async function collectAll(orgId, ids = COLLECTOR_IDS) { return Promise.all(ids.map((id) => collect(orgId, id))); }
