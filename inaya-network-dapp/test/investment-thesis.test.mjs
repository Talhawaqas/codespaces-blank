// test/investment-thesis.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§7) — load-bearing
// correctness property: "no historical thesis version may be silently
// overwritten." Same versioned-immutable-record pattern as
// compliance-policies.test.mjs proves for compliance-policies.js: a
// non-DRAFT thesis's content can only change by reviseThesis() creating a
// NEW document at version+1, never by mutating the current one in place.
//
// Run with: node --env-file=.env.local --test test/investment-thesis.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createThesis, updateThesisDraft, transitionThesis, reviseThesis } from "../src/lib/investment-thesis.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `investment-thesis-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Investment Thesis Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "financial", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.investmentTheses.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function activeThesis(key) {
  const { thesis: draft } = await createThesis({ orgId, key, title: "Original Title", target: "ACME Corp", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionThesis({ orgId, thesisId: draft._id, action: "submitForReview", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionThesis({ orgId, thesisId: draft._id, action: "submitToIC", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { thesis: approved } = await transitionThesis({ orgId, thesisId: draft._id, action: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { thesis: active } = await transitionThesis({ orgId, thesisId: approved._id, action: "activate", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  return active;
}

test("SECURITY: a non-DRAFT thesis cannot be edited via updateThesisDraft() -- the direct mutation path is unreachable once it has left DRAFT", async () => {
  const active = await activeThesis(`thesis-a-${RUN_ID}`);
  assert.equal(active.status, "ACTIVE");

  const result = await updateThesisDraft({ orgId, thesisId: active._id, updates: { title: "HACKED TITLE" }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "updateThesisDraft must reject a non-DRAFT thesis");
  assert.equal(result.status, 409);

  const stored = await collections.investmentTheses.findOne({ _id: active._id });
  assert.equal(stored.title, "Original Title", "the stored title must be completely unchanged after the rejected edit attempt");
});

test("reviseThesis() creates a NEW document at version+1 and leaves the original document's content completely untouched", async () => {
  const v1 = await activeThesis(`thesis-b-${RUN_ID}`);
  const { thesis: v2 } = await reviseThesis({ orgId, thesisId: v1._id, updates: { title: "Updated Title" }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  assert.notEqual(v2._id.toString(), v1._id.toString(), "revise must create a NEW document, not mutate the existing _id");
  assert.equal(v2.version, v1.version + 1);
  assert.equal(v2.supersedes.toString(), v1._id.toString());
  assert.equal(v2.status, "DRAFT");
  assert.equal(v2.title, "Updated Title");
  assert.equal(v2.key, v1.key, "the key identifying this thesis across versions must be carried forward unchanged");

  const v1AfterRevise = await collections.investmentTheses.findOne({ _id: v1._id });
  assert.equal(v1AfterRevise.title, "Original Title", "the original active document's title must be untouched by the revision");
  assert.equal(v1AfterRevise.status, "ACTIVE", "the original document's own status field is not touched by reviseThesis() -- it is only marked via supersededBy");
  assert.equal(v1AfterRevise.supersededBy.toString(), v2._id.toString());
});

test("reviseThesis() is rejected for a DRAFT thesis -- updateThesisDraft() is the correct path while still in DRAFT", async () => {
  const { thesis: draft } = await createThesis({ orgId, key: `thesis-c-${RUN_ID}`, title: "Draft Title", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await reviseThesis({ orgId, thesisId: draft._id, updates: { title: "Should not work" }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "revising a DRAFT thesis must be rejected");
  assert.equal(result.status, 409);
});

test("transitionThesis() rejects an action whose `from` state doesn't match the thesis's current state (atomic conflict guard)", async () => {
  const { thesis: draft } = await createThesis({ orgId, key: `thesis-d-${RUN_ID}`, title: "Draft Title", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await transitionThesis({ orgId, thesisId: draft._id, action: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "approve is only legal from IC_REVIEW, not DRAFT");
  assert.equal(result.status, 409);

  const stored = await collections.investmentTheses.findOne({ _id: draft._id });
  assert.equal(stored.status, "DRAFT", "a rejected transition must not change the stored status");
});
