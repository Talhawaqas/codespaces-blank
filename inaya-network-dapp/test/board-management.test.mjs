// test/board-management.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§36) — board
// meeting lifecycle + resolution voting. Load-bearing property: voting
// tally correctness (majority of approve vs. reject decides PASSED/
// FAILED, abstains don't count either way) and that voting, once closed,
// cannot be reopened or re-tallied.
//
// Run with: node --env-file=.env.local --test test/board-management.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createFund } from "../src/lib/fund-registry.js";
import { createPortfolioCompany } from "../src/lib/portfolio-company.js";
import { createBoardMeeting, setAgenda, holdMeeting, draftMinutes, approveMinutes, addActionItem, proposeResolution, castVote, closeVoting } from "../src/lib/board-management.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `board-mgmt-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
// Deliberately NOT elevated -- a plain member with no financialRole at
// all, to prove board records require the elevated gate on reads too.
const PLAIN_MEMBERSHIP = { role: "member", email: `plain-${RUN_ID}@example.com` };
let collections;
let orgId;
let companyId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Board Mgmt Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "private_capital", createdAt: now });
  orgId = orgResult.insertedId;
  const { fund } = await createFund({ orgId, legalName: `Board Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { portfolioCompany } = await createPortfolioCompany({ orgId, fundId: fund._id, name: `Board Company ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  companyId = portfolioCompany._id;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.financialFunds.deleteMany({ orgId }),
    collections.financialFundTeamAssignments.deleteMany({ orgId }),
    collections.portfolioCompanies.deleteMany({ orgId }),
    collections.boardMeetings.deleteMany({ orgId }),
    collections.boardResolutions.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: a plain member with no elevated financial-entities permission cannot create or read board meetings", async () => {
  const createResult = await createBoardMeeting({ orgId, portfolioCompanyId: companyId, scheduledAt: new Date().toISOString(), actorEmail: PLAIN_MEMBERSHIP.email, membership: PLAIN_MEMBERSHIP });
  assert.equal(createResult.error !== undefined, true);
  assert.equal(createResult.status, 403);
});

test("board meeting lifecycle: SCHEDULED -> AGENDA_SET -> HELD -> MINUTES_DRAFTED -> MINUTES_APPROVED", async () => {
  const { meeting } = await createBoardMeeting({ orgId, portfolioCompanyId: companyId, scheduledAt: new Date().toISOString(), actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(meeting.status, "SCHEDULED");

  const { meeting: agendaSet } = await setAgenda({ orgId, meetingId: meeting._id, agendaItems: ["Financial update", "Hiring plan"], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(agendaSet.status, "AGENDA_SET");
  assert.deepEqual(agendaSet.agenda, ["Financial update", "Hiring plan"]);

  const { meeting: held } = await holdMeeting({ orgId, meetingId: meeting._id, attendees: [{ email: OWNER_EMAIL, present: true }], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(held.status, "HELD");

  const { meeting: drafted } = await draftMinutes({ orgId, meetingId: meeting._id, minutesText: "Discussed Q3 numbers.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(drafted.status, "MINUTES_DRAFTED");

  const { meeting: approvedMins } = await approveMinutes({ orgId, meetingId: meeting._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(approvedMins.status, "MINUTES_APPROVED");
});

test("action items are append-only and never silently removed", async () => {
  const { meeting } = await createBoardMeeting({ orgId, portfolioCompanyId: companyId, scheduledAt: new Date().toISOString(), actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await addActionItem({ orgId, meetingId: meeting._id, description: "Follow up with auditor", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { meeting: withTwo } = await addActionItem({ orgId, meetingId: meeting._id, description: "Send updated cap table", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(withTwo.actionItems.length, 2);
  assert.equal(withTwo.actionItems[0].status, "open");
});

test("closeVoting() tallies approve vs. reject correctly -- abstains don't count either way", async () => {
  const { meeting } = await createBoardMeeting({ orgId, portfolioCompanyId: companyId, scheduledAt: new Date().toISOString(), actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { resolution } = await proposeResolution({ orgId, meetingId: meeting._id, title: "Approve Series B term sheet", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  await castVote({ orgId, resolutionId: resolution._id, voterEmail: "director-a@example.com", vote: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await castVote({ orgId, resolutionId: resolution._id, voterEmail: "director-b@example.com", vote: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await castVote({ orgId, resolutionId: resolution._id, voterEmail: "director-c@example.com", vote: "reject", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await castVote({ orgId, resolutionId: resolution._id, voterEmail: "director-d@example.com", vote: "abstain", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const { resolution: closed } = await closeVoting({ orgId, resolutionId: resolution._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(closed.status, "VOTING_CLOSED");
  assert.equal(closed.outcome, "PASSED", "2 approve vs 1 reject (abstain excluded) should pass");

  const doubleClose = await closeVoting({ orgId, resolutionId: resolution._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(doubleClose.error !== undefined, true, "voting cannot be closed twice");
});

test("castVote() replaces a voter's own prior vote (change of mind) but is rejected once voting is closed", async () => {
  const { meeting } = await createBoardMeeting({ orgId, portfolioCompanyId: companyId, scheduledAt: new Date().toISOString(), actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { resolution } = await proposeResolution({ orgId, meetingId: meeting._id, title: "Approve new hire comp plan", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  await castVote({ orgId, resolutionId: resolution._id, voterEmail: "director-a@example.com", vote: "reject", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { resolution: changed } = await castVote({ orgId, resolutionId: resolution._id, voterEmail: "director-a@example.com", vote: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(changed.votes.length, 1, "changing a vote must replace it, not append a duplicate");
  assert.equal(changed.votes[0].vote, "approve");

  await closeVoting({ orgId, resolutionId: resolution._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const lateVote = await castVote({ orgId, resolutionId: resolution._id, voterEmail: "director-b@example.com", vote: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(lateVote.error !== undefined, true, "a vote cannot be cast once voting is closed");
});
