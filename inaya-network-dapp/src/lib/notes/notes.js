// src/lib/notes/notes.js
//
// Secure Notes (Competitive Expansion SOW workstream C, NOTE-001..007). The server stores CIPHERTEXT ONLY and never holds a note key.
//
//   vault     per user: a random vault key (VK) wrapped by the user's passphrase (PBKDF2) in the browser; an ECDH P-256 key pair whose private
//             half is encrypted under VK; and an encrypted "index" (pins, favorites, tags, archive, key pins) under VK. A new browser unlocks
//             everything with the passphrase. Inaya cannot recover a forgotten passphrase.
//   note      a random 256-bit note key per key version, sealed to each participant's public key (note_keys). Every revision is a full
//             snapshot encrypted under the note key with AAD = noteId:rev:keyVersion, so the server cannot move a revision to another position.
//   conflicts a save carries baseRev; if the note moved on, nothing is overwritten: 409 CONFLICT with the newer revision, and the client asks.
//   removal   removing a participant rotates the note key in the same transaction (new key sealed to the remaining people, next revision under
//             it). Honest limit: someone who already read or copied content keeps it.
// What the server can see (metadata): who participates, sizes, timestamps, revision counts. Titles, bodies, types and tags are inside ciphertext.
// Collections: note_vaults, notes, note_keys, note_revisions.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { slidingWindowCheck } from "../rateLimit.js";
import { createNotification } from "../notifications.js";
import { logOrgActivity } from "../org-activity-log.js";
import { isValidPublicKeyJwk } from "../filerequests/clientCrypto.js";
import { withTxn } from "../chat/conversations.js";

export class NoteError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new NoteError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const norm = (e) => String(e || "").trim().toLowerCase();

export const LIMITS = { revisionB64Max: 90_000, indexB64Max: 400_000, envelopeMax: 2048, maxParticipants: 25, maxRevisions: 200, listPage: 30, savesPerMinute: 120, trashDays: 30, vaultFieldMax: 8192 };
export const PERMS = ["read", "write"];
const ID = /^[0-9a-f]{24}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isB64 = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max && B64.test(s);

let indexed = false;
async function cols() {
  const c = await getOrgCollections();
  const vaults = c.db.collection("note_vaults"); const notes = c.db.collection("notes"); const keys = c.db.collection("note_keys"); const revs = c.db.collection("note_revisions");
  if (!indexed) {
    await Promise.all([
      vaults.createIndex({ orgId: 1, email: 1 }, { unique: true }),
      notes.createIndex({ orgId: 1, "participants.email": 1, state: 1, updatedAt: -1 }), notes.createIndex({ state: 1, trashedAt: 1 }),
      keys.createIndex({ noteId: 1, email: 1, keyVersion: 1 }, { unique: true }),
      revs.createIndex({ noteId: 1, rev: 1 }, { unique: true }),
    ]);
    indexed = true;
  }
  return { c, vaults, notes, keys, revs };
}
const audit = (orgId, noteId, actorEmail, action, metadata = {}) =>
  logOrgActivity({ orgId, recordType: "NOTE", recordId: noteId, actorEmail, action, previousState: null, newState: null, metadata }).catch(() => {});

// ------------------------------------------------------------------------------------------------------ validation
function checkBlob(b, name, max = LIMITS.vaultFieldMax) {
  if (!b || !isB64(b.iv, 24) || !isB64(b.ct, max)) fail(400, `${name} is not valid.`);
  return { iv: b.iv, ct: b.ct };
}
function checkEnvelope(env) {
  const s = JSON.stringify(env ?? null);
  if (!env || env.v !== 1 || !env.epk || !isValidPublicKeyJwk(env.epk) || !isB64(env.iv, 24) || !isB64(env.sealed, 200) || s.length > LIMITS.envelopeMax) fail(400, "The sealed key is not valid.");
  return { v: 1, epk: { kty: env.epk.kty, crv: env.epk.crv, x: env.epk.x, y: env.epk.y }, iv: env.iv, sealed: env.sealed };
}
const checkVaultShape = (v) => {
  if (!v || !isValidPublicKeyJwk(v.publicKeyJwk) || !v.kdf || !isB64(v.kdf.salt, 44) || !(Number.isInteger(v.kdf.iter) && v.kdf.iter >= 210_000 && v.kdf.iter <= 2_000_000)) fail(400, "The vault is not valid.");
  return {
    publicKeyJwk: { kty: "EC", crv: "P-256", x: v.publicKeyJwk.x, y: v.publicKeyJwk.y },
    kdf: { salt: v.kdf.salt, iter: v.kdf.iter },
    wrappedVk: checkBlob(v.wrappedVk, "wrappedVk"), encPrivateKey: checkBlob(v.encPrivateKey, "encPrivateKey"),
  };
};

