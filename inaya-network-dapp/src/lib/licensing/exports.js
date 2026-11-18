// src/lib/licensing/exports.js -- company data export as a background job (License Manager SOW section 12).
//
// Available to Owners/Admins while active, in grace, after suspension and after cancellation (the license gate keeps
// /api/orgs/exports open). The job:
//   1. request  -> a `company_export` row (billing_requests, kind) in "queued"; one live job per company, a daily cap
//   2. build    -> ZIP = every company record (orgDataExport.collectOrgRecordFiles: secrets and Inaya-internal notes
//                  removed) + the actual contents of S3-compatible storage (NAS backups, S3/Azure/GCS uploads,
//                  bookkeeping, support attachments, document automation) up to EXPORT_FILE_BYTES_CAP + a manifest
//                  listing exactly what is included, what is not and why
//   3. store    -> encrypted with the company's server-managed key, stored in pieces (chunkedStorage.storeBytesChunked);
//                  never a public URL; the row keeps only an internal reference
//   4. download -> an authenticated route for the same company's Owner/Admin, recorded (downloadedAt/by)
//   5. expire   -> after EXPORT_ARTIFACT_TTL_DAYS the pieces are deleted and the row marked expired
// Documents-module files are encrypted with the company's passkey on the user's own device; the server cannot read
// them, so the manifest lists them and Owners/Admins download them read-only in the browser (founder decision 11).

import { ObjectId } from "mongodb";
import { toObjectId, getOrgCollections } from "../orgs.js";
import { zip } from "../bookkeeper/exportFormats.js";
import { EXPORT_ARTIFACT_TTL_DAYS, EXPORT_FILE_BYTES_CAP, EXPORT_REQUESTS_PER_DAY } from "./config.js";
import { licenseCollections } from "./service.js";

export class ExportError extends Error { constructor(status, message, code = "EXPORT_ERROR") { super(message); this.status = status; this.code = code; } }
const DAY = 86400000;
const nowIso = () => new Date().toISOString();
const safePath = (s) => String(s || "").replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..").map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, "_").slice(0, 120)).join("/") || "file";

async function audit(ledger, orgId, type, actor, metadata) {
  await ledger.insertOne({ kind: "license_event", orgId: toObjectId(orgId), eventType: type, actorType: actor === "system" ? "system" : "company_user", actorId: actor, source: actor === "system" ? "cron" : "billing_page", at: nowIso(), createdAt: nowIso(), metadata });
}

/** Owner/Admin asks for an export. Returns the job. */
export async function requestExport({ orgId, email, now = new Date() }) {
  const { ledger } = await licenseCollections();
  const oid = toObjectId(orgId);
  const live = await ledger.findOne({ kind: "company_export", orgId: oid, exportStatus: { $in: ["queued", "running"] } });
  if (live) return { job: view(live), existing: true };
  const today = await ledger.countDocuments({ kind: "company_export", orgId: oid, requestedAt: { $gt: new Date(now.getTime() - DAY).toISOString() } });
  if (today >= EXPORT_REQUESTS_PER_DAY) throw new ExportError(429, `At most ${EXPORT_REQUESTS_PER_DAY} exports a day. Download the latest one, or try again tomorrow.`, "RATE_LIMITED");
  const job = { _id: new ObjectId(), kind: "company_export", orgId: oid, exportStatus: "queued", requestedBy: String(email).toLowerCase(), requestedAt: now.toISOString(), createdAt: now.toISOString() };
  await ledger.insertOne(job);
  await audit(ledger, orgId, "data_export_requested", job.requestedBy, { exportId: String(job._id) });
  return { job: view(job) };
}

export function view(j) {
  return { id: String(j._id), status: j.exportStatus, requestedAt: j.requestedAt, completedAt: j.completedAt || null, expiresAt: j.expiresAt || null, bytes: j.bytes || null, filesIncluded: j.filesIncluded ?? null, filesNotIncluded: j.filesNotIncluded ?? null, records: j.records ?? null, error: j.errorMessageSafe || null, downloadedAt: j.downloadedAt || null };
}

export async function listExports(orgId, { limit = 10 } = {}) {
  const { ledger } = await licenseCollections();
  return (await ledger.find({ kind: "company_export", orgId: toObjectId(orgId) }).sort({ requestedAt: -1 }).limit(limit).toArray()).map(view);
}

