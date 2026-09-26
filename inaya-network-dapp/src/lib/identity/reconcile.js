// src/lib/identity/reconcile.js
//
// SOW §24, §42 (#25): reconciliation and drift detection. Compares an EXTERNAL DIRECTORY STATE (a snapshot posted by Rewst / an RMM /
// a connector, or pulled from Microsoft Graph) with INAYA'S EFFECTIVE STATE, person by person:
//
//   MATCH       nothing to do
//   DRIFT       the two disagree in a way policy can explain (disabled but still active, missing, stale or missing grants, ...)
//   CONFLICT    the identity cannot be resolved to one person (two objects claim the same email or employee id)
//   UNRESOLVED  Inaya cannot decide (ambiguous membership, department that matches none)
//
// It REPORTS. It never deletes data. The only automatic action is revoking access of someone who is disabled at the source, and only
// when the provider's policy autoRevokeDisabledOnDrift is on; otherwise each finding carries a suggested action an administrator can apply.

import { emitIdentityEvent } from "./outbound.js";
import { toObjectId, getOrgCollections } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { fail, nowIso, normEmail, SOURCE_OF_KIND, isNewer } from "./common.js";
import { validateCanonical } from "./normalize.js";
import { resolveIdentity, evaluateDesired } from "./mapping.js";
import { listGrants, diffGrants, effectiveFromGrants } from "./grants.js";
import { processEvent } from "./engine.js";
import { audit, notifyManagers } from "./record.js";

const isDisabled = (s) => s.accountEnabled === false || ["TERMINATED", "DISABLED", "INACTIVE"].includes(s.employmentStatus);
const MAX_FINDINGS = 2000;
const setEq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** Compares ONE subject with Inaya. Returns { status, findings[] } (findings empty for MATCH). */
export async function compareSubject({ provider, subject }) {
  const orgId = provider.orgId; const { orgMembers } = await getOrgCollections();
  const findings = []; const add = (kind, severity, detail, action, extra = {}) => findings.push({ kind, severity, detail, suggestedAction: action, externalId: subject.externalId, email: normEmail(subject.email || subject.upn) || null, ...extra });
  const res = await resolveIdentity({ provider, subject });
  if (res.status === "CONFLICT") { add("IDENTITY_CONFLICT", "high", res.reason, "RELINK"); return { status: "CONFLICT", findings }; }
  if (res.status === "AMBIGUOUS") { add("IDENTITY_AMBIGUOUS", "medium", res.reason, "RELINK"); return { status: "UNRESOLVED", findings }; }
  const email = normEmail(res.ext?.inayaEmail || subject.email || subject.upn);
  const m = email ? await orgMembers.findOne({ orgId, email }) : null;
  const dis = isDisabled(subject);
  if (dis) {
    if (m && m.status === "active") add("DISABLED_STILL_ACTIVE", "critical", "The account is disabled in the directory but the person still has active access in Inaya.", "REVOKE", { email });
  } else if (!m) {
    add("MISSING_IN_INAYA", "medium", "The account is enabled in the directory but has no Inaya membership.", "PROVISION", { email });
  } else if (["revoked", "restricted"].includes(m.status)) {
    add("REVOKED_BUT_ENABLED", "medium", `The account is enabled in the directory but the Inaya membership is ${m.status}.`, "RESTORE_REVIEW", { email });
  } else if (res.ext) {
    const desired = await evaluateDesired({ orgId, provider, subject });
    for (const u of desired.unresolved) add("UNRESOLVED_MAPPING", "low", `${u.kind} "${u.value}": ${u.reason}`, "FIX_MAPPING", { email });
    const source = SOURCE_OF_KIND[provider.kind];
    const ledger = await listGrants({ orgId, email });
    const mine = ledger.filter((g) => g.source === source && g.sourceRef === String(provider._id));
    const d = diffGrants(mine, desired.grants);
    if (d.add.length) add("MISSING_GRANTS", "medium", `The directory justifies access Inaya does not have: ${d.add.map((g) => `${g.kind}:${g.label || g.value}`).join(", ")}.`, "REAPPLY", { email, grants: d.add.map((g) => ({ kind: g.kind, value: g.value })) });
    if (d.remove.length) add("STALE_GRANTS", "medium", `Inaya still grants access the directory no longer justifies: ${d.remove.map((g) => `${g.kind}:${g.label || g.value}`).join(", ")}.`, "REAPPLY", { email, grants: d.remove.map((g) => ({ kind: g.kind, value: g.value })) });
    // someone edited the membership outside the ledger (the ledger is what the integration believes the person should have)
    const eff = effectiveFromGrants(ledger);
    if (m.role !== "owner" && (!setEq((m.departmentIds || []).map(String), eff.departmentIds) || (eff.role === "admin") !== (m.role === "admin"))) add("UNTRACKED_CHANGE", "low", "The membership differs from what the grant ledger justifies (it was changed outside the integration).", "REAPPLY", { email });
  }
  const overrides = email ? (await listGrants({ orgId, email })).filter((g) => g.source === "INAYA_MANUAL_OVERRIDE").length : 0;
  const status = findings.length ? "DRIFT" : "MATCH";
  return { status, findings, manualOverrides: overrides };
}