// ------------------------------------------------------------------------------------------------------------ vault
export async function getVault({ orgId, email }) {
  const { vaults } = await cols();
  const v = await vaults.findOne({ orgId: String(orgId), email: norm(email) });
  if (!v) return null;
  return { publicKeyJwk: v.publicKeyJwk, kdf: v.kdf, wrappedVk: v.wrappedVk, encPrivateKey: v.encPrivateKey, vaultRev: v.vaultRev, index: v.index ? { version: v.index.version, iv: v.index.iv, ct: v.index.ct } : { version: 0 } };
}

export async function createVault({ orgId, email, vault }) {
  const { vaults } = await cols();
  const v = checkVaultShape(vault);
  try { await vaults.insertOne({ orgId: String(orgId), email: norm(email), ...v, vaultRev: 1, index: { version: 0 }, createdAt: nowIso() }); }
  catch (e) { if (e?.code === 11000) fail(409, "You already have a notes vault."); throw e; }
  return { vaultRev: 1 };
}

/** Change the passphrase: only the wrapped vault key and KDF parameters may change; the key pair and private key blob must stay identical. */
export async function rewrapVault({ orgId, email, vault, expectedRev }) {
  const { vaults } = await cols();
  const v = checkVaultShape(vault);
  const cur = await vaults.findOne({ orgId: String(orgId), email: norm(email) });
  if (!cur) fail(404, "No vault.");
  if (cur.publicKeyJwk.x !== v.publicKeyJwk.x || cur.publicKeyJwk.y !== v.publicKeyJwk.y || cur.encPrivateKey.ct !== v.encPrivateKey.ct) fail(400, "Only the passphrase wrapping can change.");
  const r = await vaults.updateOne({ orgId: String(orgId), email: norm(email), vaultRev: Number(expectedRev) }, { $set: { kdf: v.kdf, wrappedVk: v.wrappedVk, updatedAt: nowIso() }, $inc: { vaultRev: 1 } });
  if (!r.matchedCount) fail(409, "The vault changed. Reload and try again.");
  return { vaultRev: Number(expectedRev) + 1 };
}

export async function putIndex({ orgId, email, expectedVersion, iv, ct }) {
  const { vaults } = await cols();
  const blob = checkBlob({ iv, ct }, "index", LIMITS.indexB64Max);
  const v = Number(expectedVersion) || 0;
  const r = await vaults.updateOne({ orgId: String(orgId), email: norm(email), "index.version": v }, { $set: { index: { version: v + 1, ...blob, updatedAt: nowIso() } } });
  if (!r.matchedCount) fail(409, "Your notes index changed on another device. Reload and try again.", { code: "INDEX_CONFLICT" });
  return { version: v + 1 };
}

/** Active members who have a vault: the only people a note can be shared with (their public key is needed to seal the note key). */
export async function listPeople({ orgId, email }) {
  const { c, vaults } = await cols();
  const members = await c.orgMembers.find({ orgId: toObjectId(orgId), status: "active" }, { projection: { email: 1 } }).toArray();
  const emails = members.map((m) => norm(m.email)).filter((e) => e !== norm(email));
  const rows = await vaults.find({ orgId: String(orgId), email: { $in: emails } }, { projection: { email: 1, publicKeyJwk: 1 } }).toArray();
  return { people: rows.map((r) => ({ email: r.email, publicKeyJwk: r.publicKeyJwk })), withoutVault: emails.length - rows.length };
}

