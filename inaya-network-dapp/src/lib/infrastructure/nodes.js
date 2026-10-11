// src/lib/infrastructure/nodes.js
//
// Sovereign Infrastructure Fabric SOW: cluster + node lifecycle (§41-44,
// §108, §126, §227). Phase 1 scope only — compute/block/network come in
// later phases and live in their own files once built, never bolted onto
// this one.
//
// HONEST ARCHITECTURE NOTE on §41's "use mTLS between infrastructure
// components": this holds for node<->message-fabric (the fabric is a
// self-run NATS broker we fully control, so real TLS client-cert
// negotiation is available there, wired up starting Phase 2). It does NOT
// hold for node->this Next.js control plane specifically, because that
// path is served through Vercel's edge, which does not expose custom
// client-certificate (mTLS) verification to serverless routes — the same
// real platform constraint that already shaped Secure Chat and Meet's
// transport choices earlier in this project (no persistent WebSockets
// either). The cryptographic property mTLS provides here — proof that the
// caller holds the private key matching a certificate the server trusts —
// is instead achieved over plain HTTPS via request signing: the node signs
// a short-lived token with its own certified private key, the server
// verifies that signature against the node's stored certificate. Same
// guarantee, different transport mechanics, stated plainly rather than
// claiming literal TLS-layer mTLS where the platform cannot deliver it.

import crypto from "node:crypto";
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { getOrgCollections } from "../orgs.js";
import { signNodeCsr, getOrCreateClusterCa, SIGNING_ALGORITHM } from "./nodeCerts.js";

x509.cryptoProvider.set(globalThis.crypto);

