// src/lib/education/attendance.js
//
// Education OS — daily attendance per class. One document per class per
// day: { marks: { <studentId>: "present" | "absent" | "late" | "leave" } }.
// Only a teacher assigned to the class (or the principal/owner/admin) can
// mark it. Teachers can correct a register for EDIT_WINDOW_DAYS; after that
// only the principal can, so a register can't be quietly rewritten weeks
// later.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canAccessEducation, canManageEducation, isClassTeacher, canKeepStudentRegister } from "../orgGates.js";
import { logEducationEvent } from "./audit.js";
import { getClassAssignments, teachableClassIds } from "./structure.js";

export const ATTENDANCE_STATUSES = ["present", "absent", "late", "leave"];
export const EDIT_WINDOW_DAYS = 3;

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

async function requireClassAccess({ orgId, classId, membership }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduClasses } = await getOrgCollections();
  const cls = await eduClasses.findOne({ _id: toObjectId(classId), orgId: toObjectId(orgId) });
  if (!cls) return { error: "Class not found.", status: 404 };
  const assignments = await getClassAssignments(orgId, cls._id);
  if (!isClassTeacher(membership, cls._id, assignments) && !canKeepStudentRegister(membership)) return { error: "You're not assigned to this class.", status: 403 };
  return { cls };
}

export async function markAttendance({ orgId, classId, date, marks, membership, actorEmail }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return { error: "Date must be YYYY-MM-DD.", status: 400 };
  if (date > today()) return { error: "Attendance can't be marked for a future date.", status: 400 };
  const access = await requireClassAccess({ orgId, classId, membership });
  if (access.error) return access;
  // Admissions staff may view registers but marking belongs to teachers and the principal.
  const assignments = await getClassAssignments(orgId, access.cls._id);
  if (!isClassTeacher(membership, access.cls._id, assignments)) return { error: "Only a teacher of this class or the principal can mark attendance.", status: 403 };
  if (!canManageEducation(membership) && daysBetween(date, today()) > EDIT_WINDOW_DAYS) return { error: `Registers older than ${EDIT_WINDOW_DAYS} days can only be changed by the principal.`, status: 403 };

  const { eduStudents, eduAttendance } = await getOrgCollections();
  const enrolled = await eduStudents.find({ orgId: toObjectId(orgId), classId: access.cls._id, status: "enrolled" }).project({ _id: 1 }).toArray();
  const allowed = new Set(enrolled.map((s) => String(s._id)));
  const clean = {};
  for (const [studentId, status] of Object.entries(marks || {})) {
    if (!allowed.has(studentId)) return { error: "One of the students isn't enrolled in this class.", status: 400 };
    if (!ATTENDANCE_STATUSES.includes(status)) return { error: `Status must be one of ${ATTENDANCE_STATUSES.join(", ")}.`, status: 400 };
    clean[studentId] = status;
  }
  if (!Object.keys(clean).length) return { error: "Mark at least one student.", status: 400 };

  const existing = await eduAttendance.findOne({ orgId: toObjectId(orgId), classId: access.cls._id, date });
  const set = Object.fromEntries(Object.entries(clean).map(([k, v]) => [`marks.${k}`, v]));
  await eduAttendance.updateOne(
    { orgId: toObjectId(orgId), classId: access.cls._id, date },
    { $set: { ...set, updatedAt: new Date().toISOString(), updatedByEmail: actorEmail }, $setOnInsert: { createdAt: new Date().toISOString(), createdByEmail: actorEmail } },
    { upsert: true }
  );
  await logEducationEvent({ orgId, recordType: "EDU_ATTENDANCE", recordId: access.cls._id, actorEmail, action: existing ? "CORRECTED" : "MARKED", metadata: { date, count: Object.keys(clean).length } });
  return { saved: Object.keys(clean).length };
}

export async function getRegister({ orgId, classId, date, membership }) {
  const access = await requireClassAccess({ orgId, classId, membership });
  if (access.error) return access;
  const { eduStudents, eduAttendance } = await getOrgCollections();
  const [students, row] = await Promise.all([
    eduStudents.find({ orgId: toObjectId(orgId), classId: access.cls._id, status: "enrolled" }).project({ fullName: 1, admissionNo: 1 }).sort({ fullName: 1 }).toArray(),
    eduAttendance.findOne({ orgId: toObjectId(orgId), classId: access.cls._id, date }),
  ]);
  return { date, classId: access.cls._id, students: students.map((s) => ({ _id: s._id, fullName: s.fullName, admissionNo: s.admissionNo, status: row?.marks?.[String(s._id)] || null })), marked: !!row };
}

/** Per-student attendance rate over [from, to] for one class. */
export async function classAttendanceSummary({ orgId, classId, from, to, membership }) {
  const access = await requireClassAccess({ orgId, classId, membership });
  if (access.error) return access;
  const { eduAttendance, eduStudents } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), classId: access.cls._id };
  if (from || to) q.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [rows, students] = await Promise.all([
    eduAttendance.find(q).toArray(),
    eduStudents.find({ orgId: toObjectId(orgId), classId: access.cls._id, status: "enrolled" }).project({ fullName: 1, admissionNo: 1 }).toArray(),
  ]);
  return {
    days: rows.length,
    students: students.map((s) => ({ _id: s._id, fullName: s.fullName, admissionNo: s.admissionNo, ...tally(rows, String(s._id)) })).sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)),
  };
}

/** present + late count as attended; leave is excluded from the denominator. */
export function tally(rows, studentId) {
  const t = { present: 0, absent: 0, late: 0, leave: 0 };
  for (const r of rows) { const s = r.marks?.[studentId]; if (s) t[s] += 1; }
  const counted = t.present + t.late + t.absent;
  return { ...t, rate: counted ? Math.round(((t.present + t.late) / counted) * 1000) / 10 : null };
}

export async function studentAttendance({ orgId, studentId, from }) {
  const { eduAttendance } = await getOrgCollections();
  const key = `marks.${studentId}`;
  const q = { orgId: toObjectId(orgId), [key]: { $exists: true } };
  if (from) q.date = { $gte: from };
  const rows = await eduAttendance.find(q).project({ date: 1, [key]: 1 }).toArray();
  return tally(rows, String(studentId));
}

/** Today across the classes this member can see: which registers are still unmarked. */
export async function todayOverview({ orgId, membership }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduClasses, eduAttendance } = await getOrgCollections();
  const limit = await teachableClassIds(orgId, membership);
  const q = { orgId: toObjectId(orgId) };
  if (limit && !canKeepStudentRegister(membership)) q._id = { $in: limit };
  const [classes, rows] = await Promise.all([eduClasses.find(q).toArray(), eduAttendance.find({ orgId: toObjectId(orgId), date: today() }).toArray()]);
  const marked = new Set(rows.map((r) => String(r.classId)));
  let present = 0, total = 0;
  for (const r of rows) for (const s of Object.values(r.marks || {})) { if (s !== "leave") total += 1; if (s === "present" || s === "late") present += 1; }
  return { date: today(), classes: classes.length, marked: classes.filter((c) => marked.has(String(c._id))).length, unmarked: classes.filter((c) => !marked.has(String(c._id))).map((c) => ({ _id: c._id, name: c.name, section: c.section })), rate: total ? Math.round((present / total) * 1000) / 10 : null };
}
