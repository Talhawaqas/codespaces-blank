// src/lib/nas/users.js
//
// Sovereign NAS SOW Workstream G (users, groups and identity).
//
// Layered identity, without a second enterprise identity system:
//   - the Inaya organization member is always the source of truth for WHO may
//     have access (orgGates / memberships -- see access.js reconcile);
//   - the appliance-side Samba account is only the protocol credential SMB
//     itself requires (SMB/NFS cannot do arbitrary MFA -- MFA protects the
//     management plane, which already requires an authenticated Inaya session);
//   - local capabilities the SOW lists: disabled users, password rotation,
//     account lockout (Samba's own bad-lockout policy), service accounts.
//
// Enterprise directory (Active Directory / LDAP): audited, not built. Samba
// can join a domain (`net ads join`) but that needs a reachable domain
// controller, which does not exist in this environment, so it is reported as
// CUSTOMER-ENVIRONMENT-DEPENDENT rather than claimed. See identityCapabilities().

import { randomBytes } from "node:crypto";
import { getOrgCollections, toObjectId, getMembership } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { canAccessNAS } from "../orgGates.js";
import { encryptNasSecret, isNasCredentialCryptoConfigured } from "./credentials.js";
import { fail, gate, loadAppliance } from "./common.js";
import { recordNasEvidence } from "./evidence.js";

/** Derives a stable, appliance-safe Unix username from an email. */
function deriveUnixUsername(email) {
  const local = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 28);
  return `nas${local || "user"}`.slice(0, 32);
}

function newPassword() {
  return randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "x") + "-Aa1";
}

export function identityCapabilities() {
  return {
    localUsers: "IMPLEMENTED", localGroups: "IMPLEMENTED", serviceAccounts: "IMPLEMENTED", passwordRotation: "IMPLEMENTED", accountLockout: "IMPLEMENTED (Samba bad-lockout policy)",
    inayaOrganizationIdentity: "IMPLEMENTED (org membership + nasRole decide who may hold an account)",
    googleIdentity: "Not used on the data plane: SMB/NFS cannot consume it. Google sign-in already protects the Inaya management session.",
    activeDirectory: "NOT IMPLEMENTED -- CUSTOMER-ENVIRONMENT-DEPENDENT: needs a reachable domain controller (net ads join); none exists here.",
    ldap: "NOT IMPLEMENTED -- CUSTOMER-ENVIRONMENT-DEPENDENT: needs a customer LDAP server.",
    mfa: "Management plane only (authenticated Inaya session). SMB/NFS use the protocol's own security model.",
  };
}

export async function provisionNasUser({ orgId, applianceId, memberEmail, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!isNasCredentialCryptoConfigured()) return fail("NAS_ENCRYPTION_KEY is not configured on this server.", 500);

  const targetMembership = await getMembership(orgId, memberEmail);
  if (!targetMembership) return fail(`${memberEmail} is not a member of this organization.`);
  if (!canAccessNAS(targetMembership)) return fail(`${memberEmail} does not have NAS access in this organization (grant nasRole first).`);

  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;

  const { nasUsers } = await getOrgCollections();
  if (await nasUsers.findOne({ orgId: toObjectId(orgId), applianceId: res.appliance._id, memberEmail, revokedAt: null })) return fail(`${memberEmail} already has a NAS login on this appliance.`, 409);

  const unixUsername = deriveUnixUsername(memberEmail);
  const password = newPassword();
  try {
    await res.agent.createUser({ username: unixUsername, password });
  } catch (err) {
    return fail(`Real user provisioning failed: ${err.message}`, 502);
  }

  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), applianceId: res.appliance._id, memberEmail, kind: "human", unixUsername, credential: encryptNasSecret(password), passwordRotatedAt: now, disabledAt: null, createdByEmail: actorEmail, createdAt: now, revokedAt: null };
  const result = await nasUsers.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "NAS_USER", recordId: result.insertedId, actorEmail, action: "USER_GRANTED_ACCESS", previousState: null, newState: "ACTIVE", metadata: { memberEmail, unixUsername } });
  await recordNasEvidence({ orgId, applianceId: res.appliance._id, subjectType: "NAS_APPLIANCE", subjectId: res.appliance._id, action: "USER_GRANTED_ACCESS", actorEmail, newState: "ACTIVE", data: { memberEmail, unixUsername, kind: "human" }, graph: false });
  // The plaintext password is returned ONLY here, once (same discipline as
  // api-keys.js). Inaya never displays it again.
  return { nasUser: { ...doc, credential: undefined, _id: result.insertedId }, initialPassword: password };
}

