// src/lib/signing-workflow.js
//
// Four High-Impact Business Workspace Extensions SOW — Feature 1: Inaya Sign.
//
// STATUS — Live: wallet-signature signing, session-authenticated-consent
// signing, document versioning, tamper detection, the append-only audit
// trail, and an optional on-chain completion anchor (reusing the existing
// custody contract's batchRegisterAssets call + the existing pinning-
// provider registry — no new contract). Planned, not built: real WebAuthn/
// FIDO2 passkey signing — no such infrastructure exists anywhere in this
// codebase today (MFA is TOTP/SMS only; every "passkey" reference elsewhere
// means the client-side AES-GCM encryption passphrase, unrelated to FIDO2).
// Adding it would mean a new @simplewebauthn dependency and credential-
// registration flow — a separate scope.
//
// BINDING: a signature binds SIGNER + DOCUMENT VERSION + DOCUMENT HASH +
// TIMESTAMP + AUDIT RECORD. Every signature check re-reads the document's
// CURRENT fileHash and compares it against the hash the request was bound
// to at creation — never a cached "still valid" flag — so a document
// edited after a request was sent can never be signed against stale
// content, and a signature from one version can never carry over to
// another (see supersedeActiveSigningRequests()).
//
// VERSIONING: additive fields on org_documents (documentGroupId, version,
// supersedesId) — the existing globally-unique fileHash index is untouched;
// a "new version" is simply a new document row linked by documentGroupId,
// never an in-place edit of the old one (org_documents rows are otherwise
// immutable once registered on-chain).

import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { getDocumentAccessLevel, meetsLevel } from "./document-permissions.js";
import { logOrgActivity } from "./org-activity-log.js";
import { verifyChainIntegrity } from "./auditChain.js";
import { getProvider, listAvailableProviders } from "./pinningProviders/index.js";

export const SIGNING_STATES = ["DRAFT", "SENT", "PARTIALLY_SIGNED", "FULLY_SIGNED", "REJECTED", "EXPIRED", "REVOKED", "SUPERSEDED"];
const ACTIVE_STATES = ["DRAFT", "SENT", "PARTIALLY_SIGNED"];
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // same freshness window as nodeAuth.js/metadata-auth.js/watcherPioneer.js

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888"; // same live contract api/orgs/documents/route.js already registers hashes on
const CUSTODY_ABI = [
  "function batchRegisterAssets(bytes32[] fileHashes, uint256[] fileSizes, string[] shardACIDs, string[] shardBCIDs) external",
];

function sha256Hex(str) {
  return "0x" + createHash("sha256").update(str, "utf8").digest("hex");
}
function canonicalJSON(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// ============================================================
// Wallet-signature convention — copies nodeAuth.js/metadata-auth.js/
// watcherPioneer.js's exact discipline (canonical newline-joined message,
// ethers.verifyMessage, 5-minute freshness window) under its own message
// prefix, per those files' own convention of never sharing message formats
// across domains.
// ============================================================

export function buildInayaSignMessage({ action, requestId, documentHash, timestamp }) {
  return ["Inaya Sign Action", `action: ${action}`, `requestId: ${requestId}`, `documentHash: ${documentHash}`, `timestamp: ${timestamp}`].join("\n");
}

export function verifyInayaSignSignature({ action, requestId, documentHash, walletAddress, message, signature, timestamp }) {
  if (!walletAddress || !message || !signature || typeof timestamp !== "number") {
    throw new Error("Missing signature fields — walletAddress, message, signature, and timestamp are all required.");
  }
  if (Date.now() - timestamp > MAX_SIGNATURE_AGE_MS) {
    throw new Error("Signature expired — please retry.");
  }
  const expected = buildInayaSignMessage({ action, requestId, documentHash, timestamp });
  if (message !== expected) {
    throw new Error("Signed message doesn't match the request fields — possible tampering.");
  }
  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("Signature does not match the claimed wallet.");
  }
}

function isSigningActive(request) {
  return ACTIVE_STATES.includes(request.status);
}

