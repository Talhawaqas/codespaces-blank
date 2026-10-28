// src/lib/education/exams.js
//
// Education OS — assessments, marks and report cards.
//   DRAFT      teachers of the class enter and change marks
//   PUBLISHED  the principal publishes; marks are locked. A change after
//              publishing is an amendment by the principal with a reason,
//              and the previous value is kept in the mark's history.
// Only PUBLISHED results ever reach a report card or a guardian link.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canAccessEducation, canManageEducation, isClassTeacher, canKeepStudentRegister } from "../orgGates.js";
import { logEducationEvent } from "./audit.js";
import { getClassAssignments, teachableClassIds, classLabel } from "./structure.js";

const now = () => new Date().toISOString();
const clean = (v, max = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const DEFAULT_GRADE_SCALE = [
  { min: 90, grade: "A+" }, { min: 80, grade: "A" }, { min: 70, grade: "B" }, { min: 60, grade: "C" },
  { min: 50, grade: "D" }, { min: 40, grade: "E" }, { min: 0, grade: "F" },
];

export function gradeFor(percent, scale = DEFAULT_GRADE_SCALE) {
  if (percent === null || percent === undefined) return null;
  return scale.find((s) => percent >= s.min)?.grade ?? "F";
}

async function teacherOf(orgId, classId, membership) {
  const assignments = await getClassAssignments(orgId, classId);
  return isClassTeacher(membership, classId, assignments);
}

export async function createAssessment({ orgId, classId, subjectId, name, term, maxMarks, date, membership, actorEmail }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduClasses, eduSubjects, eduAssessments } = await getOrgCollections();
  const cls = await eduClasses.findOne({ _id: toObjectId(classId), orgId: toObjectId(orgId) });
  if (!cls) return { error: "Class not found.", status: 404 };
  if (!(await teacherOf(orgId, cls._id, membership))) return { error: "Only a teacher of this class or the principal can add assessments.", status: 403 };
  let subject = null;
  if (subjectId) {
    subject = await eduSubjects.findOne({ _id: toObjectId(subjectId), orgId: toObjectId(orgId) });
    if (!subject) return { error: "Subject not found.", status: 404 };
  }
  const n = clean(name);
  if (!n) return { error: "A name such as Mid-term or Unit test 2 is required.", status: 400 };
  const max = Number(maxMarks);
  if (!(max > 0 && max <= 1000)) return { error: "Maximum marks must be between 1 and 1000.", status: 400 };
  const doc = { orgId: toObjectId(orgId), classId: cls._id, subjectId: subject?._id || null, subjectName: subject?.name || null, name: n, term: clean(term, 30) || null, maxMarks: max, date: date || null, status: "DRAFT", createdByEmail: actorEmail, createdAt: now() };
  const r = await eduAssessments.insertOne(doc);
  await logEducationEvent({ orgId, recordType: "EDU_ASSESSMENT", recordId: r.insertedId, actorEmail, action: "CREATED", metadata: { name: n } });
  return { assessment: { ...doc, _id: r.insertedId } };
}

export async function listAssessments(orgId, { classId, membership }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduAssessments } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  const limit = canKeepStudentRegister(membership) ? null : await teachableClassIds(orgId, membership);
  if (limit) q.classId = { $in: limit };
  if (classId) {
    if (limit && !limit.some((id) => String(id) === String(classId))) return { error: "You're not assigned to that class.", status: 403 };
    q.classId = toObjectId(classId);
  }
  return { assessments: await eduAssessments.find(q).sort({ createdAt: -1 }).limit(500).toArray() };
}

export async function getMarksSheet({ orgId, assessmentId, membership }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduAssessments, eduMarks, eduStudents } = await getOrgCollections();
  const a = await eduAssessments.findOne({ _id: toObjectId(assessmentId), orgId: toObjectId(orgId) });
  if (!a) return { error: "Assessment not found.", status: 404 };
  if (!(await teacherOf(orgId, a.classId, membership)) && !canKeepStudentRegister(membership)) return { error: "You're not assigned to this class.", status: 403 };
  const [students, marks] = await Promise.all([
    eduStudents.find({ orgId: toObjectId(orgId), classId: a.classId, status: "enrolled" }).project({ fullName: 1, admissionNo: 1 }).sort({ fullName: 1 }).toArray(),
    eduMarks.find({ orgId: toObjectId(orgId), assessmentId: a._id }).toArray(),
  ]);
  const byStudent = new Map(marks.map((m) => [String(m.studentId), m]));
  return { assessment: a, rows: students.map((s) => { const m = byStudent.get(String(s._id)); return { studentId: s._id, fullName: s.fullName, admissionNo: s.admissionNo, marks: m?.marks ?? null, absent: !!m?.absent, amended: (m?.history || []).length > 0 }; }) };
}

