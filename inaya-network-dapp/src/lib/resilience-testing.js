// src/lib/resilience-testing.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§71) —
// Resilience Testing. Cross-vertical. This is the GENERAL resilience
// test log (vulnerability scans, penetration tests, tabletop exercises,
// failover tests, backup-restore tests, incident simulations, dependency-
// failure simulations, scenario/performance/end-to-end testing) --
// distinct from disaster-recovery.js's recordDrTest(), which is a
// narrower, runbook-specific technical record (RTO/RPO context tied to
// one ICT asset's recovery procedure). A "disaster_recovery" test type
// exists here too for the org-wide test calendar/history view, and MAY
// reference a specific runbookId, but the authoritative RTO/RPO pass/fail
// record for that runbook still lives in disaster-recovery.js -- this
// file never duplicates that data, only cross-references it.
//
// Every test records scope/tester/date/methodology/result/findings/
// remediation/retest/evidence (§71) as one immutable record -- a test
// result is never edited after the fact, matching every other
// "immutable event record" in this codebase.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const RESILIENCE_TEST_TYPES = [
  "vulnerability", "penetration", "tabletop", "failover", "backup_restore",
  "disaster_recovery", "incident_simulation", "dependency_failure", "scenario", "performance", "end_to_end",
];
export const RESILIENCE_TEST_RESULTS = ["pass", "fail", "partial"];

export async function recordResilienceTest({ orgId, testType, scope, testerEmail, methodology, result, findings, remediation, retestRequired, evidenceDocumentId, runbookId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can record a resilience test.", status: 403 };
  if (!RESILIENCE_TEST_TYPES.includes(testType)) return { error: `Unknown test type "${testType}".`, status: 400 };
  if (!RESILIENCE_TEST_RESULTS.includes(result)) return { error: `Unknown test result "${result}".`, status: 400 };
  if (!scope?.trim()) return { error: "A test scope is required.", status: 400 };

  const { resilienceTests } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), testType, scope: scope.trim(), testerEmail: testerEmail || actorEmail,
    methodology: methodology || null, result, findings: findings || [], remediation: remediation || null,
    retestRequired: !!retestRequired, evidenceDocumentId: evidenceDocumentId ? toObjectId(evidenceDocumentId) : null,
    runbookId: runbookId ? toObjectId(runbookId) : null,
    testedByEmail: actorEmail, testedAt: now,
  };
  const insertResult = await resilienceTests.insertOne(doc);
  const inserted = { ...doc, _id: insertResult.insertedId };
  await logOrgActivity({ orgId, recordType: "RESILIENCE_TEST", recordId: inserted._id, actorEmail, action: "RECORDED", previousState: null, newState: null, metadata: { testType, result } });
  return { test: inserted };
}

export async function listResilienceTests(orgId, { testType, result } = {}) {
  const { resilienceTests } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (testType) query.testType = testType;
  if (result) query.result = result;
  return resilienceTests.find(query).sort({ testedAt: -1 }).toArray();
}

/** Every test type that has never been run at all -- never silently
 *  assumed covered because a DIFFERENT test type passed. */
export async function listUncoveredTestTypes(orgId) {
  const tests = await listResilienceTests(orgId);
  const coveredTypes = new Set(tests.map((t) => t.testType));
  return RESILIENCE_TEST_TYPES.filter((t) => !coveredTypes.has(t));
}
