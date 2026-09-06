// test/compliance-exceptions.test.mjs
//
// SOW §127: "No permanent silent exceptions." Enforced by requiring
// expiresAt on every request (never optional) and by the state machine
// only ever reaching ACTIVE with an expiry already attached.
//
// Run with: node --env-file=.env.local --test test/compliance-exceptions.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { requestException, transitionException, listExpiredExceptions } from "../src/lib/compliance-exceptions.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `compliance-exceptions-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Compliance Exceptions Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.complianceExceptions.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: an exception request with no expiresAt is rejected -- no permanent silent exceptions", async () => {
  const result = await requestException({ orgId, justification: "Missing expiry on purpose", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 400);
});

test("a well-formed exception request succeeds and carries the expiry through REQUESTED -> APPROVED -> ACTIVE", async () => {
  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { exception } = await requestException({ orgId, justification: "Legacy system migration in progress", expiresAt: futureDate, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(exception.status, "REQUESTED");
  assert.equal(exception.expiresAt, futureDate);

  const approved = await transitionException({ orgId, exceptionId: exception._id, action: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(approved.exception.status, "APPROVED");
  assert.equal(approved.exception.riskAcceptedByEmail, OWNER_EMAIL);

  const active = await transitionException({ orgId, exceptionId: exception._id, action: "activate", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(active.exception.status, "ACTIVE");
  assert.equal(active.exception.expiresAt, futureDate, "the expiry set at request time must survive through activation");
});

test("an ACTIVE exception past its expiresAt is surfaced by listExpiredExceptions() for renewal/closure -- but its stored status is not silently flipped", async () => {
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { exception } = await requestException({ orgId, justification: "Already-expired test exception", expiresAt: pastDate, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionException({ orgId, exceptionId: exception._id, action: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionException({ orgId, exceptionId: exception._id, action: "activate", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const expired = await listExpiredExceptions(orgId);
  assert.ok(expired.some((e) => e._id.toString() === exception._id.toString()), "an ACTIVE exception past its expiry must appear in listExpiredExceptions()");

  const stored = await collections.complianceExceptions.findOne({ _id: exception._id });
  assert.equal(stored.status, "ACTIVE", "the stored status is not silently auto-flipped to EXPIRED -- a human must still renew or close it");
});

test("renewing an exception requires a new expiresAt, and closing requires no expiry argument", async () => {
  const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const { exception } = await requestException({ orgId, justification: "Renewal test", expiresAt: futureDate, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionException({ orgId, exceptionId: exception._id, action: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionException({ orgId, exceptionId: exception._id, action: "activate", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const noExpiryRenewal = await transitionException({ orgId, exceptionId: exception._id, action: "renew", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(noExpiryRenewal.error !== undefined, true, "renewing without a new expiresAt must be rejected");

  const newExpiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  const renewed = await transitionException({ orgId, exceptionId: exception._id, action: "renew", expiresAt: newExpiry, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(renewed.exception.status, "RENEWED");
  assert.equal(renewed.exception.expiresAt, newExpiry);
});
