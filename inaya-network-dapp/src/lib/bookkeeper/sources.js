// src/lib/bookkeeper/sources.js
//
// AI Bookkeeper SOW sections 6, 7.4, 9, 10, 49, 51: financial sources (bank account, email inbox relay, WhatsApp, upload, API). A source
// belongs to ONE organization and ONE department; secrets (ingest signing secret, WhatsApp app secret and access token) are encrypted at
// rest, shown at most once, and never returned by any view, audit entry, evidence link or notification.

import { toObjectId } from "../orgs.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { getBookkeeperCollections, ensureBookkeeperIndexes } from "./db.js";
import { fail, nowIso, newToken, SOURCE_TYPES, SUPPORTED_CURRENCIES } from "./common.js";
import { audit } from "./record.js";

const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };
const HEX24 = /^[0-9a-f]{24}$/i;

export const sourceView = (s) => ({
  sourceId: String(s._id), type: s.type, name: s.name, provider: s.provider || null, status: s.status, departmentId: String(s.departmentId), currency: s.currency || null,
  accountLabel: s.accountLabel || null, lastSyncAt: s.lastSyncAt || null, lastSyncStatus: s.lastSyncStatus || null, lastSyncError: s.lastSyncError || null,
  allowedSenders: s.allowedSenders || [], phoneNumberId: s.phoneNumberId || null, createdAt: s.createdAt, createdBy: s.createdBy,
  secretsConfigured: { ingest: !!s.ingestSecretEncrypted, appSecret: !!s.appSecretEncrypted, accessToken: !!s.accessTokenEncrypted, verifyToken: !!s.verifyTokenEncrypted },
  verification: s.type === "WHATSAPP" ? "UNVERIFIED against a live WhatsApp Business account" : s.type === "EMAIL_INBOX" ? "signed relay; UNVERIFIED against a live mail provider" : s.type === "BANK_ACCOUNT" ? (s.provider && s.provider !== "file" ? "provider adapter UNVERIFIED" : "CSV/OFX import") : null,
});

export async function createSource({ orgId, type, name, departmentId, currency = null, provider = null, accountLabel = null, allowedSenders = [], phoneNumberId = null, appSecret = null, accessToken = null, actor }) {
  if (!SOURCE_TYPES.includes(type)) return fail(`type must be one of ${SOURCE_TYPES.join(", ")}.`);
  const nm = String(name || "").trim().slice(0, 80); if (nm.length < 2) return fail("A name is required.");
  if (!departmentId || !HEX24.test(String(departmentId))) return fail("departmentId is required.");
  if (currency && !/^[A-Z]{3}$/.test(String(currency).toUpperCase())) return fail("currency must be a 3-letter code.");
  if (type === "BANK_ACCOUNT" && !currency) return fail("A bank account needs its currency.");
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);
  await ensureBookkeeperIndexes();
  const { bkSources, departments } = await getBookkeeperCollections();
  const oid = toObjectId(orgId);
  if (!(await departments.findOne({ _id: toObjectId(departmentId), orgId: oid }))) return fail("Department not found.", 404);
  if ((await bkSources.countDocuments({ orgId: oid, status: "ACTIVE" })) >= 50) return fail("At most 50 active sources per organization.");
  const doc = { orgId: oid, type, name: nm, departmentId: toObjectId(departmentId), provider: provider ? String(provider).slice(0, 40) : (type === "BANK_ACCOUNT" ? "file" : null), currency: currency ? String(currency).toUpperCase() : null, accountLabel: accountLabel ? String(accountLabel).slice(0, 60) : null, status: "ACTIVE", createdAt: nowIso(), createdBy: actor, lastSyncAt: null };
  const secrets = {};
  if (type === "EMAIL_INBOX" || type === "API") { secrets.ingest = `bks_${newToken(24)}`; doc.ingestSecretEncrypted = encryptIntegrationSecret(secrets.ingest); }
  if (type === "WHATSAPP") {
    if (!appSecret || !accessToken || !phoneNumberId) return fail("WhatsApp needs phoneNumberId, appSecret and accessToken (from your WhatsApp Business account).");
    doc.phoneNumberId = String(phoneNumberId).slice(0, 40);
    doc.appSecretEncrypted = encryptIntegrationSecret(String(appSecret)); doc.accessTokenEncrypted = encryptIntegrationSecret(String(accessToken));
    secrets.verifyToken = `bkv_${newToken(18)}`; doc.verifyTokenEncrypted = encryptIntegrationSecret(secrets.verifyToken);
    doc.allowedSenders = (Array.isArray(allowedSenders) ? allowedSenders : []).map((p) => String(p).replace(/[^\d]/g, "")).filter((p) => p.length >= 6 && p.length <= 16).slice(0, 50);
  }
  if (type === "EMAIL_INBOX") doc.allowedSenders = (Array.isArray(allowedSenders) ? allowedSenders : []).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)).slice(0, 50);
  doc._id = (await bkSources.insertOne(doc)).insertedId;
  await audit({ orgId, recordId: doc._id, action: "BOOKKEEPER_SOURCE_CREATED", actorEmail: actor, metadata: { sourceId: String(doc._id), type, provider: doc.provider } });
  return { source: sourceView(doc), ...(Object.keys(secrets).length ? { secrets, note: "Save these now: they are shown once." } : {}) };
}

export async function listSources({ orgId }) {
  const { bkSources } = await getBookkeeperCollections();
  return { sources: (await bkSources.find({ orgId: toObjectId(orgId) }).sort({ createdAt: 1 }).limit(100).toArray()).map(sourceView) };
}

/** Internal lookup that always includes the org: a source id from another organization is simply "not found". */
export async function getSource({ orgId, sourceId }) {
  const id = oidOf(sourceId); if (!id) return null;
  const { bkSources } = await getBookkeeperCollections();
  return bkSources.findOne({ _id: id, orgId: toObjectId(orgId) });
}
/** Lookup by id only, for public webhooks that must first learn the organization from the source. */
export async function getSourceById(sourceId) {
  const id = oidOf(sourceId); if (!id) return null;
  const { bkSources } = await getBookkeeperCollections();
  return bkSources.findOne({ _id: id });
}

export async function disableSource({ orgId, sourceId, actor }) {
  const s = await getSource({ orgId, sourceId }); if (!s) return fail("Source not found.", 404);
  const { bkSources } = await getBookkeeperCollections();
  await bkSources.updateOne({ _id: s._id }, { $set: { status: "DISABLED", disabledAt: nowIso(), disabledBy: actor } });
  await audit({ orgId, recordId: s._id, action: "BOOKKEEPER_SOURCE_DISABLED", actorEmail: actor, metadata: { sourceId: String(s._id) } });
  return { disabled: true };
}

export async function rotateIngestSecret({ orgId, sourceId, actor }) {
  const s = await getSource({ orgId, sourceId }); if (!s || !s.ingestSecretEncrypted) return fail("Source not found or has no ingest secret.", 404);
  const secret = `bks_${newToken(24)}`; const { bkSources } = await getBookkeeperCollections();
  await bkSources.updateOne({ _id: s._id }, { $set: { ingestSecretEncrypted: encryptIntegrationSecret(secret), secretRotatedAt: nowIso() } });
  await audit({ orgId, recordId: s._id, action: "BOOKKEEPER_SECRET_ROTATED", actorEmail: actor, metadata: { sourceId: String(s._id) } });
  return { secret, note: "Shown once. The previous secret stopped working." };
}

export const secretOf = (enc) => { try { return enc ? decryptIntegrationSecret(enc) : null; } catch { return null; } };
export { SUPPORTED_CURRENCIES };
