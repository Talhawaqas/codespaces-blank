// src/lib/connect/intake.js -- SOW Workstream C: documents sent on WhatsApp.
//   1. only from senders allowed to submit (linked staff or the company's supplier allow-list); anyone else -> quarantine
//   2. media fetched through Meta's official endpoint, size-capped
//   3. file policy + content-signature check + malware scan (support/attachments + scanner); failures -> quarantine
//   4. content hash: the same file twice is recorded once
//   5. routing: bills/receipts/invoices -> AI Bookkeeper intake (its own extraction, DRAFT + review; never approved,
//      never paid); everything else -> the Inaya Connect document review queue, stored in the encrypted object store,
//      for a person to confirm the destination. Nothing is auto-filed into a consequential workflow.
//   6. the sender gets an acknowledgement with a reference only (no extracted data)
import { ccol, oid, sid, clean, nowIso, K, getSettings, sha256, event, audit } from "./core.js";
import { fetchMedia } from "./graph.js";

const EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const BILL_WORDS = /\b(invoice|bill|receipt|challan|payment|inv[\s#-]?\d|statement)\b/i;
let storeImpl = null; export function __setDocStore(fn) { storeImpl = fn; }
async function putObject({ orgId, key, buffer, contentType }) {
  if (storeImpl) return storeImpl.put({ orgId, key, buffer, contentType });
  const { putS3Object } = await import("../s3-compat/store.js"); const { ensureOwnerS3Passphrase } = await import("../s3-compat/credentials.js"); const { workspaceProviderOrder } = await import("../pinningProviders/index.js");
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  let last; for (const providerName of workspaceProviderOrder().length ? workspaceProviderOrder() : [undefined]) { try { return await putS3Object({ orgId: String(orgId), bucket: "connect-intake", key, bodyBuffer: buffer, contentType, actorEmail: "inaya-connect", providerName }); } catch (e) { last = e; } }
  throw last;
}
export async function getObject({ orgId, key, versionId }) {
  if (storeImpl) return storeImpl.get({ orgId, key });
  const { getS3ObjectBody } = await import("../s3-compat/store.js"); return getS3ObjectBody({ orgId: String(orgId), bucket: "connect-intake", key, versionId });
}

/** Where bills go: the company's AI Bookkeeper source for Inaya Connect (created on first use, API type, first department). */
async function bookkeeperSource(orgId, settings) {
  const { getSource, createSource } = await import("../bookkeeper/sources.js");
  if (settings.bookkeeperSourceId) { const s = await getSource({ orgId, sourceId: settings.bookkeeperSourceId }); if (s?.status === "ACTIVE") return s; }
  const { getOrgCollections } = await import("../orgs.js"); const { departments } = await getOrgCollections();
  const dep = await departments.findOne({ orgId: oid(orgId) }, { sort: { createdAt: 1 } }); if (!dep) return null;
  const r = await createSource({ orgId, type: "API", name: "Inaya Connect (WhatsApp)", departmentId: sid(dep._id), actor: "system:inaya-connect" });
  if (r.error) return null;
  const c = await ccol(); await c.updateOne({ orgId: oid(orgId), kind: K.settings }, { $set: { "settings.bookkeeperSourceId": r.source.id }, $setOnInsert: { orgId: oid(orgId), kind: K.settings, opsDoc: true } }, { upsert: true });
  const { getSource: gs } = await import("../bookkeeper/sources.js"); return gs({ orgId, sourceId: r.source.id });
}

/** Returns { ack, docId, outcome } — outcome: bookkeeper | review | quarantined | duplicate */
export async function intakeMedia({ orgId, conn, msg, sender }) {
  const s = await getSettings(orgId); const c = await ccol(); const now = nowIso();
  const base = { orgId: oid(orgId), kind: K.doc, opsDoc: true, waMessageId: msg.waMessageId, from: msg.from, senderType: sender.type, senderEmail: sender.email || null, caption: clean(msg.text, 500) || null, at: now };
  const quarantine = async (reason, extra = {}) => {
    const r = await c.insertOne({ ...base, status: "QUARANTINED", reason, ...extra });
    await event({ orgId, type: "intake", outcome: "quarantined", connId: conn._id, waMessageId: msg.waMessageId, contact: msg.from, detail: { reason } });
    return { outcome: "quarantined", docId: sid(r.insertedId), ack: "Thanks. We couldn't accept this file automatically; a member of our team will review it." };
  };
  if (!s.documentIntake) return { outcome: "disabled", ack: null };
  if (!["staff", "supplier"].includes(sender.type)) return quarantine("sender_not_allowed");
  if (!msg.media?.id || !["image", "document"].includes(msg.type)) return quarantine("unsupported_type", { mime: msg.media?.mime || null });
  let m; try { m = await fetchMedia(conn, msg.media.id, s.limits.maxMediaBytes); } catch (e) { if (e.code === "TOO_LARGE") return quarantine("too_large"); throw e; }
  const mime = String(m.mimeType || msg.media.mime || "").split(";")[0];
  const ext = EXT[mime]; if (!ext) return quarantine("unsupported_type", { mime });
  const name = (msg.media.filename && /\.[a-z0-9]{2,5}$/i.test(msg.media.filename) ? msg.media.filename : `whatsapp-${msg.waMessageId.slice(-8)}.${ext}`).replace(/[^\w.\- ]/g, "_").slice(0, 120);
  const { checkFile } = await import("../support/attachments.js"); const { scanBuffer } = await import("../support/scanner.js");
  const problem = checkFile({ filename: name, buffer: m.buffer, settings: { attachments: { maxBytes: s.limits.maxMediaBytes } } }); if (problem) return quarantine("failed_policy", { detail: problem.slice(0, 200) });
  const scan = await scanBuffer({ filename: name, buffer: m.buffer, mode: "static" }); if (scan.status !== "CLEAN") return quarantine("failed_scan", { scan: scan.status });
  const hash = sha256(m.buffer);
  const dup = await c.findOne({ orgId: oid(orgId), kind: K.doc, hash, status: { $ne: "QUARANTINED" } }, { projection: { ref: 1 } });
  if (dup) { await event({ orgId, type: "intake", outcome: "duplicate", connId: conn._id, waMessageId: msg.waMessageId }); return { outcome: "duplicate", docId: sid(dup._id), ack: `We already have this document (reference ${dup.ref}).` }; }
  const ref = `D-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const looksLikeBill = BILL_WORDS.test(`${msg.text || ""} ${name}`) || sender.type === "supplier";
  if (looksLikeBill) {
    const src = await bookkeeperSource(orgId, s);
    if (src) {
      const { ingestDocument } = await import("../bookkeeper/documents.js");
      const r = await ingestDocument({ orgId: sid(orgId), source: src, channel: "WHATSAPP", filename: name, contentType: mime, buffer: m.buffer, externalId: msg.waMessageId, meta: { messageId: msg.waMessageId, from: `+${msg.from.slice(0, 3)}…`, via: "inaya-connect" }, actor: sender.email || "system:inaya-connect" });
      if (!r.error) {
        const ins = await c.insertOne({ ...base, ref, hash, filename: name, mime, size: m.buffer.length, status: "ROUTED", destination: "bookkeeper", bookkeeperDocumentId: sid(r.document?.id || r.documentId || r.id), routedAt: now });
        await audit({ orgId, action: "CONNECT_DOCUMENT_ROUTED", recordId: ins.insertedId, metadata: { ref, destination: "bookkeeper" } });
        return { outcome: "bookkeeper", docId: sid(ins.insertedId), ack: `Thanks, we received your document (reference ${ref}). Our accounts team will review it.` };
      }
    }
  }
  const key = `${sid(orgId)}/${ref}-${name}`; const stored = await putObject({ orgId, key, buffer: m.buffer, contentType: mime });
  const ins = await c.insertOne({ ...base, ref, hash, filename: name, mime, size: m.buffer.length, status: "REVIEW", destination: null, suggested: looksLikeBill ? "bookkeeper" : null, storage: { key, versionId: stored?.versionId || null } });
  await audit({ orgId, action: "CONNECT_DOCUMENT_QUEUED", recordId: ins.insertedId, metadata: { ref } });
  return { outcome: "review", docId: sid(ins.insertedId), ack: `Thanks, we received your file (reference ${ref}). A member of our team will file it.` };
}
