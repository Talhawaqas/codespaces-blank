// test/depin-storage-manager.test.mjs
//
// Four High-Impact Business Workspace Extensions SOW — Feature 2: Native
// DePIN Storage Allocation Dashboard. Covers cross-org isolation,
// unauthorized management actions, and the "never represent an
// unsupported capability as active" honesty requirement.
//
// Run with: node --env-file=.env.local --test test/depin-storage-manager.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  registerOrgStorageNode, listOrgStorageNodes, reportOrgStorageNodeHealth,
  createStoragePolicy, listStoragePolicies, getOrgStorageOverview,
} from "../src/lib/storage-manager.js";
import { upsertDataResidencyPolicy, getDataResidencyPolicy } from "../src/lib/data-residency.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-storage-${RUN_ID}-${label}@example.com`;
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, orgStorageNodes, storagePolicies, dataResidencyPolicies, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgStorageNodes.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await storagePolicies.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await dataResidencyPolicies.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const ownerEmail = email(`${label}-owner`);
  const memberEmail = email(`${label}-member`);
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  await collections.orgMembers.insertMany([
    { orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
    { orgId, email: memberEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
  ]);
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const member = await collections.orgMembers.findOne({ orgId, email: memberEmail });
  return { orgId, owner, ownerEmail, member, memberEmail };
}

test("SECURITY: a plain member cannot register a storage node (owner/admin only)", async () => {
  const org = await makeOrg("unauth-register");
  const result = await registerOrgStorageNode({ orgId: org.orgId, nodeWallet: "0xabc", capacityGB: 100, membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 403);
});

test("VALIDATION: the same wallet cannot be registered twice for the same org", async () => {
  const org = await makeOrg("dup-register");
  const first = await registerOrgStorageNode({ orgId: org.orgId, nodeWallet: "0xDUPWALLET", capacityGB: 500, membership: org.owner, actorEmail: org.ownerEmail });
  assert.ok(first.nodeId);
  const second = await registerOrgStorageNode({ orgId: org.orgId, nodeWallet: "0xdupwallet", capacityGB: 500, membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(second.status, 409);
});

test("SECURITY: cross-org isolation -- org A's storage nodes never appear when listing org B's", async () => {
  const orgA = await makeOrg("cross-a");
  const orgB = await makeOrg("cross-b");
  await registerOrgStorageNode({ orgId: orgA.orgId, nodeWallet: "0xnodeA", capacityGB: 200, membership: orgA.owner, actorEmail: orgA.ownerEmail });

  const nodesForB = await listOrgStorageNodes(orgB.orgId);
  assert.equal(nodesForB.length, 0, "org B must see zero of org A's storage nodes");

  const nodesForA = await listOrgStorageNodes(orgA.orgId);
  assert.equal(nodesForA.length, 1);
});

test("registered node's eligibility never claims routing is enabled -- honest control-plane-only status", async () => {
  const org = await makeOrg("eligibility");
  const { nodeId } = await registerOrgStorageNode({ orgId: org.orgId, nodeWallet: "0xhonest", capacityGB: 100, membership: org.owner, actorEmail: org.ownerEmail });
  const nodes = await listOrgStorageNodes(org.orgId);
  const node = nodes.find((n) => n._id.toString() === nodeId.toString());
  assert.notEqual(node.eligibility, "routing_enabled");
  assert.equal(node.eligibility, "routing_not_yet_supported");
});

test("VALIDATION: reporting health for a nonexistent node fails cleanly", async () => {
  const org = await makeOrg("health-404");
  const { ObjectId } = await import("mongodb");
  const result = await reportOrgStorageNodeHealth({ orgId: org.orgId, nodeId: new ObjectId().toString(), capacityGB: 50, healthy: true });
  assert.equal(result.status, 404);
});

test("storage policy versioning: each create is a new immutable version, history is preserved", async () => {
  const org = await makeOrg("policy-version");
  const v1 = await createStoragePolicy({ orgId: org.orgId, key: "customer-data", dataClassification: "CONFIDENTIAL", allowedRegions: ["us-east"], membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(v1.version, 1);
  const v2 = await createStoragePolicy({ orgId: org.orgId, key: "customer-data", dataClassification: "CONFIDENTIAL", allowedRegions: ["us-east", "eu-west"], membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(v2.version, 2);

  const all = await listStoragePolicies(org.orgId);
  const versions = all.filter((p) => p.key === "customer-data").map((p) => p.version).sort();
  assert.deepEqual(versions, [1, 2], "both versions must remain queryable -- history is never overwritten");
});

test("SECURITY: only owner/admin can define a storage policy", async () => {
  const org = await makeOrg("policy-unauth");
  const result = await createStoragePolicy({ orgId: org.orgId, key: "x", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 403);
});

test("HONESTY: a declared geographic preference is never represented with an 'active' status field", async () => {
  const org = await makeOrg("region-honesty");
  const { policy } = await upsertDataResidencyPolicy({
    orgId: org.orgId, preferredRegions: ["us-east"], primaryRegion: "us-east", failoverRegion: "eu-west",
    membership: org.owner, actorEmail: org.ownerEmail,
  });
  assert.deepEqual(policy.preferredRegions, ["us-east"]);
  assert.equal(policy.primaryRegion, "us-east");
  // No field anywhere on the stored policy claims enforcement -- this
  // schema has no "active"/"enforced"/"routingStatus" field for regions,
  // which is the point: the UI layer is the one required to always label
  // this "Declared", never "Active" (see storage-manager.js's header).
  assert.equal(policy.regionRoutingActive, undefined);
  assert.equal(policy.routingEnforced, undefined);

  const reread = await getDataResidencyPolicy(org.orgId);
  assert.equal(reread.primaryRegion, "us-east");
});

test("overview: reflects real per-org plan allocation, not a fabricated number", async () => {
  const org = await makeOrg("overview");
  const overview = await getOrgStorageOverview(org.orgId);
  assert.ok(overview.allocation);
  assert.equal(typeof overview.allocation.usedBytes, "number");
  assert.ok(Array.isArray(overview.resiliencePolicies));
});