export class InfrastructureError extends Error {
  constructor(message, { status = 400, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ENROLLMENT_TOKEN_BYTES = 32;
const ENROLLMENT_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes — matches §42's "explicit enrollment" intent, not a universal static secret
const AUTH_TOKEN_MAX_SKEW_MS = 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

let indexed = false;
async function cols() {
  const c = await getOrgCollections();
  const clusters = c.db.collection("infra_clusters");
  const enrollmentTokens = c.db.collection("infra_enrollment_tokens");
  const nodes = c.db.collection("infra_nodes");
  if (!indexed) {
    await Promise.all([
      clusters.createIndex({ orgId: 1 }),
      enrollmentTokens.createIndex({ tokenHash: 1 }, { unique: true }),
      enrollmentTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      nodes.createIndex({ orgId: 1, clusterId: 1 }),
      nodes.createIndex({ nodeId: 1 }, { unique: true }),
      nodes.createIndex({ certificateSerial: 1 }),
    ]);
    indexed = true;
  }
  return { c, clusters, enrollmentTokens, nodes };
}

// ---------------------------------------------------------------------------
// Clusters (SOW §44) — Phase 1 only tracks what's needed for node join;
// scheduler/capability/policy fields are added starting Phase 5.
// ---------------------------------------------------------------------------

export async function createCluster({ orgId, membership, name, mode = "DEVELOPMENT" }) {
  const VALID_MODES = ["DEVELOPMENT", "SINGLE_NODE", "EDGE", "HA", "AIR_GAPPED", "REGULATED", "AI_GPU"];
  if (!VALID_MODES.includes(mode)) throw new InfrastructureError(`Unknown cluster mode "${mode}".`, { status: 400 });
  const { clusters } = await cols();
  const clusterId = crypto.randomUUID();
  const doc = {
    clusterId,
    orgId,
    name: name || "Default Cluster",
    mode,
    status: "ACTIVE",
    nodeIds: [],
    createdAt: new Date(),
    createdBy: membership?.email || null,
  };
  await clusters.insertOne(doc);
  return doc;
}

export async function listClusters({ orgId }) {
  const { clusters } = await cols();
  return clusters.find({ orgId }).sort({ createdAt: -1 }).toArray();
}

export async function getCluster({ orgId, clusterId }) {
  const { clusters } = await cols();
  const cluster = await clusters.findOne({ orgId, clusterId });
  if (!cluster) throw new InfrastructureError("Cluster not found.", { status: 404 });
  return cluster;
}

// ---------------------------------------------------------------------------
// Enrollment (SOW §42) — "cluster creates enrollment token -> node proves
// possession -> node certificate issued -> node appears PENDING -> admin
// approves if required -> node becomes ACTIVE."
// ---------------------------------------------------------------------------

export async function createEnrollmentToken({ orgId, membership, clusterId }) {
  await getCluster({ orgId, clusterId }); // 404s if the caller doesn't own this cluster
  const { enrollmentTokens } = await cols();
  const token = crypto.randomBytes(ENROLLMENT_TOKEN_BYTES).toString("base64url");
  await enrollmentTokens.insertOne({
    tokenHash: hashToken(token),
    orgId,
    clusterId,
    createdBy: membership?.email || null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS),
    usedAt: null,
  });
  // Returned exactly once, like every other bearer token in this codebase
  // (share links, API keys) — never retrievable again, never logged.
  return { token, expiresAt: new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS) };
}

/** Public, token-authenticated — a node has no org session. Mirrors
 *  api-keys.js:requireApiKey's "identity derives only from the credential
 *  itself" discipline: the caller never gets to assert its own orgId. */
export async function enrollNode({ enrollmentToken, hostname, csrPem }) {
  if (!enrollmentToken || !hostname || !csrPem) {
    throw new InfrastructureError("enrollmentToken, hostname, and csrPem are all required.", { status: 400 });
  }
  const { enrollmentTokens, nodes } = await cols();
  const record = await enrollmentTokens.findOne({ tokenHash: hashToken(enrollmentToken) });
  if (!record) throw new InfrastructureError("Invalid or expired enrollment token.", { status: 401 });
  if (record.usedAt) throw new InfrastructureError("This enrollment token has already been used.", { status: 409 });
  if (record.expiresAt < new Date()) throw new InfrastructureError("This enrollment token has expired.", { status: 401 });

  const nodeId = crypto.randomUUID();
  let signed;
  try {
    signed = await signNodeCsr({ clusterId: record.clusterId, orgId: record.orgId, nodeId, csrPem });
  } catch (err) {
    throw new InfrastructureError(`CSR rejected: ${err.message}`, { status: 400 });
  }

  // Single-use: mark the token used in the same step a node is created from
  // it, so a replayed enrollment request cannot mint a second node.
  const claim = await enrollmentTokens.updateOne(
    { _id: record._id, usedAt: null },
    { $set: { usedAt: new Date() } }
  );
  if (claim.modifiedCount !== 1) {
    throw new InfrastructureError("This enrollment token has already been used.", { status: 409 });
  }

  const nodeDoc = {
    nodeId,
    orgId: record.orgId,
    clusterId: record.clusterId,
    hostname,
    status: "PENDING",
    certificatePem: signed.certificatePem,
    certificateSerial: signed.certificateSerial,
    issuedAt: signed.issuedAt,
    expiresAt: signed.expiresAt,
    revokedAt: null,
    joinedAt: new Date(),
    lastHeartbeatAt: null,
    capacity: null,
    runtimeVersion: null,
    kernelVersion: null,
    qemuVersion: null,
  };
  await nodes.insertOne(nodeDoc);
  await (await cols()).clusters.updateOne({ clusterId: record.clusterId }, { $addToSet: { nodeIds: nodeId } });

  return {
    nodeId,
    status: "PENDING",
    certificatePem: signed.certificatePem,
    caCertificatePem: signed.caCertificatePem,
  };
}

export async function approveNode({ orgId, membership, nodeId }) {
  const { nodes } = await cols();
  const node = await nodes.findOne({ orgId, nodeId });
  if (!node) throw new InfrastructureError("Node not found.", { status: 404 });
  if (node.status === "REVOKED") throw new InfrastructureError("Cannot approve a revoked node.", { status: 409 });
  await nodes.updateOne({ orgId, nodeId }, { $set: { status: "ACTIVE", approvedAt: new Date(), approvedBy: membership?.email || null } });
  return { ...node, status: "ACTIVE" };
}

export async function revokeNode({ orgId, membership, nodeId }) {
  const { nodes } = await cols();
  const node = await nodes.findOne({ orgId, nodeId });
  if (!node) throw new InfrastructureError("Node not found.", { status: 404 });
  await nodes.updateOne({ orgId, nodeId }, { $set: { status: "REVOKED", revokedAt: new Date(), revokedBy: membership?.email || null } });
  return { ...node, status: "REVOKED", revokedAt: new Date() };
}

export async function listNodes({ orgId, clusterId }) {
  const { nodes } = await cols();
  const query = clusterId ? { orgId, clusterId } : { orgId };
  return nodes.find(query).sort({ joinedAt: -1 }).toArray();
}

export async function getNode({ orgId, nodeId }) {
  const { nodes } = await cols();
  const node = await nodes.findOne({ orgId, nodeId });
  if (!node) throw new InfrastructureError("Node not found.", { status: 404 });
  return node;
}

// ---------------------------------------------------------------------------
// Node request authentication (see the architecture note at the top of this
// file) — verifies a node-signed token against its stored, non-revoked
// certificate before any node->control-plane call (heartbeat, etc.) is
// trusted.
// ---------------------------------------------------------------------------

/** `signedToken` shape: base64url(JSON{nodeId,iat}) + "." + base64url(RSA-SHA256 signature over that JSON). */
export async function verifyNodeAuth({ signedToken }) {
  if (typeof signedToken !== "string" || !signedToken.includes(".")) {
    throw new InfrastructureError("Malformed node auth token.", { status: 401 });
  }
  const [payloadB64, sigB64] = signedToken.split(".");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new InfrastructureError("Malformed node auth token payload.", { status: 401 });
  }
  const { nodeId, iat } = payload;
  if (!nodeId || typeof iat !== "number") throw new InfrastructureError("Malformed node auth token payload.", { status: 401 });
  if (Math.abs(Date.now() - iat) > AUTH_TOKEN_MAX_SKEW_MS) {
    throw new InfrastructureError("Node auth token is too old or clock-skewed.", { status: 401, code: "CLOCK_SKEW" });
  }

