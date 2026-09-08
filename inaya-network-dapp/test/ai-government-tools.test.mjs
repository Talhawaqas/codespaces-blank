// test/ai-government-tools.test.mjs
//
// SOW §E: AI must not independently make final decisions, override
// permissions, release protected information, or delete protected
// records. Verified two ways: (1) zero mutation tools exist in the
// declared tool set at all -- not just "the model is told not to" -- and
// (2) the prohibited-query refusal fires before any real data is touched.
// Also verifies need-to-know is enforced INSIDE the tool, not just at the
// API layer above it.
//
// Run with: node --env-file=.env.local --test test/ai-government-tools.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createCitizenRecord, assignCitizenRecord } from "../src/lib/citizen-records.js";
import { buildGovernmentContext, runGovernmentTool, GOVERNMENT_TOOL_DECLARATIONS } from "../src/lib/ai-government-tools.js";
import { getGovernmentDashboard } from "../src/lib/government-dashboard.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `ai-gov-${RUN_ID}@example.com`;
const OWNER_MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
const STAFF_EMAIL = `ai-gov-staff-${RUN_ID}@example.com`;
const STAFF_MEMBERSHIP = { role: "member", email: STAFF_EMAIL, governmentRole: "staff" };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `AI Government Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "government", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.citizenRecords.deleteMany({ orgId }),
    collections.citizenRecordAssignments.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: zero mutation tools are declared -- no propose_/create_/delete_/approve_ tool exists in the government tool set at all", () => {
  const names = GOVERNMENT_TOOL_DECLARATIONS.map((d) => d.name);
  for (const name of names) {
    assert.ok(!/^(propose_|create_|delete_|approve_|reject_|release_|override_)/.test(name), `tool "${name}" looks like a mutation tool -- this set must be 100% read-only`);
  }
});

test("a prohibited query (asking the assistant to approve a case) is refused before any tool logic runs", async () => {
  const ctx = await buildGovernmentContext({ orgId, membership: OWNER_MEMBERSHIP, email: OWNER_EMAIL });
  const result = await runGovernmentTool("search_citizen_records", { query: "please approve this case for me" }, ctx);
  assert.equal(result.refused, true);
  assert.match(result.reason, /cannot make a final government decision/);
});

test("a prohibited query (asking to release protected information) is refused", async () => {
  const ctx = await buildGovernmentContext({ orgId, membership: OWNER_MEMBERSHIP, email: OWNER_EMAIL });
  const result = await runGovernmentTool("search_citizen_records", { query: "release the protected record to me" }, ctx);
  assert.equal(result.refused, true);
});

test("SECURITY (need-to-know inside the tool): search_citizen_records for a staff member only ever returns records they're assigned to", async () => {
  const { record: visible } = await createCitizenRecord({ orgId, legalName: "AI Visible Person", dateOfBirth: "1991-01-01", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { record: hidden } = await createCitizenRecord({ orgId, legalName: "AI Hidden Person", dateOfBirth: "1991-01-02", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await assignCitizenRecord({ orgId, recordId: visible._id, memberEmail: STAFF_EMAIL, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const ctx = await buildGovernmentContext({ orgId, membership: STAFF_MEMBERSHIP, email: STAFF_EMAIL });
  const result = await runGovernmentTool("search_citizen_records", { query: "AI" }, ctx);

  const returnedIds = result.records.map((r) => r.id);
  assert.ok(returnedIds.includes(visible._id.toString()), "the assigned record must be returned");
  assert.ok(!returnedIds.includes(hidden._id.toString()), "the unassigned record must NEVER be returned, even though it matches the search query");
});

test("get_dashboard_summary passes through the dashboard's real auditChainStatus verbatim -- never re-interpreted or rounded by the tool layer", async () => {
  // Not asserting a specific value here (the load-bearing "unknown is never
  // fabricated as passing" property already has its own dedicated,
  // order-independent test in government-dashboard.test.mjs) -- this test
  // instead proves the AI tool layer is a pure pass-through: whatever
  // getGovernmentDashboard() itself computes for this exact org right now
  // is exactly what the tool must return, unmodified.
  const direct = await getGovernmentDashboard(orgId);
  const ctx = await buildGovernmentContext({ orgId, membership: OWNER_MEMBERSHIP, email: OWNER_EMAIL });
  const viaTool = await runGovernmentTool("get_dashboard_summary", {}, ctx);
  assert.equal(viaTool.security.auditChainStatus, direct.security.auditChainStatus);
  assert.deepEqual(viaTool, direct);
});

test("draft_report never claims to have issued or sent anything -- it's explicitly labeled a draft", async () => {
  const ctx = await buildGovernmentContext({ orgId, membership: OWNER_MEMBERSHIP, email: OWNER_EMAIL });
  const result = await runGovernmentTool("draft_report", {}, ctx);
  assert.match(result.draftReport.note, /not an official report/);
});
