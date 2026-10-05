// src/lib/ha/replication.js
//
// High availability and site replication (Competitive Expansion SOW workstream O, HA-001). Provider-independent: a "site" here is a storage provider that holds
// replicas of the organization's encrypted shards (the same pinning providers the backup engine already replicates to). Everything reported is MEASURED from the
// replica records the backup engine keeps, or from a recovery test that really reads replicas back from the secondary and checks their content hash:
//
//   * replication state per secondary: how many of the organization's files have a healthy replica there, what is missing, how old the oldest missing file is
//     (that age is the real RPO exposure if the primary were lost right now), how stale the last replica check is, and whether replicas disagree (conflict);
//   * recovery test: reads a sample of files from the secondary, verifies each against the content hash taken when it was pinned, and times it. The time is for
//     THAT SAMPLE; it is not extrapolated into a full-site recovery time, and the evidence says so;
//   * failover readiness: a list of blockers, never a switch. Failing over is a manual, operator-run procedure (see the runbooks); this module never moves traffic.
//
// It is ACTIVE-PASSIVE (one primary, replicas that are read only). Nothing here implements or claims active-active behaviour.

import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import clientPromise from "../mongodb.js";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { hasAdminRole, canManageOrg } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { PROVIDERS, getProvider } from "../pinningProviders/index.js";
import { sha256Hex } from "../pinningProviders/hash.js";

export class HaError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HaError(status, message); };
const nowIso = () => new Date().toISOString();
const ROLES = ["storageAdmin", "securityAdmin"];
const can = (m, { read = false } = {}) => hasAdminRole(m, ROLES, { read });
const FRESH_MS = 24 * 3600_000;
export const MODE = "active_passive";
export const TEST_SAMPLE_MAX = 20;

async function cols() { const { db } = await getOrgCollections(); return { profiles: db.collection("ha_profiles"), tests: db.collection("ha_recovery_tests"), snaps: db.collection("ha_snapshots") }; }
async function replicaCol() { const c = await clientPromise; return c.db("inaya_network").collection("backup_replicas"); }

// ------------------------------------------------------------------------------------------------ profile
export async function getProfile({ orgId, membership }) {
  if (!can(membership, { read: true })) fail(403, "Only an administrator or auditor can see the replication profile.");
  const { profiles } = await cols(); const p = await profiles.findOne({ orgId: toObjectId(orgId) });
  const configured = Object.entries(PROVIDERS).filter(([, v]) => { try { return v.isConfigured(); } catch { return false; } }).map(([k]) => k);
  return { profile: p ? { primary: p.primary, secondaries: p.secondaries, targets: p.targets, mode: MODE, updatedAt: p.updatedAt, updatedBy: p.updatedBy } : null, availableProviders: configured, knownProviders: Object.keys(PROVIDERS), mode: MODE, note: "Active-passive replication to read-only replicas. Active-active operation is not provided." };
}
export async function setProfile({ orgId, membership, actorEmail, primary, secondaries, targets = {} }) {
  if (!can(membership)) fail(403, "Only an owner, admin or storage administrator can change the replication profile.");
  const known = Object.keys(PROVIDERS); if (!known.includes(primary)) fail(400, `primary must be one of ${known.join(", ")}.`);
  const list = Array.isArray(secondaries) ? [...new Set(secondaries)] : []; if (!list.length || list.length > 3 || list.some((s) => !known.includes(s) || s === primary)) fail(400, "Give one to three secondary providers, different from the primary.");
  const rto = Number(targets.rtoMinutes ?? 240), rpo = Number(targets.rpoMinutes ?? 1440); if (![rto, rpo].every((n) => Number.isFinite(n) && n >= 1 && n <= 525600)) fail(400, "Targets must be minutes between 1 and 525600.");
  const { profiles } = await cols(); const doc = { orgId: toObjectId(orgId), primary, secondaries: list, targets: { rtoMinutes: rto, rpoMinutes: rpo }, mode: MODE, updatedAt: nowIso(), updatedBy: actorEmail };
  await profiles.updateOne({ orgId: doc.orgId }, { $set: doc }, { upsert: true });
  await logOrgActivity({ orgId, recordType: "HA_PROFILE", recordId: new ObjectId(), actorEmail, action: "PROFILE_SET", previousState: null, newState: null, metadata: { primary, secondaries: list, targets: doc.targets } }).catch(() => {});
  return getProfile({ orgId, membership });
}

