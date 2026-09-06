// test/fund-visibility.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 1 (§5.3): "A user
// must not automatically inherit access across funds merely because
// they belong to the same organization." This is the exact same
// assignment-based model as health_care_team_assignments/
// legal_matter_team_assignments -- this test proves it holds for funds
// too, via getAccessibleScope() (document-permissions.js), the single
// shared visibility resolver every module reads from.
//
// Run with: node --env-file=.env.local --test test/fund-visibility.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createFund, assignFundTeamMember } from "../src/lib/fund-registry.js";
import { getAccessibleScope } from "../src/lib/document-permissions.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `fund-visibility-owner-${RUN_ID}@example.com`;
const PLAIN_MEMBER_EMAIL = `fund-visibility-plain-${RUN_ID}@example.com`;
const ASSIGNED_ANALYST_EMAIL = `fund-visibility-analyst-${RUN_ID}@example.com`;
const OWNER_MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Fund Visibility Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "financial", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.financialFunds.deleteMany({ orgId }),
    collections.financialFundTeamAssignments.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: a fund's creator is automatically on its team and can see it", async () => {
  const { fund } = await createFund({ orgId, legalName: `Alpha Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const scope = await getAccessibleScope({ orgId, membership: OWNER_MEMBERSHIP, email: OWNER_EMAIL });
  // Owner also has org-wide visibility (canManageOrg bypass), so this
  // alone doesn't prove assignment-based scoping -- the next test does.
  assert.ok(scope.visibleFunds.some((f) => f._id.toString() === fund._id.toString()));
});

test("SECURITY: a plain member (role:'member', no financialRole, no fund assignment) sees ZERO funds, even though the org has one", async () => {
  const { fund } = await createFund({ orgId, legalName: `Beta Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const plainMembership = { role: "member", email: PLAIN_MEMBER_EMAIL };
  const scope = await getAccessibleScope({ orgId, membership: plainMembership, email: PLAIN_MEMBER_EMAIL });
  assert.equal(scope.visibleFunds.length, 0, "a plain org member with no fund-team assignment must see zero funds -- department/org membership alone must not grant fund access");
  assert.ok(fund, "sanity: the fund really was created"); // keep fund referenced
});

test("SECURITY: an assigned analyst sees ONLY the fund they're assigned to, not other funds in the same org", async () => {
  const { fund: fundA } = await createFund({ orgId, legalName: `Gamma Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { fund: fundB } = await createFund({ orgId, legalName: `Delta Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  await assignFundTeamMember({ orgId, fundId: fundA._id, memberEmail: ASSIGNED_ANALYST_EMAIL, role: "analyst", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const analystMembership = { role: "member", email: ASSIGNED_ANALYST_EMAIL };
  const scope = await getAccessibleScope({ orgId, membership: analystMembership, email: ASSIGNED_ANALYST_EMAIL });

  const visibleIds = scope.visibleFunds.map((f) => f._id.toString());
  assert.ok(visibleIds.includes(fundA._id.toString()), "the assigned analyst must see the fund they're assigned to");
  assert.ok(!visibleIds.includes(fundB._id.toString()), "the assigned analyst must NOT see a different fund in the same org they were never assigned to");
});

test("a financialRole:'manager' member sees ALL funds org-wide, same as owner/admin", async () => {
  const { fund } = await createFund({ orgId, legalName: `Epsilon Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const managerMembership = { role: "member", email: `fund-visibility-manager-${RUN_ID}@example.com`, financialRole: "manager" };
  const scope = await getAccessibleScope({ orgId, membership: managerMembership, email: managerMembership.email });
  assert.ok(scope.visibleFunds.some((f) => f._id.toString() === fund._id.toString()), "a financialRole:'manager' must see every fund org-wide, not just assigned ones");
});
