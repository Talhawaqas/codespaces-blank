// src/lib/record-grants.js
//
// Business Workspace gap closure, Batch 2 — record-level permissions for
// tasks and CRM deals, modeled on document_permissions.
//
// A task or deal is DEPARTMENT-visible unless it has visibility:"PRIVATE"
// (absent on every pre-existing record, so their behavior is unchanged).
// A PRIVATE record is visible only to: org owner/admin, its creator, its
// assignee (tasks), and people with an unexpired grant. Grants are VIEW or
// EDIT. Department access is still required on top of this — private
// narrows who can see a record, it never widens it.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageOrg } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const RECORD_TYPES = ["TASK", "DEAL"];
export const VISIBILITIES = ["DEPARTMENT", "PRIVATE"];
export const GRANT_LEVELS = ["VIEW", "EDIT"];
const norm = (e) => String(e || "").trim().toLowerCase();
const notExpired = (now) => ({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] });

const isPrivate = (record) => record?.visibility === "PRIVATE";

function isInsider(record, recordType, membership, email) {
  if (canManageOrg(membership)) return true;
  const me = norm(email);
  if (norm(record.createdByEmail) === me) return true;
  if (recordType === "TASK" && norm(record.assigneeEmail) === me) return true;
  return false;
}

/** Bulk filter: keeps every non-private record and the private ones this
 *  person may see. One extra query, only when private records exist. */
export async function filterVisibleRecords({ orgId, recordType, records, membership, email }) {
  const privates = records.filter((r) => isPrivate(r) && !isInsider(r, recordType, membership, email));
  if (!privates.length) return records;
  const { recordGrants } = await getOrgCollections();
  const granted = new Set((await recordGrants.find({
    orgId: toObjectId(orgId), recordType, email: norm(email), recordId: { $in: privates.map((r) => r._id) },
    ...notExpired(new Date().toISOString()),
  }, { projection: { recordId: 1 } }).toArray()).map((g) => g.recordId.toString()));
  const hidden = new Set(privates.filter((r) => !granted.has(r._id.toString())).map((r) => r._id.toString()));
  return records.filter((r) => !hidden.has(r._id.toString()));
}

/** Single-record check. need: "VIEW" | "EDIT". Returns true/false. */
export async function canAccessRecord({ orgId, recordType, record, membership, email, need = "VIEW" }) {
  if (!isPrivate(record) || isInsider(record, recordType, membership, email)) return true;
  const { recordGrants } = await getOrgCollections();
  const grant = await recordGrants.findOne({
    orgId: toObjectId(orgId), recordType, recordId: record._id, email: norm(email), ...notExpired(new Date().toISOString()),
  });
  if (!grant) return false;
  return need === "VIEW" || grant.level === "EDIT";
}

/** Only the creator or an org owner/admin manages visibility and grants. */
export function canManageRecordSharing(record, membership, email) {
  return canManageOrg(membership) || norm(record.createdByEmail) === norm(email);
}

const collectionFor = async (recordType) => {
  const c = await getOrgCollections();
  return recordType === "TASK" ? c.tasks : c.crmDeals;
};

export async function setVisibility({ orgId, recordType, record, visibility, actorEmail }) {
  if (!VISIBILITIES.includes(visibility)) return { error: `visibility must be one of ${VISIBILITIES.join(", ")}.`, status: 400 };
  const col = await collectionFor(recordType);
  await col.updateOne({ _id: record._id, orgId: toObjectId(orgId) }, { $set: { visibility, updatedAt: new Date().toISOString() } });
  await logOrgActivity({ orgId: toObjectId(orgId), recordType, recordId: record._id, actorEmail, action: `${recordType}_VISIBILITY_SET`, previousState: record.visibility || "DEPARTMENT", newState: visibility, metadata: {} });
  return { visibility };
}

export async function listGrants({ orgId, recordType, recordId }) {
  const { recordGrants } = await getOrgCollections();
  const rows = await recordGrants.find({ orgId: toObjectId(orgId), recordType, recordId: toObjectId(recordId) }).sort({ createdAt: 1 }).toArray();
  const now = new Date().toISOString();
  return rows.map((g) => ({ id: g._id.toString(), email: g.email, level: g.level, expiresAt: g.expiresAt, expired: !!g.expiresAt && g.expiresAt <= now }));
}

/** Upserts one grant per (record, email). The grantee must be an active
 *  member of the org. */
export async function grantAccess({ orgId, recordType, record, email, level = "VIEW", expiresAt = null, actorEmail }) {
  const target = norm(email);
  if (!target) return { error: "email is required.", status: 400 };
  if (!GRANT_LEVELS.includes(level)) return { error: `level must be one of ${GRANT_LEVELS.join(", ")}.`, status: 400 };
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) return { error: "expiresAt must be a valid date.", status: 400 };
  const { recordGrants, orgMembers } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  if (!(await orgMembers.findOne({ orgId: orgObjectId, email: target, status: "active" }))) {
    return { error: "You can only share with an active member of this organization.", status: 400 };
  }
  const now = new Date().toISOString();
  await recordGrants.updateOne(
    { orgId: orgObjectId, recordType, recordId: record._id, email: target },
    { $set: { level, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, grantedByEmail: actorEmail, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  await logOrgActivity({ orgId: orgObjectId, recordType, recordId: record._id, actorEmail, action: `${recordType}_ACCESS_GRANTED`, previousState: null, newState: level, metadata: { email: target, expiresAt } });
  return { grants: await listGrants({ orgId, recordType, recordId: record._id }) };
}

export async function revokeAccess({ orgId, recordType, record, email, actorEmail }) {
  const { recordGrants } = await getOrgCollections();
  const r = await recordGrants.deleteOne({ orgId: toObjectId(orgId), recordType, recordId: record._id, email: norm(email) });
  if (!r.deletedCount) return { error: "No such grant.", status: 404 };
  await logOrgActivity({ orgId: toObjectId(orgId), recordType, recordId: record._id, actorEmail, action: `${recordType}_ACCESS_REVOKED`, previousState: null, newState: null, metadata: { email: norm(email) } });
  return { grants: await listGrants({ orgId, recordType, recordId: record._id }) };
}

export const isValidId = (id) => ObjectId.isValid(String(id || ""));
