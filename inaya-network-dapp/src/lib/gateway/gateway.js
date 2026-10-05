// src/lib/gateway/gateway.js
//
// Sovereign Gateway (Competitive Expansion SOW workstream M, GATEWAY-001, -003, -004). A small agent runs INSIDE a customer's network and connects OUT to
// Inaya. There is no inbound port, no tunnel and no way for Inaya to reach into the customer network: the agent polls and pushes.
//
//   Enrollment   An administrator creates a one-time enrollment token (24 hours, one use, bound to one organization). The agent generates an Ed25519 key
//                pair on the customer's machine, proves it holds the private key, and sends only the PUBLIC key. Inaya stores the public key.
//   Requests     Every later request is signed (Ed25519 over method, path, timestamp, nonce and body hash). No bearer secret exists on the server side to
//                steal, and no secret travels on the wire. A five-minute clock window and a one-use nonce stop replays.
//   Tenant bind  The organization is read from the gateway record, never from the request. A gateway can only ever see its own organization's rows.
//   Revocation   Revoking a gateway stops its next request, cancels its queued transfers and is audited.
//
// What the gateway sends is metadata (names, sizes, times), ACL snapshots, health, and file content that the AGENT encrypted with a key that never leaves
// the customer (see transfers.js). Inaya cannot read gateway file content.

import { createHash, createPublicKey, verify as edVerify, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { hasAdminRole } from "../orgGates.js";

export class GatewayError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new GatewayError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const sha = (v) => createHash("sha256").update(v).digest("hex");

export const CLOCK_WINDOW_MS = 5 * 60_000;
export const ONLINE_WITHIN_MS = 3 * 60_000;
export const ENROLL_TTL_MS = 24 * 3600_000;
export const CONNECTOR_TYPES = ["filesystem", "smb", "nfs"];
export const GATEWAY_ROLES = ["integrationAdmin", "storageAdmin", "securityAdmin"];
export const canManageGateways = (m, { read = false } = {}) => hasAdminRole(m, GATEWAY_ROLES, { read });
const mustManage = (m) => { if (!canManageGateways(m)) fail(403, "Only an owner, an admin or an integration, storage or security administrator can manage gateways."); };

let indexed = false;
export async function gwCols() {
  const { db } = await getOrgCollections();
  const c = { db, enrollments: db.collection("gateway_enrollments"), gateways: db.collection("gateways"), connectors: db.collection("gateway_connectors"), inventory: db.collection("gateway_inventory"), nonces: db.collection("gateway_nonces"), audit: db.collection("gateway_audit"), principals: db.collection("gateway_principals"), idmap: db.collection("gateway_identity_map"), acl: db.collection("gateway_acl_snapshots"), aclEvents: db.collection("gateway_acl_events"), transfers: db.collection("gateway_transfers"), chunks: db.collection("gateway_chunks") };
  if (!indexed) {
    await Promise.all([
      c.enrollments.createIndex({ tokenHash: 1 }, { unique: true }), c.enrollments.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 86400 * 7 }),
      c.gateways.createIndex({ orgId: 1, status: 1 }), c.gateways.createIndex({ publicKeyFingerprint: 1 }, { unique: true }),
      c.connectors.createIndex({ orgId: 1, gatewayId: 1 }),
      c.inventory.createIndex({ gatewayId: 1, connectorId: 1, folderId: 1, path: 1 }, { unique: true }), c.inventory.createIndex({ orgId: 1, folderId: 1 }),
      c.nonces.createIndex({ gatewayId: 1, nonce: 1 }, { unique: true }), c.nonces.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      c.audit.createIndex({ gatewayId: 1, seq: 1 }, { unique: true }),
      c.principals.createIndex({ gatewayId: 1, principal: 1 }, { unique: true }),
      c.idmap.createIndex({ orgId: 1, principal: 1 }, { unique: true }),
      c.acl.createIndex({ gatewayId: 1, folderId: 1 }, { unique: true }), c.aclEvents.createIndex({ orgId: 1, at: -1 }),
      c.transfers.createIndex({ orgId: 1, gatewayId: 1, status: 1 }), c.chunks.createIndex({ transferId: 1, index: 1 }, { unique: true }),
    ]);
    indexed = true;
  }
  return c;
}

