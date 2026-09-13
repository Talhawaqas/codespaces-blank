// test/inaya-sign.test.mjs
//
// Four High-Impact Business Workspace Extensions SOW — Feature 1: Inaya
// Sign. Covers the SOW §8 security test list against real DB fixtures, no
// mocks: unauthorized request creation, unauthorized signer, expired/
// revoked rejection, cross-org isolation, tamper detection, and old-
// signature-cannot-carry-to-a-new-version.
//
// Run with: node --env-file=.env.local --test test/inaya-sign.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  createSigningRequest, sendSigningRequest, recordSignature, rejectSigningRequest,
  revokeSigningRequest, verifySigningRequest, buildInayaSignMessage, supersedeActiveSigningRequests,
} from "../src/lib/signing-workflow.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-sign-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, projects, orgDocuments, signingRequests, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await signingRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithDocument(label, { fileHash } = {}) {
  const now = new Date().toISOString();
  const ownerEmail = email(`${label}-owner`);
  const memberEmail = email(`${label}-member`);
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  const deptResult = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });
  const projResult = await collections.projects.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Proj", createdAt: now });
  await collections.orgMembers.insertMany([
    { orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
    { orgId, email: memberEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
  ]);
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const member = await collections.orgMembers.findOne({ orgId, email: memberEmail });

  const docResult = await collections.orgDocuments.insertOne({
    orgId, departmentId: deptResult.insertedId, projectId: projResult.insertedId,
    filename: "contract.pdf", fileHash: fileHash || `0xhash-${randomUUID()}`, sizeBytes: 1024,
    cidAlpha: "cidA", cidBeta: "cidB", uploadedByEmail: ownerEmail, txHash: "0xtest",
    status: "DRAFT", accessLevel: "DEPARTMENT", documentGroupId: null, version: 1, supersedesId: null,
    createdAt: now, deletedAt: null,
  });
  await collections.orgDocuments.updateOne({ _id: docResult.insertedId }, { $set: { documentGroupId: docResult.insertedId } });
  const doc = await collections.orgDocuments.findOne({ _id: docResult.insertedId });

  return { orgId, doc, owner, ownerEmail, member, memberEmail, deptId: deptResult.insertedId };
}

async function signWith(wallet, { requestId, documentHash }) {
  const timestamp = Date.now();
  const message = buildInayaSignMessage({ action: "sign", requestId: requestId.toString(), documentHash, timestamp });
  const signature = await wallet.signMessage(message);
  return { walletAddress: wallet.address, message, signature, timestamp };
}

test("end-to-end: wallet-signature signing completes a request and verification reports VALID", async () => {
  const fx = await makeOrgWithDocument("e2e");
  const wallet = ethers.Wallet.createRandom();
  const walletAddr = wallet.address.toLowerCase();

  const created = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ wallet: walletAddr, role: "required" }],
    membership: fx.owner, actorEmail: fx.ownerEmail,
  });
  assert.ok(created.requestId);

  await sendSigningRequest({ orgId: fx.orgId, requestId: created.requestId, actorEmail: fx.ownerEmail });

  const proof = await signWith(wallet, { requestId: created.requestId, documentHash: fx.doc.fileHash });
  const signed = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { wallet: walletAddr },
    method: "wallet", proof, actorEmail: walletAddr,
  });
  assert.equal(signed.completed, true);
  assert.equal(signed.request.status, "FULLY_SIGNED");

  const verification = await verifySigningRequest({ orgId: fx.orgId, requestId: created.requestId });
  assert.equal(verification.result, "VALID");
  assert.equal(verification.hashMatches, true);
});

test("SECURITY: a member with no document access cannot create a signing request", async () => {
  const fx = await makeOrgWithDocument("unauth-create");
  // fx.member has role:"member", no departmentIds, isn't the uploader -> null access level.
  const result = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ email: email("signer") }],
    membership: fx.member, actorEmail: fx.memberEmail,
  });
  assert.equal(result.status, 403);
});

