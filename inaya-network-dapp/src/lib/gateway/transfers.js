// src/lib/gateway/transfers.js
//
// Encrypted, resumable file transfer between a customer's gateway and Inaya (Competitive Expansion SOW GATEWAY-001/002, "encrypted chunk transfer",
// "offline queue", "reconnect/resume").
//
// An administrator APPROVES a file that the gateway has listed (the approval is the transfer request). The agent then:
//   1. encrypts the file on the customer's machine with a fresh AES-256-GCM key, split into fixed parts;
//   2. wraps that key under a secret only the customer holds and sends the wrapped key as an opaque envelope. Inaya stores the envelope and CANNOT open it;
//   3. uploads parts one by one. Each part carries its own SHA-256; re-sending a part is harmless; the server reports which parts it already holds, so a
//      dropped connection resumes where it stopped;
//   4. completes the transfer with a chain hash over all part hashes, which the server recomputes.
// Restore is the reverse and only a gateway of the same organization can read the parts back.

import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { gwCols, GatewayError, canManageGateways } from "./gateway.js";

const fail = (status, message, extra) => { throw new GatewayError(status, message, extra); };
const nowIso = () => new Date().toISOString();
export const LIMITS = { partBytes: 1024 * 1024, maxParts: 64, maxFileBytes: 50 * 1024 * 1024, envelopeMax: 4096 };
const sha = (b) => createHash("sha256").update(b).digest("hex");
export const chainHashOf = (partHashes) => sha(partHashes.map((h, i) => `${i}:${h}`).join("\n"));
const bytesOf = (d) => (Buffer.isBuffer(d) ? d : Buffer.from(d.buffer));
const oid = (id) => { if (!/^[0-9a-f]{24}$/.test(String(id || ""))) fail(404, "Transfer not found."); return new ObjectId(String(id)); };
const emit = (orgId, data) => import("../webhooks/registry.js").then((m) => m.emitWebhookEvent({ orgId, type: "gateway.event", data })).catch(() => {});

const view = (t) => ({ transferId: String(t._id), gatewayId: String(t.gatewayId), connectorId: String(t.connectorId), folderId: t.folderId, path: t.path, name: t.name, status: t.status, size: t.size, cipherSize: t.cipherSize || null, partCount: t.partCount || null, received: (t.receivedCount ?? 0), requestedBy: t.requestedBy, createdAt: t.createdAt, completedAt: t.completedAt || null });

// ------------------------------------------------------------------------------------------------ administrator side
export async function requestTransfer({ orgId, membership, actorEmail, gatewayId, connectorId, folderId, path, ip = null }) {
  if (!canManageGateways(membership)) fail(403, "Only an administrator can approve a file for transfer.");
  const c = await gwCols(); const gid = new ObjectId(String(gatewayId).match(/^[0-9a-f]{24}$/) ? gatewayId : fail(404, "Gateway not found."));
  const g = await c.gateways.findOne({ _id: gid, orgId: toObjectId(orgId), status: "active" }); if (!g) fail(404, "Gateway not found.");
  const k = await c.connectors.findOne({ _id: oid(connectorId), orgId: g.orgId, gatewayId: g._id }); if (!k || !(k.folders || []).some((f) => f.folderId === String(folderId))) fail(403, "That folder is not approved for this connector.");
  const entry = await c.inventory.findOne({ orgId: g.orgId, connectorId: k._id, folderId: String(folderId), path: String(path || "") });
  if (!entry || entry.isDir) fail(404, "That file is not in the gateway's listing.");
  if (entry.size > LIMITS.maxFileBytes) fail(413, `Files can be at most ${LIMITS.maxFileBytes / 1048576} MB.`, { code: "TOO_LARGE" });
  const open = await c.transfers.findOne({ gatewayId: g._id, connectorId: k._id, folderId: String(folderId), path: entry.path, status: { $in: ["requested", "uploading"] } }); if (open) return view(open);
  const { governUpload } = await import("../governance/uploads.js");
  const gov = await governUpload({ orgId, actorEmail, source: "gateway", filename: entry.name, size: entry.size, ip, path: entry.path, role: membership.role }); if (!gov.allowed) fail(403, gov.message || "The organization's upload policy does not allow this file.", { code: "POLICY" });
  const doc = { _id: new ObjectId(), orgId: g.orgId, gatewayId: g._id, connectorId: k._id, folderId: String(folderId), path: entry.path, name: entry.name, size: entry.size, status: "requested", requestedBy: actorEmail, createdAt: nowIso(), receivedCount: 0 };
  await c.transfers.insertOne(doc); await logOrgActivity({ orgId, recordType: "GATEWAY", recordId: doc._id, actorEmail, action: "TRANSFER_REQUESTED", previousState: null, newState: null, metadata: { gatewayId: String(g._id), size: doc.size } }).catch(() => {});
  return view(doc);
}
export async function listTransfers({ orgId, membership, gatewayId = null, limit = 50 }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can see transfers.");
  const c = await gwCols(); const q = { orgId: toObjectId(orgId) }; if (gatewayId && /^[0-9a-f]{24}$/.test(gatewayId)) q.gatewayId = new ObjectId(gatewayId);
  return { transfers: (await c.transfers.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 200)).toArray()).map(view) };
}
export async function cancelTransfer({ orgId, membership, actorEmail, transferId }) {
  if (!canManageGateways(membership)) fail(403, "Only an administrator can cancel a transfer.");
  const c = await gwCols(); const t = await c.transfers.findOneAndUpdate({ _id: oid(transferId), orgId: toObjectId(orgId), status: { $in: ["requested", "uploading"] } }, { $set: { status: "cancelled", cancelledAt: nowIso() } }, { returnDocument: "after" });
  if (!t) fail(404, "Transfer not found, or already finished."); await c.chunks.deleteMany({ transferId: t._id }); await logOrgActivity({ orgId, recordType: "GATEWAY", recordId: t._id, actorEmail, action: "TRANSFER_CANCELLED", previousState: null, newState: null, metadata: {} }).catch(() => {});
  return { cancelled: true };
}