const oid = (id, what = "Not found.") => { if (!/^[0-9a-f]{24}$/.test(String(id || ""))) fail(404, what); return new ObjectId(String(id)); };
const emit = (orgId, data) => import("../webhooks/registry.js").then((m) => m.emitWebhookEvent({ orgId, type: "gateway.event", data })).catch(() => {});
const record = (orgId, id, actorEmail, action, metadata = {}) => logOrgActivity({ orgId, recordType: "GATEWAY", recordId: id, actorEmail, action, previousState: null, newState: null, metadata }).catch(() => {});

// ------------------------------------------------------------------------------------------------ signing (shared contract with the agent)
/** The exact bytes a gateway signs. The agent builds the same string; a test pins the two together. */
export const signingString = ({ method, path, ts, nonce, body }) => `${String(method).toUpperCase()}\n${path}\n${ts}\n${nonce}\n${sha(body || "")}`;
export const enrollProofString = ({ tokenHash, ts }) => `enroll\n${tokenHash}\n${ts}`;
const publicKeyOf = (b64) => { try { const k = createPublicKey({ key: Buffer.from(String(b64), "base64"), format: "der", type: "spki" }); if (k.asymmetricKeyType !== "ed25519") return null; return k; } catch { return null; } };
export const fingerprint = (b64) => sha(Buffer.from(String(b64), "base64")).slice(0, 32);
const checkSig = (pub, data, sigB64) => { try { return edVerify(null, Buffer.from(data), pub, Buffer.from(String(sigB64), "base64")); } catch { return false; } };

// ------------------------------------------------------------------------------------------------ enrollment
export async function createEnrollment({ orgId, membership, actorEmail, label, mode = "customer_gateway" }) {
  mustManage(membership); const c = await gwCols();
  const token = `gwe_${randomBytes(24).toString("base64url")}`;
  const doc = { _id: new ObjectId(), orgId: toObjectId(orgId), tokenHash: sha(token), label: String(label || "Gateway").trim().slice(0, 80), mode, createdByEmail: actorEmail, createdAt: nowIso(), expiresAt: new Date(Date.now() + ENROLL_TTL_MS), usedAt: null };
  await c.enrollments.insertOne(doc); await record(orgId, doc._id, actorEmail, "ENROLLMENT_CREATED", { label: doc.label });
  return { token, expiresAt: doc.expiresAt.toISOString(), note: "Shown once. It works one time and expires in 24 hours." };
}

/** Called by the agent with no session: the enrollment token is the only credential, and it is exchanged for a registration, not a secret. */
export async function enroll({ token, publicKey, proof, ts, label, version, platform, capabilities }) {
  const c = await gwCols(); const pub = publicKeyOf(publicKey); if (!pub) fail(400, "publicKey must be an Ed25519 public key (base64 SPKI).");
  const t = Number(ts); if (!Number.isFinite(t) || Math.abs(Date.now() - t) > CLOCK_WINDOW_MS) fail(400, "The timestamp is outside the allowed window.");
  const tokenHash = sha(String(token || ""));
  if (!checkSig(pub, enrollProofString({ tokenHash, ts }), proof)) fail(401, "The key proof is not valid.");
  const caps = Array.isArray(capabilities) ? [...new Set(capabilities.map((x) => String(x).slice(0, 40)))].slice(0, 30) : [];
  const used = await c.enrollments.findOneAndUpdate({ tokenHash, usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: nowIso() } }, { returnDocument: "before" });
  if (!used) fail(401, "That enrollment token is not valid, was already used, or has expired.");
  const g = { _id: new ObjectId(), orgId: used.orgId, label: used.label || String(label || "Gateway").slice(0, 80), mode: used.mode, status: "active", publicKey: String(publicKey), publicKeyFingerprint: fingerprint(publicKey), registeredAt: nowIso(), lastSeenAt: null, version: String(version || "").slice(0, 40), platform: String(platform || "").slice(0, 40), capabilities: caps, health: null, configVersion: 0, commands: [], revokedAt: null };
  try { await c.gateways.insertOne(g); } catch (e) { if (e?.code === 11000) fail(409, "That key is already registered."); throw e; }
  await record(used.orgId, g._id, used.createdByEmail, "GATEWAY_REGISTERED", { label: g.label, fingerprint: g.publicKeyFingerprint, capabilities: caps, version: g.version });
  emit(used.orgId, { gatewayId: String(g._id), event: "registered" });
  return { gatewayId: String(g._id), heartbeatSeconds: 30, fingerprint: g.publicKeyFingerprint };
}

