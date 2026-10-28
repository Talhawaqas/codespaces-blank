// src/lib/education/dashboard.js
//
// Education OS home: real counts only. Fee figures are shown only to
// people who handle fees; a teacher sees their own classes' registers.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canAccessEducation, canHandleFees, canKeepStudentRegister } from "../orgGates.js";
import { todayOverview } from "./attendance.js";
import { collectionSummary, defaulters } from "./fees.js";
import { getEducationSettings } from "./settings.js";

export async function educationDashboard({ orgId, membership }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const c = await getOrgCollections();
  const oid = toObjectId(orgId);
  const month = new Date().toISOString().slice(0, 7);
  const [settings, attendance, enrolled, classes, openApplications, docsPending] = await Promise.all([
    getEducationSettings(orgId),
    todayOverview({ orgId, membership }),
    c.eduStudents.countDocuments({ orgId: oid, status: "enrolled" }),
    c.eduClasses.countDocuments({ orgId: oid }),
    canKeepStudentRegister(membership) ? c.eduApplications.countDocuments({ orgId: oid, status: { $in: ["APPLIED", "UNDER_REVIEW", "ACCEPTED"] } }) : null,
    canKeepStudentRegister(membership) ? c.eduStudents.countDocuments({ orgId: oid, status: "enrolled", documents: { $elemMatch: { status: { $ne: "verified" } } } }) : null,
  ]);
  let fees = null;
  if (canHandleFees(membership)) {
    const [summary, overdue, pendingConcessions] = await Promise.all([
      collectionSummary(orgId, { membership, from: `${month}-01`, to: `${month}-31` }),
      defaulters(orgId, { membership }),
      c.eduConcessions.countDocuments({ orgId: oid, status: "REQUESTED" }),
    ]);
    const collectedThisMonth = summary.byMethod.filter((m) => m.currency === settings.currency).reduce((t, m) => t + m.amountMinor, 0);
    const outstanding = overdue.defaulters.filter((d) => d.currency === settings.currency).reduce((t, d) => t + d.outstandingMinor, 0);
    fees = { currency: settings.currency, collectedThisMonthMinor: collectedThisMonth, overdueMinor: outstanding, defaulters: overdue.defaulters.length, pendingConcessions };
  }
  return { settings, enrolled, classes, openApplications, documentsPending: docsPending, attendance: attendance.error ? null : attendance, fees, educationRole: membership.educationRole || null };
}
