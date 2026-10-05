// src/lib/filelocks.js
//
// File locking (Competitive Expansion SOW B4, LOCK-001/002). A lock is a lease stored on the document row itself (`lock: { byEmail, at,
// expiresAt, reason }`), set and released with ONE atomic conditional write, so two people can never both hold it and there is no second
// collection to drift out of step. A lease expires by itself (a crashed editor cannot lock a file forever): readers compare expiresAt with the
// clock, and sweepStaleLocks() only tidies the stored fields.
//
// Enforcement lives at the chokepoints, not in the UI: the S3/Azure store (src/lib/s3-compat/store.js assertNotLocked, which also covers
// DirectSync, rclone, Terraform and every other client of those APIs) and the new-version route. The lock holder keeps full write access, in the
// web app and through API credentials the holder created. Legal hold and retention are separate and stronger: a lock never overrides them.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageOrg } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const LEASE = { defaultMinutes: 15, maxMinutes: 8 * 60 };

export class LockError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
const fail = (status, message, extra) => { throw new LockError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const norm = (e) => String(e || "").trim().toLowerCase();

/** Pure: the lock on `doc` if it is still in force at `now`, else null. */
export function activeLock(doc, now = Date.now()) {
  const l = doc?.lock;
  if (!l || !l.byEmail || !l.expiresAt) return null;
  return new Date(l.expiresAt).getTime() > now ? l : null;
}

/** Pure: the lock when someone OTHER than `email` holds it, else null. */
export function lockedByOther(doc, email, now = Date.now()) {
  const l = activeLock(doc, now);
  return l && norm(l.byEmail) !== norm(email) ? l : null;
}

const view = (doc) => { const l = activeLock(doc); return l ? { locked: true, byEmail: l.byEmail, at: l.at, expiresAt: l.expiresAt, reason: l.reason || null } : { locked: false }; };

function clampLease(minutes) {
  const m = minutes === undefined || minutes === null ? LEASE.defaultMinutes : Number(minutes);
  if (!Number.isFinite(m) || m < 1) fail(400, "leaseMinutes must be at least 1.");
  return Math.min(Math.floor(m), LEASE.maxMinutes);
}

/** Take or renew a lock. The caller has already checked the person may edit the document. */
export async function acquireLock({ orgId, documentId, actorEmail, leaseMinutes, reason = null }) {
  const me = norm(actorEmail); const lease = clampLease(leaseMinutes);
  const { orgDocuments } = await getOrgCollections();
  const _id = toObjectId(documentId); const orgObj = toObjectId(orgId);
  const now = nowIso(); const expiresAt = new Date(Date.now() + lease * 60_000).toISOString();
  const lock = { byEmail: me, at: now, expiresAt, reason: reason ? String(reason).replace(/[\u0000-\u001f<>]/g, "").slice(0, 200) : null };
  const prev = await orgDocuments.findOne({ _id, orgId: orgObj, deletedAt: null }, { projection: { lock: 1 } });
  if (!prev) fail(404, "Document not found.");
  const won = await orgDocuments.findOneAndUpdate(
    { _id, orgId: orgObj, deletedAt: null, $or: [{ lock: { $exists: false } }, { lock: null }, { "lock.expiresAt": { $lte: now } }, { "lock.byEmail": me }] },
    { $set: { lock } }, { returnDocument: "after" });
  if (!won) {
    const cur = await orgDocuments.findOne({ _id, orgId: orgObj }, { projection: { lock: 1 } });
    const l = activeLock(cur);
    fail(423, `This file is locked by ${l?.byEmail || "someone else"} until ${l?.expiresAt || "later"}.`, { lockedBy: l?.byEmail || null, expiresAt: l?.expiresAt || null });
  }
  const renewed = activeLock(prev) && norm(activeLock(prev).byEmail) === me;
  await logOrgActivity({ orgId, recordType: "FILE_LOCK", recordId: _id, actorEmail: me, action: renewed ? "RENEWED" : "LOCKED", previousState: null, newState: null, metadata: { expiresAt, leaseMinutes: lease } });
  return view(won);
}

/** Release. The holder always can; `force` (an organization owner/admin, or someone with MANAGE on the document, decided by the caller) can break
 *  someone else's lock, and that is recorded as its own event. */
export async function releaseLock({ orgId, documentId, actorEmail, membership, force = false, canForce = false }) {
  const me = norm(actorEmail);
  const { orgDocuments } = await getOrgCollections();
  const _id = toObjectId(documentId); const orgObj = toObjectId(orgId);
  const cur = await orgDocuments.findOne({ _id, orgId: orgObj, deletedAt: null }, { projection: { lock: 1 } });
  if (!cur) fail(404, "Document not found.");
  const l = activeLock(cur);
  if (!l) { if (cur.lock) await orgDocuments.updateOne({ _id, "lock.expiresAt": cur.lock.expiresAt }, { $unset: { lock: "" } }); return { locked: false, released: false }; }
  const mine = norm(l.byEmail) === me;
  if (!mine) {
    if (!force) fail(403, `This file is locked by ${l.byEmail}. Only they, or an administrator, can unlock it.`, { lockedBy: l.byEmail });
    if (!(canForce || canManageOrg(membership))) fail(403, "Only an organization owner or admin, or someone with Manage access to the document, can break another person's lock.");
  }
  const r = await orgDocuments.findOneAndUpdate({ _id, orgId: orgObj, "lock.byEmail": l.byEmail, "lock.at": l.at }, { $unset: { lock: "" } }, { returnDocument: "after" });
  if (r) await logOrgActivity({ orgId, recordType: "FILE_LOCK", recordId: _id, actorEmail: me, action: mine ? "UNLOCKED" : "FORCE_RELEASED", previousState: { byEmail: l.byEmail }, newState: null, metadata: { heldBy: l.byEmail } });
  return { locked: false, released: !!r, forced: !mine };
}

export async function getLockInfo({ orgId, documentId }) {
  const { orgDocuments } = await getOrgCollections();
  const doc = await orgDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId), deletedAt: null }, { projection: { lock: 1, filename: 1 } });
  if (!doc) fail(404, "Document not found.");
  return view(doc);
}

