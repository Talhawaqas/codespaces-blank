// src/lib/education/guardianLinks.js
//
// Education OS — read-only links for parents and guardians. A link shows
// ONE student's fee statement, attendance rate and published results, and
// nothing else: no identifiers, medical notes, address or other guardians'
// contact details. Only the SHA-256 hash of the token is stored; the token
// itself is shown once, when the link is made. Links expire (30 days by
// default, 90 at most), can be revoked, stop working the moment the
// student's data is erased or the school leaves the education vertical,
// and every view is written to the audit chain.

import { randomBytes, createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canHandleFees, canKeepStudentRegister } from "../orgGates.js";
import { logEducationEvent } from "./audit.js";
import { statementFor } from "./fees.js";
import { studentAttendance } from "./attendance.js";
import { publishedResults } from "./exams.js";
import { getEducationSettings } from "./settings.js";
import { classLabel } from "./structure.js";

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;

const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const canIssue = (m) => canHandleFees(m) || canKeepStudentRegister(m);

export async function createGuardianLink({ orgId, studentId, days, label, membership, actorEmail }) {
  if (!canIssue(membership)) return { error: "Only accounts, admissions, the principal, the owner or an admin can share a guardian link.", status: 403 };
  const d = days === undefined || days === null || days === "" ? DEFAULT_DAYS : Number(days);
  if (!(Number.isInteger(d) && d >= 1 && d <= MAX_DAYS)) return { error: `A link can last 1 to ${MAX_DAYS} days.`, status: 400 };
  const { eduStudents, eduGuardianLinks } = await getOrgCollections();
  const s = await eduStudents.findOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId), status: { $ne: "erased" } });
  if (!s) return { error: "Student not found.", status: 404 };
  const token = randomBytes(32).toString("base64url");
  const doc = { orgId: toObjectId(orgId), studentId: s._id, tokenHash: hashToken(token), label: String(label || "").trim().slice(0, 60) || null, expiresAt: new Date(Date.now() + d * 86400000).toISOString(), revokedAt: null, viewCount: 0, lastViewedAt: null, createdByEmail: actorEmail, createdAt: new Date().toISOString() };
  const r = await eduGuardianLinks.insertOne(doc);
  await logEducationEvent({ orgId, recordType: "EDU_GUARDIAN_LINK", recordId: r.insertedId, actorEmail, action: "CREATED", metadata: { studentId: String(s._id), days: d } });
  return { link: { _id: r.insertedId, expiresAt: doc.expiresAt, label: doc.label }, token, path: `/guardian/${token}` };
}

export async function listGuardianLinks({ orgId, studentId, membership }) {
  if (!canIssue(membership)) return { error: "You can't see guardian links.", status: 403 };
  const { eduGuardianLinks } = await getOrgCollections();
  const rows = await eduGuardianLinks.find({ orgId: toObjectId(orgId), studentId: toObjectId(studentId) }).project({ tokenHash: 0 }).sort({ createdAt: -1 }).toArray();
  const t = new Date().toISOString();
  return { links: rows.map((l) => ({ ...l, active: !l.revokedAt && l.expiresAt > t })) };
}

export async function revokeGuardianLink({ orgId, linkId, membership, actorEmail }) {
  if (!canIssue(membership)) return { error: "You can't revoke guardian links.", status: 403 };
  const { eduGuardianLinks } = await getOrgCollections();
  const r = await eduGuardianLinks.updateOne({ _id: toObjectId(linkId), orgId: toObjectId(orgId), revokedAt: null }, { $set: { revokedAt: new Date().toISOString(), revokedByEmail: actorEmail } });
  if (!r.modifiedCount) return { error: "Active link not found.", status: 404 };
  await logEducationEvent({ orgId, recordType: "EDU_GUARDIAN_LINK", recordId: linkId, actorEmail, action: "REVOKED", metadata: {} });
  return { revoked: true };
}

/** Public, token-only. Every failure returns the same 404 so a guess
 *  learns nothing about whether a link ever existed. */
export async function resolveGuardianLink(token) {
  const notFound = { error: "This link isn't valid. It may have expired or been withdrawn by the school.", status: 404 };
  if (typeof token !== "string" || token.length < 40 || token.length > 64) return notFound;
  const { eduGuardianLinks, eduStudents, eduClasses, orgs } = await getOrgCollections();
  const link = await eduGuardianLinks.findOne({ tokenHash: hashToken(token) });
  if (!link || link.revokedAt || link.expiresAt <= new Date().toISOString()) return notFound;
  const [org, s] = await Promise.all([
    orgs.findOne({ _id: link.orgId }, { projection: { vertical: 1 } }),
    eduStudents.findOne({ _id: link.studentId, orgId: link.orgId }),
  ]);
  if (org?.vertical !== "education" || !s || s.status === "erased") return notFound;
  const orgId = String(link.orgId);
  const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const [settings, cls, statement, attendance, results] = await Promise.all([
    getEducationSettings(orgId),
    s.classId ? eduClasses.findOne({ _id: s.classId }) : null,
    statementFor(orgId, s._id),
    studentAttendance({ orgId, studentId: s._id, from }),
    publishedResults(orgId, s._id),
  ]);
  await eduGuardianLinks.updateOne({ _id: link._id }, { $inc: { viewCount: 1 }, $set: { lastViewedAt: new Date().toISOString() } });
  await logEducationEvent({ orgId, recordType: "EDU_GUARDIAN_LINK", recordId: link._id, actorEmail: null, action: "VIEWED", metadata: {} });
  return {
    view: {
      schoolName: settings.schoolName, currency: statement.currency || settings.currency, expiresAt: link.expiresAt,
      student: { fullName: s.fullName, admissionNo: s.admissionNo, classLabel: classLabel(cls), status: s.status },
      fees: {
        outstandingMinor: statement.outstandingMinor,
        invoices: statement.invoices.map((i) => ({ invoiceNo: i.invoiceNo, period: i.period, structureName: i.structureName, lines: i.lines, concessionMinor: i.concessionMinor, lateFeeMinor: i.lateFeeMinor, totalMinor: i.totalMinor, paidMinor: i.paidMinor, status: i.status, dueDate: i.dueDate })),
        payments: statement.payments.filter((p) => p.status === "posted").map((p) => ({ receiptNo: p.receiptNo, invoiceNo: p.invoiceNo, amountMinor: p.amountMinor, method: p.method, paidOn: p.paidOn })),
      },
      attendance: { since: from, ...attendance },
      results,
    },
  };
}
