// test/investment-committee.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§8) — load-bearing
// correctness property: "a [IC] decision record cannot be silently modified;
// amendments create a new version; original decision remains preserved"
// (§8.4). Same versioned-immutable-record pattern as
// compliance-policies.test.mjs / investment-thesis.test.mjs. Also covers
// the array-`from` transition support IC_CASE_TRANSITIONS.withdraw
// introduced for this workflow (a case can be withdrawn from any of six
// pre-decision states, not just one fixed predecessor).
//
// Run with: node --env-file=.env.local --test test/investment-committee.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createCase, transitionCase, recordDecision, amendDecision, getCaseDecisionHistory } from "../src/lib/investment-committee.js";
import mongoClientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `investment-committee-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Investment Committee Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "financial", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  const { db } = await connectToDatabase();
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.investmentCommitteeCases.deleteMany({ orgId }),
    collections.icDecisions.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
    db.collection("notifications").deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function scheduledCase(opportunity) {
  const { case: created } = await createCase({ orgId, opportunity, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "submit", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "startResearch", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "submitForComplianceReview", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "submitForRiskReview", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { case: scheduled } = await transitionCase({ orgId, caseId: created._id, action: "scheduleIC", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  return scheduled;
}

test("recordDecision() creates an immutable ic_decisions v1 and transitions the case, only reachable from IC_SCHEDULED", async () => {
  const scheduled = await scheduledCase(`Deal A ${RUN_ID}`);
  const { case: decided, decision } = await recordDecision({ orgId, caseId: scheduled._id, outcome: "approve", finalResolution: "Approved as proposed.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  assert.equal(decided.status, "APPROVED");
  assert.equal(decision.version, 1);
  assert.equal(decision.supersedes, null);
  assert.equal(decision.outcome, "APPROVED");

  const again = await recordDecision({ orgId, caseId: scheduled._id, outcome: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(again.error !== undefined, true, "a decision can only be recorded once from IC_SCHEDULED -- the case is no longer in that state");
  assert.equal(again.status, 409);
});

test("amendDecision() creates a NEW ic_decisions row at version+1 and leaves the original decision row completely untouched", async () => {
  const scheduled = await scheduledCase(`Deal B ${RUN_ID}`);
  const { decision: v1 } = await recordDecision({ orgId, caseId: scheduled._id, outcome: "approveWithConditions", conditions: "Subject to legal review.", finalResolution: "Conditional approval.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const { decision: v2 } = await amendDecision({ orgId, caseId: scheduled._id, finalResolution: "Conditional approval -- amended after legal review completed.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  assert.notEqual(v2._id.toString(), v1._id.toString(), "amend must create a NEW document, not mutate the existing _id");
  assert.equal(v2.version, v1.version + 1);
  assert.equal(v2.supersedes.toString(), v1._id.toString());
  assert.equal(v2.outcome, v1.outcome, "amending does not change the vote outcome, only the recorded detail fields");
  assert.equal(v2.conditions, v1.conditions, "fields not passed to amendDecision() carry forward from the current version unchanged");

  const v1AfterAmend = await collections.icDecisions.findOne({ _id: v1._id });
  assert.equal(v1AfterAmend.finalResolution, "Conditional approval.", "the original decision row's content must be untouched by the amendment");

  const history = await getCaseDecisionHistory(orgId, scheduled._id);
  assert.equal(history.length, 2, "both the original and the amended decision rows must remain queryable -- amendment never deletes history");
});

test("amendDecision() is rejected when the case has no existing decision to amend", async () => {
  const { case: created } = await createCase({ orgId, opportunity: `Deal C ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await amendDecision({ orgId, caseId: created._id, finalResolution: "Should not work", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 404);
});

test("withdraw is legal from any of its declared array `from` states, not just one fixed predecessor", async () => {
  const { case: fromDraft } = await createCase({ orgId, opportunity: `Deal D ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const withdrawnFromDraft = await transitionCase({ orgId, caseId: fromDraft._id, action: "withdraw", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(withdrawnFromDraft.case.status, "WITHDRAWN", "withdraw must succeed from DRAFT");

  const scheduled = await scheduledCase(`Deal E ${RUN_ID}`);
  const withdrawnFromScheduled = await transitionCase({ orgId, caseId: scheduled._id, action: "withdraw", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(withdrawnFromScheduled.case.status, "WITHDRAWN", "withdraw must succeed from IC_SCHEDULED -- both are in the declared array of allowed source states");
});

test("withdraw is rejected once a case is past the array's declared states (e.g. already EXECUTED)", async () => {
  const scheduled = await scheduledCase(`Deal F ${RUN_ID}`);
  const { case: decided } = await recordDecision({ orgId, caseId: scheduled._id, outcome: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const executed = await transitionCase({ orgId, caseId: decided._id, action: "execute", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(executed.case.status, "EXECUTED");

  const result = await transitionCase({ orgId, caseId: decided._id, action: "withdraw", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "EXECUTED is not in withdraw's declared array of allowed source states");
  assert.equal(result.status, 409);
});