// ------------------------------------------------------------------------------------------------------------ notes
const meta = (n, me) => ({
  noteId: String(n._id), ownerEmail: n.ownerEmail, state: n.state, rev: n.rev, keyVersion: n.keyVersion, createdAt: n.createdAt, updatedAt: n.updatedAt, trashedAt: n.trashedAt || null,
  lastEditedBy: n.lastEditedBy, size: n.size || 0, rotationDue: !!n.rotationDue,
  perm: n.ownerEmail === me ? "owner" : (n.participants.find((p) => p.email === me)?.perm || "read"),
  participants: n.participants.map((p) => ({ email: p.email, perm: p.perm })),
});
const revOut = (r) => r && ({ rev: r.rev, keyVersion: r.keyVersion, by: r.byEmail, at: r.at, iv: r.iv, ct: r.ct });

async function load({ orgId, email, noteId, needOwner = false, needWrite = false, allowTrashed = false }) {
  const { notes } = await cols();
  if (!ID.test(String(noteId))) fail(404, "Note not found.");
  const n = await notes.findOne({ _id: new ObjectId(noteId), orgId: String(orgId) });
  const me = norm(email); const p = n?.participants.find((x) => x.email === me);
  if (!n || !p || (n.state === "trashed" && !(allowTrashed && n.ownerEmail === me))) fail(404, "Note not found.");
  if (n.state === "deleted") fail(404, "Note not found.");
  if (needOwner && n.ownerEmail !== me) fail(403, "Only the owner can do that.");
  if (needWrite && !(n.ownerEmail === me || p.perm === "write")) fail(403, "You have read-only access to this note.");
  return { n, me };
}

export async function createNote({ orgId, email, noteId, keyEnvelope, revision }) {
  const { notes, keys, revs, vaults } = await cols();
  if (!ID.test(String(noteId))) fail(400, "noteId must be 24 hex characters.");
  const me = norm(email);
  if (!(await vaults.findOne({ orgId: String(orgId), email: me }, { projection: { _id: 1 } }))) fail(409, "Set up your notes vault first.", { code: "NO_VAULT" });
  const env = checkEnvelope(keyEnvelope); const blob = checkBlob(revision, "revision", LIMITS.revisionB64Max);
  const _id = new ObjectId(noteId); const at = nowIso();
  try {
    await withTxn(async (session) => {
      await notes.insertOne({ _id, orgId: String(orgId), ownerEmail: me, state: "active", rev: 1, keyVersion: 1, participants: [{ email: me, perm: "owner", addedAt: at }], createdAt: at, updatedAt: at, lastEditedBy: me, size: blob.ct.length, rotationDue: false }, { session });
      await keys.insertOne({ noteId: noteId, email: me, keyVersion: 1, envelope: env }, { session });
      await revs.insertOne({ noteId, rev: 1, keyVersion: 1, byEmail: me, at, ...blob }, { session });
    });
  } catch (e) { if (e?.code === 11000) fail(409, "That note already exists."); throw e; }
  await audit(orgId, _id, me, "CREATED");
  return { noteId, rev: 1, keyVersion: 1 };
}

export async function listNotes({ orgId, email, state = "active", before, limit = LIMITS.listPage }) {
  const { notes, keys, revs } = await cols();
  const me = norm(email); const lim = Math.min(Math.max(Number(limit) || LIMITS.listPage, 1), LIMITS.listPage);
  const q = { orgId: String(orgId), "participants.email": me, state: state === "trashed" ? "trashed" : "active" };
  if (state === "trashed") q.ownerEmail = me;
  if (before) q.updatedAt = { $lt: String(before) };
  const rows = await notes.find(q).sort({ updatedAt: -1 }).limit(lim + 1).toArray();
  const page = rows.slice(0, lim); const ids = page.map((n) => String(n._id));
  const [ks, rv] = await Promise.all([
    keys.find({ noteId: { $in: ids }, email: me }).toArray(),
    Promise.all(page.map((n) => revs.findOne({ noteId: String(n._id), rev: n.rev }))),
  ]);
  const keyBy = {}; for (const k of ks) (keyBy[k.noteId] ||= {})[k.keyVersion] = k.envelope;
  return { notes: page.map((n, i) => ({ ...meta(n, me), keys: keyBy[String(n._id)] || {}, latest: revOut(rv[i]) })), nextBefore: rows.length > lim ? page[page.length - 1].updatedAt : null };
}