/**
 * Reconciles a set of directory subjects (already canonical subjects) with Inaya. `complete` means the set is the WHOLE directory for
 * this tenant, which also allows finding identities that vanished from it.
 */
export async function reconcileSubjects({ orgId, provider, subjects, complete = false, actor, source = "snapshot", remediate = false }) {
  const { identityExternalUsers, identityDriftReports } = await getIdentityCollections();
  const { orgMembers } = await getOrgCollections();
  const t0 = Date.now();
  const counts = { MATCH: 0, DRIFT: 0, CONFLICT: 0, UNRESOLVED: 0 }; const findings = []; let overrides = 0; const seen = new Set();
  for (const raw of subjects) {
    const v = validateCanonical({ eventId: `recon-${Date.now()}`, type: "user.updated", tenantId: provider.providerTenantId, occurredAt: new Date().toISOString(), subject: raw }, { now: Date.now() });
    if (v.error) { counts.UNRESOLVED++; findings.push({ kind: "INVALID_SUBJECT", severity: "low", detail: v.error, suggestedAction: "FIX_SOURCE", externalId: raw?.externalId || null }); continue; }
    const s = v.event.subject; seen.add(s.externalId);
    const r = await compareSubject({ provider, subject: s });
    counts[r.status]++; overrides += r.manualOverrides || 0;
    for (const f of r.findings) if (findings.length < MAX_FINDINGS) findings.push(f);
  }
  let vanished = 0;
  if (complete) {
    const active = await identityExternalUsers.find({ orgId: toObjectId(orgId), providerId: provider._id, lifecycleState: "ACTIVE" }).toArray();
    for (const ext of active) if (!seen.has(ext.externalObjectId)) {
      const m = ext.inayaEmail ? await orgMembers.findOne({ orgId: toObjectId(orgId), email: ext.inayaEmail }) : null;
      if (m && m.status === "active") { counts.DRIFT++; vanished++; findings.push({ kind: "ABSENT_FROM_DIRECTORY", severity: "high", detail: "The identity is no longer present in the directory but the person still has active access.", suggestedAction: "REVOKE", externalId: ext.externalObjectId, email: ext.inayaEmail }); }
    }
  }
  const members = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1 }).toArray();
  const linked = new Set((await identityExternalUsers.find({ orgId: toObjectId(orgId), providerId: provider._id }).project({ inayaEmail: 1 }).toArray()).map((e) => e.inayaEmail));
  const unmanaged = members.filter((m) => !linked.has(m.email)).map((m) => m.email);
  const report = { orgId: toObjectId(orgId), providerId: provider._id, generatedAt: nowIso(), source, complete, directoryUsers: subjects.length, summary: { ...counts, vanished, manualOverrides: overrides, unmanagedMembers: unmanaged.length }, findings, unmanagedSample: unmanaged.slice(0, 100), durationMs: Date.now() - t0, actor };
  report._id = (await identityDriftReports.insertOne(report)).insertedId;
  await (await getIdentityCollections()).identityProviders.updateOne({ _id: provider._id }, { $set: { lastSyncAt: nowIso(), lastError: null } });
  await audit({ orgId, action: "IDENTITY_RECONCILED", actorEmail: actor, metadata: { reportId: String(report._id), provider: provider.kind, ...report.summary } });
  const critical = findings.filter((f) => f.severity === "critical" || f.severity === "high");
  if (critical.length) await notifyManagers({ orgId, title: `Identity drift: ${critical.length} finding(s) need attention`, body: `${critical.filter((f) => f.kind === "DISABLED_STILL_ACTIVE").length} disabled at the source but still active in Inaya.`, severity: "critical", dedupeKey: `identity:drift:${report._id}` });
  if (counts.DRIFT + counts.CONFLICT + counts.UNRESOLVED > 0) await emitIdentityEvent({ orgId, type: "sync.drift_detected", tenant: provider.providerTenantId, data: { reportId: String(report._id), ...report.summary } });
  let remediated = 0;
  if (remediate || provider.policy.autoRevokeDisabledOnDrift) remediated = (await remediateFindings({ orgId, provider, report, kinds: ["DISABLED_STILL_ACTIVE", "ABSENT_FROM_DIRECTORY"], actor: actor || "identity-reconcile" })).applied;
  return { report: reportView(report), remediated };
}

