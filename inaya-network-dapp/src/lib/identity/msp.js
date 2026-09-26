// src/lib/identity/msp.js
//
// SOW §25, §26: managed-service-provider multi-tenancy.
//
//     MSP org  ─ link (accepted by the CUSTOMER) ─  Customer A org
//                                                  ─  Customer B org
//
// * A link is created by the CUSTOMER's owner/admin (an invite code the customer hands to the MSP) and accepted by the MSP's
//   owner/admin. Either side can end it at any time; ending it stops every MSP credential and technician for that customer at once.
// * MSP technicians hold a DELEGATED ROLE, per customer or for all linked customers:
//     MSP_SUPER_ADMIN            every identity action on every linked customer (implicit for the MSP org's owners/admins)
//     MSP_CUSTOMER_ADMIN         every identity action on the customers they are assigned
//     MSP_AUTOMATION_OPERATOR    read, provision, revoke, reconcile, audit on assigned customers; no policy or credential changes
//     MSP_READ_ONLY_AUDITOR      read and audit on assigned customers
// * Nothing here creates a second permission system: it only decides whether a person from ANOTHER organization may call the
//   identity actions of a customer organization. Everything else stays in the customer's own membership model.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { getIdentityCollections, ensureIdentityIndexes } from "./db.js";
import { fail, nowIso, sha256, newToken, normEmail } from "./common.js";
import { audit } from "./record.js";

export const MSP_ROLES = ["MSP_SUPER_ADMIN", "MSP_CUSTOMER_ADMIN", "MSP_AUTOMATION_OPERATOR", "MSP_READ_ONLY_AUDITOR"];
/** capability -> roles allowed. Capabilities: read, audit, provision, revoke, reconcile, mapping, admin. */
export const MSP_CAPABILITIES = {
  MSP_SUPER_ADMIN: ["read", "audit", "provision", "revoke", "reconcile", "mapping", "admin"],
  MSP_CUSTOMER_ADMIN: ["read", "audit", "provision", "revoke", "reconcile", "mapping", "admin"],
  MSP_AUTOMATION_OPERATOR: ["read", "audit", "provision", "revoke", "reconcile"],
  MSP_READ_ONLY_AUDITOR: ["read", "audit"],
};
const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

/** Customer side: creates the invite code the customer gives to its MSP. Shown once. */
export async function createLinkInvite({ customerOrgId, actorEmail }) {
  await ensureIdentityIndexes();
  const { identityMspInvites } = await getIdentityCollections();
  const token = `idm_${newToken(24)}`;
  await identityMspInvites.insertOne({ tokenHash: sha256(token), customerOrgId: toObjectId(customerOrgId), createdBy: normEmail(actorEmail), createdAt: nowIso(), expiresAt: new Date(Date.now() + 7 * 86400000) });
  await audit({ orgId: customerOrgId, action: "IDENTITY_MSP_INVITE_CREATED", actorEmail, metadata: {} });
  return { inviteCode: token, note: "Give this code to your MSP. It is shown once and expires in 7 days." };
}