// ------------------------------------------------------------------------------------------------ gateway side
async function own({ gateway, transferId, statuses }) {
  const c = await gwCols(); const t = await c.transfers.findOne({ _id: oid(transferId), orgId: gateway.orgId, gatewayId: gateway._id });
  if (!t) fail(404, "Transfer not found."); if (statuses && !statuses.includes(t.status)) fail(409, `This transfer is ${t.status}.`, { code: "BAD_STATE", status: t.status }); return { c, t };
}
export async function beginTransfer({ gateway, transferId, partCount, cipherSize, keyEnvelope, plainSha256 = null }) {
  const { c, t } = await own({ gateway, transferId, statuses: ["requested", "uploading"] });
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > LIMITS.maxParts) fail(400, `partCount must be between 1 and ${LIMITS.maxParts}.`);
  if (!Number.isInteger(cipherSize) || cipherSize < 1 || cipherSize > LIMITS.maxFileBytes + 4096 || partCount !== Math.ceil(cipherSize / LIMITS.partBytes)) fail(400, "partCount does not match cipherSize.");
  const env = String(keyEnvelope || ""); if (!env || env.length > LIMITS.envelopeMax) fail(400, "The key envelope is missing or too large.");
  await c.transfers.updateOne({ _id: t._id }, { $set: { status: "uploading", partCount, cipherSize, keyEnvelope: env, plainSha256: /^[0-9a-f]{64}$/.test(plainSha256 || "") ? plainSha256 : null, startedAt: t.startedAt || nowIso() } });
  const held = await c.chunks.find({ transferId: t._id }).project({ index: 1 }).toArray(); return { transferId: String(t._id), received: held.map((x) => x.index).sort((a, b) => a - b) };
}
export async function transferState({ gateway, transferId }) {
  const { c, t } = await own({ gateway, transferId }); const held = await c.chunks.find({ transferId: t._id }).project({ index: 1 }).toArray();
  return { transferId: String(t._id), status: t.status, partCount: t.partCount || null, received: held.map((x) => x.index).sort((a, b) => a - b), keyEnvelope: t.status === "complete" ? t.keyEnvelope : undefined };
}
export async function putPart({ gateway, transferId, index, data, sha256 }) {
  const { c, t } = await own({ gateway, transferId, statuses: ["uploading"] });
  if (!Number.isInteger(index) || index < 0 || index >= (t.partCount || 0)) fail(400, "index is out of range.");
  if (typeof data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(data)) fail(400, "data must be base64."); const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > LIMITS.partBytes + 64) fail(413, "A part can be at most 1 MB."); if (!/^[0-9a-f]{64}$/.test(sha256 || "") || sha(bytes) !== sha256) fail(422, "The part does not match its hash.", { code: "HASH_MISMATCH" });
  const last = index === t.partCount - 1; if (!last && bytes.length !== LIMITS.partBytes) fail(400, "Every part except the last must be exactly 1 MB.");
  const existing = await c.chunks.findOne({ transferId: t._id, index }); if (existing) { if (existing.sha256 === sha256) return { stored: false, duplicate: true }; fail(409, "A different part is already stored at that index.", { code: "CONFLICT" }); }
  await c.chunks.insertOne({ orgId: gateway.orgId, transferId: t._id, index, sha256, data: bytes, at: nowIso() }); await c.transfers.updateOne({ _id: t._id }, { $inc: { receivedCount: 1 } });
  return { stored: true, duplicate: false };
}
export async function completeTransfer({ gateway, transferId, chainHash }) {
  const { c, t } = await own({ gateway, transferId, statuses: ["uploading", "complete"] }); if (t.status === "complete") return { complete: true, already: true };
  const parts = await c.chunks.find({ transferId: t._id }).project({ index: 1, sha256: 1, data: 1 }).sort({ index: 1 }).toArray();
  if (parts.length !== t.partCount || parts.some((p, i) => p.index !== i)) fail(409, "Not every part has arrived.", { code: "INCOMPLETE", received: parts.map((p) => p.index) });
  const hashes = parts.map((p) => p.sha256); if (chainHashOf(hashes) !== chainHash) fail(422, "The chain hash does not match the stored parts.", { code: "CHAIN_MISMATCH" });
  const stored = parts.reduce((n, p) => n + bytesOf(p.data).length, 0); if (stored !== t.cipherSize) fail(422, "The stored size does not match the announced size.", { code: "SIZE_MISMATCH" });
  await c.transfers.updateOne({ _id: t._id }, { $set: { status: "complete", completedAt: nowIso(), chainHash } });
  await logOrgActivity({ orgId: gateway.orgId, recordType: "GATEWAY", recordId: t._id, actorEmail: "gateway:" + String(gateway._id), action: "TRANSFER_COMPLETED", previousState: null, newState: null, metadata: { size: t.size, parts: t.partCount } }).catch(() => {});
  emit(gateway.orgId, { gatewayId: String(gateway._id), event: "transfer.completed", transferId: String(t._id), size: t.size }); return { complete: true };
}
export async function getPart({ gateway, transferId, index }) {
  const { c, t } = await own({ gateway, transferId, statuses: ["complete"] }); const p = await c.chunks.findOne({ transferId: t._id, index: Number(index) }); if (!p) fail(404, "Part not found.");
  return { index: p.index, sha256: p.sha256, data: bytesOf(p.data).toString("base64") };
}
