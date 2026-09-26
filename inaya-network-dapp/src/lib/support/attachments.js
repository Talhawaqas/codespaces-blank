// src/lib/support/attachments.js
//
// SOW §10.4, §22, §44: ticket attachments. Bytes are NEVER placed in the database: each file is stored as an
// encrypted, sharded object through the existing S3-compatible storage layer (s3-compat/store.js: server-managed
// encryption, provider fallback) in a per-organization `support-attachments` bucket. The ticket only keeps a
// reference. Downloads always go through this module: the request supplies an attachment id (never a path or
// key), permission is re-checked on EVERY download against the ticket and the attachment's visibility, the
// object key comes from our own record, and every access is written to the audit chain.
//
// Scanning: every file passes the policy checks (type allow-list, blocked extensions, magic bytes, size) and then
// scanner.js (built-in static inspection of archives, macros, PDF active content and executables, plus any antivirus
// engine the platform has configured; see that file for exactly what each layer does). Files are never rendered inline,
// are served as downloads with nosniff, and HTML/SVG are never served as such.

import { toObjectId } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { fail, nowIso, sha256 } from "./common.js";
import { BLOCKED_EXTENSIONS } from "./settings.js";
import { supportPerms } from "./access.js";
import { audit, emit } from "./record.js";
import { mutate, loadTicket, agentCanSee, customerAccessFilter, oidOf } from "./tickets.js";
import { putS3Object, getS3ObjectBody } from "../s3-compat/store.js";
import { scanBuffer, scanRefusal } from "./scanner.js";
import { ensureOwnerS3Passphrase } from "../s3-compat/credentials.js";
import { listAvailableProviders } from "../pinningProviders/index.js";

export const BUCKET = "support-attachments";
const ALLOWED = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv", log: "text/plain", json: "application/json", md: "text/plain",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime", eml: "message/rfc822" };

/**
 * Stores bytes in the organization's support bucket through the existing encrypted, sharded storage layer.
 * Same resilience as the document engine: if the preferred pinning provider refuses the write (outage, exhausted
 * plan), the next configured provider is tried; nothing is written to the database until a pin succeeds.
 */
export async function storeSupportObject({ orgId, key, buffer, contentType, actorEmail }) {
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  const configured = listAvailableProviders();
  const attempts = configured.length ? [...configured].sort((a, b) => (a === "pinata" ? -1 : b === "pinata" ? 1 : 0)) : [undefined];
  let lastError;
  for (const providerName of attempts) {
    try { return await putS3Object({ orgId: String(orgId), bucket: BUCKET, key, bodyBuffer: buffer, contentType, actorEmail: actorEmail || "support", providerName }); }
    catch (err) { lastError = err; console.error(`support storage: provider "${providerName || "default"}" failed (${String(err.message).slice(0, 100)}); trying the next one`); }
  }
  throw lastError;
}

/** Cheap check of the file NAME and declared size, before any bytes are uploaded. */
export function preflightFile({ filename, size, settings }) {
  const name = safeFilename(filename);
  const x = (name.split(".").pop() || "").toLowerCase();
  if (!name.includes(".")) return { error: "The file needs a name with an extension." };
  if (BLOCKED_EXTENSIONS.includes(x)) return { error: `Files of type .${x} are not accepted.` };
  if (!ALLOWED[x]) return { error: `Files of type .${x} are not accepted. Allowed: ${Object.keys(ALLOWED).join(", ")}.` };
  if (!Number.isInteger(size) || size <= 0) return { error: "The file is empty." };
  const max = settings?.attachments?.maxBytes || 25 * 1048576;
  if (size > max) return { error: `The file is larger than ${Math.round(max / 1048576)} MB.` };
  return { name };
}

