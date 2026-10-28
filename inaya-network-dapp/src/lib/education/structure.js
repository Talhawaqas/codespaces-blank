// src/lib/education/structure.js
//
// Education OS — academic years, classes (grade + section), subjects,
// class-teacher assignments and staff education roles. A teacher's access
// to students, attendance and marks comes ONLY from edu_class_teachers
// rows (isClassTeacher in orgGates.js), never from the role alone.

import { getOrgCollections, toObjectId, canManageOrg } from "../orgs.js";
import { canAccessEducation, canManageEducation, EDUCATION_ROLES } from "../orgGates.js";
import { logEducationEvent } from "./audit.js";

const now = () => new Date().toISOString();
const clean = (v, max = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const isDuplicateKey = (err) => err?.code === 11000;

// ---------- Academic years ----------
export async function createAcademicYear({ orgId, name, startDate, endDate, current, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can add academic years.", status: 403 };
  const n = clean(name, 30);
  if (!n) return { error: "A name such as 2026-27 is required.", status: 400 };
  if (startDate && endDate && startDate > endDate) return { error: "The start date must be before the end date.", status: 400 };
  const { eduAcademicYears } = await getOrgCollections();
  const doc = { orgId: toObjectId(orgId), name: n, startDate: startDate || null, endDate: endDate || null, current: !!current, createdByEmail: actorEmail, createdAt: now() };
  try {
    if (doc.current) await eduAcademicYears.updateMany({ orgId: doc.orgId }, { $set: { current: false } });
    const r = await eduAcademicYears.insertOne(doc);
    return { year: { ...doc, _id: r.insertedId } };
  } catch (err) {
    if (isDuplicateKey(err)) return { error: "That academic year already exists.", status: 409 };
    throw err;
  }
}

export async function listAcademicYears(orgId, { membership }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduAcademicYears } = await getOrgCollections();
  return { years: await eduAcademicYears.find({ orgId: toObjectId(orgId) }).sort({ name: -1 }).toArray() };
}

// ---------- Classes ----------
export async function createClass({ orgId, academicYearId, name, section, capacity, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can add classes.", status: 403 };
  const n = clean(name, 40);
  if (!n) return { error: "A class name such as Grade 5 or FSc Part 1 is required.", status: 400 };
  const { eduClasses, eduAcademicYears } = await getOrgCollections();
  let yearId = null;
  if (academicYearId) {
    const year = await eduAcademicYears.findOne({ _id: toObjectId(academicYearId), orgId: toObjectId(orgId) });
    if (!year) return { error: "Academic year not found.", status: 404 };
    yearId = year._id;
  }
  const cap = capacity === undefined || capacity === null || capacity === "" ? null : Number(capacity);
  if (cap !== null && !(Number.isInteger(cap) && cap > 0)) return { error: "Capacity must be a positive whole number.", status: 400 };
  const doc = { orgId: toObjectId(orgId), academicYearId: yearId, name: n, section: clean(section, 10) || null, capacity: cap, createdByEmail: actorEmail, createdAt: now() };
  try {
    const r = await eduClasses.insertOne(doc);
    await logEducationEvent({ orgId, recordType: "EDU_CLASS", recordId: r.insertedId, actorEmail, action: "CREATED", metadata: { name: n, section: doc.section } });
    return { class: { ...doc, _id: r.insertedId } };
  } catch (err) {
    if (isDuplicateKey(err)) return { error: "That class and section already exist for this year.", status: 409 };
    throw err;
  }
}

/** Every education member can see the class list (names only); a teacher's
 *  own classes are flagged so the UI can default to them. */
export async function listClasses(orgId, { membership }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduClasses, eduClassTeachers, eduStudents } = await getOrgCollections();
  const oid = toObjectId(orgId);
  const [classes, teachers, counts] = await Promise.all([
    eduClasses.find({ orgId: oid }).sort({ name: 1, section: 1 }).toArray(),
    eduClassTeachers.find({ orgId: oid }).toArray(),
    eduStudents.aggregate([{ $match: { orgId: oid, status: "enrolled" } }, { $group: { _id: "$classId", n: { $sum: 1 } } }]).toArray(),
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.n]));
  return {
    classes: classes.map((c) => {
      const t = teachers.filter((a) => String(a.classId) === String(c._id));
      return { ...c, label: classLabel(c), teachers: t.map((a) => ({ email: a.email, role: a.role })), mine: t.some((a) => a.email === membership.email), enrolled: countBy.get(String(c._id)) || 0 };
    }),
  };
}

export function classLabel(c) {
  return c ? (c.section ? `${c.name} ${c.section}` : c.name) : "";
}

