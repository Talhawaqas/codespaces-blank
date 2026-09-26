// src/lib/nas/access.js
//
// Sovereign NAS SOW Workstreams G and H: users/groups and the permission
// translation layer
//
//     Inaya organization permissions
//         -> NAS share permissions
//             -> filesystem ACLs
//                 -> SMB / NFS enforcement
//
// Fail-closed by construction: a principal only reaches Samba's
// valid/read/write lists if (1) it is an active NAS account of THIS
// organization on THIS appliance, and (2) its org member still holds NAS
// access and any department boundary the share has. Enforcement is at the
// data plane (Samba + POSIX ACLs on the appliance), not in the web UI.
//
// This is the organization's existing identity model, not a second one:
// eligibility comes from orgGates/memberships; the Samba account is only the
// protocol-level credential SMB needs.

import { getOrgCollections, toObjectId, getMembership, canAccessDepartment } from "../orgs.js";
import { canAccessNAS } from "../orgGates.js";
import { canonicalHash } from "../documentAutomation/manifest.js";
import { fail, gate, loadShare, loadAppliance } from "./common.js";
import { recordNasEvidence } from "./evidence.js";

export const ACCESS_LEVELS = ["read", "write", "deny"];
const GROUP_RE = /^[a-z][a-z0-9_]{1,30}$/;

/** Pure: may this org member have ANY access to this share? */
export function orgEligibility({ membership, share }) {
  if (!membership) return { eligible: false, reason: "Not a member of the organization." };
  if (!canAccessNAS(membership)) return { eligible: false, reason: "The member has no NAS role." };
  if (share?.departmentId && !canAccessDepartment(membership, share.departmentId)) return { eligible: false, reason: "The member is outside this share's department boundary." };
  return { eligible: true, reason: null };
}

/** Pure: the Samba access specification for a share. Deterministic, so the
 *  same policy always renders the same configuration (and hashes the same). */
export function buildShareSpec({ share, usersById = new Map(), groupsById = new Map() }) {
  const acc = share.access || {};
  const valid = new Set();
  const readList = [];
  const writeList = [];
  const invalid = [];
  for (const e of acc.entries || []) {
    const name = e.principalType === "group" ? (groupsById.get(String(e.principalId))?.unixGroup ? "@" + groupsById.get(String(e.principalId)).unixGroup : null) : usersById.get(String(e.principalId))?.unixUsername || null;
    if (!name) continue;
    if (e.level === "deny") { invalid.push(name); continue; }
    valid.add(name);
    (e.level === "read" ? readList : writeList).push(name);
  }
  return {
    name: share.shareName, owner: share.ownerUnixUser,
    validUsers: [...valid].sort(), readList: readList.sort(), writeList: writeList.sort(), invalidUsers: invalid.sort(),
    hostsAllow: [...(acc.hostsAllow || [])].sort(), readOnly: !!acc.readOnly, hidden: !!acc.hidden, enabled: acc.enabled !== false,
    lockdown: !!acc.lockdown?.active, recycle: { enabled: share.recycle?.enabled !== false },
  };
}

export function accessPolicyHash(share) {
  return canonicalHash({ entries: (share.access?.entries || []).map((e) => ({ t: e.principalType, p: String(e.principalId), l: e.level })).sort((a, b) => (a.p + a.l).localeCompare(b.p + b.l)), hostsAllow: [...(share.access?.hostsAllow || [])].sort(), readOnly: !!share.access?.readOnly, hidden: !!share.access?.hidden, enabled: share.access?.enabled !== false });
}

async function accountMaps(orgId, applianceId) {
  const { nasUsers, nasGroups } = await getOrgCollections();
  const [users, groups] = await Promise.all([
    nasUsers.find({ orgId: toObjectId(orgId), applianceId: toObjectId(applianceId), revokedAt: null }).toArray(),
    nasGroups.find({ orgId: toObjectId(orgId), applianceId: toObjectId(applianceId), deletedAt: null }).toArray(),
  ]);
  return { usersById: new Map(users.map((u) => [String(u._id), u])), groupsById: new Map(groups.map((g) => [String(g._id), g])) };
}

/** Pushes the share's stored access policy to the appliance. */
export async function applyShareAccess({ orgId, share, agent }) {
  const maps = await accountMaps(orgId, share.applianceId);
  const spec = buildShareSpec({ share, ...maps });
  return agent.applyShare({ spec, backend: share.backend || "dir", pool: share.poolName || null });
}

/**
 * Sets who may use a share and how. Every principal is validated against the
 * org: a NAS account of this org/appliance whose member still qualifies.
 */
