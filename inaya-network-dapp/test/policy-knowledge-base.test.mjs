// test/policy-knowledge-base.test.mjs
//
// The load-bearing correctness property for this module (mirrors
// compliance-policies.test.mjs exactly): "a published entry cannot be
// mutated in place — every change after publication must create a new
// version." Enforced structurally in policy-knowledge-base.js — there is
// no updateEntryDraft() path reachable once status is PUBLISHED.
//
// Run with: node --env-file=.env.local --test test/policy-knowledge-base.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  createEntryDraft, updateEntryDraft, transitionEntry, publishEntry, amendEntry, recordAcknowledgement,
} from "../src/lib/policy-knowledge-base.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `policy-kb-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Policy KB Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "government", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.policyKbEntries.deleteMany({ orgId }),
    collections.policyKbAcknowledgements.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function publishFreshEntry(key) {
  const { entry: draft } = await createEntryDraft({ orgId, key, title: "Original Title", body: "Original body text.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionEntry({ orgId, entryId: draft._id, action: "submitForReview", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionEntry({ orgId, entryId: draft._id, action: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { entry: published } = await publishEntry({ orgId, entryId: draft._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  return published;
}

test("SECURITY: a published entry cannot be edited via updateEntryDraft() -- the direct mutation path is unreachable once PUBLISHED", async () => {
  const published = await publishFreshEntry(`entry-a-${RUN_ID}`);
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.immutable, true);

  const result = await updateEntryDraft({ orgId, entryId: published._id, title: "HACKED TITLE", body: "HACKED BODY", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "updateEntryDraft must reject a PUBLISHED entry");
  assert.equal(result.status, 409);

  const stored = await collections.policyKbEntries.findOne({ _id: published._id });
  assert.equal(stored.title, "Original Title", "the stored title must be completely unchanged after the rejected edit attempt");
  assert.equal(stored.body, "Original body text.", "the stored body must be completely unchanged after the rejected edit attempt");
});

test("SECURITY: publishEntry() cannot be called twice", async () => {
  const published = await publishFreshEntry(`entry-b-${RUN_ID}`);
  const secondAttempt = await publishEntry({ orgId, entryId: published._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(secondAttempt.error !== undefined, true, "publishing an already-PUBLISHED entry must be rejected");
  assert.equal(secondAttempt.status, 409);
});

test("amendEntry() creates a NEW document at version+1 and leaves the original document's content completely untouched", async () => {
  const v1 = await publishFreshEntry(`entry-c-${RUN_ID}`);
  const { entry: v2 } = await amendEntry({ orgId, entryId: v1._id, title: "Updated Title", body: "Updated body text.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  assert.notEqual(v2._id.toString(), v1._id.toString(), "amend must create a NEW document, not mutate the existing _id");
  assert.equal(v2.version, v1.version + 1);
  assert.equal(v2.supersedes.toString(), v1._id.toString());
  assert.equal(v2.status, "DRAFT");

  const v1AfterAmend = await collections.policyKbEntries.findOne({ _id: v1._id });
  assert.equal(v1AfterAmend.title, "Original Title", "the original published document's title must be untouched by the amendment");
  assert.equal(v1AfterAmend.status, "AMENDED", "only the original's status field changes, marking it superseded");
});

test("amendEntry() can only be called on a PUBLISHED entry, not a DRAFT one", async () => {
  const { entry: draft } = await createEntryDraft({ orgId, key: `entry-d-${RUN_ID}`, title: "Draft Title", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await amendEntry({ orgId, entryId: draft._id, title: "Should not work", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "amending a non-PUBLISHED entry must be rejected");
  assert.equal(result.status, 409);
});

test("recordAcknowledgement() is idempotent per member", async () => {
  const published = await publishFreshEntry(`entry-e-${RUN_ID}`);
  const memberEmail = `staff-${RUN_ID}@example.com`;
  await recordAcknowledgement({ orgId, entryId: published._id, memberEmail, actorEmail: memberEmail });
  await recordAcknowledgement({ orgId, entryId: published._id, memberEmail, actorEmail: memberEmail });
  const count = await collections.policyKbAcknowledgements.countDocuments({ orgId, entryId: published._id, memberEmail });
  assert.equal(count, 1, "acknowledging twice must not create a duplicate record");
});

test("a non-manager (no governmentRole) cannot author a policy knowledge base entry", async () => {
  const staffMembership = { role: "member", email: `staff-noauth-${RUN_ID}@example.com` };
  const result = await createEntryDraft({ orgId, key: `entry-f-${RUN_ID}`, title: "Should be denied", actorEmail: staffMembership.email, membership: staffMembership });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 403);
});