// ------------------------------------------------------------------------------------------------ per-request authentication
/** Returns { gateway } or { error, status }. orgId for everything that follows is gateway.orgId, never anything the request says. */
export async function authenticateGateway({ method, path, headers, rawBody }) {
  const get = (n) => (typeof headers?.get === "function" ? headers.get(n) : headers?.[n]);
  const gid = get("x-inaya-gateway"), ts = get("x-inaya-timestamp"), nonce = get("x-inaya-nonce"), sig = get("x-inaya-signature");
  if (!gid || !ts || !nonce || !sig || !/^[0-9a-f]{24}$/.test(gid) || String(nonce).length < 12 || String(nonce).length > 80) return { error: "Gateway signature headers are required.", status: 401 };
  const t = Number(ts); if (!Number.isFinite(t) || Math.abs(Date.now() - t) > CLOCK_WINDOW_MS) return { error: "The request timestamp is outside the allowed window.", status: 401 };
  const c = await gwCols(); const g = await c.gateways.findOne({ _id: new ObjectId(gid) });
  if (!g || g.status !== "active" || g.revokedAt) return { error: "This gateway is not active.", status: 401, revoked: !!g?.revokedAt };
  const pub = publicKeyOf(g.publicKey); if (!pub || !checkSig(pub, signingString({ method, path, ts, nonce, body: rawBody }), sig)) return { error: "The signature is not valid.", status: 401 };
  try { await c.nonces.insertOne({ gatewayId: g._id, nonce, expiresAt: new Date(Date.now() + 2 * CLOCK_WINDOW_MS) }); } catch (e) { if (e?.code === 11000) return { error: "That request was already used.", status: 401 }; throw e; }
  return { gateway: g };
}

// ------------------------------------------------------------------------------------------------ heartbeat and desired configuration
const folderView = (f) => ({ folderId: f.folderId, path: f.path, label: f.label });
const connectorView = (k) => ({ connectorId: String(k._id), name: k.name, type: k.type, rootPath: k.rootPath, enabled: k.enabled !== false, folders: (k.folders || []).map(folderView) });
const cfgHash = (list) => sha(JSON.stringify(list)).slice(0, 16);

export async function heartbeat({ gateway, report = {} }) {
  import("../metrics/metrics.js").then((m) => m.metric("gateway.heartbeat", { orgId: gateway.orgId })).catch(() => {});
  const c = await gwCols(); const n = (v, max = 1e9) => Math.max(0, Math.min(max, Number(v) || 0));
  const conns = Array.isArray(report.connectors) ? report.connectors.slice(0, 50).map((x) => ({ connectorId: String(x.connectorId || "").slice(0, 24), status: ["ok", "degraded", "error", "disabled"].includes(x.status) ? x.status : "error", lastError: x.lastError ? String(x.lastError).slice(0, 200) : null, lastScanAt: x.lastScanAt || null })) : [];
  const health = { connectors: conns, queueDepth: n(report.queueDepth), lagSeconds: n(report.lagSeconds, 86400 * 365), aclFailures: n(report.aclFailures), uptimeSeconds: n(report.uptimeSeconds, 86400 * 3650), bandwidthKbps: report.bandwidthKbps == null ? null : n(report.bandwidthKbps), at: nowIso() };
  const desired = (await c.connectors.find({ orgId: gateway.orgId, gatewayId: gateway._id }).toArray()).map(connectorView);
  const configVersion = cfgHash(desired);
  const commands = (gateway.commands || []).filter((x) => !x.deliveredAt);
  const kept = (gateway.commands || []).map((x) => ({ ...x, deliveredAt: x.deliveredAt || nowIso() })).slice(-30);
  await c.gateways.updateOne({ _id: gateway._id }, { $set: { lastSeenAt: nowIso(), version: String(report.version || gateway.version).slice(0, 40), platform: String(report.platform || gateway.platform).slice(0, 40), capabilities: Array.isArray(report.capabilities) ? [...new Set(report.capabilities.map((x) => String(x).slice(0, 40)))].slice(0, 30) : gateway.capabilities, health, configVersion, commands: kept } });
  const pendingTransfers = await c.transfers.find({ orgId: gateway.orgId, gatewayId: gateway._id, status: { $in: ["requested", "uploading"] } }).project({ path: 1, connectorId: 1, folderId: 1, status: 1, size: 1 }).limit(20).toArray();
  return { serverTime: nowIso(), configVersion, connectors: desired, commands: commands.map((x) => ({ commandId: x.commandId, type: x.type, args: x.args || {} })), transfers: pendingTransfers.map((t) => ({ transferId: String(t._id), connectorId: String(t.connectorId), folderId: t.folderId, path: t.path, status: t.status })), heartbeatSeconds: 30 };
}

