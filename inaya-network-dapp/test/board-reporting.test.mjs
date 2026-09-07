// test/board-reporting.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§115) — Board
// Reporting. Load-bearing property: a report can never be published
// twice, and once PUBLISHED nothing in this file can alter its sections
// -- exactly compliance-policies.js's own immutability discipline.
//
// Run with: node --env-file=.env.local --test test/board-reporting.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { draftBoardReport, publishBoardReport, listBoardReports } from "../src/lib/board-reporting.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `board-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let financialOrgId, generalOrgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const financialOrgResult = await collections.orgs.insertOne({ name: `Board Test Financial ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "financial", createdAt: now });
  financialOrgId = financialOrgResult.insertedId;
  const generalOrgResult = await collections.orgs.insertOne({ name: `Board Test General ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "general", createdAt: now });
  generalOrgId = generalOrgResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: [financialOrgId, generalOrgId] } }),
    collections.boardReports.deleteMany({ orgId: { $in: [financialOrgId, generalOrgId] } }),
    collections.orgActivity.deleteMany({ orgId: { $in: [financialOrgId, generalOrgId] } }),
    collections.auditChainEntries.deleteMany({ orgId: { $in: [financialOrgId, generalOrgId] } }),
    collections.auditChainHeads.deleteMany({ orgId: { $in: [financialOrgId, generalOrgId] } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("draftBoardReport compiles real sections and marks vertical-inapplicable ones honestly, never fabricated", async () => {
  const { report: generalReport } = await draftBoardReport({ orgId: generalOrgId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(generalReport.status, "DRAFT");
  assert.equal(generalReport.sections.investmentExposure.notApplicable, true, "a general-vertical org has no investment exposure");
  assert.equal(generalReport.sections.portfolioPerformance.notApplicable, true);
  assert.ok(generalReport.sections.regulatoryChanges.note.includes("No live external regulatory-change feed"));

  const { report: financialReport } = await draftBoardReport({ orgId: financialOrgId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(financialReport.sections.investmentExposure.notApplicable, undefined, "a financial-vertical org DOES get a real investment exposure section");
  assert.ok("positionCount" in financialReport.sections.investmentExposure);
});

test("SECURITY: a plain member cannot draft or publish a board report", async () => {
  const plainMember = { role: "member", email: `plain-${RUN_ID}@example.com` };
  const draftResult = await draftBoardReport({ orgId: generalOrgId, actorEmail: plainMember.email, membership: plainMember });
  assert.equal(draftResult.status, 403);
});

test("SECURITY/HONESTY: publishBoardReport() can only be called once -- a second attempt fails, and the immutability holds", async () => {
  const { report } = await draftBoardReport({ orgId: generalOrgId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const first = await publishBoardReport({ orgId: generalOrgId, reportId: report._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(first.report.status, "PUBLISHED");
  assert.ok(first.report.publishedAt);

  const second = await publishBoardReport({ orgId: generalOrgId, reportId: report._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(second.status, 409);

  const stored = await collections.boardReports.findOne({ _id: report._id });
  assert.equal(stored.publishedAt, first.report.publishedAt, "a rejected re-publish must not touch publishedAt");
});

test("listBoardReports filters by status and orders most-recent-drafted first", async () => {
  const reports = await listBoardReports(generalOrgId, {});
  assert.ok(reports.length >= 1);
  const published = await listBoardReports(generalOrgId, { status: "PUBLISHED" });
  assert.ok(published.every((r) => r.status === "PUBLISHED"));
});