/** Builds the ZIP for one company: records + file contents + manifest. Exported for tests. */
export async function buildCompanyExportZip(orgId, { now = new Date(), fileBytesCap = EXPORT_FILE_BYTES_CAP } = {}) {
  const { collectOrgRecordFiles } = await import("../orgDataExport.js");
  const { listCompanyObjectsForExport } = await import("../s3-compat/store.js");
  const { org, files, records, collections } = await collectOrgRecordFiles(orgId);
  const objects = await listCompanyObjectsForExport(orgId);
  const included = []; const notIncluded = []; let bytes = 0;
  for (const o of objects) {
    const path = `files/${safePath(o.bucket)}/${safePath(o.key)}`;
    if (bytes + o.sizeBytes > fileBytesCap) { notIncluded.push({ path, sizeBytes: o.sizeBytes, reason: "over the export size limit: download it with your S3 / Azure tools or ask Inaya support" }); continue; }
    try { const buf = await o.read(); files.push({ name: path, data: buf }); bytes += buf.length; included.push({ path, sizeBytes: buf.length, contentType: o.contentType }); }
    catch (e) { notIncluded.push({ path, sizeBytes: o.sizeBytes, reason: "could not be read from storage right now; try the export again" }); }
  }
  const { orgDocuments } = await getOrgCollections();
  const encryptedDocs = await orgDocuments.find({ orgId: toObjectId(orgId), deletedAt: null, encryptionMode: { $ne: "server-managed" }, cidAlpha: { $exists: true } }, { projection: { filename: 1, sizeBytes: 1, departmentId: 1, projectId: 1, createdAt: 1 } }).limit(100000).toArray();
  const manifest = {
    format: "inaya-company-export", version: 2, company: org?.name || String(orgId), orgId: String(orgId), exportedAt: now.toISOString(),
    included: {
      records: { collections, records, where: "records/<collection>.json", note: "Every record the company owns, one JSON file per kind of record." },
      files: { count: included.length, bytes, where: "files/<bucket>/<key>", sources: "S3-compatible storage: NAS backups, S3 / Azure / GCS uploads, bookkeeping documents, support attachments, generated documents" },
    },
    notIncluded: {
      filesOverLimit: notIncluded,
      encryptedDocuments: { count: encryptedDocs.length, where: "documents-encrypted.json", reason: "Documents-module files are encrypted with your company passkey on your own device; Inaya cannot read them. Download them in Business Workspace (Billing > Documents download, available even while suspended)." },
      secrets: "Passwords, sign-in tokens, API keys, encryption keys and integration credentials are never exported.",
      internal: "Inaya's internal billing notes and audit rows are not company data and are not exported.",
    },
  };
  files.push({ name: "export-manifest.json", data: JSON.stringify(manifest, null, 2) });
  files.push({ name: "documents-encrypted.json", data: JSON.stringify(encryptedDocs.map((d) => ({ id: String(d._id), filename: d.filename, sizeBytes: d.sizeBytes || null, departmentId: d.departmentId ? String(d.departmentId) : null, projectId: d.projectId ? String(d.projectId) : null, createdAt: d.createdAt || null })), null, 2) });
  files.unshift({ name: "README.txt", data: [
    "Inaya Business Workspace - company data export", `Company: ${manifest.company}`, `Exported: ${manifest.exportedAt}`, "",
    "records/<name>.json   every record of one kind (contacts, invoices, employees, tasks, ...), standard JSON.",
    "files/<bucket>/<key>  the actual files from S3-compatible storage (NAS backups, S3 / Azure / GCS uploads and more).",
    "export-manifest.json  exactly what is and is not in this export, and why.",
    "documents-encrypted.json  Documents-module files (encrypted with your passkey; download them in Business Workspace).", "",
    "Passwords, tokens, API keys and credentials are never included.", "Questions: contact@inayanetwork.com",
  ].join("\r\n") });
  const safeName = String(org?.name || "company").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "company";
  return { buffer: zip(files), filename: `inaya-${safeName}-export-${now.toISOString().slice(0, 10)}.zip`, records, filesIncluded: included.length, filesNotIncluded: notIncluded.length + encryptedDocs.length };
}

