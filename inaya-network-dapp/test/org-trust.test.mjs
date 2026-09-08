// test/org-trust.test.mjs
//
// Institutional Trust Infrastructure SOW, Phase 5 coverage: the propose/
// accept/reject/revoke state machine, the SOW's explicit "independent
// control" requirement (an org can never accept its own outbound
// proposal), expiry, and cross-org isolation.
//
// Run with: node --env-file=.env.local --test test/org-trust.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  proposeTrustRelationship, acceptTrustRelationship, rejectTrustRelationship,
  revokeTrustRelationship, listTrustRelationships, isTrustedAccess,
} from "../src/lib/org-trust.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-orgtrust-${RUN_ID}-${label}@example.com`;
const OWNER = { role: "owner" };
const MEMBER = { role: "member" };

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgTrustRelationships, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await orgTrustRelationships.deleteMany({ $or: [{ fromOrgId: { $in: cleanup.orgIds } }, { toOrgId: { $in: cleanup.orgIds } }] });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(label) {
  const { orgs } = collections;
  const { insertedId } = await orgs.insertOne({ name: `${label} Co`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(insertedId);
  return insertedId;
}

test("proposeTrustRelationship: rejects a self-relationship, requires manage, requires the target org to exist", async () => {
  const orgA = await makeOrg("self");
  const self = await proposeTrustRelationship({ fromOrgId: orgA, toOrgId: orgA, scope: ["evidence:read"], membership: OWNER, actorEmail: email("a") });
  assert.equal(self.status, 400);

  const orgB = await makeOrg("perm");
  const notManager = await proposeTrustRelationship({ fromOrgId: orgA, toOrgId: orgB, scope: ["evidence:read"], membership: MEMBER, actorEmail: email("a") });
  assert.equal(notManager.status, 403);

  const fakeTarget = new ObjectId();
  const noTarget = await proposeTrustRelationship({ fromOrgId: orgA, toOrgId: fakeTarget, scope: ["evidence:read"], membership: OWNER, actorEmail: email("a") });
  assert.equal(noTarget.status, 404);
});

test("full lifecycle: propose -> accept -> revoke, each step logged", async () => {
  const orgA = await makeOrg("life-a");
  const orgB = await makeOrg("life-b");

  const { relationship } = await proposeTrustRelationship({ fromOrgId: orgA, toOrgId: orgB, scope: ["evidence:read"], purpose: "shared audit review", membership: OWNER, actorEmail: email("a") });
  assert.equal(relationship.status, "PENDING");

  const accepted = await acceptTrustRelationship({ relationshipId: relationship.relationshipId, toOrgId: orgB, membership: OWNER, actorEmail: email("b") });
  assert.equal(accepted.relationship.status, "ACTIVE");

  const trusted = await isTrustedAccess({ fromOrgId: orgA, toOrgId: orgB, scope: "evidence:read" });
  assert.equal(trusted.trusted, true);

  const revoked = await revokeTrustRelationship({ relationshipId: relationship.relationshipId, orgId: orgB, membership: OWNER, actorEmail: email("b") });
  assert.equal(revoked.relationship.status, "REVOKED");

  const noLongerTrusted = await isTrustedAccess({ fromOrgId: orgA, toOrgId: orgB, scope: "evidence:read" });
  assert.equal(noLongerTrusted.trusted, false);
});

test("SECURITY: independent control -- org A can never accept or reject its own outbound proposal", async () => {
  const orgA = await makeOrg("indep-a");
  const orgB = await makeOrg("indep-b");
  const { relationship } = await proposeTrustRelationship({ fromOrgId: orgA, toOrgId: orgB, scope: ["evidence:read"], membership: OWNER, actorEmail: email("a") });

  const selfAccept = await acceptTrustRelationship({ relationshipId: relationship.relationshipId, toOrgId: orgA, membership: OWNER, actorEmail: email("a") });
  assert.equal(selfAccept.status, 404, "org A supplying its OWN orgId as toOrgId must never match the row (toOrgId is really org B)");

  const selfReject = await rejectTrustRelationship({ relationshipId: relationship.relationshipId, toOrgId: orgA, membership: OWNER, actorEmail: email("a") });
  assert.equal(selfReject.status, 404);

  // The real target CAN reject.
  const rejected = await rejectTrustRelationship({ relationshipId: relationship.relationshipId, toOrgId: orgB, membership: OWNER, actorEmail: email("b") });
  assert.equal(rejected.relationship.status, "REJECTED");
});

test("expiry: an ACTIVE relationship past its expiresAt reads as EXPIRED and is no longer trusted", async () => {
  const orgA = await makeOrg("expiry-a");
  const orgB = await makeOrg("expiry-b");
  const past = new Date(Date.now() - 1000).toISOString();
  const { relationship } = await proposeTrustRelationship({ fromOrgId: orgA, toOrgId: orgB, scope: ["evidence:read"], expiresAt: past, membership: OWNER, actorEmail: email("a") });
  await acceptTrustRelationship({ relationshipId: relationship.relationshipId, toOrgId: orgB, membership: OWNER, actorEmail: email("b") });

  const { relationships } = await listTrustRelationships({ orgId: orgA });
  const found = relationships.find((r) => r.relationshipId === relationship.relationshipId);
  assert.equal(found.status, "EXPIRED");

  const trusted = await isTrustedAccess({ fromOrgId: orgA, toOrgId: orgB, scope: "evidence:read" });
  assert.equal(trusted.trusted, false);
});

test("SECURITY: cross-org isolation -- listTrustRelationships only ever returns relationships this org is actually party to", async () => {
  const orgA = await makeOrg("iso-a");
  const orgB = await makeOrg("iso-b");
  const orgC = await makeOrg("iso-c");
  await proposeTrustRelationship({ fromOrgId: orgA, toOrgId: orgB, scope: ["evidence:read"], membership: OWNER, actorEmail: email("a") });

  const { relationships } = await listTrustRelationships({ orgId: orgC });
  assert.equal(relationships.length, 0, "org C is not party to the A->B relationship and must not see it");
});