/** Policy check + malware scan. Returns { error, reasonCode } to refuse, or { scan } to accept. */
export async function screenFile({ filename, buffer, settings }) {
  const problem = checkFile({ filename, buffer, settings });
  if (problem) return { error: problem, reasonCode: "ATTACHMENT_REJECTED" };
  const scan = await scanBuffer({ filename, buffer, mode: settings?.scan?.mode || "static" });
  if (scan.status !== "CLEAN") return { error: scanRefusal(scan), reasonCode: scan.status === "ERROR" ? "SCAN_UNAVAILABLE" : "MALWARE_DETECTED", scan };
  return { scan };
}

export function safeFilename(name) {
  const base = String(name || "file").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return base || "file";
}

/** Returns an error string, or null when the file passes policy. */
export function checkFile({ filename, buffer, settings }) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (!filename.includes(".")) return "The file needs a name with an extension.";
  if (BLOCKED_EXTENSIONS.includes(ext)) return `Files of type .${ext} are not accepted.`;
  if (!ALLOWED[ext]) return `Files of type .${ext} are not accepted. Allowed: ${Object.keys(ALLOWED).join(", ")}.`;
  if (filename.split(".").length > 2 && BLOCKED_EXTENSIONS.includes(filename.split(".").slice(-2, -1)[0].toLowerCase())) return "Double extensions are not accepted.";
  if (!buffer?.length) return "The file is empty.";
  if (buffer.length > (settings?.attachments?.maxBytes || 4 * 1024 * 1024)) return `The file is larger than ${Math.round((settings?.attachments?.maxBytes || 4194304) / 1048576)} MB.`;
  const head = buffer.subarray(0, 8);
  if ((head[0] === 0x4d && head[1] === 0x5a) || (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) || (head[0] === 0x23 && head[1] === 0x21)) return "Executable content is not accepted.";
  const declared = ext;
  if (["png", "jpg", "jpeg", "gif", "pdf"].includes(declared)) {
    const isPng = head[0] === 0x89 && head[1] === 0x50; const isJpg = head[0] === 0xff && head[1] === 0xd8; const isGif = head[0] === 0x47 && head[1] === 0x49; const isPdf = head[0] === 0x25 && head[1] === 0x50;
    const ok = (declared === "png" && isPng) || ((declared === "jpg" || declared === "jpeg") && isJpg) || (declared === "gif" && isGif) || (declared === "pdf" && isPdf);
    if (!ok) return "The file content does not match its type.";
  }
  return null;
}