/** Builds one queued export (claimed atomically, so two workers never build the same job). */
export async function processExportJob(jobId, { now = new Date() } = {}) {
  const { ledger } = await licenseCollections();
  const r = await ledger.findOneAndUpdate({ _id: toObjectId(jobId), kind: "company_export", exportStatus: "queued" }, { $set: { exportStatus: "running", startedAt: now.toISOString() } }, { returnDocument: "after" });
  const job = r?.value ?? r;
  if (!job) return null;
  try {
    const built = await buildCompanyExportZip(job.orgId, { now });
    const { storeBytesChunked } = await import("../chunkedStorage.js");
    // The company's server-managed key encrypts the ZIP at rest. A company that never used S3 storage has none yet:
    // create it (the same key S3 storage would use), so every company can export.
    const { ensureOwnerS3Passphrase, getOwnerS3Passphrase } = await import("../s3-compat/credentials.js");
    await ensureOwnerS3Passphrase({ type: "org", orgId: String(job.orgId) });
    const passkey = await getOwnerS3Passphrase({ type: "org", orgId: String(job.orgId) });
    const stored = await storeBytesChunked({ orgId: String(job.orgId), email: "data-export", bytes: built.buffer, contentType: "application/zip", passkey });
    const expiresAt = new Date(now.getTime() + EXPORT_ARTIFACT_TTL_DAYS * DAY).toISOString();
    await ledger.updateOne({ _id: job._id }, { $set: { exportStatus: "ready", completedAt: nowIso(), expiresAt, filename: built.filename, bytes: built.buffer.length, records: built.records, filesIncluded: built.filesIncluded, filesNotIncluded: built.filesNotIncluded, artifact: stored.storage } });
    await audit(ledger, job.orgId, "data_export_completed", "system", { exportId: String(job._id), bytes: built.buffer.length });
    import("../metrics/metrics.js").then((m) => m.metric?.("license.export_job", { orgId: String(job.orgId), label: "ready" })).catch(() => {});
    const { sendEmail } = await import("../email.js");
    sendEmail({ to: job.requestedBy, subject: "Your company data export is ready", text: `Your company data export is ready to download from Billing in Business Workspace until ${expiresAt.slice(0, 10)}.\n\nhttps://www.inayanetwork.com/business?view=billing\n\nInaya Network` }).catch(() => {});
    return { ready: true };
  } catch (e) {
    const safe = /not configured|off during test runs/i.test(e.message) ? "File storage for exports is not available right now. Please try again later or contact support." : "The export could not be built. Please try again.";
    await ledger.updateOne({ _id: job._id }, { $set: { exportStatus: "failed", completedAt: nowIso(), errorCode: e.code || "BUILD_FAILED", errorMessageSafe: safe } });
    await audit(ledger, job.orgId, "data_export_failed", "system", { exportId: String(job._id), code: e.code || "BUILD_FAILED" });
    import("../metrics/metrics.js").then((m) => m.metric?.("license.export_job", { orgId: String(job.orgId), label: "failed" })).catch(() => {});
    console.error("company export failed:", String(e.message || e).slice(0, 200));
    return { ready: false };
  }
}

/** The job step: builds queued exports (oldest first), at most `limit` per run. */
export async function processExportJobs({ now = new Date(), limit = 3 } = {}) {
  const { ledger } = await licenseCollections();
  // A job left "running" by a crashed worker for over an hour goes back to the queue.
  await ledger.updateMany({ kind: "company_export", exportStatus: "running", startedAt: { $lt: new Date(now.getTime() - 3600000).toISOString() } }, { $set: { exportStatus: "queued" } });
  const queued = await ledger.find({ kind: "company_export", exportStatus: "queued" }).sort({ requestedAt: 1 }).limit(limit).toArray();
  let built = 0; for (const j of queued) if ((await processExportJob(j._id, { now }))?.ready) built++;
  return { built, queued: queued.length };
}

/** Deletes expired export ZIPs (the pieces) and marks the rows expired. */
export async function expireExportArtifacts({ now = new Date() } = {}) {
  const { ledger } = await licenseCollections();
  const { deleteStoredPrefix } = await import("../chunkedStorage.js");
  const due = await ledger.find({ kind: "company_export", exportStatus: "ready", expiresAt: { $lte: now.toISOString() } }).limit(100).toArray();
  let expired = 0;
  for (const j of due) {
    try { if (j.artifact?.prefix) await deleteStoredPrefix(j.artifact.prefix); await ledger.updateOne({ _id: j._id, exportStatus: "ready" }, { $set: { exportStatus: "expired", expiredAt: now.toISOString() }, $unset: { artifact: "" } }); expired++; }
    catch (e) { console.error("export expiry failed:", String(e.message || e).slice(0, 120)); }
  }
  return { expired };
}

/** The ready ZIP for an authorized download (same company only), recorded as downloaded. */
export async function readExportForDownload({ orgId, exportId, email, now = new Date() }) {
  const { ledger } = await licenseCollections();
  let id; try { id = toObjectId(exportId); } catch { throw new ExportError(404, "Export not found.", "NOT_FOUND"); }
  const job = await ledger.findOne({ _id: id, kind: "company_export", orgId: toObjectId(orgId) });
  if (!job) throw new ExportError(404, "Export not found.", "NOT_FOUND");
  if (job.exportStatus !== "ready" || !job.artifact?.prefix) throw new ExportError(409, job.exportStatus === "expired" ? "This export has expired. Request a new one." : "This export is not ready yet.", "NOT_READY");
  if (new Date(job.expiresAt) <= now) throw new ExportError(410, "This export has expired. Request a new one.", "EXPIRED");
  const { readBytesChunked } = await import("../chunkedStorage.js");
  const { getOwnerS3Passphrase } = await import("../s3-compat/credentials.js");
  const buffer = await readBytesChunked({ storage: job.artifact }, await getOwnerS3Passphrase({ type: "org", orgId: String(orgId) }));
  await ledger.updateOne({ _id: job._id }, { $set: { downloadedAt: now.toISOString(), downloadedBy: String(email).toLowerCase() } });
  await audit(ledger, orgId, "data_export_downloaded", String(email).toLowerCase(), { exportId: String(job._id) });
  return { buffer, filename: job.filename || "inaya-company-export.zip" };
}
