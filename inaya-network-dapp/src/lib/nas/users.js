// src/lib/nas/users.js
//
// Sovereign NAS SOW, Workstream G. Maps an Inaya org member to a real
// appliance-side SMB login (Workstream G's "layered identity model" --
// local identities backed by the existing organization identity, not a
// second, conflicting identity system). The Inaya org member is always
// the authorization source of truth (must be a real org member with NAS
// access to be granted a NAS login); the appliance-side Samba account is
// purely the protocol-level credential SMB itself requires.

import { randomBytes } from "node:crypto";
import { getOrgCollections, toObjectId, getMembership } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { canManageNAS, canAccessNAS } from "../orgGates.js";
import { encryptNasSecret, decryptNasSecret, isNasCredentialCryptoConfigured } from "./credentials.js";
import { resolveApplianceForAgent } from "./appliances.js";

async function assertAccess(membership, requireManage) {
  const ok = requireManage ? canManageNAS(membership) : canAccessNAS(membership);
  if (!ok) return { error: requireManage ? "Only a NAS manager can do that." : "You don't have NAS access.", status: 403 };
  return null;
}

const UNIX_USER_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** Derives a stable, appliance-safe Unix username from an org member's
 *  email -- deterministic so the same member always maps to the same
 *  login, never a randomly generated identifier the admin would need to
 *  look up separately. */
function deriveUnixUsername(email) {
  const local = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 28);
  return `nas${local || "user"}`.slice(0, 32);
}

export async function provisionNasUser({ orgId, applianceId, memberEmail, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  if (!isNasCredentialCryptoConfigured()) return { error: "NAS_ENCRYPTION_KEY is not configured on this server.", status: 500 };

  const targetMembership = await getMembership(orgId, memberEmail);
  if (!targetMembership) return { error: `${memberEmail} is not a member of this organization.`, status: 400 };
  if (!canAccessNAS(targetMembership)) return { error: `${memberEmail} does not have NAS access in this organization (grant nasRole first).`, status: 400 };

  const resolved = await resolveApplianceForAgent({ orgId, applianceId });
  if (!resolved) return { error: "Appliance not found.", status: 404 };

  const { nasUsers } = await getOrgCollections();
  const existing = await nasUsers.findOne({ orgId: toObjectId(orgId), applianceId: resolved.appliance._id, memberEmail, revokedAt: null });
  if (existing) return { error: `${memberEmail} already has a NAS login on this appliance.`, status: 409 };

  const unixUsername = deriveUnixUsername(memberEmail);
  const password = randomBytes(18).toString("base64");

  try {
    await resolved.agent.createUser({ username: unixUsername, password });
  } catch (err) {
    return { error: `Real user provisioning failed: ${err.message}`, status: 502 };
  }

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), applianceId: resolved.appliance._id, memberEmail,
    unixUsername, credential: encryptNasSecret(password),
    createdByEmail: actorEmail, createdAt: now, revokedAt: null,
  };
  const result = await nasUsers.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "NAS_USER", recordId: result.insertedId, actorEmail, action: "USER_GRANTED_ACCESS", previousState: null, newState: "ACTIVE", metadata: { memberEmail, unixUsername } });

  // The plaintext password is returned ONLY here, once, at creation time
  // -- the same never-stored-again discipline api-keys.js uses for raw
  // API keys. The admin must relay it to the user through a separate
  // secure channel; Inaya itself never displays it again.
  return { nasUser: { ...doc, credential: undefined }, initialPassword: password };
}

export async function listNasUsers({ orgId, applianceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { nasUsers } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), revokedAt: null };
  if (applianceId) query.applianceId = toObjectId(applianceId);
  const rows = await nasUsers.find(query, { projection: { credential: 0 } }).sort({ createdAt: -1 }).toArray();
  return { nasUsers: rows };
}

export async function revokeNasUser({ orgId, nasUserId, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  const { nasUsers } = await getOrgCollections();
  const doc = await nasUsers.findOne({ _id: toObjectId(nasUserId), orgId: toObjectId(orgId), revokedAt: null });
  if (!doc) return { error: "NAS user not found.", status: 404 };

  const resolved = await resolveApplianceForAgent({ orgId, applianceId: doc.applianceId.toString() });
  if (resolved) {
    try {
      await resolved.agent.disableUser({ username: doc.unixUsername });
    } catch (err) {
      return { error: `Real user revocation failed: ${err.message}`, status: 502 };
    }
  }

  await nasUsers.updateOne({ _id: doc._id }, { $set: { revokedAt: new Date().toISOString() } });
  await logOrgActivity({ orgId, recordType: "NAS_USER", recordId: doc._id, actorEmail, action: "USER_REVOKED_ACCESS", previousState: "ACTIVE", newState: "REVOKED", metadata: { memberEmail: doc.memberEmail, unixUsername: doc.unixUsername } });
  return { revoked: true };
}