test("SECURITY: a wallet not on the signer list cannot sign", async () => {
  const fx = await makeOrgWithDocument("unauth-signer");
  const invitedWallet = ethers.Wallet.createRandom();
  const strangerWallet = ethers.Wallet.createRandom();

  const created = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ wallet: invitedWallet.address.toLowerCase(), role: "required" }],
    membership: fx.owner, actorEmail: fx.ownerEmail,
  });
  await sendSigningRequest({ orgId: fx.orgId, requestId: created.requestId, actorEmail: fx.ownerEmail });

  const proof = await signWith(strangerWallet, { requestId: created.requestId, documentHash: fx.doc.fileHash });
  const result = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { wallet: strangerWallet.address.toLowerCase() },
    method: "wallet", proof, actorEmail: strangerWallet.address.toLowerCase(),
  });
  assert.equal(result.status, 403);
});

test("SECURITY: a forged signature (wrong wallet's signature claiming to be the invited signer) is rejected", async () => {
  const fx = await makeOrgWithDocument("forged-sig");
  const invitedWallet = ethers.Wallet.createRandom();
  const attackerWallet = ethers.Wallet.createRandom();

  const created = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ wallet: invitedWallet.address.toLowerCase(), role: "required" }],
    membership: fx.owner, actorEmail: fx.ownerEmail,
  });
  await sendSigningRequest({ orgId: fx.orgId, requestId: created.requestId, actorEmail: fx.ownerEmail });

  // Attacker signs but claims to be the invited wallet in the request body.
  const timestamp = Date.now();
  const message = buildInayaSignMessage({ action: "sign", requestId: created.requestId.toString(), documentHash: fx.doc.fileHash, timestamp });
  const forgedSignature = await attackerWallet.signMessage(message);
  const result = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { wallet: invitedWallet.address.toLowerCase() },
    method: "wallet", proof: { walletAddress: invitedWallet.address, message, signature: forgedSignature, timestamp },
    actorEmail: invitedWallet.address.toLowerCase(),
  });
  assert.equal(result.status, 401);
});

test("VALIDATION: an expired signing request cannot be signed", async () => {
  const fx = await makeOrgWithDocument("expired");
  const wallet = ethers.Wallet.createRandom();
  const created = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ wallet: wallet.address.toLowerCase(), role: "required" }],
    deadline: new Date(Date.now() - 60_000).toISOString(), // already past
    membership: fx.owner, actorEmail: fx.ownerEmail,
  });
  await sendSigningRequest({ orgId: fx.orgId, requestId: created.requestId, actorEmail: fx.ownerEmail });

  const proof = await signWith(wallet, { requestId: created.requestId, documentHash: fx.doc.fileHash });
  const result = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { wallet: wallet.address.toLowerCase() },
    method: "wallet", proof, actorEmail: wallet.address.toLowerCase(),
  });
  assert.equal(result.status, 409);
});

test("VALIDATION: a revoked signing request cannot be signed", async () => {
  const fx = await makeOrgWithDocument("revoked");
  const wallet = ethers.Wallet.createRandom();
  const created = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ wallet: wallet.address.toLowerCase(), role: "required" }],
    membership: fx.owner, actorEmail: fx.ownerEmail,
  });
  await sendSigningRequest({ orgId: fx.orgId, requestId: created.requestId, actorEmail: fx.ownerEmail });
  await revokeSigningRequest({ orgId: fx.orgId, requestId: created.requestId, membership: fx.owner, actorEmail: fx.ownerEmail });

  const proof = await signWith(wallet, { requestId: created.requestId, documentHash: fx.doc.fileHash });
  const result = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { wallet: wallet.address.toLowerCase() },
    method: "wallet", proof, actorEmail: wallet.address.toLowerCase(),
  });
  assert.equal(result.status, 409);
});

test("SECURITY: cross-org isolation -- a signing request cannot be fetched/acted on under the wrong org", async () => {
  const fxA = await makeOrgWithDocument("cross-a");
  const fxB = await makeOrgWithDocument("cross-b");
  const wallet = ethers.Wallet.createRandom();

  const created = await createSigningRequest({
    orgId: fxA.orgId, documentId: fxA.doc._id, signers: [{ wallet: wallet.address.toLowerCase(), role: "required" }],
    membership: fxA.owner, actorEmail: fxA.ownerEmail,
  });

  const sentUnderWrongOrg = await sendSigningRequest({ orgId: fxB.orgId, requestId: created.requestId, actorEmail: fxB.ownerEmail });
  assert.equal(sentUnderWrongOrg.status, 409, "the request doesn't exist under org B's scope, so this must fail closed");
});

