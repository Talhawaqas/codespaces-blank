// src/lib/filePrefs.js
//
// File management UX (Competitive Expansion SOW §38, UX-001): per-person favorites, pins, tags and "recent" for documents. These are PERSONAL organization
// aids stored per (organization, person, document); they grant nothing and nobody else sees them. Every write requires at least view access to the document.
// Tags are plain labels (letters, digits, space, - _ .), up to 10 per document and 40 characters each.
// Collection: file_prefs.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { requireDocumentAccess } from "./document-permissions.js";

export class PrefsError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new PrefsError(status, message); };
const lower = (v) => String(v ?? "").trim().toLowerCase();
const TAG = /^[\p{L}\p{N} _.\-]{1,40}$/u;
let indexed = false;
async function col() { const c = await getOrgCollections(); const p = c.db.collection("file_prefs"); if (!indexed) { await Promise.all([p.createIndex({ orgId: 1, email: 1, documentId: 1 }, { unique: true }), p.createIndex({ orgId: 1, email: 1, recentAt: -1 })]); indexed = true; } return p; }

export async function setPrefs({ orgId, email, membership, documentId, favorite, pinned, addTag, removeTag, touch }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "VIEW" }); if (access.error) fail(access.status, access.error);
  const p = await col(); const key = { orgId: toObjectId(orgId), email: lower(email), documentId: access.doc._id }; const set = {}; const ops = {};
  if (favorite !== undefined) set.favorite = !!favorite; if (pinned !== undefined) set.pinned = !!pinned; if (touch) set.recentAt = new Date().toISOString();
  if (addTag !== undefined) { const t = String(addTag).trim(); if (!TAG.test(t)) fail(400, "A tag is 1 to 40 letters, digits, spaces, - _ or ."); const cur = await p.findOne(key); if ((cur?.tags || []).length >= 10 && !(cur.tags || []).includes(t)) fail(409, "A document can have at most 10 tags."); ops.$addToSet = { tags: t }; }
  if (removeTag !== undefined) ops.$pull = { tags: String(removeTag) };
  if (!Object.keys(set).length && !ops.$addToSet && !ops.$pull) return await getPrefsFor({ orgId, email, documentId: String(access.doc._id) });
  await p.updateOne(key, { ...(Object.keys(set).length ? { $set: set } : {}), ...ops, $setOnInsert: { createdAt: new Date().toISOString() } }, { upsert: true });
  // an empty record is not kept around
  await p.deleteOne({ ...key, favorite: { $ne: true }, pinned: { $ne: true }, tags: { $in: [null, []] }, recentAt: { $exists: false } }).catch(() => {});
  return getPrefsFor({ orgId, email, documentId: String(access.doc._id) });
}
async function getPrefsFor({ orgId, email, documentId }) { const p = await col(); const r = await p.findOne({ orgId: toObjectId(orgId), email: lower(email), documentId: toObjectId(documentId) }); return { favorite: !!r?.favorite, pinned: !!r?.pinned, tags: r?.tags || [], recentAt: r?.recentAt || null }; }
/** One query for a whole list: documentId -> prefs, for the caller only. */
export async function prefsForDocs({ orgId, email, documentIds }) {
  if (!documentIds.length) return new Map(); const p = await col();
  const rows = await p.find({ orgId: toObjectId(orgId), email: lower(email), documentId: { $in: documentIds.map(toObjectId) } }).toArray();
  return new Map(rows.map((r) => [String(r.documentId), { favorite: !!r.favorite, pinned: !!r.pinned, tags: r.tags || [], recentAt: r.recentAt || null }]));
}
export async function listTags({ orgId, email }) { const p = await col(); return { tags: (await p.distinct("tags", { orgId: toObjectId(orgId), email: lower(email) })).filter(Boolean).sort() }; }
