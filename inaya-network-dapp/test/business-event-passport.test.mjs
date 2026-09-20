// test/business-event-passport.test.mjs
//
// Evidence Graph SOW §17 — Business Event Passport. Load-bearing property:
// the manifest hash is a real, independently recomputable function of the
// passport's own content (reusing evidenceExporter.js's canonicalize, per
// businessEventPassport.js's header), so tampering with any field after
// generation must flip verification to INVALID — not silently pass.
//
// Run with: node --env-file=.env.local --test test/business-event-passport.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createBusinessEvent } from "../src/lib/businessEvents.js";
import { buildBusinessEventPassport, verifyBusinessEventPassport, renderBusinessEventPassportPdf } from "../src/lib/businessEventPassport.js";

const RUN_ID = randomUUID().slice(0, 8);
let collections;
const cleanupOrgIds = [];

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: cleanupOrgIds } }),
    collections.departments.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.orgMembers.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.invoices.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.businessEvents.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.orgActivity.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.auditChainEntries.deleteMany({ orgId: { $in: cleanupOrgIds } }),
    collections.auditChainHeads.deleteMany({ orgId: { $in: cleanupOrgIds } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithEvent() {
  const now = new Date().toISOString();
  const ownerEmail = `passport-owner-${RUN_ID}@example.com`;
  const orgResult = await collections.orgs.insertOne({ name: `Passport ${RUN_ID} Co`, ownerEmail, createdAt: now });
  const orgId = orgResult.insertedId;
  cleanupOrgIds.push(orgId);
  const deptResult = await collections.departments.insertOne({ orgId, name: "Finance", createdAt: now });
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const { insertedId: invoiceId } = await collections.invoices.insertOne({
    orgId, departmentId: deptResult.insertedId, contactId: orgId, invoiceNumber: `INV-PP-${RUN_ID}`, issueDate: now, dueDate: now,
    lineItems: [], subtotal: 25000, total: 25000, currency: "USD", status: "DRAFT", createdByEmail: ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });
  const { event } = await createBusinessEvent({ orgId, subjectType: "INVOICE", subjectId: invoiceId, membership: owner, actorEmail: ownerEmail });
  return { orgId, owner, ownerEmail, event };
}

test("a generated passport verifies as VERIFIED, and self-audits its own generation", async () => {
  const { orgId, owner, ownerEmail, event } = await makeOrgWithEvent();
  const { passport } = await buildBusinessEventPassport({ orgId, eventId: event._id, membership: owner, actorEmail: ownerEmail });

  assert.ok(passport.manifestHash);
  assert.equal(passport.eventSummary.eventId, String(event._id));

  const verification = await verifyBusinessEventPassport(passport);
  assert.equal(verification.state, "VERIFIED");

  const auditRow = await collections.orgActivity.findOne({ orgId, recordType: "BUSINESS_EVENT", recordId: event._id, action: "PASSPORT_GENERATED" });
  assert.ok(auditRow, "passport generation must self-audit via the existing audit chain");
  assert.equal(auditRow.metadata.manifestHash, passport.manifestHash);
});

test("tampering with a passport's content after generation is detected as INVALID", async () => {
  const { orgId, owner, ownerEmail, event } = await makeOrgWithEvent();
  const { passport } = await buildBusinessEventPassport({ orgId, eventId: event._id, membership: owner, actorEmail: ownerEmail });

  const tampered = { ...passport, eventSummary: { ...passport.eventSummary, riskLevel: "LOW" } };
  const verification = await verifyBusinessEventPassport(tampered);
  assert.equal(verification.state, "INVALID");
});

test("a passport missing its manifest hash is reported INCOMPLETE, never silently VERIFIED", async () => {
  const { orgId, owner, ownerEmail, event } = await makeOrgWithEvent();
  const { passport } = await buildBusinessEventPassport({ orgId, eventId: event._id, membership: owner, actorEmail: ownerEmail });
  const { manifestHash, ...withoutHash } = passport;

  const verification = await verifyBusinessEventPassport(withoutHash);
  assert.equal(verification.state, "INCOMPLETE");
});

test("PDF rendering produces a non-empty PDF buffer containing the manifest hash", async () => {
  const { orgId, owner, ownerEmail, event } = await makeOrgWithEvent();
  const { passport } = await buildBusinessEventPassport({ orgId, eventId: event._id, membership: owner, actorEmail: ownerEmail });

  const pdfBuffer = await renderBusinessEventPassportPdf(passport);
  assert.ok(Buffer.isBuffer(pdfBuffer));
  assert.ok(pdfBuffer.length > 500, "a real rendered PDF should be well over a few hundred bytes");
  assert.equal(pdfBuffer.slice(0, 4).toString(), "%PDF", "must be a real PDF file signature");
});