/** scope "mine": locks I hold. scope "org" (owner/admin): every lock in force. Bounded and newest first. */
export async function listLocks({ orgId, actorEmail, membership, scope = "mine", limit = 100 }) {
  const { orgDocuments } = await getOrgCollections();
  const now = nowIso();
  const q = { orgId: toObjectId(orgId), deletedAt: null, "lock.expiresAt": { $gt: now } };
  if (scope === "org") { if (!canManageOrg(membership)) fail(403, "Only the owner or an admin can see every lock."); }
  else q["lock.byEmail"] = norm(actorEmail);
  const rows = await orgDocuments.find(q).project({ filename: 1, lock: 1 }).sort({ "lock.at": -1 }).limit(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200)).toArray();
  return { locks: rows.map((d) => ({ documentId: String(d._id), filename: d.filename, ...view(d) })) };
}

/** Tidy: clear lock fields whose lease has ended (correctness never depends on this running). Bounded per call. */
export async function sweepStaleLocks({ limit = 500 } = {}) {
  const { orgDocuments } = await getOrgCollections();
  const stale = await orgDocuments.find({ "lock.expiresAt": { $lte: nowIso() } }).project({ _id: 1, "lock.expiresAt": 1 }).limit(limit).toArray();
  let cleared = 0;
  for (const d of stale) { const r = await orgDocuments.updateOne({ _id: d._id, "lock.expiresAt": d.lock.expiresAt }, { $unset: { lock: "" } }); cleared += r.modifiedCount; }
  return { cleared, scanned: stale.length };
}