/** Service accounts (backup agents, applications) are not tied to a person. */
export async function createServiceAccount({ orgId, applianceId, name, description, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!isNasCredentialCryptoConfigured()) return fail("NAS_ENCRYPTION_KEY is not configured on this server.", 500);
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  if (!slug) return fail("A service account name is required.");
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const unixUsername = `nassvc_${slug}`;
  const { nasUsers } = await getOrgCollections();
  if (await nasUsers.findOne({ orgId: toObjectId(orgId), applianceId: res.appliance._id, unixUsername, revokedAt: null })) return fail("A service account with that name already exists.", 409);
  const password = newPassword();
  try {
    await res.agent.createUser({ username: unixUsername, password });
  } catch (err) {
    return fail(`Real user provisioning failed: ${err.message}`, 502);
  }
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), applianceId: res.appliance._id, memberEmail: null, kind: "service", description: description ? String(description).slice(0, 200) : null, unixUsername, credential: encryptNasSecret(password), passwordRotatedAt: now, disabledAt: null, createdByEmail: actorEmail, createdAt: now, revokedAt: null };
  const result = await nasUsers.insertOne(doc);
  await recordNasEvidence({ orgId, applianceId: res.appliance._id, subjectType: "NAS_APPLIANCE", subjectId: res.appliance._id, action: "USER_GRANTED_ACCESS", actorEmail, data: { unixUsername, kind: "service" }, graph: false });
  return { nasUser: { ...doc, credential: undefined, _id: result.insertedId }, initialPassword: password };
}

export async function listNasUsers({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasUsers } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), revokedAt: null };
  if (applianceId) query.applianceId = toObjectId(applianceId);
  return { nasUsers: await nasUsers.find(query, { projection: { credential: 0 } }).sort({ createdAt: -1 }).toArray() };
}

async function loadNasUser({ orgId, nasUserId }) {
  const { nasUsers } = await getOrgCollections();
  let user;
  try { user = await nasUsers.findOne({ _id: toObjectId(nasUserId), orgId: toObjectId(orgId), revokedAt: null }); } catch { user = null; }
  if (!user) return fail("NAS user not found.", 404);
  const res = await loadAppliance({ orgId, applianceId: user.applianceId });
  if (res.error) return res;
  return { user, ...res };
}

