// src/lib/compliance-health.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§48, §113,
// §191-192) — the Continuous Compliance dashboard aggregator. This is a
// pure read-aggregation over the other modules' collections; it never
// writes anything.
//
// THE LOAD-BEARING RULE OF THIS ENTIRE PHASE (§191-192): a control that
// has never been tested is UNKNOWN, never silently counted as passing.
// "Unknown" and "green/passing" are NOT the same bucket, and this file
// must never let a control default into "passing" just because nothing
// contradicts it. overallStatus follows the same discipline — it can
// only be "green" when there is real, positive evidence everything is
// fine; a control-free or untested org is "unknown", never "green".
//
// test/compliance-health.test.mjs asserts this directly: seed a control
// with zero test records and confirm it lands in controlsUnknown, never
// controlsPassing.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { listExpiringEvidence } from "./compliance-evidence.js";
import { getOrgEnabledFrameworks, getFrameworkRequirements } from "./compliance-frameworks.js";

export async function getComplianceHealth(orgId) {
  const { complianceControls, complianceControlTests, complianceFindings } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();

  const [controls, allTests, findings, evidenceExpiringSoon, enabledFrameworkIds] = await Promise.all([
    complianceControls.find({ orgId: orgObjectId, status: { $ne: "retired" } }).toArray(),
    complianceControlTests.find({ orgId: orgObjectId }).sort({ testedAt: -1 }).toArray(),
    complianceFindings.find({ orgId: orgObjectId }).toArray(),
    listExpiringEvidence(orgId, { withinDays: 30 }),
    getOrgEnabledFrameworks(orgId),
  ]);

  // Latest test per control — tests are already sorted testedAt desc, so
  // the first one seen per controlId is the latest.
  const latestTestByControl = new Map();
  for (const test of allTests) {
    const key = test.controlId?.toString();
    if (key && !latestTestByControl.has(key)) latestTestByControl.set(key, test);
  }

  let controlsPassing = 0, controlsFailing = 0, controlsUnknown = 0, overdueReviews = 0;
  for (const control of controls) {
    const latest = latestTestByControl.get(control._id.toString());
    if (!latest || latest.result === "unknown") controlsUnknown += 1;
    else if (latest.result === "pass") controlsPassing += 1;
    else if (latest.result === "fail") controlsFailing += 1;
    else controlsUnknown += 1; // any unrecognized value is unknown, never silently passing

    if (control.nextTestDueAt && control.nextTestDueAt < now) overdueReviews += 1;
  }

  const openFindings = findings.filter((f) => f.status !== "CLOSED");
  const criticalFindings = openFindings.filter((f) => f.severity === "critical");
  const closedFindings = findings.filter((f) => f.status === "CLOSED");

  const remediationProgress = findings.length === 0
    ? { total: 0, closed: 0, percentComplete: null } // null, not 0 — "no findings" is not "0% progress"
    : { total: findings.length, closed: closedFindings.length, percentComplete: Math.round((closedFindings.length / findings.length) * 100) };

  const frameworkCoverage = [];
  for (const frameworkId of enabledFrameworkIds) {
    const requirements = getFrameworkRequirements(frameworkId) || [];
    const coveredIds = new Set();
    for (const control of controls) {
      for (const link of control.linkedRequirements || []) {
        if (link.frameworkId === frameworkId) coveredIds.add(link.requirementId);
      }
    }
    frameworkCoverage.push({
      frameworkId,
      totalRequirements: requirements.length,
      coveredRequirements: coveredIds.size,
      coveragePercent: requirements.length === 0 ? null : Math.round((coveredIds.size / requirements.length) * 100),
    });
  }

  // Overall status: never "green" unless there is real positive evidence.
  // A control-free or fully-untested org is "unknown", not "green" — this
  // is the single most important line in this file.
  let overallStatus;
  if (controlsFailing > 0 || criticalFindings.length > 0) overallStatus = "red";
  else if (controls.length === 0 || controlsUnknown > 0) overallStatus = "unknown";
  else if (openFindings.length > 0 || evidenceExpiringSoon.length > 0 || overdueReviews > 0) overallStatus = "amber";
  else overallStatus = "green";

  return {
    overallStatus,
    controlsPassing,
    controlsFailing,
    controlsUnknown,
    totalControls: controls.length,
    evidenceExpiringSoon: evidenceExpiringSoon.length,
    overdueReviews,
    openFindings: openFindings.length,
    criticalFindings: criticalFindings.length,
    remediationProgress,
    frameworkCoverage,
    computedAt: now,
  };
}
