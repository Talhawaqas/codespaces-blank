// src/lib/education/admissions.js
//
// Education OS — admissions pipeline. An application holds the applicant's
// details (guardian contact sealed, same as the student register) and moves
// through a fixed state machine. Enrolling an accepted application creates
// the student record through students.js, so every register rule
// (duplicates, sealing, admission numbers) applies exactly once.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canKeepStudentRegister, canAccessEducation } from "../orgGates.js";
import { sealJson, openJson } from "./crypto.js";
import { logEducationEvent } from "./audit.js";
import { createStudent } from "./students.js";

export const APPLICATION_TRANSITIONS = {
  APPLIED: ["UNDER_REVIEW", "REJECTED", "WITHDRAWN"],
  UNDER_REVIEW: ["ACCEPTED", "REJECTED", "WITHDRAWN"],
  ACCEPTED: ["WITHDRAWN"], // ENROLLED only via enrolApplication()
  REJECTED: [],
  WITHDRAWN: [],
  ENROLLED: [],
};

const now = () => new Date().toISOString();
const clean = (v, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function createApplication({ orgId, applicantName, dateOfBirth, gender, classId, previousSchool, guardian, notes, membership, actorEmail }) {
  if (!canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can record applications.", status: 403 };
  const name = clean(applicantName, 100);
  if (!name) return { error: "The applicant's name is required.", status: 400 };
  if (!guardian?.name) return { error: "A guardian name is required.", status: 400 };
  if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return { error: "Date of birth must be YYYY-MM-DD.", status: 400 };
  const { eduApplications, eduClasses } = await getOrgCollections();
  if (classId && !(await eduClasses.findOne({ _id: toObjectId(classId), orgId: toObjectId(orgId) }))) return { error: "Class not found.", status: 404 };
  const g = { name: clean(guardian.name, 80), relation: clean(guardian.relation, 30) || "guardian", phone: clean(guardian.phone, 20).replace(/[^\d+]/g, "") || null, email: clean(guardian.email, 120).toLowerCase() || null, primary: true };
  if (g.phone && !/^\+?\d{7,15}$/.test(g.phone)) return { error: "The guardian's phone number doesn't look right.", status: 400 };
  const doc = {
    orgId: toObjectId(orgId), applicantName: name, dateOfBirth: dateOfBirth || null, gender: gender || null,
    classId: classId ? toObjectId(classId) : null, previousSchool: clean(previousSchool, 120) || null,
    guardianName: g.name, guardianSealed: sealJson(g), notes: clean(notes, 1000) || null,
    status: "APPLIED", history: [{ status: "APPLIED", at: now(), byEmail: actorEmail }],
    createdByEmail: actorEmail, createdAt: now(), updatedAt: now(),
  };
  const r = await eduApplications.insertOne(doc);
  await logEducationEvent({ orgId, recordType: "EDU_APPLICATION", recordId: r.insertedId, actorEmail, action: "CREATED", metadata: {} });
  return { application: publicShape({ ...doc, _id: r.insertedId }) };
}

function publicShape(a, { withGuardian = false } = {}) {
  const { guardianSealed, ...rest } = a;
  return withGuardian ? { ...rest, guardian: openJson(guardianSealed) } : rest;
}

export async function listApplications(orgId, { membership, status } = {}) {
  if (!canAccessEducation(membership) || !canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can see applications.", status: 403 };
  const { eduApplications } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (status) q.status = status;
  const rows = await eduApplications.find(q).sort({ createdAt: -1 }).limit(1000).toArray();
  return { applications: rows.map((a) => publicShape(a)) };
}

export async function getApplication({ orgId, applicationId, membership, actorEmail }) {
  if (!canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can open applications.", status: 403 };
  const { eduApplications } = await getOrgCollections();
  const a = await eduApplications.findOne({ _id: toObjectId(applicationId), orgId: toObjectId(orgId) });
  if (!a) return { error: "Application not found.", status: 404 };
  await logEducationEvent({ orgId, recordType: "EDU_APPLICATION", recordId: a._id, actorEmail, action: "VIEWED", metadata: {} });
  return { application: publicShape(a, { withGuardian: true }) };
}

export async function transitionApplication({ orgId, applicationId, toStatus, note, membership, actorEmail }) {
  if (!canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can move applications.", status: 403 };
  const { eduApplications } = await getOrgCollections();
  const a = await eduApplications.findOne({ _id: toObjectId(applicationId), orgId: toObjectId(orgId) });
  if (!a) return { error: "Application not found.", status: 404 };
  if (!(APPLICATION_TRANSITIONS[a.status] || []).includes(toStatus)) return { error: `An application that is ${a.status} can't move to ${toStatus}.`, status: 409 };
  // Conditional on the status we read, so two people acting at once can't both win.
  const r = await eduApplications.updateOne({ _id: a._id, status: a.status }, { $set: { status: toStatus, updatedAt: now() }, $push: { history: { status: toStatus, at: now(), byEmail: actorEmail, note: clean(note, 300) || null } } });
  if (!r.modifiedCount) return { error: "Someone else changed this application. Reload and try again.", status: 409 };
  await logEducationEvent({ orgId, recordType: "EDU_APPLICATION", recordId: a._id, actorEmail, action: "TRANSITIONED", metadata: { from: a.status, to: toStatus } });
  return { status: toStatus };
}

export async function enrolApplication({ orgId, applicationId, classId, admissionNo, allowDuplicate, membership, actorEmail }) {
  if (!canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can enrol students.", status: 403 };
  const { eduApplications } = await getOrgCollections();
  const a = await eduApplications.findOne({ _id: toObjectId(applicationId), orgId: toObjectId(orgId) });
  if (!a) return { error: "Application not found.", status: 404 };
  if (a.status !== "ACCEPTED") return { error: "Only an accepted application can be enrolled.", status: 409 };
  const claimed = await eduApplications.updateOne({ _id: a._id, status: "ACCEPTED" }, { $set: { status: "ENROLLING" } });
  if (!claimed.modifiedCount) return { error: "This application is already being enrolled.", status: 409 };
  const result = await createStudent({
    orgId, fullName: a.applicantName, dateOfBirth: a.dateOfBirth, gender: a.gender, classId: classId || a.classId,
    admissionNo, guardians: [openJson(a.guardianSealed)].filter(Boolean), allowDuplicate, fromApplicationId: a._id, membership, actorEmail,
  });
  if (result.error) {
    await eduApplications.updateOne({ _id: a._id }, { $set: { status: "ACCEPTED" } });
    return result;
  }
  await eduApplications.updateOne({ _id: a._id }, { $set: { status: "ENROLLED", studentId: result.student._id, updatedAt: now() }, $push: { history: { status: "ENROLLED", at: now(), byEmail: actorEmail } } });
  await logEducationEvent({ orgId, recordType: "EDU_APPLICATION", recordId: a._id, actorEmail, action: "ENROLLED", metadata: { studentId: String(result.student._id) } });
  return { student: result.student };
}