test("SECURITY: tamper detection -- modifying the underlying document invalidates a fully-signed request", async () => {
  const fx = await makeOrgWithDocument("tamper");
  const wallet = ethers.Wallet.createRandom();
  const created = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ wallet: wallet.address.toLowerCase(), role: "required" }],
    membership: fx.owner, actorEmail: fx.ownerEmail,
  });
  await sendSigningRequest({ orgId: fx.orgId, requestId: created.requestId, actorEmail: fx.ownerEmail });
  const proof = await signWith(wallet, { requestId: created.requestId, documentHash: fx.doc.fileHash });
  await recordSignature({ orgId: fx.orgId, requestId: created.requestId, signerIdentity: { wallet: wallet.address.toLowerCase() }, method: "wallet", proof, actorEmail: wallet.address.toLowerCase() });

  // Simulate the document's bytes changing after signing completed (a raw
  // DB edit, standing in for "someone found a way to alter stored content").
  await collections.orgDocuments.updateOne({ _id: fx.doc._id }, { $set: { fileHash: "0xtampered" } });

  const verification = await verifySigningRequest({ orgId: fx.orgId, requestId: created.requestId });
  assert.equal(verification.result, "TAMPERED");
  assert.equal(verification.hashMatches, false);
});

test("SECURITY: a signature collected against one document version cannot carry over to a new version", async () => {
  const fx = await makeOrgWithDocument("version");
  const wallet = ethers.Wallet.createRandom();
  const created = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ wallet: wallet.address.toLowerCase(), role: "required" }],
    membership: fx.owner, actorEmail: fx.ownerEmail,
  });
  await sendSigningRequest({ orgId: fx.orgId, requestId: created.requestId, actorEmail: fx.ownerEmail });

  // A new version is uploaded (new fileHash) under the same document row's
  // id being superseded -- simulate by directly invoking the supersede
  // helper the versions route calls, then changing the bound document's
  // hash (standing in for the new version's real row).
  await supersedeActiveSigningRequests({ orgId: fx.orgId, oldDocumentId: fx.doc._id, actorEmail: fx.ownerEmail });
  const afterSupersede = await collections.signingRequests.findOne({ _id: created.requestId });
  assert.equal(afterSupersede.status, "SUPERSEDED");

  // The old, now-superseded request must reject any further signature.
  const proof = await signWith(wallet, { requestId: created.requestId, documentHash: fx.doc.fileHash });
  const result = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { wallet: wallet.address.toLowerCase() },
    method: "wallet", proof, actorEmail: wallet.address.toLowerCase(),
  });
  assert.equal(result.status, 409);
});

test("session_consent: requires the signer's own authenticated session and explicit consent, and is labeled distinctly from a wallet signature", async () => {
  const fx = await makeOrgWithDocument("consent");
  const signerEmail = email("consent-signer");
  const created = await createSigningRequest({
    orgId: fx.orgId, documentId: fx.doc._id, signers: [{ email: signerEmail, role: "required" }],
    membership: fx.owner, actorEmail: fx.ownerEmail,
  });
  await sendSigningRequest({ orgId: fx.orgId, requestId: created.requestId, actorEmail: fx.ownerEmail });

  // Wrong actor (not the invited signer) cannot consent on their behalf.
  const wrongActor = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { email: signerEmail },
    method: "session_consent", proof: { typedName: "Someone Else", consent: true }, actorEmail: fx.ownerEmail,
  });
  assert.equal(wrongActor.status, 403);

  // Missing explicit consent is rejected even for the right signer.
  const noConsent = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { email: signerEmail },
    method: "session_consent", proof: { typedName: "Real Signer", consent: false }, actorEmail: signerEmail,
  });
  assert.equal(noConsent.status, 400);

  const result = await recordSignature({
    orgId: fx.orgId, requestId: created.requestId, signerIdentity: { email: signerEmail },
    method: "session_consent", proof: { typedName: "Real Signer", consent: true }, actorEmail: signerEmail,
  });
  assert.equal(result.completed, true);
  const signer = result.request.signers.find((s) => s.email === signerEmail);
  assert.ok(signer.signatureRef.startsWith("session_consent:"), "must be labeled as consent, never presented as a wallet signature");
});
