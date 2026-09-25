// src/lib/nas/shares.js
//
// Sovereign NAS SOW, Workstream B/H/I. Real share creation -- calling
// NasAgentClient.createShare() actually writes a Samba share stanza and
// creates the backing directory on the appliance (see agent.js), not a
// database row pretending a share exists.
//
// Quotas (Workstream I): the data model below stores a quota POLICY
// (requestedBytes) because it's useful for reporting/alerting, but this
// pass's one real appliance is WSL2's ext4 root filesystem mounted
// WITHOUT usrquota/grpquota (confirmed: `mount | grep ' / '` shows no
// quota option) -- remounting root to add filesystem quotas isn't safely
// doable on a managed WSL2 VHD without real risk of breaking the distro,
// so quota ENFORCEMENT is honestly reported as `enforced: false` here,
// per the SOW's own explicit rule: "Do not claim quota enforcement if the
// application merely displays a number without preventing writes." This
// is CUSTOMER-ENVIRONMENT-DEPENDENT -- a real multi-disk Linux appliance
// with quota-enabled XFS/ext4 (the common real-world case) would flip
// this to true with no API shape change.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { canManageNAS, canAccessNAS } from "../orgGates.js";
import { resolveApplianceForAgent } from "./appliances.js";

async function assertAccess(membership, requireManage) {
  const ok = requireManage ? canManageNAS(membership) : canAccessNAS(membership);
  if (!ok) return { error: requireManage ? "Only a NAS manager can do that." : "You don't have NAS access.", status: 403 };
  return null;
}

const SHARE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export async function createShare({ orgId, applianceId, shareName, ownerUnixUser, quotaBytes, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  if (!SHARE_NAME_RE.test(shareName || "")) return { error: "shareName must be 1-64 chars: letters, digits, hyphen, underscore only.", status: 400 };
  if (!ownerUnixUser?.trim()) return { error: "ownerUnixUser is required (must already exist as a NAS user -- see users.js).", status: 400 };

  const resolved = await resolveApplianceForAgent({ orgId, applianceId });
  if (!resolved) return { error: "Appliance not found.", status: 404 };

  const { nasShares } = await getOrgCollections();
  const existing = await nasShares.findOne({ orgId: toObjectId(orgId), applianceId: resolved.appliance._id, shareName, deletedAt: null });
  if (existing) return { error: `Share "${shareName}" already exists on this appliance.`, status: 409 };

  let provisioned;
  try {
    provisioned = await resolved.agent.createShare({ shareName, ownerUnixUser: ownerUnixUser.trim(), recycleBin: true });
  } catch (err) {
    return { error: `Real share provisioning failed: ${err.message}`, status: 502 };
  }

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), applianceId: resolved.appliance._id, shareName,
    ownerUnixUser: ownerUnixUser.trim(), dataPath: provisioned.dataPath,
    quota: Number.isFinite(Number(quotaBytes)) ? { requestedBytes: Number(quotaBytes), enforced: false } : null,
    protocol: "smb", recycleBinEnabled: true,
    status: "ACTIVE", createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await nasShares.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "NAS_SHARE", recordId: result.insertedId, actorEmail, action: "SHARE_CREATED", previousState: null, newState: "ACTIVE", metadata: { shareName, applianceId } });

  return { share: { ...doc, _id: result.insertedId } };
}

export async function listShares({ orgId, applianceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { nasShares } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), deletedAt: null };
  if (applianceId) query.applianceId = toObjectId(applianceId);
  const rows = await nasShares.find(query).sort({ createdAt: -1 }).toArray();
  return { shares: rows };
}

export async function getShare({ orgId, shareId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { nasShares } = await getOrgCollections();
  const doc = await nasShares.findOne({ _id: toObjectId(shareId), orgId: toObjectId(orgId), deletedAt: null });
  if (!doc) return { error: "Share not found.", status: 404 };
  return { share: doc };
}

export async function deleteShare({ orgId, shareId, purgeData = false, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  const { nasShares } = await getOrgCollections();
  const doc = await nasShares.findOne({ _id: toObjectId(shareId), orgId: toObjectId(orgId), deletedAt: null });
  if (!doc) return { error: "Share not found.", status: 404 };

  const resolved = await resolveApplianceForAgent({ orgId, applianceId: doc.applianceId.toString() });
  if (resolved) {
    try {
      await resolved.agent.deleteShare({ shareName: doc.shareName, purgeData });
    } catch (err) {
      return { error: `Real share removal failed: ${err.message}`, status: 502 };
    }
  }

  await nasShares.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date().toISOString(), status: "DELETED" } });
  await logOrgActivity({ orgId, recordType: "NAS_SHARE", recordId: doc._id, actorEmail, action: "SHARE_DELETED", previousState: "ACTIVE", newState: "DELETED", metadata: { shareName: doc.shareName, purgeData } });
  return { deleted: true };
}

export async function listRecycleBin({ orgId, shareId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { nasShares } = await getOrgCollections();
  const doc = await nasShares.findOne({ _id: toObjectId(shareId), orgId: toObjectId(orgId), deletedAt: null });
  if (!doc) return { error: "Share not found.", status: 404 };
  const resolved = await resolveApplianceForAgent({ orgId, applianceId: doc.applianceId.toString() });
  if (!resolved) return { error: "Appliance not found.", status: 404 };
  const entries = await resolved.agent.listRecycleBin({ shareName: doc.shareName, unixUser: doc.ownerUnixUser });
  return { entries };
}