  const { nodes } = await cols();
  const node = await nodes.findOne({ nodeId });
  if (!node) throw new InfrastructureError("Unknown node.", { status: 401 });
  if (node.status === "REVOKED") throw new InfrastructureError("This node's certificate has been revoked.", { status: 403, code: "NODE_REVOKED" });
  if (new Date(node.expiresAt) < new Date()) throw new InfrastructureError("This node's certificate has expired.", { status: 403, code: "CERT_EXPIRED" });

  const cert = new x509.X509Certificate(node.certificatePem);
  const publicKey = await cert.publicKey.export();
  // JWT-style: the signature covers the base64url-encoded payload STRING's
  // own ASCII bytes, not the decoded JSON underneath — matches exactly
  // what the Rust node's sign_auth_token() signs.
  const payloadBytes = Buffer.from(payloadB64, "utf8");
  const sigBytes = Buffer.from(sigB64, "base64url");
  const signatureValid = await globalThis.crypto.subtle.verify(SIGNING_ALGORITHM, publicKey, sigBytes, payloadBytes);
  if (!signatureValid) throw new InfrastructureError("Node auth signature verification failed.", { status: 401 });

  return { node, orgId: node.orgId, clusterId: node.clusterId };
}

// ---------------------------------------------------------------------------
// Heartbeat (SOW §15, §40, §107, §126)
// ---------------------------------------------------------------------------

export async function recordHeartbeat({ signedToken, capacity, runtimeVersion, kernelVersion, qemuVersion, clockOffsetMs }) {
  const { node, orgId } = await verifyNodeAuth({ signedToken });
  const { nodes } = await cols();
  const now = new Date();
  await nodes.updateOne(
    { orgId, nodeId: node.nodeId },
    {
      $set: {
        lastHeartbeatAt: now,
        capacity: capacity || null,
        runtimeVersion: runtimeVersion || null,
        kernelVersion: kernelVersion || null,
        qemuVersion: qemuVersion || null,
        clockOffsetMs: typeof clockOffsetMs === "number" ? clockOffsetMs : null,
      },
    }
  );
  return { ok: true, receivedAt: now };
}

/** SOW §108: a node that stops renewing eventually reads as UNAVAILABLE,
 *  never relying solely on HTTP reachability of a long-dead heartbeat. */
export function deriveNodeHealth(node, { staleAfterMs = 90_000 } = {}) {
  if (node.status === "REVOKED") return "REVOKED";
  if (node.status === "PENDING") return "PENDING";
  if (!node.lastHeartbeatAt) return "UNKNOWN";
  const age = Date.now() - new Date(node.lastHeartbeatAt).getTime();
  return age > staleAfterMs ? "UNAVAILABLE" : "ACTIVE";
}

export async function getClusterCaCertificate({ orgId, clusterId }) {
  const ca = await getOrCreateClusterCa({ clusterId, orgId });
  return ca.caCertificatePem;
}