const COMMANDS = ["rescan", "acl_refresh", "upgrade", "rollback"];
export async function queueCommand({ orgId, membership, actorEmail, gatewayId, type, args = {} }) {
  mustManage(membership); if (!COMMANDS.includes(type)) fail(400, `type must be one of ${COMMANDS.join(", ")}.`);
  const c = await gwCols(); const g = await c.gateways.findOne({ _id: oid(gatewayId, "Gateway not found."), orgId: toObjectId(orgId), status: "active" }); if (!g) fail(404, "Gateway not found.");
  const commandId = randomBytes(8).toString("hex"); await c.gateways.updateOne({ _id: g._id }, { $push: { commands: { commandId, type, args, at: nowIso(), by: actorEmail } } });
  await record(orgId, g._id, actorEmail, "COMMAND_QUEUED", { type }); return { commandId, type };
}

// ------------------------------------------------------------------------------------------------ views and revocation
export const statusOf = (g, now = Date.now()) => (g.status === "revoked" || g.revokedAt ? "REVOKED" : !g.lastSeenAt ? "NEVER_CONNECTED" : now - new Date(g.lastSeenAt).getTime() <= ONLINE_WITHIN_MS ? "ONLINE" : "OFFLINE");
const view = (g) => ({ gatewayId: String(g._id), label: g.label, mode: g.mode, status: statusOf(g), registeredAt: g.registeredAt, lastSeenAt: g.lastSeenAt, version: g.version, platform: g.platform, capabilities: g.capabilities, fingerprint: g.publicKeyFingerprint, health: g.health, revokedAt: g.revokedAt, pendingCommands: (g.commands || []).filter((x) => !x.deliveredAt).length });
export async function listGateways({ orgId, membership }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can see gateways.");
  const c = await gwCols(); const rows = await c.gateways.find({ orgId: toObjectId(orgId) }).sort({ registeredAt: -1 }).limit(100).toArray(); return { gateways: rows.map(view) };
}
export async function getGateway({ orgId, membership, gatewayId }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can see gateways.");
  const c = await gwCols(); const g = await c.gateways.findOne({ _id: oid(gatewayId, "Gateway not found."), orgId: toObjectId(orgId) }); if (!g) fail(404, "Gateway not found.");
  const connectors = (await c.connectors.find({ gatewayId: g._id, orgId: g.orgId }).toArray()).map(connectorView); return { ...view(g), connectors };
}
export async function revokeGateway({ orgId, membership, actorEmail, gatewayId, reason = null }) {
  mustManage(membership); const c = await gwCols();
  const g = await c.gateways.findOneAndUpdate({ _id: oid(gatewayId, "Gateway not found."), orgId: toObjectId(orgId), revokedAt: null }, { $set: { status: "revoked", revokedAt: nowIso(), revokedBy: actorEmail, revokeReason: reason ? String(reason).slice(0, 200) : null, commands: [] } }, { returnDocument: "after" });
  if (!g) fail(404, "Gateway not found, or already revoked.");
  const cancelled = await c.transfers.updateMany({ gatewayId: g._id, status: { $in: ["requested", "uploading"] } }, { $set: { status: "cancelled", cancelledAt: nowIso() } });
  await c.nonces.deleteMany({ gatewayId: g._id });
  await record(orgId, g._id, actorEmail, "GATEWAY_REVOKED", { reason: g.revokeReason, transfersCancelled: cancelled.modifiedCount }); emit(orgId, { gatewayId: String(g._id), event: "revoked" });
  return { revoked: true, transfersCancelled: cancelled.modifiedCount };
}

// ------------------------------------------------------------------------------------------------ connectors and approved folders (administrator side)
const cleanRel = (p) => { const s = String(p ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); if (!s || s.split("/").some((x) => x === ".." || x === "." || x === "" || /[\u0000-\u001f]/.test(x))) return null; return s.slice(0, 400); };
export const relativePath = cleanRel;
const cleanRoot = (p) => { const s = String(p ?? "").trim(); return s && s.length <= 500 && !/[\u0000-\u001f]/.test(s) ? s : null; };

