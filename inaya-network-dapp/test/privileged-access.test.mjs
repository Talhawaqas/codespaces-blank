// test/privileged-access.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§62-63) — load-
// bearing correctness properties: (1) approveElevation() must reject the
// requester approving their own request (the exact SoD conflict §61
// names: "administrator approving own access"); (2) grantBreakGlass()
// activates immediately with no approval gate but ALWAYS sends a
// real-time notification and requires a post-event review+attestation
// before it can be closed out; (3) isSessionActive() is the single
// source of truth for "is this elevation in effect right now" and
// correctly reflects expiry.
//
// Run with: node --env-file=.env.local --test test/privileged-access.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { requestElevation, approveElevation, rejectElevation, grantBreakGlass, revokeSession, reviewSession, isSessionActive, listUnreviewedSessions } from "../src/lib/privileged-access.js";
import mongoClientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `privileged-access-${RUN_ID}@example.com`;
const OTHER_ADMIN_EMAIL = `privileged-access-admin2-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
const OTHER_ADMIN_MEMBERSHIP = { role: "admin", email: OTHER_ADMIN_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Privileged Access Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "general", createdAt: now });
  orgId = orgResult.insertedId;
  await collections.orgMembers.insertMany([
    { orgId, email: OWNER_EMAIL, role: "owner", status: "active", joinedAt: now, createdAt: now },
    { orgId, email: OTHER_ADMIN_EMAIL, role: "admin", status: "active", joinedAt: now, createdAt: now },
  ]);
});

after(async () => {
  const { db } = await connectToDatabase();
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.orgMembers.deleteMany({ orgId }),
    collections.privilegedSessions.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
    db.collection("notifications").deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: approveElevation() rejects the requester approving their own request", async () => {
  const { session } = await requestElevation({ orgId, role: "database_admin", reason: "Investigate slow query", scope: "prod-db-01", requestedHours: 2, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(session.status, "PENDING_APPROVAL");

  const result = await approveElevation({ orgId, sessionId: session._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "the requester cannot approve their own elevation request");
  assert.equal(result.status, 403);

  const stored = await collections.privilegedSessions.findOne({ _id: session._id });
  assert.equal(stored.status, "PENDING_APPROVAL", "a rejected self-approval attempt must not change the session's status");
});

test("approveElevation() succeeds for a genuinely different admin, and computes a real expiresAt", async () => {
  const { session } = await requestElevation({ orgId, role: "database_admin", reason: "Emergency patch", scope: "prod-db-02", requestedHours: 1, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const before = Date.now();
  const { session: approved } = await approveElevation({ orgId, sessionId: session._id, actorEmail: OTHER_ADMIN_EMAIL, membership: OTHER_ADMIN_MEMBERSHIP });
  assert.equal(approved.status, "ACTIVE");
  assert.equal(approved.approvedByEmail, OTHER_ADMIN_EMAIL);
  const expiresAtMs = new Date(approved.expiresAt).getTime();
  assert.ok(expiresAtMs > before + 59 * 60 * 1000 && expiresAtMs < before + 61 * 60 * 1000, "expiresAt should be ~1 hour out");
  assert.equal(isSessionActive(approved), true);
});

test("rejectElevation() moves a pending request to REJECTED, never ACTIVE", async () => {
  const { session } = await requestElevation({ orgId, role: "network_admin", reason: "Firewall change", scope: "prod-vpc", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { session: rejected } = await rejectElevation({ orgId, sessionId: session._id, actorEmail: OTHER_ADMIN_EMAIL, membership: OTHER_ADMIN_MEMBERSHIP, reason: "Not justified" });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(isSessionActive(rejected), false);
});

test("grantBreakGlass() activates immediately with no approval gate, sends a real-time notification, and appears in the unreviewed list until reviewed", async () => {
  const { session, expiresAt } = await grantBreakGlass({ orgId, role: "incident_responder", reason: "Active security incident", scope: "prod-payments-service", hours: 2, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(session.status, "ACTIVE", "break-glass access must be active immediately, not pending approval");
  assert.equal(session.approvedByEmail, null, "break-glass never goes through the planned-approval path");
  assert.equal(isSessionActive(session), true);
  assert.notEqual(expiresAt, null);

  const { db } = await connectToDatabase();
  const notifications = await db.collection("notifications").find({ orgId, sourceModule: "privileged-access", sourceId: session._id.toString() }).toArray();
  assert.ok(notifications.length > 0, "a break-glass grant must trigger a real-time notification, not a silent log entry");

  const unreviewed = await listUnreviewedSessions(orgId);
  assert.ok(unreviewed.some((s) => s._id.toString() === session._id.toString()), "an unreviewed break-glass grant must appear in the mandatory-review list");
});

test("reviewSession() requires an attestation and cannot be performed twice", async () => {
  const { session } = await grantBreakGlass({ orgId, role: "incident_responder", reason: "Second incident", scope: "prod-auth-service", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const missingAttestation = await reviewSession({ orgId, sessionId: session._id, actorEmail: OTHER_ADMIN_EMAIL, membership: OTHER_ADMIN_MEMBERSHIP, reviewNotes: "Looked fine" });
  assert.equal(missingAttestation.error !== undefined, true, "a review without an attestation must be rejected");

  const { session: reviewed } = await reviewSession({ orgId, sessionId: session._id, actorEmail: OTHER_ADMIN_EMAIL, membership: OTHER_ADMIN_MEMBERSHIP, attestation: "Confirmed access was necessary and scoped correctly." });
  assert.notEqual(reviewed.reviewedAt, null);

  const secondReview = await reviewSession({ orgId, sessionId: session._id, actorEmail: OTHER_ADMIN_EMAIL, membership: OTHER_ADMIN_MEMBERSHIP, attestation: "Reviewing again" });
  assert.equal(secondReview.error !== undefined, true, "a session cannot be reviewed twice");
  assert.equal(secondReview.status, 409);
});

test("revokeSession() only succeeds on an ACTIVE session", async () => {
  const { session } = await grantBreakGlass({ orgId, role: "incident_responder", reason: "Third incident", scope: "prod-db-03", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { session: revoked } = await revokeSession({ orgId, sessionId: session._id, actorEmail: OTHER_ADMIN_EMAIL, membership: OTHER_ADMIN_MEMBERSHIP });
  assert.equal(revoked.status, "REVOKED");
  assert.equal(isSessionActive(revoked), false);

  const secondRevoke = await revokeSession({ orgId, sessionId: session._id, actorEmail: OTHER_ADMIN_EMAIL, membership: OTHER_ADMIN_MEMBERSHIP });
  assert.equal(secondRevoke.error !== undefined, true, "an already-revoked session cannot be revoked again");
});

test("isSessionActive() correctly reflects an expired session even though its status field still says ACTIVE", async () => {
  const { session } = await requestElevation({ orgId, role: "database_admin", reason: "Test expiry", scope: "prod-db-04", requestedHours: 1, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { session: approved } = await approveElevation({ orgId, sessionId: session._id, actorEmail: OTHER_ADMIN_EMAIL, membership: OTHER_ADMIN_MEMBERSHIP });

  // Simulate time passing past expiry without a separate cron flipping the
  // status -- isSessionActive() must be the honest source of truth, not
  // the stored status field alone.
  await collections.privilegedSessions.updateOne({ _id: approved._id }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  const expired = await collections.privilegedSessions.findOne({ _id: approved._id });
  assert.equal(expired.status, "ACTIVE", "the stored status field is not auto-flipped by a cron in this pass");
  assert.equal(isSessionActive(expired), false, "isSessionActive() must still correctly report false once expiresAt has passed");
});