/** entries: [{ studentId, marks, absent }]. DRAFT only. */
export async function enterMarks({ orgId, assessmentId, entries, membership, actorEmail }) {
  const { eduAssessments, eduMarks, eduStudents } = await getOrgCollections();
  const a = await eduAssessments.findOne({ _id: toObjectId(assessmentId), orgId: toObjectId(orgId) });
  if (!a) return { error: "Assessment not found.", status: 404 };
  if (!(await teacherOf(orgId, a.classId, membership))) return { error: "Only a teacher of this class or the principal can enter marks.", status: 403 };
  if (a.status !== "DRAFT") return { error: "These results are published. Ask the principal to amend a mark.", status: 409 };
  const enrolled = new Set((await eduStudents.find({ orgId: toObjectId(orgId), classId: a.classId, status: "enrolled" }).project({ _id: 1 }).toArray()).map((s) => String(s._id)));
  const ops = [];
  for (const e of entries || []) {
    if (!enrolled.has(String(e.studentId))) return { error: "One of the students isn't enrolled in this class.", status: 400 };
    const absent = !!e.absent;
    const value = absent || e.marks === null || e.marks === "" || e.marks === undefined ? null : Number(e.marks);
    if (value !== null && !(value >= 0 && value <= a.maxMarks)) return { error: `Marks must be between 0 and ${a.maxMarks}.`, status: 400 };
    ops.push({ updateOne: { filter: { orgId: toObjectId(orgId), assessmentId: a._id, studentId: toObjectId(e.studentId) }, update: { $set: { marks: value, absent, classId: a.classId, updatedAt: now(), updatedByEmail: actorEmail } }, upsert: true } });
  }
  if (!ops.length) return { error: "No marks to save.", status: 400 };
  await eduMarks.bulkWrite(ops);
  await logEducationEvent({ orgId, recordType: "EDU_ASSESSMENT", recordId: a._id, actorEmail, action: "MARKS_ENTERED", metadata: { count: ops.length } });
  return { saved: ops.length };
}

export async function publishAssessment({ orgId, assessmentId, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can publish results.", status: 403 };
  const { eduAssessments } = await getOrgCollections();
  const r = await eduAssessments.findOneAndUpdate({ _id: toObjectId(assessmentId), orgId: toObjectId(orgId), status: "DRAFT" }, { $set: { status: "PUBLISHED", publishedAt: now(), publishedByEmail: actorEmail } }, { returnDocument: "after" });
  if (!r) return { error: "Assessment not found, or already published.", status: 409 };
  await logEducationEvent({ orgId, recordType: "EDU_ASSESSMENT", recordId: r._id, actorEmail, action: "PUBLISHED", metadata: {} });
  return { assessment: r };
}

export async function amendPublishedMark({ orgId, assessmentId, studentId, marks, absent, reason, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can amend published marks.", status: 403 };
  const why = clean(reason, 300);
  if (!why) return { error: "A reason is required to change a published mark.", status: 400 };
  const { eduAssessments, eduMarks } = await getOrgCollections();
  const a = await eduAssessments.findOne({ _id: toObjectId(assessmentId), orgId: toObjectId(orgId) });
  if (!a) return { error: "Assessment not found.", status: 404 };
  if (a.status !== "PUBLISHED") return { error: "This assessment isn't published; change the marks directly.", status: 409 };
  const value = absent ? null : Number(marks);
  if (!absent && !(value >= 0 && value <= a.maxMarks)) return { error: `Marks must be between 0 and ${a.maxMarks}.`, status: 400 };
  const prev = await eduMarks.findOne({ orgId: toObjectId(orgId), assessmentId: a._id, studentId: toObjectId(studentId) });
  if (!prev) return { error: "No mark recorded for that student.", status: 404 };
  await eduMarks.updateOne({ _id: prev._id }, { $set: { marks: value, absent: !!absent, updatedAt: now(), updatedByEmail: actorEmail }, $push: { history: { marks: prev.marks, absent: !!prev.absent, changedAt: now(), changedByEmail: actorEmail, reason: why } } });
  await logEducationEvent({ orgId, recordType: "EDU_ASSESSMENT", recordId: a._id, actorEmail, action: "MARK_AMENDED", metadata: { studentId: String(studentId), from: prev.marks, to: value, reason: why } });
  return { amended: true };
}

/** Published results only. Used by the report card and guardian links. */
export async function publishedResults(orgId, studentId) {
  const { eduMarks, eduAssessments } = await getOrgCollections();
  const marks = await eduMarks.find({ orgId: toObjectId(orgId), studentId: toObjectId(studentId) }).toArray();
  if (!marks.length) return [];
  const assessments = await eduAssessments.find({ _id: { $in: marks.map((m) => m.assessmentId) }, status: "PUBLISHED" }).toArray();
  const byId = new Map(assessments.map((a) => [String(a._id), a]));
  return marks.filter((m) => byId.has(String(m.assessmentId))).map((m) => {
    const a = byId.get(String(m.assessmentId));
    const percent = m.absent || m.marks === null ? null : Math.round((m.marks / a.maxMarks) * 1000) / 10;
    return { assessment: a.name, subject: a.subjectName, term: a.term, date: a.date, maxMarks: a.maxMarks, marks: m.marks, absent: !!m.absent, percent, grade: gradeFor(percent) };
  }).sort((x, y) => String(x.term).localeCompare(String(y.term)) || String(x.subject).localeCompare(String(y.subject)));
}

export async function reportCard({ orgId, studentId, membership, actorEmail }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduStudents, eduClasses } = await getOrgCollections();
  const s = await eduStudents.findOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId), status: { $ne: "erased" } });
  if (!s) return { error: "Student not found.", status: 404 };
  if (!canKeepStudentRegister(membership) && !(s.classId && (await teacherOf(orgId, s.classId, membership)))) return { error: "You're not assigned to this student's class.", status: 403 };
  const cls = s.classId ? await eduClasses.findOne({ _id: s.classId }) : null;
  const results = await publishedResults(orgId, s._id);
  const scored = results.filter((r) => r.percent !== null);
  const overall = scored.length ? Math.round((scored.reduce((t, r) => t + r.percent, 0) / scored.length) * 10) / 10 : null;
  await logEducationEvent({ orgId, recordType: "EDU_STUDENT", recordId: s._id, actorEmail, action: "REPORT_CARD_VIEWED", metadata: {} });
  return { student: { _id: s._id, fullName: s.fullName, admissionNo: s.admissionNo, classLabel: classLabel(cls) }, results, overall, overallGrade: gradeFor(overall) };
}