export async function upsertConnector({ orgId, membership, actorEmail, gatewayId, connectorId = null, name, type, rootPath, folders, enabled = true }) {
  mustManage(membership); if (!CONNECTOR_TYPES.includes(type)) fail(400, `type must be one of ${CONNECTOR_TYPES.join(", ")}.`);
  const c = await gwCols(); const g = await c.gateways.findOne({ _id: oid(gatewayId, "Gateway not found."), orgId: toObjectId(orgId), status: "active" }); if (!g) fail(404, "Gateway not found.");
  const root = cleanRoot(rootPath); if (!root) fail(400, "rootPath is required (a path as the gateway sees it, such as D:\\Shares or \\\\fileserver\\finance).");
  const list = (Array.isArray(folders) ? folders : []).slice(0, 100).map((f) => ({ folderId: f.folderId && /^[0-9a-f]{24}$/.test(f.folderId) ? f.folderId : String(new ObjectId()), path: cleanRel(f.path), label: String(f.label || f.path || "").slice(0, 80) }));
  if (list.some((f) => !f.path)) fail(400, "Every approved folder needs a relative path with no '..'.");
  if (new Set(list.map((f) => f.path.toLowerCase())).size !== list.length) fail(400, "Approved folders must be unique.");
  const doc = { orgId: g.orgId, gatewayId: g._id, name: String(name || type).trim().slice(0, 80), type, rootPath: root, folders: list, enabled: !!enabled, updatedAt: nowIso() };
  let id;
  if (connectorId) { id = oid(connectorId, "Connector not found."); const r = await c.connectors.updateOne({ _id: id, orgId: g.orgId, gatewayId: g._id }, { $set: doc }); if (!r.matchedCount) fail(404, "Connector not found."); }
  else { id = new ObjectId(); await c.connectors.insertOne({ _id: id, ...doc, createdAt: nowIso(), createdBy: actorEmail }); }
  await record(orgId, g._id, actorEmail, connectorId ? "CONNECTOR_UPDATED" : "CONNECTOR_CREATED", { connectorId: String(id), type, folders: list.length });
  return connectorView({ _id: id, ...doc });
}
export async function removeConnector({ orgId, membership, actorEmail, gatewayId, connectorId }) {
  mustManage(membership); const c = await gwCols(); const id = oid(connectorId, "Connector not found.");
  const r = await c.connectors.deleteOne({ _id: id, orgId: toObjectId(orgId), gatewayId: oid(gatewayId, "Gateway not found.") }); if (!r.deletedCount) fail(404, "Connector not found.");
  await c.inventory.deleteMany({ orgId: toObjectId(orgId), connectorId: id }); await record(orgId, new ObjectId(gatewayId), actorEmail, "CONNECTOR_REMOVED", { connectorId }); return { removed: true };
}

// ------------------------------------------------------------------------------------------------ inventory (the agent lists local files; metadata only)
const MAX_ENTRIES = 2000;
export async function recordInventory({ gateway, connectorId, folderId, entries, scanId = null, complete = false }) {
  const c = await gwCols(); const k = await c.connectors.findOne({ _id: oid(connectorId, "Connector not found."), orgId: gateway.orgId, gatewayId: gateway._id });
  if (!k) fail(404, "Connector not found."); const folder = (k.folders || []).find((f) => f.folderId === folderId); if (!folder) fail(403, "That folder is not approved for this connector.");
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) fail(400, `entries must be a list of at most ${MAX_ENTRIES}.`);
  const seenAt = nowIso(); const ops = []; let rejected = 0;
  for (const e of entries) {
    const p = cleanRel(e?.path); if (!p) { rejected++; continue; }
    ops.push({ updateOne: { filter: { gatewayId: gateway._id, connectorId: k._id, folderId, path: p }, update: { $set: { orgId: gateway.orgId, name: p.split("/").pop(), size: Math.max(0, Number(e.size) || 0), mtime: e.mtime ? new Date(e.mtime).toISOString() : null, isDir: !!e.isDir, sha256: /^[0-9a-f]{64}$/.test(e.sha256 || "") ? e.sha256 : null, classification: e.classification ? String(e.classification).slice(0, 40) : null, scanId: scanId || null, seenAt } }, upsert: true } });
  }
  if (ops.length) await c.inventory.bulkWrite(ops, { ordered: false });
  let removed = 0; if (complete && scanId) removed = (await c.inventory.deleteMany({ gatewayId: gateway._id, connectorId: k._id, folderId, scanId: { $ne: scanId } })).deletedCount;
  return { accepted: ops.length, rejected, removed };
}
export async function listInventory({ orgId, membership, actorEmail, connectorId, folderId, prefix = "", limit = 200, audit = true }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can list gateway inventory.");
  const c = await gwCols(); const q = { orgId: toObjectId(orgId), connectorId: oid(connectorId, "Connector not found."), folderId: String(folderId) };
  const pre = prefix ? cleanRel(prefix) : null; if (prefix && !pre) fail(400, "prefix is not valid."); if (pre) q.path = { $regex: `^${pre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)` };
  const rows = await c.inventory.find(q).sort({ path: 1 }).limit(Math.min(Number(limit) || 200, 500)).toArray();
  if (audit) await record(orgId, rows[0]?._id || new ObjectId(), actorEmail, "ADMIN_INVENTORY_VIEWED", { folderId: String(folderId), count: rows.length });
  return { items: rows.map((r) => ({ entryId: String(r._id), path: r.path, name: r.name, size: r.size, mtime: r.mtime, isDir: r.isDir, classification: r.classification })) };
}