/** Stores one file on a ticket message. uploader = { type: customer|agent|api|email, email }. */
export async function addAttachment({ orgId, settings, ticketId, messageId = null, file, uploader, visibility = "PUBLIC" }) {
  const ticket = await loadTicket(orgId, ticketId);
  if (!ticket) return fail("Ticket not found.", 404);
  const filename = safeFilename(file?.filename);
  const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || []);
  const screened = await screenFile({ filename, buffer, settings });
  if (screened.error) {
    if (screened.scan) await audit({ orgId, ticketId: ticket._id, action: "TICKET_ATTACHMENT_BLOCKED", actorEmail: uploader.email, metadata: { number: ticket.number, filename, status: screened.scan.status, findings: screened.scan.findings.map((f) => f.kind) } });
    return fail(screened.error, screened.reasonCode === "SCAN_UNAVAILABLE" ? 503 : 400, { reasonCode: screened.reasonCode });
  }
  const { supportAttachments, supportMessages } = await getSupportCollections();
  if (messageId) { const m = await supportMessages.findOne({ _id: oidOf(messageId) || undefined, orgId: ticket.orgId, ticketId: ticket._id }); if (!m) return fail("Message not found.", 404); if ((m.attachments || []).length >= (settings.attachments.maxPerMessage || 5)) return fail(`At most ${settings.attachments.maxPerMessage} attachments per message.`); }
  const doc = { orgId: ticket.orgId, ticketId: ticket._id, messageId: messageId ? oidOf(messageId) : null, filename, contentType: ALLOWED[filename.split(".").pop().toLowerCase()], sizeBytes: buffer.length, sha256: sha256(buffer), visibility: visibility === "INTERNAL" ? "INTERNAL" : "PUBLIC", uploadedBy: { type: uploader.type, email: uploader.email }, createdAt: nowIso(), scan: screened.scan, storage: null };
  const r = await supportAttachments.insertOne(doc); doc._id = r.insertedId;
  const key = `${ticket._id}/${doc._id}/${filename}`;
  try {
    const obj = await storeSupportObject({ orgId: ticket.orgId, key, buffer, contentType: doc.contentType, actorEmail: uploader.email });
    await supportAttachments.updateOne({ _id: doc._id }, { $set: { storage: { bucket: BUCKET, key, versionId: obj?.versionId || null, documentId: obj?._id ? String(obj._id) : null } } });
  } catch (err) {
    await supportAttachments.deleteOne({ _id: doc._id });
    console.error("support attachment storage failed:", err.message);
    return fail("The file could not be stored right now. Please try again.", 502, { reasonCode: "STORAGE_FAILED" });
  }
  if (messageId) await supportMessages.updateOne({ _id: doc.messageId }, { $push: { attachments: doc._id } });
  await audit({ orgId, ticketId: ticket._id, action: "TICKET_ATTACHMENT_ADDED", actorEmail: uploader.email, metadata: { attachmentId: String(doc._id), filename, sizeBytes: buffer.length, sha256: doc.sha256, visibility: doc.visibility, number: ticket.number } });
  await emit({ orgId, type: "ticket.attachment_added", ticket, actor: uploader.email, data: { attachmentId: String(doc._id), filename, sizeBytes: buffer.length }, customerVisible: false });
  return { attachment: { id: String(doc._id), filename, contentType: doc.contentType, sizeBytes: doc.sizeBytes, visibility: doc.visibility } };
}

/**
 * Loads an attachment for download after re-checking permission. viewer = { kind: "agent", membership, email } or
 * { kind: "customer", user }. Returns { filename, contentType, buffer } or null (identical for "missing" and "not yours").
 */
export async function getAttachmentForDownload({ orgId, attachmentId, viewer }) {
  const id = oidOf(attachmentId);
  if (!id) return null;
  const { supportAttachments, supportTickets } = await getSupportCollections();
  const a = await supportAttachments.findOne({ _id: id, orgId: toObjectId(orgId) });
  if (!a || !a.storage?.key) return null;
  const ticket = await supportTickets.findOne({ _id: a.ticketId, orgId: a.orgId, deletedAt: null });
  if (!ticket) return null;
  if (viewer.kind === "agent") {
    if (!(await agentCanSee({ orgId, membership: viewer.membership, email: viewer.email, ticket }))) return null;
    if (a.visibility === "INTERNAL" && !supportPerms(viewer.membership).has("create_notes")) return null;
  } else {
    if (a.visibility !== "PUBLIC") return null;
    const ok = await supportTickets.findOne({ $and: [{ _id: ticket._id, orgId: ticket.orgId }, customerAccessFilter(viewer.user)] }, { projection: { _id: 1 } });
    if (!ok) return null;
  }
  const obj = await getS3ObjectBody({ orgId: String(a.orgId), bucket: a.storage.bucket, key: a.storage.key, versionId: a.storage.versionId || undefined });
  if (!obj) return null;
  await audit({ orgId, ticketId: ticket._id, action: "TICKET_ATTACHMENT_ACCESSED", actorEmail: viewer.kind === "agent" ? viewer.email : viewer.user.email, metadata: { attachmentId: String(a._id), by: viewer.kind } });
  return { filename: a.filename, contentType: ALLOWED[a.filename.split(".").pop().toLowerCase()] || "application/octet-stream", buffer: obj.buffer };
}

/** Headers every attachment download must carry (never inline, never sniffed). */
export const DOWNLOAD_HEADERS = (filename, contentType) => ({ "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename.replace(/["\\]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox" });