export async function revokeNasUser({ orgId, nasUserId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadNasUser({ orgId, nasUserId });
  if (r.error) return r;
  try {
    await r.agent.disableUser({ username: r.user.unixUsername });
    await r.agent.call("session_close", { username: r.user.unixUsername }).catch(() => {});
  } catch (err) {
    return fail(`Real user revocation failed: ${err.message}`, 502);
  }
  const { nasUsers } = await getOrgCollections();
  await nasUsers.updateOne({ _id: r.user._id }, { $set: { revokedAt: new Date().toISOString(), revokedReason: "REVOKED_BY_ADMIN" } });
  await logOrgActivity({ orgId, recordType: "NAS_USER", recordId: r.user._id, actorEmail, action: "USER_REVOKED_ACCESS", previousState: "ACTIVE", newState: "REVOKED", metadata: { memberEmail: r.user.memberEmail, unixUsername: r.user.unixUsername } });
  await recordNasEvidence({ orgId, applianceId: r.user.applianceId, subjectType: "NAS_APPLIANCE", subjectId: r.user.applianceId, action: "USER_REVOKED_ACCESS", actorEmail, newState: "REVOKED", data: { unixUsername: r.user.unixUsername }, graph: false });
  return { revoked: true };
}

/** Rotates the Samba password and returns the new one once. */
export async function rotateNasUserPassword({ orgId, nasUserId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadNasUser({ orgId, nasUserId });
  if (r.error) return r;
  const password = newPassword();
  try {
    await r.agent.call("user_set_password", { username: r.user.unixUsername, password });
  } catch (err) {
    return fail(`Password not rotated: ${err.message}`, 502);
  }
  const { nasUsers } = await getOrgCollections();
  await nasUsers.updateOne({ _id: r.user._id }, { $set: { credential: encryptNasSecret(password), passwordRotatedAt: new Date().toISOString() } });
  await recordNasEvidence({ orgId, applianceId: r.user.applianceId, subjectType: "NAS_APPLIANCE", subjectId: r.user.applianceId, action: "POLICY_CHANGED", actorEmail, data: { change: "password-rotated", unixUsername: r.user.unixUsername }, graph: false });
  return { rotated: true, newPassword: password };
}

/** Temporarily disable / re-enable a login without revoking the account. */
export async function setNasUserEnabled({ orgId, nasUserId, enabled, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadNasUser({ orgId, nasUserId });
  if (r.error) return r;
  try {
    await r.agent.call(enabled ? "user_enable" : "user_disable", { username: r.user.unixUsername });
    if (!enabled) await r.agent.call("session_close", { username: r.user.unixUsername }).catch(() => {});
  } catch (err) {
    return fail(`The appliance did not change the account: ${err.message}`, 502);
  }
  const { nasUsers } = await getOrgCollections();
  await nasUsers.updateOne({ _id: r.user._id }, { $set: { disabledAt: enabled ? null : new Date().toISOString() } });
  await recordNasEvidence({ orgId, applianceId: r.user.applianceId, subjectType: "NAS_APPLIANCE", subjectId: r.user.applianceId, action: enabled ? "USER_GRANTED_ACCESS" : "USER_REVOKED_ACCESS", actorEmail, data: { unixUsername: r.user.unixUsername, change: enabled ? "enabled" : "disabled" }, graph: false });
  return { enabled };
}

export async function getNasUserStatus({ orgId, nasUserId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const r = await loadNasUser({ orgId, nasUserId });
  if (r.error) return r;
  return r.agent.call("user_status", { username: r.user.unixUsername });
}

export async function unlockNasUser({ orgId, nasUserId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadNasUser({ orgId, nasUserId });
  if (r.error) return r;
  await r.agent.call("user_unlock", { username: r.user.unixUsername });
  await recordNasEvidence({ orgId, applianceId: r.user.applianceId, subjectType: "NAS_APPLIANCE", subjectId: r.user.applianceId, action: "POLICY_CHANGED", actorEmail, data: { change: "account-unlocked", unixUsername: r.user.unixUsername }, graph: false });
  return { unlocked: true };
}

/** Samba's bad-password lockout for this appliance (SOW 37 brute-force protection). */
export async function setLockoutPolicy({ orgId, applianceId, attempts = 5, durationMinutes = 15, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  let applied;
  try {
    applied = await res.agent.call("lockout_policy", { attempts: Number(attempts), durationMinutes: Number(durationMinutes) });
  } catch (err) {
    return fail(err.message, err.code === "BAD_INPUT" ? 400 : 502);
  }
  const { nasAppliances } = await getOrgCollections();
  await nasAppliances.updateOne({ _id: res.appliance._id }, { $set: { lockoutPolicy: applied, updatedAt: new Date().toISOString() } });
  await recordNasEvidence({ orgId, applianceId: res.appliance._id, subjectType: "NAS_APPLIANCE", subjectId: res.appliance._id, action: "POLICY_CHANGED", actorEmail, policy: { kind: "lockout", ...applied }, data: { change: "lockout-policy" }, graph: false });
  return { lockoutPolicy: applied };
}