// ------------------------------------------------------------------------------------------------ measurement
/** Pure: summarize one secondary from per-file replica facts. files: [{ createdAt, hasPrimary, hasSecondary, corrupted, disagrees, checkedAt }] */
export function summarizeSite({ files, rpoTargetMinutes, now = Date.now() }) {
  if (!files.length || !files.some((f) => f.hasPrimary || f.hasSecondary)) return { state: "NO_DATA", covered: 0, total: files.length, missing: 0, noReplica: files.length, lagMinutes: null, staleChecks: 0, conflicts: 0, corrupted: 0, rpoMinutes: null, note: files.length ? "None of the organization's files has a replica record yet, so replication cannot be assessed." : "The organization has no files yet." };
  const covered = files.filter((f) => f.hasSecondary).length; const missingFiles = files.filter((f) => f.hasPrimary && !f.hasSecondary);
  const oldest = missingFiles.length ? Math.min(...missingFiles.map((f) => new Date(f.createdAt).getTime())) : null; const lagMinutes = oldest === null ? 0 : Math.round((now - oldest) / 60000);
  const staleChecks = files.filter((f) => f.hasSecondary && (!f.checkedAt || now - new Date(f.checkedAt).getTime() > FRESH_MS)).length; const conflicts = files.filter((f) => f.disagrees).length; const corrupted = files.filter((f) => f.corrupted).length;
  let state = "SYNCED"; if (conflicts) state = "CONFLICT"; else if (corrupted) state = "ERROR"; else if (missingFiles.length) state = lagMinutes > rpoTargetMinutes ? "BEHIND_TARGET" : "LAGGING"; else if (staleChecks) state = "STALE";
  return { state, covered, total: files.length, missing: missingFiles.length, noReplica: files.filter((f) => !f.hasPrimary && !f.hasSecondary).length, lagMinutes, staleChecks, conflicts, corrupted, rpoMinutes: lagMinutes, note: state === "SYNCED" ? "Every file has a recently checked replica here." : state === "STALE" ? "Replicas exist but their last check is older than 24 hours." : null };
}

export async function measure({ orgId, membership, now = Date.now() }) {
  if (!can(membership, { read: true })) fail(403, "Only an administrator or auditor can see replication state.");
  const { profiles, tests } = await cols(); const p = await profiles.findOne({ orgId: toObjectId(orgId) }); if (!p) return { configured: false, mode: MODE, note: "No replication profile is set." };
  const { orgDocuments } = await getOrgCollections(); const docs = await orgDocuments.find({ orgId: toObjectId(orgId), deletedAt: null, fileHash: { $type: "string" } }).project({ fileHash: 1, createdAt: 1 }).limit(5000).toArray();
  const hashes = docs.map((d) => d.fileHash); const reps = hashes.length ? await (await replicaCol()).find({ fileHash: { $in: hashes } }).toArray() : [];
  const by = new Map(); for (const r of reps) { const m = by.get(r.fileHash) || new Map(); const k = `${r.shardId}`; const arr = m.get(k) || []; arr.push(r); m.set(k, arr); by.set(r.fileHash, m); }
  const ok = (r) => r.lastCheckOk !== false && !r.corrupted && (r.consecutiveFailures || 0) < 3;
  const facts = (site) => docs.map((d) => { const shards = by.get(d.fileHash) || new Map(); let hasP = shards.size > 0, hasS = shards.size > 0, corrupted = false, disagrees = false, checked = null;
    for (const [, arr] of shards) { const pr = arr.find((r) => r.provider === p.primary && ok(r)); const sr = arr.find((r) => r.provider === site); if (!pr) hasP = false; if (!sr || !ok(sr)) hasS = false; if (sr?.corrupted) corrupted = true; if (pr && sr && pr.contentHash && sr.contentHash && pr.contentHash !== sr.contentHash) disagrees = true; if (sr?.lastCheckedAt && (!checked || new Date(sr.lastCheckedAt) < new Date(checked))) checked = sr.lastCheckedAt; }
    return { createdAt: d.createdAt, hasPrimary: hasP, hasSecondary: hasS, corrupted, disagrees, checkedAt: hasS ? checked : null }; });
  const sites = p.secondaries.map((s) => ({ siteId: s, role: "secondary", ...summarizeSite({ files: facts(s), rpoTargetMinutes: p.targets.rpoMinutes, now }) }));
  const last = await tests.find({ orgId: toObjectId(orgId) }).sort({ startedAt: -1 }).limit(10).toArray(); const lastPass = last.find((t) => t.result === "PASS");
  const blockers = []; for (const s of sites) { if (s.state === "NO_DATA") blockers.push({ site: s.siteId, code: "NO_DATA", detail: "There is nothing replicated to verify yet." }); else if (!["SYNCED"].includes(s.state)) blockers.push({ site: s.siteId, code: s.state, detail: `Replication to ${s.siteId} is ${s.state.replace(/_/g, " ").toLowerCase()}${s.missing ? ` (${s.missing} file(s) missing, oldest ${s.lagMinutes} min)` : ""}.` }); const ls = last.find((t) => t.secondary === s.siteId); if (!ls) blockers.push({ site: s.siteId, code: "NEVER_TESTED", detail: `No recovery test has been run against ${s.siteId}.` }); else if (ls.result !== "PASS") blockers.push({ site: s.siteId, code: "LAST_TEST_FAILED", detail: `The last recovery test against ${s.siteId} failed.` }); else if (now - new Date(ls.finishedAt).getTime() > 30 * 86400_000) blockers.push({ site: s.siteId, code: "TEST_OLD", detail: `The last passing recovery test against ${s.siteId} is more than 30 days old.` }); }
  const rpoMeasured = sites.length ? Math.max(...sites.map((s) => s.rpoMinutes ?? 0)) : null;
  return { configured: true, mode: MODE, primary: p.primary, targets: p.targets, sites, measured: { rpoMinutes: rpoMeasured, rpoWithinTarget: rpoMeasured === null ? null : rpoMeasured <= p.targets.rpoMinutes, basis: "Age of the oldest file that is not yet replicated to the slowest secondary." }, lastVerifiedRestoreAt: lastPass?.finishedAt || null, failoverReadiness: { ready: blockers.length === 0 && sites.length > 0, blockers, note: "Failover is a manual procedure run by an operator. This view reports readiness; it does not switch anything." }, recentTests: last.map(testView), generatedAt: new Date(now).toISOString() };
}
const testView = (t) => ({ testId: String(t._id), secondary: t.secondary, result: t.result, startedAt: t.startedAt, finishedAt: t.finishedAt, sampled: t.sampled, verified: t.verified, failures: t.failures, measuredSeconds: t.measuredSeconds, rpoMinutes: t.rpoMinutes, rto: t.rto, by: t.by });