export async function getNote({ orgId, email, noteId }) {
  const { keys, revs } = await cols();
  const { n, me } = await load({ orgId, email, noteId, allowTrashed: true });
  const ks = await keys.find({ noteId: String(noteId), email: me }).toArray(); const keyBy = {}; for (const k of ks) keyBy[k.keyVersion] = k.envelope;
  return { ...meta(n, me), keys: keyBy, latest: revOut(await revs.findOne({ noteId: String(noteId), rev: n.rev })) };
}

export async function saveRevision({ orgId, email, noteId, baseRev, keyVersion, iv, ct }) {
  const { notes, revs } = await cols();
  const { n, me } = await load({ orgId, email, noteId, needWrite: true });
  const blob = checkBlob({ iv, ct }, "revision", LIMITS.revisionB64Max);
  const rl = await slidingWindowCheck({ action: "notes:save", key: `${orgId}:${me}`, max: LIMITS.savesPerMinute, windowMs: 60_000 });
  if (!rl.allowed) fail(429, "You are saving too quickly. Wait a moment.");
  if (Number(keyVersion) !== n.keyVersion) fail(409, "This note's key was rotated. Reload it.", { code: "KEY_ROTATED", keyVersion: n.keyVersion });
  const base = Number(baseRev); const at = nowIso();
  const upd = await notes.findOneAndUpdate({ _id: n._id, state: "active", rev: base, keyVersion: n.keyVersion }, { $inc: { rev: 1 }, $set: { updatedAt: at, lastEditedBy: me, size: blob.ct.length } }, { returnDocument: "after" });
  const cur = upd?.value ?? upd; // driver 5/6 return shapes differ
  if (!cur || cur.rev !== base + 1) {
    const fresh = await notes.findOne({ _id: n._id });
    fail(409, "Someone saved a newer version first. Nothing was overwritten.", { code: "CONFLICT", currentRev: fresh.rev, latest: revOut(await revs.findOne({ noteId: String(noteId), rev: fresh.rev })) });
  }
  try { await revs.insertOne({ noteId: String(noteId), rev: cur.rev, keyVersion: cur.keyVersion, byEmail: me, at, ...blob }); }
  catch (e) { await notes.updateOne({ _id: n._id, rev: cur.rev }, { $set: { rev: base } }); throw e; }
  await revs.deleteMany({ noteId: String(noteId), rev: { $lte: cur.rev - LIMITS.maxRevisions } }).catch(() => {});
  return { rev: cur.rev, at };
}

export async function listRevisions({ orgId, email, noteId, before, limit = 50 }) {
  const { revs } = await cols();
  const { n } = await load({ orgId, email, noteId });
  const q = { noteId: String(noteId) }; if (before) q.rev = { $lt: Number(before) };
  const rows = await revs.find(q, { projection: { iv: 0, ct: 0 } }).sort({ rev: -1 }).limit(Math.min(Number(limit) || 50, 100)).toArray();
  return { current: n.rev, revisions: rows.map((r) => ({ rev: r.rev, keyVersion: r.keyVersion, by: r.byEmail, at: r.at })) };
}
export async function getRevision({ orgId, email, noteId, rev }) {
  const { revs } = await cols();
  await load({ orgId, email, noteId });
  const r = await revs.findOne({ noteId: String(noteId), rev: Number(rev) });
  if (!r) fail(404, "That version no longer exists.");
  return revOut(r);
}