export async function setShareAccess({ orgId, shareId, entries = [], hostsAllow, readOnly, hidden, enabled, reason, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  if (!Array.isArray(entries) || entries.length > 200) return fail("entries must be an array of at most 200 items.");
  const maps = await accountMaps(orgId, share.applianceId);
  const clean = [];
  for (const e of entries) {
    if (!["user", "group"].includes(e?.principalType) || !ACCESS_LEVELS.includes(e?.level)) return fail("Each entry needs principalType user|group and level read|write|deny.");
    const key = String(e.principalId);
    if (e.principalType === "user") {
      const u = maps.usersById.get(key);
      if (!u) return fail(`NAS account ${key} does not belong to this organization/appliance.`, 400);
      if (u.kind !== "service") {
        const el = orgEligibility({ membership: await getMembership(orgId, u.memberEmail), share });
        if (!el.eligible && e.level !== "deny") return fail(`${u.memberEmail} cannot be given access: ${el.reason}`, 400);
      }
    } else if (!maps.groupsById.has(key)) return fail(`NAS group ${key} does not belong to this organization/appliance.`, 400);
    clean.push({ principalType: e.principalType, principalId: toObjectId(key), level: e.level });
  }
  const before = accessPolicyHash(share);
  const access = {
    ...(share.access || {}), entries: clean,
    hostsAllow: Array.isArray(hostsAllow) ? hostsAllow : share.access?.hostsAllow || [],
    readOnly: readOnly ?? share.access?.readOnly ?? false, hidden: hidden ?? share.access?.hidden ?? false, enabled: enabled ?? share.access?.enabled ?? true,
  };
  const next = { ...share, access };
  try {
    await applyShareAccess({ orgId, share: next, agent });
  } catch (err) {
    return fail(`The appliance rejected the access policy (nothing changed): ${err.message}`, 502);
  }
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: share._id }, { $set: { access, updatedAt: new Date().toISOString() } });
  const after = accessPolicyHash(next);
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "SHARE_PERMISSION_CHANGED", actorEmail, previousState: before, newState: after, integrityHash: after, policy: { entries: clean.map((c) => ({ t: c.principalType, p: String(c.principalId), l: c.level })), hostsAllow: access.hostsAllow, readOnly: access.readOnly, hidden: access.hidden, enabled: access.enabled }, data: { reason: reason || null } });
  return { access, policyHash: after };
}

/** Folder-level ACL (POSIX ACL on the appliance filesystem, honoured by
 *  both SMB and NFS). Explicit deny is a `---` entry; `default` entries make
 *  new files inherit. */
export async function setFolderAcl({ orgId, shareId, relPath, entries, recursive = false, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  const maps = await accountMaps(orgId, share.applianceId);
  const agentEntries = [];
  for (const e of entries || []) {
    if (!["user", "group"].includes(e?.principalType) || !/^[r-][w-][x-]$/.test(e?.perms || "")) return fail("Each ACL entry needs principalType user|group and perms like rwx, r-x or ---.");
    const acct = e.principalType === "user" ? maps.usersById.get(String(e.principalId)) : maps.groupsById.get(String(e.principalId));
    if (!acct) return fail("An ACL principal does not belong to this organization/appliance.");
    agentEntries.push({ type: e.principalType, name: e.principalType === "user" ? acct.unixUsername : acct.unixGroup, perms: e.perms, default: !!e.default });
  }
  let result;
  try {
    result = await agent.call("acl_apply", { share: share.shareName, relPath: relPath || ".", entries: agentEntries, recursive });
  } catch (err) {
    return fail(`ACL not applied: ${err.message}`, err.code === "TRAVERSAL" ? 400 : 502);
  }
  const { nasAcls } = await getOrgCollections();
  await nasAcls.updateOne({ orgId: toObjectId(orgId), shareId: share._id, relPath: relPath || "." }, { $set: { entries: (entries || []).map((e) => ({ principalType: e.principalType, principalId: toObjectId(e.principalId), perms: e.perms, default: !!e.default })), updatedAt: new Date().toISOString(), updatedBy: actorEmail } }, { upsert: true });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "SHARE_PERMISSION_CHANGED", actorEmail, integrityHash: canonicalHash(agentEntries), data: { scope: "folder", relPath: relPath || ".", entries: agentEntries.length, recursive } });
  return { acl: result.acl };
}

export async function getFolderAcl({ orgId, shareId, relPath, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  try {
    return await res.agent.call("acl_get", { share: res.share.shareName, relPath: relPath || "." });
  } catch (err) {
    return fail(err.message, err.code === "TRAVERSAL" ? 400 : 502);
  }
}

// ---------------------------------------------------------------- groups
export async function createNasGroup({ orgId, applianceId, name, description, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  if (!slug) return fail("A group name is required.");
  const unixGroup = `nasg_${slug}`;
  if (!GROUP_RE.test(unixGroup)) return fail("Invalid group name.");
  const { nasGroups } = await getOrgCollections();
  if (await nasGroups.findOne({ orgId: toObjectId(orgId), applianceId: res.appliance._id, name: slug, deletedAt: null })) return fail("A group with that name already exists.", 409);
  try {
    await res.agent.call("group_create", { group: unixGroup });
  } catch (err) {
    return fail(`Group not created on the appliance: ${err.message}`, 502);
  }
  const doc = { orgId: toObjectId(orgId), applianceId: res.appliance._id, name: slug, unixGroup, description: description ? String(description).slice(0, 200) : null, members: [], createdBy: actorEmail, createdAt: new Date().toISOString(), deletedAt: null };
  const r = await nasGroups.insertOne(doc);
  return { group: { ...doc, _id: r.insertedId } };
}

export async function listNasGroups({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasGroups } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), deletedAt: null };
  if (applianceId) q.applianceId = toObjectId(applianceId);
  return { groups: await nasGroups.find(q).sort({ createdAt: -1 }).toArray() };
}

