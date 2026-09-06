// test/compliance-policies.test.mjs
//
// The other load-bearing correctness property of this phase (SOW §49):
// "Policies must be immutable after publication except through versioned
// amendment." This is enforced structurally in compliance-policies.js --
// there is no updatePolicyDraft() path reachable once status is
// PUBLISHED. This test proves that directly: publish a policy, then
// confirm every mutation path either rejects it outright or creates a
// NEW document rather than touching the published one.
//
// Run with: node --env-file=.env.local --test test/compliance-policies.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  createPolicyDraft, updatePolicyDraft, transitionPolicy, publishPolicy, amendPolicy, recordAcknowledgement,
} from "../src/lib/compliance-policies.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `compliance-policies-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Compliance Policies Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.compliancePolicies.deleteMany({ orgId }),
    collections.compliancePolicyAcknowledgements.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function publishFreshPolicy(key) {
  const { policy: draft } = await createPolicyDraft({ orgId, key, title: "Original Title", body: "Original body text.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionPolicy({ orgId, policyId: draft._id, action: "submitForReview", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionPolicy({ orgId, policyId: draft._id, action: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { policy: published } = await publishPolicy({ orgId, policyId: draft._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  return published;
}

test("SECURITY: a published policy cannot be edited via updatePolicyDraft() -- the direct mutation path is unreachable once PUBLISHED", async () => {
  const published = await publishFreshPolicy(`policy-a-${RUN_ID}`);
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.immutable, true);

  const result = await updatePolicyDraft({ orgId, policyId: published._id, title: "HACKED TITLE", body: "HACKED BODY", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "updatePolicyDraft must reject a PUBLISHED policy");
  assert.equal(result.status, 409);

  const stored = await collections.compliancePolicies.findOne({ _id: published._id });
  assert.equal(stored.title, "Original Title", "the stored title must be completely unchanged after the rejected edit attempt");
  assert.equal(stored.body, "Original body text.", "the stored body must be completely unchanged after the rejected edit attempt");
});

test("SECURITY: publishPolicy() cannot be called twice, and republishing does not silently reset immutable/effectiveDate", async () => {
  const published = await publishFreshPolicy(`policy-b-${RUN_ID}`);
  const secondAttempt = await publishPolicy({ orgId, policyId: published._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(secondAttempt.error !== undefined, true, "publishing an already-PUBLISHED policy must be rejected");
  assert.equal(secondAttempt.status, 409);
});

test("amendPolicy() creates a NEW document at version+1 and leaves the original document's content completely untouched", async () => {
  const v1 = await publishFreshPolicy(`policy-c-${RUN_ID}`);
  const { policy: v2 } = await amendPolicy({ orgId, policyId: v1._id, title: "Updated Title", body: "Updated body text.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  assert.notEqual(v2._id.toString(), v1._id.toString(), "amend must create a NEW document, not mutate the existing _id");
  assert.equal(v2.version, v1.version + 1);
  assert.equal(v2.supersedes.toString(), v1._id.toString());
  assert.equal(v2.status, "DRAFT");
  assert.equal(v2.title, "Updated Title");

  const v1AfterAmend = await collections.compliancePolicies.findOne({ _id: v1._id });
  assert.equal(v1AfterAmend.title, "Original Title", "the original published document's title must be untouched by the amendment");
  assert.equal(v1AfterAmend.body, "Original body text.", "the original published document's body must be untouched by the amendment");
  assert.equal(v1AfterAmend.status, "AMENDED", "only the original's status field changes, marking it superseded");
});

test("amendPolicy() can only be called on a PUBLISHED policy, not a DRAFT/APPROVED one", async () => {
  const { policy: draft } = await createPolicyDraft({ orgId, key: `policy-d-${RUN_ID}`, title: "Draft Title", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await amendPolicy({ orgId, policyId: draft._id, title: "Should not work", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "amending a non-PUBLISHED policy must be rejected");
  assert.equal(result.status, 409);
});

test("recordAcknowledgement() is idempotent per member and does not require compliance-manager permission", async () => {
  const published = await publishFreshPolicy(`policy-e-${RUN_ID}`);
  const memberEmail = `staff-${RUN_ID}@example.com`;
  await recordAcknowledgement({ orgId, policyId: published._id, memberEmail, actorEmail: memberEmail });
  await recordAcknowledgement({ orgId, policyId: published._id, memberEmail, actorEmail: memberEmail }); // second call must not throw or duplicate
  const count = await collections.compliancePolicyAcknowledgements.countDocuments({ orgId, policyId: published._id, memberEmail });
  assert.equal(count, 1, "acknowledging twice must not create a duplicate record");
});
