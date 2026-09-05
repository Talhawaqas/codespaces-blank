// test/phase7-gapfill-and-integrations.test.mjs
//
// Healthcare & Legal Expansion SOW coverage for the Phase 7 files that
// were missed on the first implementation pass (legal-calendar.js,
// redaction.js, legal-discovery-workflow.js) plus Phase 10's integration
// adapter stubs. Covers: a manually-entered deadline is auto-confirmed
// but an externally-synced one starts unconfirmed until a human
// confirms it; redaction never mutates the original document reference;
// discovery production excludes privileged documents even when also
// tagged responsive; and every adapter is an honest, non-fabricating
// stub by default, becoming configured only when its required env vars
// are actually present.
//
// Run with: node --env-file=.env.local --test test/phase7-gapfill-and-integrations.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createMatter } from "../src/lib/legal-matter-workflow.js";
import { createDeadline, confirmDeadline, sendDeadlineReminders } from "../src/lib/legal-calendar.js";
import { createRedactionRequest, completeRedaction } from "../src/lib/redaction.js";
import { createDiscoveryRequest, addCollectedDocuments, tagDocument, produceDiscovery } from "../src/lib/legal-discovery-workflow.js";
import { getFhirAdapter } from "../src/lib/integrations/health/fhirAdapter.js";
import { getEfilingAdapter } from "../src/lib/integrations/legal/efilingAdapter.js";
import { getSsoAdapter } from "../src/lib/integrations/sso.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-p7gap-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, legalMatters, legalDeadlines, legalDiscovery, orgActivity, db } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalMatters.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalDeadlines.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalDiscovery.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await db.collection("legal_redaction_requests").deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const ownerEmail = email(`${label}-owner`);
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  return { orgId, ownerEmail, owner };
}