export async function setNasGroupMember({ orgId, groupId, nasUserId, action = "add", membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasGroups, nasUsers } = await getOrgCollections();
  const group = await nasGroups.findOne({ _id: toObjectId(groupId), orgId: toObjectId(orgId), deletedAt: null });
  if (!group) return fail("Group not found.", 404);
  const user = await nasUsers.findOne({ _id: toObjectId(nasUserId), orgId: toObjectId(orgId), applianceId: group.applianceId, revokedAt: null });
  if (!user) return fail("NAS account not found on this appliance.", 404);
  const res = await loadAppliance({ orgId, applianceId: group.applianceId });
  if (res.error) return res;
  try {
    await res.agent.call("group_member", { group: group.unixGroup, username: user.unixUsername, action });
  } catch (err) {
    return fail(`Membership not changed on the appliance: ${err.message}`, 502);
  }
  await nasGroups.updateOne({ _id: group._id }, action === "remove" ? { $pull: { members: user._id } } : { $addToSet: { members: user._id } });
  await recordNasEvidence({ orgId, applianceId: group.applianceId, subjectType: "NAS_APPLIANCE", subjectId: group.applianceId, action: action === "remove" ? "USER_REVOKED_ACCESS" : "USER_GRANTED_ACCESS", actorEmail, data: { group: group.unixGroup, unixUsername: user.unixUsername } });
  return { ok: true };
}

export async function deleteNasGroup({ orgId, groupId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasGroups, nasShares } = await getOrgCollections();
  const group = await nasGroups.findOne({ _id: toObjectId(groupId), orgId: toObjectId(orgId), deletedAt: null });
  if (!group) return fail("Group not found.", 404);
  if (await nasShares.findOne({ orgId: toObjectId(orgId), deletedAt: null, "access.entries.principalId": group._id })) return fail("The group is still used by a share's access policy.", 409);
  const res = await loadAppliance({ orgId, applianceId: group.applianceId });
  if (!res.error) await res.agent.call("group_delete", { group: group.unixGroup }).catch(() => {});
  await nasGroups.updateOne({ _id: group._id }, { $set: { deletedAt: new Date().toISOString() } });
  return { deleted: true };
}

/**
 * Re-checks every NAS account against the organization's CURRENT
 * memberships. An account whose member left, lost NAS access, or fell
 * outside a department boundary is disabled on the appliance immediately,
 * its sessions closed and it is removed from share policies. Run by the
 * worker and on demand -- this is what makes "revoked" actually revoked at
 * the data plane rather than just in the UI.
 */
export async function reconcileNasAccess({ orgId, applianceId, actorEmail = "system" }) {
  const { nasUsers, nasShares } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), revokedAt: null, kind: { $ne: "service" } };
  if (applianceId) q.applianceId = toObjectId(applianceId);
  const accounts = await nasUsers.find(q).toArray();
  const revoked = [];
  for (const acct of accounts) {
    const m = await getMembership(orgId, acct.memberEmail);
    const el = orgEligibility({ membership: m, share: null });
    if (el.eligible) continue;
    const res = await loadAppliance({ orgId, applianceId: acct.applianceId });
    if (!res.error) {
      await res.agent.disableUser({ username: acct.unixUsername }).catch(() => {});
      await res.agent.call("session_close", { username: acct.unixUsername }).catch(() => {});
    }
    await nasUsers.updateOne({ _id: acct._id }, { $set: { revokedAt: new Date().toISOString(), revokedReason: el.reason } });
    const shares = await nasShares.find({ orgId: toObjectId(orgId), applianceId: acct.applianceId, deletedAt: null, "access.entries.principalId": acct._id }).toArray();
    for (const sh of shares) {
      const entries = (sh.access.entries || []).filter((e) => String(e.principalId) !== String(acct._id));
      await nasShares.updateOne({ _id: sh._id }, { $set: { "access.entries": entries } });
      if (!res.error) await applyShareAccess({ orgId, share: { ...sh, access: { ...sh.access, entries } }, agent: res.agent }).catch(() => {});
    }
    await recordNasEvidence({ orgId, applianceId: acct.applianceId, subjectType: "NAS_APPLIANCE", subjectId: acct.applianceId, action: "USER_REVOKED_ACCESS", actorEmail, actorType: "system", data: { memberEmail: acct.memberEmail, unixUsername: acct.unixUsername, reason: el.reason } });
    revoked.push({ memberEmail: acct.memberEmail, reason: el.reason });
  }
  return { checked: accounts.length, revoked };
}