// ------------------------------------------------------------------------------------------------ forwarded audit events (tamper-evident, anchored in the organization's own chain)
const stable = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`);
export const stableStringify = stable;
export const eventHash = ({ prevHash, seq, at, type, detail }) => sha(`${prevHash}|${seq}|${at}|${type}|${stable(detail ?? {})}`);
export const GENESIS = "0".repeat(64);

export async function recordAuditEvents({ gateway, events }) {
  const c = await gwCols(); if (!Array.isArray(events) || !events.length || events.length > 500) fail(400, "events must be a list of 1 to 500.");
  const last = await c.audit.find({ gatewayId: gateway._id }).sort({ seq: -1 }).limit(1).next(); let seq = last ? last.seq : 0; let prev = last ? last.hash : GENESIS; let accepted = 0;
  for (const e of events) {
    if (e.seq <= seq) continue; // a retry of events Inaya already holds
    if (e.seq !== seq + 1) fail(409, `Expected event ${seq + 1}, received ${e.seq}.`, { expectedSeq: seq + 1 });
    if (e.prevHash !== prev) fail(409, "The event chain does not continue from the last event Inaya holds.", { expectedSeq: seq + 1 });
    const type = String(e.type || "").slice(0, 60); const detail = e.detail && typeof e.detail === "object" ? e.detail : {}; if (JSON.stringify(detail).length > 4000) fail(400, "An event detail is too large.");
    if (eventHash({ prevHash: prev, seq: e.seq, at: e.at, type, detail }) !== e.hash) fail(409, "An event hash does not match its content.", { expectedSeq: seq + 1 });
    await c.audit.insertOne({ orgId: gateway.orgId, gatewayId: gateway._id, seq: e.seq, at: String(e.at), type, detail, prevHash: prev, hash: e.hash, receivedAt: nowIso() }); seq = e.seq; prev = e.hash; accepted++;
  }
  if (accepted) await record(gateway.orgId, gateway._id, "gateway:" + String(gateway._id), "AUDIT_ANCHORED", { upToSeq: seq, head: prev, events: accepted });
  return { accepted, head: prev, seq };
}
export async function verifyGatewayAudit({ orgId, membership, gatewayId }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can verify gateway events.");
  const c = await gwCols(); const id = oid(gatewayId, "Gateway not found."); let prev = GENESIS, n = 0;
  for await (const e of c.audit.find({ orgId: toObjectId(orgId), gatewayId: id }).sort({ seq: 1 })) { n++; if (e.seq !== n || e.prevHash !== prev || eventHash({ prevHash: prev, seq: e.seq, at: e.at, type: e.type, detail: e.detail }) !== e.hash) return { valid: false, brokenAt: e.seq, checked: n }; prev = e.hash; }
  return { valid: true, checked: n, head: prev };
}
export async function listGatewayAudit({ orgId, membership, gatewayId, limit = 50 }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can read gateway events.");
  const c = await gwCols(); const rows = await c.audit.find({ orgId: toObjectId(orgId), gatewayId: oid(gatewayId, "Gateway not found.") }).sort({ seq: -1 }).limit(Math.min(Number(limit) || 50, 200)).toArray();
  return { events: rows.map((e) => ({ seq: e.seq, at: e.at, type: e.type, detail: e.detail })) };
}