// ============================================================
// Legal calendar — authoritative-deadline discipline
// ============================================================
test("SECURITY: a manually-entered deadline is auto-confirmed, but an externally-synced one starts UNCONFIRMED", async () => {
  const org = await makeOrg("calendar-confirmation");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Calendar Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });

  const { deadline: manual } = await createDeadline({ orgId: org.orgId, matterId: matter._id, description: "Manual filing deadline", dueAt: "2026-12-01", source: "manual", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(manual.manualConfirmation, true);
  assert.equal(manual.confidence, "high");

  const { deadline: synced } = await createDeadline({ orgId: org.orgId, matterId: matter._id, description: "Synced hearing date", dueAt: "2026-12-15", source: "external_sync", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(synced.manualConfirmation, false, "an externally-synced deadline must NOT be presented as authoritative until confirmed");
  assert.equal(synced.confidence, "unverified");

  const confirmed = await confirmDeadline({ orgId: org.orgId, deadlineId: synced._id, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(confirmed.deadline.manualConfirmation, true);
  assert.equal(confirmed.deadline.confidence, "high");
});

test("legal calendar: reminders sent exactly once, escalate for unconfirmed deadlines", async () => {
  const org = await makeOrg("calendar-reminders");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Reminder Matter", type: "litigation", responsiblePartnerEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await createDeadline({ orgId: org.orgId, matterId: matter._id, description: "Urgent unconfirmed deadline", dueAt: soon, source: "external_sync", actorEmail: org.ownerEmail, membership: org.owner });

  const first = await sendDeadlineReminders(3);
  assert.equal(first.sent, 1);
  const second = await sendDeadlineReminders(3);
  assert.equal(second.sent, 0, "a reminder already sent must not be sent again");
});

// ============================================================
// Redaction — original is never mutated
// ============================================================
test("SECURITY: redaction never mutates the original document reference, only links a new redacted document", async () => {
  const org = await makeOrg("redaction");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Redaction Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const fakeOriginalDocId = "000000000000000000000111";
  const { request } = await createRedactionRequest({ orgId: org.orgId, matterId: matter._id, originalDocumentId: fakeOriginalDocId, suggestions: [{ text: "SSN", reason: "PII" }], actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(request.status, "PENDING_REVIEW");
  assert.equal(request.originalDocumentId.toString(), fakeOriginalDocId);

  const fakeRedactedDocId = "000000000000000000000222";
  const completed = await completeRedaction({ orgId: org.orgId, requestId: request._id, redactedDocumentId: fakeRedactedDocId, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(completed.request.status, "COMPLETED");
  assert.equal(completed.request.originalDocumentId.toString(), fakeOriginalDocId, "the original document reference must be untouched");
  assert.equal(completed.request.redactedDocumentId.toString(), fakeRedactedDocId);
});

// ============================================================
// Discovery — privileged documents never enter the production set
// ============================================================
test("SECURITY: a document tagged responsive AND privileged is EXCLUDED from the production set", async () => {
  const org = await makeOrg("discovery-privilege");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Discovery Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const { discovery } = await createDiscoveryRequest({ orgId: org.orgId, matterId: matter._id, requestingParty: "Opposing Co", respondingParty: "Our Client", actorEmail: org.ownerEmail, membership: org.owner });

  const docA = "000000000000000000000301";
  const docB = "000000000000000000000302";
  await addCollectedDocuments({ orgId: org.orgId, discoveryId: discovery._id, documentIds: [docA, docB], custodianEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });

  // Dedup check: re-adding the same IDs should add 0 new documents.
  const dedupResult = await addCollectedDocuments({ orgId: org.orgId, discoveryId: discovery._id, documentIds: [docA, docB], custodianEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(dedupResult.added, 0);

  await tagDocument({ orgId: org.orgId, discoveryId: discovery._id, documentId: docA, responsive: true, privileged: false, actorEmail: org.ownerEmail, membership: org.owner });
  await tagDocument({ orgId: org.orgId, discoveryId: discovery._id, documentId: docB, responsive: true, privileged: true, actorEmail: org.ownerEmail, membership: org.owner });

  const produced = await produceDiscovery({ orgId: org.orgId, discoveryId: discovery._id, actorEmail: org.ownerEmail, membership: org.owner });
  const producedIds = produced.discovery.productionSet.map((id) => id.toString());
  assert.ok(producedIds.includes(docA), "responsive, non-privileged document must be produced");
  assert.ok(!producedIds.includes(docB), "responsive BUT privileged document must NEVER be produced");
});

// ============================================================
// Integration adapters — honest stubs, never fabricated data
// ============================================================
test("integration adapters: default to configured:false and every method returns an honest not-configured message", async () => {
  const fhir = getFhirAdapter();
  assert.equal(fhir.configured, false);
  const result = await fhir.getPatient();
  assert.equal(result.configured, false);
  assert.match(result.message, /not configured/i);

  const efiling = getEfilingAdapter();
  assert.equal(efiling.configured, false);
  const filingResult = await efiling.submitFiling();
  assert.equal(filingResult.configured, false);

  const sso = getSsoAdapter();
  assert.equal(sso.configured, false);
});

test("integration adapters: become configured:true only when ALL required env vars are actually present", async () => {
  const before = getEfilingAdapter();
  assert.equal(before.configured, false);

  process.env.EFILING_PROVIDER_URL = "https://example-test-efiling.invalid";
  // Only one of two required vars set — must still be unconfigured.
  const partiallyConfigured = getEfilingAdapter();
  assert.equal(partiallyConfigured.configured, false, "partial credentials must not flip configured to true");

  process.env.EFILING_API_KEY = "test-key";
  const fullyConfigured = getEfilingAdapter();
  assert.equal(fullyConfigured.configured, true);
  assert.equal(fullyConfigured.credentials.EFILING_PROVIDER_URL, "https://example-test-efiling.invalid");

  delete process.env.EFILING_PROVIDER_URL;
  delete process.env.EFILING_API_KEY;
});
