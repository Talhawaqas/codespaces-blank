// src/lib/protectionBackfill.js -- gives buckets and NAS shares that existed BEFORE the protection defaults
// (src/lib/protectionDefaults.js, 17 Nov 2026) the same ransomware protection new ones get. Founder decision, 17 Nov 2026.
//
// It never overrides a choice the company made:
//   - S3 bucket: versioning is switched on only if it was NEVER set (a bucket the company Suspended is left alone);
//     the 30-day old-version lifecycle rule is added only if the bucket has no lifecycle policy of its own;
//     a hidden tripwire (decoy) file is placed only if the bucket has none.
//   - NAS share: a daily immutable snapshot schedule only if the share has no snapshot policy (enabled or not);
//     a nightly off-site backup to Inaya cloud storage only if the share has no backup policy.
// Preview by default (apply=false) -- it reports what it WOULD change. Idempotent: a second run changes nothing.
import { getOrgCollections, toObjectId } from "./orgs.js";
import { NONCURRENT_VERSION_DAYS, DEFAULT_LIFECYCLE_RULE_ID, DEFAULT_NAS_SNAPSHOT_POLICY, DEFAULT_NAS_BACKUP_POLICY } from "./protectionDefaults.js";

const S3_SYSTEM_DEPARTMENT_NAME = "S3/Azure Compatible Storage (System)";
const SYSTEM = { role: "owner" }; // system actor for the NAS policy setters (they check canManageNAS)
const ACTOR = "inaya-protection-defaults";

export async function applyProtectionDefaults({ apply = false, orgIds = null } = {}) {
  const { db, departments, projects, orgDocuments, nasShares, nasSnapshotPolicies, nasBackupPolicies } = await getOrgCollections();
  const orgFilter = orgIds ? { orgId: { $in: orgIds.map((id) => toObjectId(id)) } } : {};
  const out = { apply, buckets: { versioningEnabled: 0, lifecycleAdded: 0, tripwirePlaced: 0, leftAlone: 0, errors: [] }, shares: { snapshotScheduleAdded: 0, offsiteBackupAdded: 0, leftAlone: 0, errors: [] } };

  // S3-compatible buckets live as projects under each company's S3 system department.
  const depts = await departments.find({ ...orgFilter, name: S3_SYSTEM_DEPARTMENT_NAME }).project({ _id: 1, orgId: 1 }).toArray();
  const lifecycle = db.collection("s3_lifecycle_policies");
  const liveOrgs = new Set((await db.collection("orgs").find({ _id: { $in: depts.map((d) => d.orgId) } }).project({ _id: 1 }).toArray()).map((o) => String(o._id)));
  for (const d of depts) {
    if (!liveOrgs.has(String(d.orgId))) continue; // leftover buckets of a company that no longer exists
    for (const b of await projects.find({ orgId: d.orgId, departmentId: d._id }).project({ _id: 1, name: 1, versioningStatus: 1 }).toArray()) {
      let touched = false;
      if (b.versioningStatus == null) {
        touched = true; out.buckets.versioningEnabled++;
        if (apply) await projects.updateOne({ _id: b._id, versioningStatus: null }, { $set: { versioningStatus: "Enabled", protectionDefaults: true, protectionDefaultsAppliedAt: new Date().toISOString() } });
      }
      if (!(await lifecycle.findOne({ orgId: d.orgId, bucket: b.name }, { projection: { _id: 1 } }))) {
        touched = true; out.buckets.lifecycleAdded++;
        if (apply) {
          const now = new Date().toISOString();
          await lifecycle.updateOne({ orgId: d.orgId, bucket: b.name }, { $setOnInsert: { orgId: d.orgId, bucket: b.name, rules: [{ id: DEFAULT_LIFECYCLE_RULE_ID, prefix: "", enabled: true, expirationDays: null, noncurrentVersionExpirationDays: NONCURRENT_VERSION_DAYS }], createdAt: now, updatedAt: now, updatedByEmail: "inaya-default" } }, { upsert: true });
        }
      }
      if (!(await orgDocuments.findOne({ orgId: d.orgId, projectId: b._id, filename: /^\.inaya-canary\//, deletedAt: null }, { projection: { _id: 1 } }))) {
        touched = true; out.buckets.tripwirePlaced++;
        if (apply) {
          const { placeTripwire } = await import("./ransomware/cloud.js");
          await placeTripwire({ orgId: String(d.orgId), bucket: b.name }).catch((e) => out.buckets.errors.push({ bucket: b.name, orgId: String(d.orgId), error: String(e.message).slice(0, 160) }));
        }
      }
      if (!touched) out.buckets.leftAlone++;
    }
  }

  // NAS shares.
  const { setSnapshotPolicy } = await import("./nas/snapshots.js");
  const { setBackupPolicy } = await import("./nas/backup.js");
  for (const s of await nasShares.find({ ...orgFilter, deletedAt: null }).project({ _id: 1, orgId: 1 }).toArray()) {
    let touched = false;
    if (!(await nasSnapshotPolicies.findOne({ orgId: s.orgId, shareId: s._id }, { projection: { _id: 1 } }))) {
      touched = true; out.shares.snapshotScheduleAdded++;
      if (apply) {
        const r = await setSnapshotPolicy({ orgId: s.orgId, shareId: s._id, ...DEFAULT_NAS_SNAPSHOT_POLICY, membership: SYSTEM, actorEmail: ACTOR }).catch((e) => ({ error: e.message }));
        if (r?.error) out.shares.errors.push({ shareId: String(s._id), step: "snapshot", error: String(r.error).slice(0, 160) });
      }
    }
    if (!(await nasBackupPolicies.findOne({ orgId: s.orgId, shareId: s._id }, { projection: { _id: 1 } }))) {
      touched = true; out.shares.offsiteBackupAdded++;
      if (apply) {
        const r = await setBackupPolicy({ orgId: s.orgId, shareId: s._id, ...DEFAULT_NAS_BACKUP_POLICY, membership: SYSTEM, actorEmail: ACTOR }).catch((e) => ({ error: e.message }));
        if (r?.error) out.shares.errors.push({ shareId: String(s._id), step: "backup", error: String(r.error).slice(0, 160) });
      }
    }
    if (!touched) out.shares.leftAlone++;
  }
  return out;
}
