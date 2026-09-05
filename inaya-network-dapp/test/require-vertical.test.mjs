// test/require-vertical.test.mjs
//
// requireVertical()'s actual runtime behavior — the function every
// Health/Legal route now calls (see vertical-lock-wiring.test.mjs for
// the static proof every route calls it correctly). Confirms it fails
// closed (an org with no vertical configured is "general", never
// silently matches) and correctly allows/denies each real combination.
//
// Run with: node --env-file=.env.local --test test/require-vertical.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { requireVertical } from "../src/lib/industry-config.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  await collections.orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(vertical) {
  const now = new Date().toISOString();
  const doc = { name: `require-vertical-${RUN_ID}-${vertical || "none"} Co`, ownerEmail: `rv-${RUN_ID}@example.com`, createdAt: now };
  if (vertical) doc.vertical = vertical;
  const result = await collections.orgs.insertOne(doc);
  cleanup.orgIds.push(result.insertedId);
  return result.insertedId;
}

test("SECURITY: a healthcare org is allowed through the healthcare check", async () => {
  const orgId = await makeOrg("healthcare");
  const result = await requireVertical(orgId, "healthcare");
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test("SECURITY: a legal org is REJECTED by the healthcare check", async () => {
  const orgId = await makeOrg("legal");
  const result = await requireVertical(orgId, "healthcare");
  assert.equal(result.status, 403);
  assert.match(result.error, /Health OS/);
});

test("SECURITY: a general (non-vertical) org is REJECTED by both the healthcare and legal checks", async () => {
  const orgId = await makeOrg("general");
  const healthResult = await requireVertical(orgId, "healthcare");
  const legalResult = await requireVertical(orgId, "legal");
  assert.equal(healthResult.status, 403);
  assert.equal(legalResult.status, 403);
});

test("SECURITY: an org with NO vertical field at all (pre-existing/legacy org) fails closed as 'general' -- never silently matches healthcare or legal", async () => {
  const orgId = await makeOrg(null);
  const healthResult = await requireVertical(orgId, "healthcare");
  const legalResult = await requireVertical(orgId, "legal");
  assert.equal(healthResult.status, 403, "a legacy org with no vertical must NOT be treated as healthcare");
  assert.equal(legalResult.status, 403, "a legacy org with no vertical must NOT be treated as legal");
});

test("SECURITY: a healthcare org is REJECTED by the legal check (cross-vertical denial both ways)", async () => {
  const orgId = await makeOrg("healthcare");
  const result = await requireVertical(orgId, "legal");
  assert.equal(result.status, 403);
  assert.match(result.error, /Legal OS/);
});