// ------------------------------------------------------------------------------------------------ recovery test
/** Reads a sample of the organization's files back from the secondary and checks each against the content hash taken when it was pinned. */
export async function runRecoveryTest({ orgId, membership, actorEmail, secondary, sample = 5, getProviderFn = getProvider, now = Date.now }) {
  if (!can(membership)) fail(403, "Only an owner, admin or storage administrator can run a recovery test.");
  const { profiles, tests } = await cols(); const p = await profiles.findOne({ orgId: toObjectId(orgId) }); if (!p) fail(409, "Set a replication profile first.");
  if (!p.secondaries.includes(secondary)) fail(400, "That is not a secondary in the profile.");
  const n = Math.max(1, Math.min(TEST_SAMPLE_MAX, Number(sample) || 5)); const { orgDocuments } = await getOrgCollections();
  const docs = await orgDocuments.find({ orgId: toObjectId(orgId), deletedAt: null, fileHash: { $type: "string" } }).project({ fileHash: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(500).toArray();
  const reps = docs.length ? await (await replicaCol()).find({ fileHash: { $in: docs.map((d) => d.fileHash) }, provider: secondary }).toArray() : []; const byFile = new Map(); for (const r of reps) { if (!r.providerRef || !r.contentHash) continue; if (!byFile.has(r.fileHash) && byFile.size >= n) continue; if (!byFile.has(r.fileHash)) byFile.set(r.fileHash, []); byFile.get(r.fileHash).push(r); } const chosen = [...byFile.values()].flat(); const started = now(); const startedAt = new Date(started).toISOString(); const failures = []; let verified = 0;
  const prov = (() => { try { return getProviderFn(secondary); } catch { return null; } })();
  for (const r of chosen) { try { if (!prov) throw new Error("provider unavailable"); const content = await prov.fetchReplica(r.providerRef); if (sha256Hex(content) !== r.contentHash) throw new Error("content hash mismatch"); verified++; } catch (e) { failures.push({ fileHash: r.fileHash, shard: r.shardId, reason: String(e.message || e).slice(0, 80) }); } }
  const finished = now(); const measuredSeconds = Math.round((finished - started) / 100) / 10; const m = await measure({ orgId, membership: { ...membership, role: "owner" }, now: finished });
  const rpoMinutes = m.sites?.find((s) => s.siteId === secondary)?.rpoMinutes ?? null;
  const result = !chosen.length ? "NO_DATA" : failures.length ? "FAIL" : "PASS"; const rtoMinutes = measuredSeconds / 60;
  const rto = { basis: "SAMPLE_ONLY", sampleFiles: new Set(chosen.map((c) => c.fileHash)).size, minutes: Math.round(rtoMinutes * 100) / 100, targetMinutes: p.targets.rtoMinutes, note: "Time to read this sample back from the secondary and verify it. It is not a measured full-site recovery time." };
  const doc = { _id: new ObjectId(), orgId: toObjectId(orgId), secondary, result, startedAt, finishedAt: new Date(finished).toISOString(), sampled: chosen.length, verified, failures, measuredSeconds, rpoMinutes, rto, by: actorEmail };
  await tests.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "HA_RECOVERY_TEST", recordId: doc._id, actorEmail, action: result === "PASS" ? "PASSED" : result === "FAIL" ? "FAILED" : "NO_DATA", previousState: null, newState: null, metadata: { secondary, sampled: chosen.length, verified, failures: failures.length, measuredSeconds, rpoMinutes } }).catch(() => {});
  if (result === "FAIL") import("../notify/router.js").then((r) => r.notifyEvent({ orgId, event: "resilience.failed", audience: "admins", title: "A recovery test against a secondary site failed", body: `${failures.length} of ${chosen.length} sampled files could not be read back from ${secondary}.`, link: "/business?view=settings", sourceId: String(doc._id), dedupeKey: `ha-test:${doc._id}` })).catch(() => {});
  import("../webhooks/registry.js").then((w) => w.emitWebhookEvent({ orgId, type: "resilience.event", eventId: `ha:${doc._id}`, data: { kind: "ha_recovery_test", secondary, result, sampled: chosen.length, verified } })).catch(() => {});
  return testView(doc);
}