export async function assignClassTeacher({ orgId, classId, email, role, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can assign teachers.", status: 403 };
  const { eduClasses, eduClassTeachers, orgMembers } = await getOrgCollections();
  const cls = await eduClasses.findOne({ _id: toObjectId(classId), orgId: toObjectId(orgId) });
  if (!cls) return { error: "Class not found.", status: 404 };
  const em = String(email || "").trim().toLowerCase();
  const member = await orgMembers.findOne({ orgId: toObjectId(orgId), email: em, status: "active" });
  if (!member) return { error: "That person isn't an active member of this school.", status: 404 };
  await eduClassTeachers.updateOne(
    { orgId: toObjectId(orgId), classId: cls._id, email: em },
    { $set: { role: role === "class_teacher" ? "class_teacher" : "subject_teacher", updatedAt: now() }, $setOnInsert: { assignedByEmail: actorEmail, createdAt: now() } },
    { upsert: true }
  );
  await logEducationEvent({ orgId, recordType: "EDU_CLASS", recordId: cls._id, actorEmail, action: "TEACHER_ASSIGNED", metadata: { email: em } });
  return { assigned: true };
}

export async function unassignClassTeacher({ orgId, classId, email, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can change teacher assignments.", status: 403 };
  const { eduClassTeachers } = await getOrgCollections();
  const em = String(email || "").trim().toLowerCase();
  await eduClassTeachers.deleteOne({ orgId: toObjectId(orgId), classId: toObjectId(classId), email: em });
  await logEducationEvent({ orgId, recordType: "EDU_CLASS", recordId: classId, actorEmail, action: "TEACHER_UNASSIGNED", metadata: { email: em } });
  return { unassigned: true };
}

export async function getClassAssignments(orgId, classId) {
  const { eduClassTeachers } = await getOrgCollections();
  return eduClassTeachers.find({ orgId: toObjectId(orgId), classId: toObjectId(classId) }).toArray();
}

/** Class ids the member teaches; null means "no limit" (managers). */
export async function teachableClassIds(orgId, membership) {
  if (canManageEducation(membership)) return null;
  const { eduClassTeachers } = await getOrgCollections();
  const rows = await eduClassTeachers.find({ orgId: toObjectId(orgId), email: membership.email }).toArray();
  return rows.map((r) => r.classId);
}

// ---------- Subjects ----------
export async function createSubject({ orgId, name, code, membership }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can add subjects.", status: 403 };
  const n = clean(name, 60);
  if (!n) return { error: "A subject name is required.", status: 400 };
  const { eduSubjects } = await getOrgCollections();
  const doc = { orgId: toObjectId(orgId), name: n, code: clean(code, 12) || null, createdAt: now() };
  try {
    const r = await eduSubjects.insertOne(doc);
    return { subject: { ...doc, _id: r.insertedId } };
  } catch (err) {
    if (isDuplicateKey(err)) return { error: "That subject already exists.", status: 409 };
    throw err;
  }
}

export async function listSubjects(orgId, { membership }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduSubjects } = await getOrgCollections();
  return { subjects: await eduSubjects.find({ orgId: toObjectId(orgId) }).sort({ name: 1 }).toArray() };
}

// ---------- Staff education roles ----------
export async function listStaffRoles(orgId, { membership }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can see staff roles.", status: 403 };
  const { orgMembers } = await getOrgCollections();
  const rows = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1, role: 1, educationRole: 1 }).sort({ email: 1 }).limit(1000).toArray();
  return { roles: EDUCATION_ROLES, members: rows.map((m) => ({ email: m.email, role: m.role, educationRole: m.educationRole || null })) };
}

/** Owner/admin only: the org's own owner/admin decide who runs the school,
 *  so a principal can't hand out (or keep) the principal role themselves. */
export async function setStaffRole({ orgId, email, educationRole, membership, actorEmail }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can set education roles.", status: 403 };
  const role = educationRole || null;
  if (role !== null && !EDUCATION_ROLES.includes(role)) return { error: `Role must be one of: ${EDUCATION_ROLES.join(", ")}, or none.`, status: 400 };
  const { orgMembers } = await getOrgCollections();
  const em = String(email || "").trim().toLowerCase();
  const update = role ? { $set: { educationRole: role } } : { $unset: { educationRole: "" } };
  const r = await orgMembers.updateOne({ orgId: toObjectId(orgId), email: em, status: "active" }, update);
  if (!r.matchedCount) return { error: "That person isn't an active member.", status: 404 };
  await logEducationEvent({ orgId, recordType: "ORG_MEMBER", recordId: null, actorEmail, action: "EDUCATION_ROLE_SET", metadata: { email: em, educationRole: role } });
  return { email: em, educationRole: role };
}