function normalizeSigners(rawSigners) {
  if (!Array.isArray(rawSigners) || rawSigners.length === 0) return { error: "At least one signer is required." };
  const signers = [];
  for (const s of rawSigners) {
    const email = s.email ? String(s.email).trim().toLowerCase() : null;
    const wallet = s.wallet ? String(s.wallet).trim().toLowerCase() : null;
    if (!email && !wallet) return { error: "Each signer needs an email or a wallet address." };
    signers.push({
      email, wallet,
      role: s.role === "optional" ? "optional" : "required",
      order: Number.isFinite(s.order) ? s.order : signers.length,
      status: "PENDING",
      signedAt: null,
      method: null,
      signatureRef: null,
    });
  }
  return { signers };
}

/** Creates a DRAFT signing request bound to the document's CURRENT version.
 *  Requires EDIT-level access on the document — same bar
 *  document-workflow.js's submit/revise transitions already require, since
 *  starting a signature process is at least as consequential as editing. */
export async function createSigningRequest({ orgId, documentId, signers: rawSigners, deadline, message, membership, actorEmail }) {
  const { orgDocuments, signingRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const documentObjectId = toObjectId(documentId);

  const doc = await orgDocuments.findOne({ _id: documentObjectId, orgId: orgObjectId, deletedAt: null });
  if (!doc) return { error: "Document not found.", status: 404 };

  const accessLevel = await getDocumentAccessLevel({ orgId, doc, membership, email: actorEmail });
  if (!meetsLevel(accessLevel, "EDIT")) {
    return { error: "You don't have permission to request signatures on this document.", status: 403 };
  }

  const { signers, error: signersError } = normalizeSigners(rawSigners);
  if (signersError) return { error: signersError, status: 400 };

  const now = new Date().toISOString();
  const result = await signingRequests.insertOne({
    orgId: orgObjectId,
    documentId: documentObjectId,
    documentGroupId: doc.documentGroupId || documentObjectId,
    documentVersion: doc.version || 1,
    documentHash: doc.fileHash,
    status: "DRAFT",
    signers,
    deadline: deadline || null,
    message: message ? String(message).trim() : null,
    createdByEmail: actorEmail,
    createdAt: now,
    sentAt: null,
    completedAt: null,
    anchorTxHash: null,
    anchorCertificateHash: null,
    anchorCid: null,
  });

  await logOrgActivity({
    orgId: orgObjectId, recordType: "SIGNING_REQUEST", recordId: result.insertedId, actorEmail,
    action: "SIGNING_REQUEST_CREATED", previousState: null, newState: "DRAFT",
    metadata: { documentId, signerCount: signers.length },
  });

  return { requestId: result.insertedId };
}

export async function sendSigningRequest({ orgId, requestId, actorEmail }) {
  const { signingRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const updated = await signingRequests.findOneAndUpdate(
    { _id: toObjectId(requestId), orgId: orgObjectId, status: "DRAFT" },
    { $set: { status: "SENT", sentAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This request isn't in DRAFT state (already sent, or doesn't exist).", status: 409 };
  await logOrgActivity({ orgId: orgObjectId, recordType: "SIGNING_REQUEST", recordId: updated._id, actorEmail, action: "SIGNING_REQUEST_SENT", previousState: "DRAFT", newState: "SENT", metadata: {} });
  return { request: updated };
}

/** The core per-signer action. Two real methods:
 *   - "wallet": a fresh ethers signature over buildInayaSignMessage(), verified here.
 *   - "session_consent": the signer's own authenticated session plus an explicit
 *     typed-name consent — recorded and LABELED as consent, never presented as
 *     cryptographically equivalent to a wallet signature.
 *  Re-validates the document's CURRENT hash against the hash this request was
 *  bound to at creation before accepting any signature — the tamper/version
 *  binding the SOW requires. */
export async function recordSignature({ orgId, requestId, signerIdentity, method, proof, actorEmail }) {
  const { signingRequests, orgDocuments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requestObjectId = toObjectId(requestId);

  const request = await signingRequests.findOne({ _id: requestObjectId, orgId: orgObjectId });
  if (!request) return { error: "Signing request not found.", status: 404 };

  if (request.deadline && new Date(request.deadline).getTime() < Date.now() && request.status !== "EXPIRED") {
    await signingRequests.updateOne({ _id: requestObjectId, status: request.status }, { $set: { status: "EXPIRED" } });
    return { error: "This signing request has expired.", status: 409 };
  }
  if (!isSigningActive(request)) {
    return { error: `This request is ${request.status} and cannot be signed.`, status: 409 };
  }

  const signerEmail = signerIdentity.email ? String(signerIdentity.email).trim().toLowerCase() : null;
  const signerWallet = signerIdentity.wallet ? String(signerIdentity.wallet).trim().toLowerCase() : null;
  const signerIndex = request.signers.findIndex((s) => (signerEmail && s.email === signerEmail) || (signerWallet && s.wallet === signerWallet));
  if (signerIndex === -1) return { error: "You are not a signer on this request.", status: 403 };
  if (request.signers[signerIndex].status === "SIGNED") return { error: "You have already signed this request.", status: 409 };

  // Version/tamper binding — the whole point of this feature.
  const doc = await orgDocuments.findOne({ _id: request.documentId, orgId: orgObjectId });
  if (!doc || doc.fileHash !== request.documentHash) {
    return { error: "The underlying document has changed since this request was created — this request is no longer valid.", status: 409 };
  }

  let signatureRef;
  if (method === "wallet") {
    const { walletAddress, message, signature, timestamp } = proof || {};
    if (!signerWallet || !walletAddress || walletAddress.toLowerCase() !== signerWallet) {
      return { error: "Signature wallet doesn't match the invited signer.", status: 403 };
    }
    try {
      verifyInayaSignSignature({ action: "sign", requestId: requestId.toString(), documentHash: request.documentHash, walletAddress, message, signature, timestamp });
    } catch (err) {
      return { error: err.message, status: 401 };
    }
    signatureRef = signature;
  } else if (method === "session_consent") {
    if (!signerEmail || signerEmail !== actorEmail?.toLowerCase()) {
      return { error: "You must be signed in as the invited signer to consent.", status: 403 };
    }
    if (!proof?.typedName || proof.consent !== true) {
      return { error: "A typed full name and explicit consent are required.", status: 400 };
    }
    signatureRef = `session_consent:${String(proof.typedName).trim()}`;
  } else {
    return { error: `Unknown signing method "${method}".`, status: 400 };
  }

  const now = new Date().toISOString();
  const updatedSigners = request.signers.map((s, i) => (i === signerIndex ? { ...s, status: "SIGNED", signedAt: now, method, signatureRef } : s));
  const requiredSigners = updatedSigners.filter((s) => s.role === "required");
  const allRequiredSigned = requiredSigners.length > 0 && requiredSigners.every((s) => s.status === "SIGNED");
  const newStatus = allRequiredSigned ? "FULLY_SIGNED" : "PARTIALLY_SIGNED";

  const updated = await signingRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: request.status },
    { $set: { signers: updatedSigners, status: newStatus, completedAt: newStatus === "FULLY_SIGNED" ? now : null } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This request was modified concurrently — please retry.", status: 409 };

  await logOrgActivity({
    orgId: orgObjectId, recordType: "SIGNING_REQUEST", recordId: requestObjectId, actorEmail,
    action: "SIGNATURE_RECORDED", previousState: request.status, newState: newStatus,
    metadata: { signerEmail, signerWallet, method },
  });

  return { request: updated, completed: newStatus === "FULLY_SIGNED" };
}

export async function rejectSigningRequest({ orgId, requestId, signerIdentity, reason, actorEmail }) {
  const { signingRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requestObjectId = toObjectId(requestId);
  const request = await signingRequests.findOne({ _id: requestObjectId, orgId: orgObjectId });
  if (!request) return { error: "Signing request not found.", status: 404 };
  if (!isSigningActive(request)) return { error: `This request is ${request.status} and cannot be rejected.`, status: 409 };

  const signerEmail = signerIdentity.email ? String(signerIdentity.email).trim().toLowerCase() : null;
  const signerWallet = signerIdentity.wallet ? String(signerIdentity.wallet).trim().toLowerCase() : null;
  const isSigner = request.signers.some((s) => (signerEmail && s.email === signerEmail) || (signerWallet && s.wallet === signerWallet));
  if (!isSigner) return { error: "You are not a signer on this request.", status: 403 };

  const updated = await signingRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: request.status },
    { $set: { status: "REJECTED", rejectedAt: new Date().toISOString(), rejectionReason: reason ? String(reason).trim() : null } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This request was modified concurrently.", status: 409 };
  await logOrgActivity({ orgId: orgObjectId, recordType: "SIGNING_REQUEST", recordId: requestObjectId, actorEmail, action: "SIGNING_REQUEST_REJECTED", previousState: request.status, newState: "REJECTED", metadata: { reason } });
  return { request: updated };
}

export async function revokeSigningRequest({ orgId, requestId, membership, actorEmail }) {
  const { signingRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requestObjectId = toObjectId(requestId);
  const request = await signingRequests.findOne({ _id: requestObjectId, orgId: orgObjectId });
  if (!request) return { error: "Signing request not found.", status: 404 };
  if (!ACTIVE_STATES.includes(request.status)) return { error: `This request is ${request.status} and cannot be revoked.`, status: 409 };
  if (!canManageOrg(membership) && request.createdByEmail !== actorEmail) {
    return { error: "Only the creator or an org manager can revoke this request.", status: 403 };
  }

  const updated = await signingRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: request.status },
    { $set: { status: "REVOKED", revokedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This request was modified concurrently.", status: 409 };
  await logOrgActivity({ orgId: orgObjectId, recordType: "SIGNING_REQUEST", recordId: requestObjectId, actorEmail, action: "SIGNING_REQUEST_REVOKED", previousState: request.status, newState: "REVOKED", metadata: {} });
  return { request: updated };
}

/** Called when a new document version is uploaded under the same
 *  documentGroupId — any signing request still active against the OLD
 *  version is transitioned to SUPERSEDED, since a signature collected
 *  against one version can never be valid for another. */
export async function supersedeActiveSigningRequests({ orgId, oldDocumentId, actorEmail }) {
  const { signingRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const activeRequests = await signingRequests
    .find({ orgId: orgObjectId, documentId: toObjectId(oldDocumentId), status: { $in: ACTIVE_STATES } })
    .toArray();

  for (const req of activeRequests) {
    const updated = await signingRequests.findOneAndUpdate(
      { _id: req._id, orgId: orgObjectId, status: req.status },
      { $set: { status: "SUPERSEDED", supersededAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );
    if (updated) {
      await logOrgActivity({ orgId: orgObjectId, recordType: "SIGNING_REQUEST", recordId: req._id, actorEmail, action: "SIGNING_REQUEST_SUPERSEDED", previousState: req.status, newState: "SUPERSEDED", metadata: {} });
    }
  }
  return { supersededCount: activeRequests.length };
}

export async function listSigningRequests({ orgId, documentId }) {
  const { signingRequests } = await getOrgCollections();
  const filter = { orgId: toObjectId(orgId) };
  if (documentId) filter.documentId = toObjectId(documentId);
  return signingRequests.find(filter).sort({ createdAt: -1 }).toArray();
}

export async function getSigningRequest({ orgId, requestId }) {
  const { signingRequests } = await getOrgCollections();
  return signingRequests.findOne({ _id: toObjectId(requestId), orgId: toObjectId(orgId) });
}

/** Independent verification — recomputes everything rather than trusting
 *  any stored "verified" flag. Any modified document fails with TAMPERED,
 *  a broken audit chain fails with AUDIT_CHAIN_BROKEN, never silently
 *  passes either. */
export async function verifySigningRequest({ orgId, requestId }) {
  const { signingRequests, orgDocuments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const request = await signingRequests.findOne({ _id: toObjectId(requestId), orgId: orgObjectId });
  if (!request) return { error: "Signing request not found.", status: 404 };

  const doc = await orgDocuments.findOne({ _id: request.documentId, orgId: orgObjectId });
  const hashMatches = !!doc && doc.fileHash === request.documentHash;
  const chainCheck = await verifyChainIntegrity(orgId.toString());

  let result;
  if (!hashMatches) result = "TAMPERED";
  else if (!chainCheck.valid) result = "AUDIT_CHAIN_BROKEN";
  else if (request.status === "FULLY_SIGNED") result = "VALID";
  else result = "INCOMPLETE";

  return {
    result,
    status: request.status,
    documentHash: request.documentHash,
    documentVersion: request.documentVersion,
    currentDocumentHash: doc?.fileHash || null,
    hashMatches,
    auditChainValid: chainCheck.valid,
    signers: request.signers.map((s) => ({ email: s.email, wallet: s.wallet, role: s.role, status: s.status, signedAt: s.signedAt, method: s.method })),
    anchorTxHash: request.anchorTxHash || null,
    anchorCertificateHash: request.anchorCertificateHash || null,
  };
}

/** Optional, real on-chain anchor for a completed request. The document's
 *  OWN hash is already anchored at upload time (api/orgs/documents/route.js
 *  already calls batchRegisterAssets for every uploaded document) — this
 *  registers a NEW, distinct hash for the signing CERTIFICATE (document
 *  hash + every signer's signatureRef + completion time), pinned via the
 *  existing pinning-provider registry, giving the completed signature
 *  event its own real, independently-verifiable on-chain timestamp. No new
 *  contract; reuses the exact batchRegisterAssets call the upload route
 *  already makes. */
export async function anchorSigningRequestOnChain({ orgId, requestId, actorEmail }) {
  const { signingRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const request = await signingRequests.findOne({ _id: toObjectId(requestId), orgId: orgObjectId });
  if (!request) return { error: "Signing request not found.", status: 404 };
  if (request.status !== "FULLY_SIGNED") return { error: "Only a fully-signed request can be anchored on-chain.", status: 409 };
  if (request.anchorTxHash) return { anchorTxHash: request.anchorTxHash, alreadyAnchored: true };

  const providerName = listAvailableProviders()[0];
  if (!providerName) return { error: "No pinning provider is configured — cannot anchor on-chain.", status: 503 };
  if (!process.env.TREASURY_WALLET_PRIVATE_KEY) return { error: "On-chain anchoring is not configured on this server.", status: 503 };

  const certificate = {
    completedAt: request.completedAt,
    documentHash: request.documentHash,
    documentVersion: request.documentVersion,
    signers: request.signers.filter((s) => s.status === "SIGNED").map((s) => ({ identity: s.email || s.wallet, method: s.method, signatureRef: s.signatureRef, signedAt: s.signedAt })),
  };
  const certificateJson = canonicalJSON(certificate);
  const certificateHash = sha256Hex(certificateJson);

  const provider = getProvider(providerName);
  const { cid } = await provider.pin(certificateJson, { name: `inaya-sign-${requestId}.json` });

  const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
  const treasuryWallet = new ethers.Wallet(process.env.TREASURY_WALLET_PRIVATE_KEY, rpcProvider);
  const custody = new ethers.Contract(CUSTODY_ADDRESS, CUSTODY_ABI, treasuryWallet);
  const tx = await custody.batchRegisterAssets([certificateHash], [certificateJson.length], [cid], [cid]);
  await tx.wait();

  await signingRequests.updateOne({ _id: request._id }, { $set: { anchorTxHash: tx.hash, anchorCertificateHash: certificateHash, anchorCid: cid } });
  await logOrgActivity({
    orgId: orgObjectId, recordType: "SIGNING_REQUEST", recordId: request._id, actorEmail,
    action: "SIGNING_REQUEST_ANCHORED", previousState: "FULLY_SIGNED", newState: "FULLY_SIGNED",
    metadata: { anchorTxHash: tx.hash, certificateHash },
  });

  return { anchorTxHash: tx.hash, certificateHash, cid };
}