/** Applies suggested REVOKE actions through the normal engine (so ordering, verification, audit and evidence all apply). */
export async function remediateFindings({ orgId, provider, report, kinds = null, actor }) {
  const out = { applied: 0, results: [] };
  for (const f of report.findings) {
    if (kinds && !kinds.includes(f.kind)) continue;
    if (f.suggestedAction !== "REVOKE" || !f.externalId) continue;
    const ev = validateCanonical({ eventId: `reconcile:${report._id}:${f.externalId}`, type: "user.disabled", tenantId: provider.providerTenantId, occurredAt: new Date().toISOString(), subject: { externalId: f.externalId, email: f.email, accountEnabled: false } }, { now: Date.now() });
    if (ev.error) continue;
    const r = await processEvent({ provider, event: ev.event, actor, origin: "reconcile" });
    out.results.push({ externalId: f.externalId, status: r.status, state: r.state || null }); if (r.status === "PROCESSED") out.applied++;
  }
  return out;
}

export const reportView = (r) => ({ reportId: String(r._id), providerId: String(r.providerId), generatedAt: r.generatedAt, source: r.source, complete: r.complete, directoryUsers: r.directoryUsers, summary: r.summary, findings: r.findings, unmanagedSample: r.unmanagedSample, durationMs: r.durationMs });

export async function listReports({ orgId, limit = 20 }) {
  const { identityDriftReports } = await getIdentityCollections();
  const rows = await identityDriftReports.find({ orgId: toObjectId(orgId) }).sort({ generatedAt: -1 }).limit(Math.min(50, limit)).toArray();
  return { reports: rows.map((r) => ({ ...reportView(r), findings: undefined, findingCount: r.findings.length })) };
}
export async function getReport({ orgId, reportId }) {
  const { identityDriftReports } = await getIdentityCollections();
  let id; try { id = toObjectId(reportId); } catch { return null; }
  const r = await identityDriftReports.findOne({ _id: id, orgId: toObjectId(orgId) });
  return r ? reportView(r) : null;
}

// ------------------------------------------------------------------------------ chunked snapshot upload
const MAX_CHUNK = 1000;
/** A directory export can be large: it is posted in chunks of up to 1000 users and reconciled when the last chunk says complete. */
export async function ingestSnapshot({ orgId, provider, snapshotId, users, last = false, actor }) {
  if (!/^[A-Za-z0-9._:-]{6,80}$/.test(String(snapshotId || ""))) return fail("snapshotId is required (6-80 characters).");
  if (!Array.isArray(users) || users.length > MAX_CHUNK) return fail(`users must be a list of up to ${MAX_CHUNK} entries per request.`);
  const { identitySnapshots } = await getIdentityCollections();
  const n = await identitySnapshots.countDocuments({ orgId: toObjectId(orgId), providerId: provider._id, snapshotId });
  if (n >= 200) return fail("That snapshot has too many chunks.", 413);
  await identitySnapshots.insertOne({ orgId: toObjectId(orgId), providerId: provider._id, snapshotId, chunk: n, users, createdAt: new Date() });
  if (!last) return { received: users.length, chunk: n, complete: false };
  const chunks = await identitySnapshots.find({ orgId: toObjectId(orgId), providerId: provider._id, snapshotId }).sort({ chunk: 1 }).toArray();
  const all = chunks.flatMap((c) => c.users);
  const r = await reconcileSubjects({ orgId, provider, subjects: all, complete: true, actor, source: "snapshot" });
  await identitySnapshots.deleteMany({ orgId: toObjectId(orgId), providerId: provider._id, snapshotId });
  return { received: users.length, chunk: n, complete: true, ...r };
}
void isNewer; void fail;
