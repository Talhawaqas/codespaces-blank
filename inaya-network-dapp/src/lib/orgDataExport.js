// src/lib/orgDataExport.js
//
// "Download all company data" (founder request, 16 Nov 2026): a ZIP of every record the company owns,
// one JSON file per collection, for owners/admins who decide not to continue before free accounts are
// removed on 1 January 2027. Scans every collection for documents with this orgId (records of every
// module and industry edition, without a hand-kept list), skips collections that hold credentials or
// sign-in state, and blanks secret-looking fields. Files are stored client-side encrypted, so the
// export lists them; the readable files are downloaded from the Documents page.

import { BSON } from "mongodb";
import { connectToDatabase } from "./mongodb.js";
import { toObjectId } from "./orgs.js";
import { zip } from "./bookkeeper/exportFormats.js";

const { EJSON } = BSON;

const SKIP_COLLECTION = /(^system\.|^_meta$|session|magic|token|secret|credential|api_?key|password|otp|nonce|webauthn|passkey|oauth|mfa|^rag_|embedding|integration_connections|gateway_nonces|share_email_codes|drm_sessions)/i;
const SECRET_FIELD = /^(.*(password|secret|token|apiKey|api_key|privateKey|private_key|tokenHash|keyHash|hashedKey|encryptedKey|wrappedKey|clientSecret|refreshToken|accessToken|otp|nonce).*)$/i;

function redact(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value._bsontype || value instanceof Date || Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELD.test(k) ? "[removed]" : redact(v, depth + 1);
  return out;
}

async function pool(items, size, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); } }));
  return results;
}

// Company license records (License Manager SOW 12.3 / 7.1): the company gets its payments and subscription periods,
// never Inaya's internal admin notes, reasons or admin names, nor the internal audit and notice rows.
const LICENSE_INTERNAL_FIELDS = ["notes", "overrideReason", "manualSuspensionReason", "needsReview", "createdBy", "updatedBy", "confirmedBy", "rejectedBy", "reversedBy", "adjustmentReason", "rejectReason", "reason", "note", "changeReason", "activatedBy", "previousLicense"];
const stripInternal = (d) => { const o = { ...d }; for (const f of LICENSE_INTERNAL_FIELDS) delete o[f]; return o; };
function sanitizeCollection(name, docs) {
  if (name === "org_subscriptions") return docs.map(stripInternal);
  if (name === "billing_requests") return docs.filter((d) => !["license_event", "license_notice"].includes(d.kind)).map(stripInternal);
  return docs;
}

/** Every record the company owns, as ZIP entries: records/<collection>.json plus company.json. */
export async function collectOrgRecordFiles(orgId) {
  const { db } = await connectToDatabase();
  const oid = toObjectId(orgId);
  const filter = { $or: [{ orgId: oid }, { orgId: String(orgId) }] };
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !SKIP_COLLECTION.test(n)).sort();
  const org = await db.collection("orgs").findOne({ _id: oid });
  const found = await pool(names, 16, async (name) => {
    const docs = await db.collection(name).find(filter).limit(50000).toArray().catch(() => []);
    const kept = sanitizeCollection(name, docs);
    return kept.length ? { name, docs: kept } : null;
  });
  const files = [{ name: "company.json", data: EJSON.stringify(redact(org || { _id: oid }), null, 2, { relaxed: true }) }];
  let records = 0;
  for (const f of found.filter(Boolean)) {
    records += f.docs.length;
    files.push({ name: `records/${f.name}.json`, data: EJSON.stringify(f.docs.map((d) => redact(d)), null, 2, { relaxed: true }) });
  }
  return { org, files, records, collections: files.length - 1 };
}

/** Builds the ZIP. Returns { buffer, filename, collections, records }. */
export async function buildOrgDataExport(orgId) {
  const { db } = await connectToDatabase();
  const oid = toObjectId(orgId);
  const filter = { $or: [{ orgId: oid }, { orgId: String(orgId) }] };
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !SKIP_COLLECTION.test(n)).sort();

  const org = await db.collection("orgs").findOne({ _id: oid });
  const found = await pool(names, 16, async (name) => {
    const docs = sanitizeCollection(name, await db.collection(name).find(filter).limit(50000).toArray().catch(() => []));
    return docs.length ? { name, docs } : null;
  });

  const files = [];
  let records = 0;
  for (const f of found.filter(Boolean)) {
    records += f.docs.length;
    files.push({ name: `records/${f.name}.json`, data: EJSON.stringify(f.docs.map((d) => redact(d)), null, 2, { relaxed: true }) });
  }
  const exportedAt = new Date().toISOString();
  files.unshift({ name: "company.json", data: EJSON.stringify(redact(org || { _id: oid }), null, 2, { relaxed: true }) });
  files.unshift({
    name: "README.txt",
    data: [
      `Inaya Business OS - company data export`,
      `Company: ${org?.name || orgId}`,
      `Exported: ${exportedAt}`,
      ``,
      `records/<name>.json holds every record of one kind (for example crm_contacts, invoices, employees, tasks).`,
      `Each file is standard JSON (MongoDB extended JSON for ids and dates) and opens in any text editor or spreadsheet tool that reads JSON.`,
      `Passwords, sign-in tokens, API keys and integration credentials are not included.`,
      ``,
      `Documents: files in the Documents module are encrypted on your own device before upload, so the server cannot read them.`,
      `Their names and details are listed in records/org_documents.json; download the files themselves from the Documents page while signed in.`,
      ``,
      `Questions: contact@inayanetwork.com`,
    ].join("\r\n"),
  });
  const safeName = String(org?.name || "company").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "company";
  return { buffer: zip(files), filename: `inaya-${safeName}-data-${exportedAt.slice(0, 10)}.zip`, collections: files.length - 2, records };
}