/** MSP side: redeems a customer's invite code. */
export async function acceptLinkInvite({ mspOrgId, token, actorEmail }) {
  const { identityMspInvites, identityMspLinks } = await getIdentityCollections();
  const inv = await identityMspInvites.findOneAndDelete({ tokenHash: sha256(String(token || "")), expiresAt: { $gt: new Date() } });
  if (!inv) return fail("That invite code is not valid or has expired.", 400);
  if (String(inv.customerOrgId) === String(mspOrgId)) return fail("An organization cannot be its own MSP.", 400);
  const now = nowIso();
  await identityMspLinks.updateOne({ mspOrgId: toObjectId(mspOrgId), customerOrgId: inv.customerOrgId }, { $set: { status: "ACTIVE", acceptedBy: normEmail(actorEmail), invitedBy: inv.createdBy, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
  await audit({ orgId: inv.customerOrgId, action: "IDENTITY_MSP_LINKED", actorEmail, metadata: { mspOrgId: String(mspOrgId) } });
  await audit({ orgId: mspOrgId, action: "IDENTITY_MSP_LINKED", actorEmail, metadata: { customerOrgId: String(inv.customerOrgId) } });
  return { linked: true, customerOrgId: String(inv.customerOrgId) };
}

export async function listLinks({ orgId }) {
  const { identityMspLinks } = await getIdentityCollections(); const { orgs } = await getOrgCollections();
  const oid = toObjectId(orgId);
  const rows = await identityMspLinks.find({ $or: [{ mspOrgId: oid }, { customerOrgId: oid }] }).toArray();
  const ids = [...new Set(rows.flatMap((r) => [String(r.mspOrgId), String(r.customerOrgId)]))].map(toObjectId);
  const names = new Map((await orgs.find({ _id: { $in: ids } }).project({ name: 1 }).toArray()).map((o) => [String(o._id), o.name]));
  return { links: rows.map((r) => ({ mspOrgId: String(r.mspOrgId), mspName: names.get(String(r.mspOrgId)) || null, customerOrgId: String(r.customerOrgId), customerName: names.get(String(r.customerOrgId)) || null, status: r.status, direction: String(r.mspOrgId) === String(orgId) ? "customer" : "msp", createdAt: r.createdAt, acceptedBy: r.acceptedBy })) };
}

/** Either side ends the link; everything that relied on it stops immediately (links are checked on every request). */
export async function revokeLink({ orgId, mspOrgId, customerOrgId, actorEmail }) {
  const { identityMspLinks, identityMspAssignments } = await getIdentityCollections();
  const a = oidOf(mspOrgId); const b = oidOf(customerOrgId);
  if (!a || !b) return fail("Link not found.", 404);
  if (String(orgId) !== String(a) && String(orgId) !== String(b)) return fail("Link not found.", 404);
  const r = await identityMspLinks.updateOne({ mspOrgId: a, customerOrgId: b, status: "ACTIVE" }, { $set: { status: "REVOKED", revokedAt: nowIso(), revokedBy: normEmail(actorEmail), revokedByOrg: String(orgId) } });
  if (!r.matchedCount) return fail("Link not found.", 404);
  await identityMspAssignments.updateMany({ mspOrgId: a }, { $pull: { customerOrgIds: b } });
  await audit({ orgId: b, action: "IDENTITY_MSP_UNLINKED", actorEmail, metadata: { mspOrgId: String(a), by: String(orgId) === String(a) ? "msp" : "customer" } });
  await audit({ orgId: a, action: "IDENTITY_MSP_UNLINKED", actorEmail, metadata: { customerOrgId: String(b) } });
  return { unlinked: true };
}

/** MSP admin: gives a technician a delegated role over some (or all, for super admins) linked customers. */
export async function assignTechnician({ mspOrgId, email, role, customerOrgIds, actorEmail }) {
  if (!MSP_ROLES.includes(role)) return fail(`role must be one of ${MSP_ROLES.join(", ")}.`);
  const { orgMembers } = await getOrgCollections(); const { identityMspAssignments, identityMspLinks } = await getIdentityCollections();
  const e = normEmail(email);
  if (!(await orgMembers.findOne({ orgId: toObjectId(mspOrgId), email: e, status: "active" }))) return fail("That person is not an active member of the MSP organization.", 404);
  let cust;
  if (role === "MSP_SUPER_ADMIN") cust = "*";
  else {
    if (!Array.isArray(customerOrgIds) || !customerOrgIds.length) return fail("customerOrgIds is required for this role.");
    cust = [];
    for (const id of customerOrgIds) { const oid = oidOf(id); if (!oid || !(await identityMspLinks.findOne({ mspOrgId: toObjectId(mspOrgId), customerOrgId: oid, status: "ACTIVE" }))) return fail(`Customer ${id} is not linked to this MSP.`, 403); cust.push(oid); }
  }
  await identityMspAssignments.updateOne({ mspOrgId: toObjectId(mspOrgId), email: e }, { $set: { role, customerOrgIds: cust, updatedBy: normEmail(actorEmail), updatedAt: nowIso() }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  await audit({ orgId: mspOrgId, action: "IDENTITY_MSP_ASSIGNED", actorEmail, metadata: { email: e, role, customers: cust === "*" ? "*" : cust.length } });
  return { assigned: true, role };
}
export async function listAssignments({ mspOrgId }) {
  const { identityMspAssignments } = await getIdentityCollections();
  return { assignments: (await identityMspAssignments.find({ mspOrgId: toObjectId(mspOrgId) }).toArray()).map((a) => ({ email: a.email, role: a.role, customerOrgIds: a.customerOrgIds === "*" ? "*" : (a.customerOrgIds || []).map(String) })) };
}

/**
 * Can this signed-in person act, as MSP staff, on this customer organization? Returns { role, mspOrgId } or null.
 * Re-verified on every call: link still ACTIVE, person still an active member of the MSP, assignment still covers the customer.
 */
export async function resolveMspAccess({ email, customerOrgId }) {
  const { identityMspLinks, identityMspAssignments } = await getIdentityCollections(); const { orgMembers } = await getOrgCollections();
  const cid = oidOf(customerOrgId); if (!cid) return null;
  const links = await identityMspLinks.find({ customerOrgId: cid, status: "ACTIVE" }).toArray();
  const e = normEmail(email);
  for (const l of links) {
    const m = await orgMembers.findOne({ orgId: l.mspOrgId, email: e, status: "active" });
    if (!m) continue;
    if (m.role === "owner" || m.role === "admin") return { role: "MSP_SUPER_ADMIN", mspOrgId: String(l.mspOrgId) };
    const a = await identityMspAssignments.findOne({ mspOrgId: l.mspOrgId, email: e });
    if (a && (a.customerOrgIds === "*" || (a.customerOrgIds || []).some((x) => String(x) === String(cid)))) return { role: a.role, mspOrgId: String(l.mspOrgId) };
  }
  return null;
}

export async function listCustomersFor({ email }) {
  const { identityMspLinks } = await getIdentityCollections(); const { orgMembers, orgs } = await getOrgCollections();
  const mine = await orgMembers.find({ email: normEmail(email), status: "active" }).toArray();
  const out = [];
  for (const m of mine) {
    for (const l of await identityMspLinks.find({ mspOrgId: m.orgId, status: "ACTIVE" }).toArray()) {
      const acc = await resolveMspAccess({ email, customerOrgId: l.customerOrgId });
      if (acc) out.push({ customerOrgId: String(l.customerOrgId), role: acc.role, mspOrgId: acc.mspOrgId });
    }
  }
  const names = new Map((await orgs.find({ _id: { $in: out.map((o) => toObjectId(o.customerOrgId)) } }).project({ name: 1 }).toArray()).map((o) => [String(o._id), o.name]));
  return { customers: out.map((o) => ({ ...o, name: names.get(o.customerOrgId) || null })) };
}
