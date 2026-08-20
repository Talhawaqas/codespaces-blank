// test/dataroom.test.mjs
//
// Covers Investor Data Room's validate*Input guards and the token/session
// helpers (generation, hashing, magic-link consume, revoke). Real
// MongoDB, disposable randomized docs, cleanup in after() — same
// convention as every other test file in this directory.
//
// Run with: node --test test/dataroom.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validateVisitorInput,
  validateDocumentUploadInput,
  getDataroomCollections,
  ensureDataroomIndexes,
  requestDataroomAccess,
  consumeDataroomMagicLink,
  getVisitorEngagementSummary,
  revokeDataroomVisitor,
  recordViewOpened,
  recordViewEvent,
  toObjectId,
} from "../src/lib/dataroom.js";
import mongoClientPromise from "../src/lib/mongodb.js";

after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

// ---------------------------------------------------------------
// validateVisitorInput
// ---------------------------------------------------------------

test("validateVisitorInput: accepts a well-formed name+email and normalizes email", () => {
  const clean = validateVisitorInput({ name: "Jane Investor", email: "  Jane@Fund.VC  " });
  assert.equal(clean.name, "Jane Investor");
  assert.equal(clean.email, "jane@fund.vc");
});

test("validateVisitorInput: rejects a missing or empty name", () => {
  assert.throws(() => validateVisitorInput({ name: "", email: "a@b.com" }), /Name is required/i);
  assert.throws(() => validateVisitorInput({ email: "a@b.com" }), /Name is required/i);
});

test("validateVisitorInput: rejects a missing or malformed email", () => {
  assert.throws(() => validateVisitorInput({ name: "Jane", email: "" }), /valid email/i);
  assert.throws(() => validateVisitorInput({ name: "Jane", email: "not-an-email" }), /valid email/i);
});

// ---------------------------------------------------------------
// validateDocumentUploadInput
// ---------------------------------------------------------------

const baseUpload = { title: "Q3 Financials", category: "Financials", sizeBytes: 1024 * 1024, mimeType: "application/pdf" };

test("validateDocumentUploadInput: accepts a well-formed PDF upload", () => {
  const clean = validateDocumentUploadInput(baseUpload);
  assert.equal(clean.title, "Q3 Financials");
  assert.equal(clean.category, "Financials");
});

test("validateDocumentUploadInput: defaults category to General when omitted", () => {
  const clean = validateDocumentUploadInput({ ...baseUpload, category: undefined });
  assert.equal(clean.category, "General");
});

test("validateDocumentUploadInput: rejects a missing title", () => {
  assert.throws(() => validateDocumentUploadInput({ ...baseUpload, title: "" }), /Title is required/i);
});

test("validateDocumentUploadInput: rejects an oversized file", () => {
  assert.throws(() => validateDocumentUploadInput({ ...baseUpload, sizeBytes: 100 * 1024 * 1024 }), /too large/i);
});

test("validateDocumentUploadInput: rejects an unsupported mime type", () => {
  assert.throws(() => validateDocumentUploadInput({ ...baseUpload, mimeType: "application/x-msdownload" }), /Unsupported file type/i);
});

test("validateDocumentUploadInput: rejects an empty (zero-byte) file", () => {
  assert.throws(() => validateDocumentUploadInput({ ...baseUpload, sizeBytes: 0 }), /empty or unreadable/i);
});

// ---------------------------------------------------------------
// Visitor request-access + magic-link consume + engagement (real MongoDB)
// ---------------------------------------------------------------

const TEST_EMAIL = `dataroom-test-${randomUUID().slice(0, 8)}@example.com`;
let createdVisitorId;

test("requestDataroomAccess + consumeDataroomMagicLink: full round trip", async () => {
  await ensureDataroomIndexes();

  const { token, visitorId } = await requestDataroomAccess({ name: "Test Investor", email: TEST_EMAIL });
  createdVisitorId = visitorId;
  assert.ok(token);
  assert.ok(visitorId);

  const result = await consumeDataroomMagicLink(token);
  assert.equal(result.visitorId.toString(), visitorId.toString());
  assert.ok(result.sessionToken);

  // A used token must not be consumable a second time.
  const reused = await consumeDataroomMagicLink(token);
  assert.equal(reused.error, "invalid_or_expired");
});

test("consumeDataroomMagicLink: rejects an unknown token", async () => {
  const result = await consumeDataroomMagicLink("not-a-real-token");
  assert.equal(result.error, "invalid_or_expired");
});

test("view tracking + engagement summary: opened -> heartbeat -> closed yields a sensible duration", async () => {
  const { documents } = await getDataroomCollections();
  const { insertedId: documentId } = await documents.insertOne({
    title: "Test Doc",
    category: "General",
    filename: "test.pdf",
    cid: "fake-cid",
    sizeBytes: 1000,
    mimeType: "application/pdf",
    uploadedAt: new Date().toISOString(),
    order: 0,
  });

  try {
    await recordViewOpened({ visitorId: createdVisitorId, documentId });
    await recordViewEvent({ visitorId: createdVisitorId, documentId, event: "heartbeat" });
    await recordViewEvent({ visitorId: createdVisitorId, documentId, event: "closed" });

    const summary = await getVisitorEngagementSummary();
    const entry = summary.find((v) => v.visitorId === createdVisitorId.toString());
    assert.ok(entry, "visitor should appear in the engagement summary");
    assert.equal(entry.totalViews, 1);
    assert.equal(entry.views[0].documentTitle, "Test Doc");
    assert.ok(entry.totalDurationMs >= 0);
  } finally {
    await documents.deleteOne({ _id: documentId });
  }
});

test("revokeDataroomVisitor: clears sessions and marks revoked", async () => {
  const { visitors, sessions } = await getDataroomCollections();

  await revokeDataroomVisitor(createdVisitorId);

  const visitor = await visitors.findOne({ _id: toObjectId(createdVisitorId) });
  assert.ok(visitor.revokedAt);

  const remainingSessions = await sessions.countDocuments({ visitorId: toObjectId(createdVisitorId) });
  assert.equal(remainingSessions, 0);
});

// ---------------------------------------------------------------
// Cleanup — remove everything this test run created
// ---------------------------------------------------------------

test("cleanup: remove test visitor and magic links", async () => {
  const { visitors, magicLinks, sessions, views } = await getDataroomCollections();
  await visitors.deleteOne({ email: TEST_EMAIL });
  await magicLinks.deleteMany({ email: TEST_EMAIL });
  await sessions.deleteMany({ visitorId: toObjectId(createdVisitorId) });
  await views.deleteMany({ visitorId: toObjectId(createdVisitorId) });
});