// --------------------------------------------------------------------------------------------------------- sharing
export async function shareNote({ orgId, email, noteId, targetEmail, perm = "read", keys: keyMap }) {
  const { c, notes, keys, vaults } = await cols();
  const { n, me } = await load({ orgId, email, noteId, needOwner: true });
  const target = norm(targetEmail);
  if (!PERMS.includes(perm)) fail(400, "Permission must be read or write.");
  if (target === me) fail(400, "You already own this note.");
  if (n.participants.length >= LIMITS.maxParticipants) fail(409, `A note can have at most ${LIMITS.maxParticipants} people.`);
  if (n.participants.some((p) => p.email === target)) fail(409, "That person already has access.");
  if (!(await c.orgMembers.findOne({ orgId: toObjectId(orgId), email: target, status: "active" }, { projection: { _id: 1 } }))) fail(404, "That person is not an active member of this organization.");
  if (!(await vaults.findOne({ orgId: String(orgId), email: target }, { projection: { _id: 1 } }))) fail(409, "That person has not set up Secure Notes yet.", { code: "NO_VAULT" });
  const versions = Object.keys(keyMap || {}).map(Number);
  if (!versions.includes(n.keyVersion) || versions.some((v) => !Number.isInteger(v) || v < 1 || v > n.keyVersion)) fail(400, "Keys must cover the current key version.");
  const docs = versions.map((v) => ({ noteId: String(noteId), email: target, keyVersion: v, envelope: checkEnvelope(keyMap[v]) }));
  await withTxn(async (session) => {
    const r = await notes.updateOne({ _id: n._id, state: "active", "participants.email": { $ne: target }, "participants.24": { $exists: false } }, { $push: { participants: { email: target, perm, addedAt: nowIso(), addedBy: me } }, $set: { updatedAt: nowIso() } }, { session });
    if (!r.matchedCount) fail(409, "The note changed. Try again.");
    await keys.insertMany(docs, { session });
  });
  await audit(orgId, n._id, me, "SHARED", { target, perm });
  try { await createNotification({ scope: "org", orgId, targetEmail: target, category: "collaboration", type: "note.shared", title: "A note was shared with you", body: `${me} shared a secure note with you.`, sourceModule: "notes", sourceId: String(noteId), actionUrl: `/business?view=notes&note=${noteId}`, metadata: {}, dedupeKey: `note-share:${noteId}:${target}` }); } catch { /* best effort */ }
  return { ok: true };
}

export async function setPermission({ orgId, email, noteId, targetEmail, perm }) {
  const { notes } = await cols();
  const { n, me } = await load({ orgId, email, noteId, needOwner: true });
  if (!PERMS.includes(perm)) fail(400, "Permission must be read or write.");
  const t = norm(targetEmail);
  const r = await notes.updateOne({ _id: n._id, participants: { $elemMatch: { email: t, perm: { $ne: "owner" } } } }, { $set: { "participants.$.perm": perm } });
  if (!r.matchedCount) fail(404, "That person is not a participant.");
  await audit(orgId, n._id, me, "PERMISSION_CHANGED", { target: t, perm });
  return { ok: true };
}

/** Owner removes someone, or rotates the key after a leave. `rotation` = { baseRev, keys: {email: envelope for EVERY remaining participant}, iv, ct }
 *  where ct is the next revision encrypted under the NEW key (keyVersion + 1). Everything happens in one transaction. */