/** Alerts an operator when the secondary falls behind the stated RPO target. Safe to call on a schedule; one alert per site per day. */
export async function checkAndAlert({ orgId, now = Date.now() }) {
  const m = await measure({ orgId, membership: { role: "owner" }, now }); if (!m.configured) return { alerted: 0 }; let alerted = 0; const day = new Date(now).toISOString().slice(0, 10);
  for (const s of m.sites) if (["BEHIND_TARGET", "CONFLICT", "ERROR"].includes(s.state)) { await import("../notify/router.js").then((r) => r.notifyEvent({ orgId, event: "resilience.failed", audience: "admins", title: `Replication to ${s.siteId} needs attention`, body: `State ${s.state}; ${s.missing} file(s) not replicated, oldest ${s.lagMinutes} minutes.`, link: "/business?view=settings", sourceId: s.siteId, dedupeKey: `ha-lag:${orgId}:${s.siteId}:${day}` })).then(() => { alerted++; }).catch(() => {}); }
  return { alerted };
}

// ------------------------------------------------------------------------------------------------ evidence
/** A package an auditor can keep: the profile, measured state, recent tests, the audit-chain head and a hash over all of it. Honest about what it does not show. */
export async function evidencePackage({ orgId, membership, actorEmail }) {
  if (!can(membership, { read: true })) fail(403, "Only an administrator or auditor can export replication evidence.");
  const m = await measure({ orgId, membership }); const prof = await getProfile({ orgId, membership }); let chain = null; try { const { verifyOrgEvidenceIntegrity } = await import("../evidence.js"); chain = await verifyOrgEvidenceIntegrity(orgId); } catch { chain = null; }
  const body = { kind: "inaya.ha-replication-evidence", version: 1, orgId: String(orgId), generatedAt: nowIso(), profile: prof.profile, measured: m, auditChain: chain ? { valid: chain.valid ?? chain.ok ?? null, checked: chain.checked ?? chain.entries ?? null } : null,
    statements: ["Active-passive replication to read-only replicas. No active-active operation is provided or claimed.", "Replication state is computed from the backup engine's replica records, which are refreshed by scheduled pin and integrity checks.", "The recovery-test time covers the sampled files only and is not a full-site recovery time.", "Failover is a manual operator procedure; this evidence does not show a completed failover."] };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex"); await logOrgActivity({ orgId, recordType: "HA_EVIDENCE", recordId: new ObjectId(), actorEmail, action: "EXPORTED", previousState: null, newState: null, metadata: { hash } }).catch(() => {});
  return { ...body, sha256: hash };
}