export async function rotateNoteKey({ orgId, email, noteId, removeEmail, rotation }) {
  const { notes, keys, revs } = await cols();
  const { n, me } = await load({ orgId, email, noteId, needOwner: true });
  const rm = removeEmail ? norm(removeEmail) : null;
  if (rm && (rm === me || !n.participants.some((p) => p.email === rm))) fail(404, "That person is not a participant.");
  const remaining = n.participants.filter((p) => p.email !== rm).map((p) => p.email);
  const given = Object.keys(rotation?.keys || {}).map(norm);
  if (given.length !== remaining.length || remaining.some((e) => !given.includes(e))) fail(400, "A new sealed key is needed for every remaining person, and only for them.");
  const blob = checkBlob(rotation, "revision", LIMITS.revisionB64Max);
  const nextVersion = n.keyVersion + 1; const at = nowIso(); const base = Number(rotation.baseRev);
  const keyDocs = remaining.map((e) => ({ noteId: String(noteId), email: e, keyVersion: nextVersion, envelope: checkEnvelope(rotation.keys[e]) }));
  await withTxn(async (session) => {
    const r = await notes.updateOne({ _id: n._id, state: "active", rev: base, keyVersion: n.keyVersion }, { $inc: { rev: 1 }, $set: { keyVersion: nextVersion, updatedAt: at, lastEditedBy: me, size: blob.ct.length, rotationDue: false }, ...(rm ? { $pull: { participants: { email: rm } } } : {}) }, { session });
    if (!r.matchedCount) fail(409, "Someone saved a newer version first. Reload and try again.", { code: "CONFLICT" });
    await keys.insertMany(keyDocs, { session });
    if (rm) await keys.deleteMany({ noteId: String(noteId), email: rm }, { session });
    await revs.insertOne({ noteId: String(noteId), rev: base + 1, keyVersion: nextVersion, byEmail: me, at, iv: blob.iv, ct: blob.ct }, { session });
  });
  await audit(orgId, n._id, me, rm ? "UNSHARED" : "KEY_ROTATED", rm ? { target: rm, keyVersion: nextVersion } : { keyVersion: nextVersion });
  return { rev: base + 1, keyVersion: nextVersion };
}

/** A participant leaves. The owner's browser will rotate the key next time it opens the note (rotationDue). */
export async function leaveNote({ orgId, email, noteId }) {
  const { notes, keys } = await cols();
  const { n, me } = await load({ orgId, email, noteId });
  if (n.ownerEmail === me) fail(400, "The owner cannot leave. Delete the note instead.");
  await withTxn(async (session) => {
    await notes.updateOne({ _id: n._id }, { $pull: { participants: { email: me } }, $set: { rotationDue: true, updatedAt: nowIso() } }, { session });
    await keys.deleteMany({ noteId: String(noteId), email: me }, { session });
  });
  await audit(orgId, n._id, me, "LEFT");
  return { ok: true };
}

// --------------------------------------------------------------------------------------------------------- lifecycle
export async function trashNote({ orgId, email, noteId }) {
  const { notes } = await cols(); const { n, me } = await load({ orgId, email, noteId, needOwner: true });
  await notes.updateOne({ _id: n._id, state: "active" }, { $set: { state: "trashed", trashedAt: nowIso() } });
  await audit(orgId, n._id, me, "TRASHED"); return { ok: true };
}
export async function restoreNote({ orgId, email, noteId }) {
  const { notes } = await cols(); const { n, me } = await load({ orgId, email, noteId, needOwner: true, allowTrashed: true });
  await notes.updateOne({ _id: n._id, state: "trashed" }, { $set: { state: "active", updatedAt: nowIso() }, $unset: { trashedAt: "" } });
  await audit(orgId, n._id, me, "RESTORED"); return { ok: true };
}
async function destroy(n) {
  const { notes, keys, revs } = await cols();
  await withTxn(async (session) => {
    await revs.deleteMany({ noteId: String(n._id) }, { session }); await keys.deleteMany({ noteId: String(n._id) }, { session }); await notes.deleteOne({ _id: n._id }, { session });
  });
}
/** Permanent delete: owner only, and only from the trash. Removes every revision and key. The audit entry (metadata only) remains. */
export async function deleteNotePermanently({ orgId, email, noteId }) {
  const { n, me } = await load({ orgId, email, noteId, needOwner: true, allowTrashed: true });
  if (n.state !== "trashed") fail(409, "Move the note to the trash first.");
  await destroy(n); await audit(orgId, n._id, me, "DELETED"); return { ok: true };
}
/** Cron/maintenance: permanently remove notes that have sat in the trash longer than the retention period. */
export async function purgeTrashedNotes({ olderThanDays = LIMITS.trashDays, now = Date.now() } = {}) {
  const { notes } = await cols();
  const cutoff = new Date(now - olderThanDays * 86400_000).toISOString();
  const old = await notes.find({ state: "trashed", trashedAt: { $lt: cutoff } }).limit(200).toArray();
  for (const n of old) { await destroy(n); await audit(n.orgId, n._id, "system", "PURGED", { reason: "trash retention" }); }
  return { purged: old.length };
}
