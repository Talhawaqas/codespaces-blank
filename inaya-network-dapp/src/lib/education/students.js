// src/lib/education/students.js
//
// Education OS — the student and guardian register. This is where a
// school's most sensitive personal data lives, so:
//
//  * Guardian contact details, home address, national identifiers and
//    medical notes are sealed with AES-256-GCM (crypto.js) before they are
//    written. Name, date of birth, admission number and class stay plain so
//    the register can be searched and duplicates found.
//  * Who sees what is decided per request by studentViewFor():
//      full    principal / admissions / owner / admin
//      teacher a teacher assigned to the student's class: no address,
//              identifiers masked to the last 4 digits
//      fees    accounts staff: name, class and guardian name/phone only
//    Anyone else gets 403. Every open of a record is written to the audit
//    chain with the view level that was served.
//  * Export (subject access) and erase (right to be forgotten) are
//    principal-only. Erase strips personal data but keeps the fee ledger
//    under an anonymised name, because financial records must be kept.

import { randomUUID } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canAccessEducation, canManageEducation, canKeepStudentRegister, canHandleFees, isClassTeacher } from "../orgGates.js";
import { sealJson, openJson, sealField, openField } from "./crypto.js";
import { validateIdentifiers, maskValue, IDENTIFIER_TYPES } from "./identifiers.js";
import { logEducationEvent } from "./audit.js";
import { nextNumber } from "./counters.js";
import { getClassAssignments, teachableClassIds, classLabel } from "./structure.js";

export const STUDENT_STATUSES = ["enrolled", "withdrawn", "graduated", "erased"];
export const GENDERS = ["female", "male", "other", null];
export const DOCUMENT_TYPES = ["birth_certificate", "b_form", "previous_school_certificate", "transfer_certificate", "photo", "guardian_id", "medical_record", "result_card", "other"];

const now = () => new Date().toISOString();
const clean = (v, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function validateGuardians(list) {
  const out = [];
  for (const g of list || []) {
    const name = clean(g?.name, 80);
    if (!name) return { error: "Every guardian needs a name." };
    const phone = clean(g?.phone, 20).replace(/[^\d+]/g, "");
    if (phone && !/^\+?\d{7,15}$/.test(phone)) return { error: `Guardian ${name}: the phone number doesn't look right.` };
    const email = clean(g?.email, 120).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: `Guardian ${name}: the email address doesn't look right.` };
    out.push({ name, relation: clean(g?.relation, 30) || "guardian", phone: phone || null, email: email || null, occupation: clean(g?.occupation, 60) || null, primary: !!g?.primary });
  }
  if (out.length && !out.some((g) => g.primary)) out[0].primary = true;
  return { guardians: out };
}

/** Builds the sealed/plain field set shared by create and update. */
function buildPersonalFields(input) {
  const set = {};
  if (input.guardians !== undefined) {
    const g = validateGuardians(input.guardians);
    if (g.error) return { error: g.error };
    set.guardiansSealed = sealJson(g.guardians);
    const primary = g.guardians.find((x) => x.primary);
    set.primaryGuardianName = primary?.name || null; // plain, for search and fee follow-up lists
  }
  if (input.identifiers !== undefined) {
    const ids = validateIdentifiers(input.identifiers);
    if (ids.error) return { error: ids.error };
    set.identifiersSealed = sealJson(ids.identifiers);
  }
  if (input.address !== undefined) set.addressSealed = sealField(clean(input.address, 300) || null);
  if (input.medicalNotes !== undefined) set.medicalSealed = sealField(clean(input.medicalNotes, 1000) || null);
  return { set };
}

export async function findDuplicateStudents({ orgId, fullName, dateOfBirth }) {
  if (!fullName || !dateOfBirth) return [];
  const { eduStudents } = await getOrgCollections();
  const escaped = fullName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return eduStudents.find({ orgId: toObjectId(orgId), status: { $ne: "erased" }, fullName: { $regex: `^${escaped}$`, $options: "i" }, dateOfBirth }).project({ fullName: 1, admissionNo: 1, classId: 1 }).toArray();
}

export async function createStudent({ orgId, fullName, dateOfBirth, gender, classId, admissionNo, admissionDate, guardians, identifiers, address, medicalNotes, allowDuplicate, fromApplicationId, membership, actorEmail }) {
  if (!canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can add students.", status: 403 };
  const name = clean(fullName, 100);
  if (!name) return { error: "The student's full name is required.", status: 400 };
  if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return { error: "Date of birth must be YYYY-MM-DD.", status: 400 };
  if (!GENDERS.includes(gender ?? null)) return { error: "Gender must be female, male or other.", status: 400 };
  const { eduStudents, eduClasses } = await getOrgCollections();
  let cls = null;
  if (classId) {
    cls = await eduClasses.findOne({ _id: toObjectId(classId), orgId: toObjectId(orgId) });
    if (!cls) return { error: "Class not found.", status: 404 };
  }
  if (!allowDuplicate) {
    const dups = await findDuplicateStudents({ orgId, fullName: name, dateOfBirth });
    if (dups.length) return { error: "A student with the same name and date of birth already exists. Check the register, or confirm this is a different child.", status: 409, duplicates: dups };
  }
  const personal = buildPersonalFields({ guardians: guardians || [], identifiers: identifiers || [], address: address ?? null, medicalNotes: medicalNotes ?? null });
  if (personal.error) return { error: personal.error, status: 400 };

  let number = clean(admissionNo, 30);
  if (!number) number = `${new Date().getFullYear()}-${String(await nextNumber(orgId, `admission:${new Date().getFullYear()}`)).padStart(4, "0")}`;
  const doc = {
    orgId: toObjectId(orgId), fullName: name, dateOfBirth: dateOfBirth || null, gender: gender ?? null,
    admissionNo: number, admissionDate: admissionDate || now().slice(0, 10), classId: cls?._id || null, status: "enrolled",
    ...personal.set, documents: [], fromApplicationId: fromApplicationId ? toObjectId(fromApplicationId) : null,
    createdByEmail: actorEmail, createdAt: now(), updatedAt: now(),
  };
  try {
    const r = await eduStudents.insertOne(doc);
    await logEducationEvent({ orgId, recordType: "EDU_STUDENT", recordId: r.insertedId, actorEmail, action: "CREATED", metadata: { admissionNo: number } });
    return { student: listShape({ ...doc, _id: r.insertedId }, cls) };
  } catch (err) {
    if (err?.code === 11000) return { error: `Admission number ${number} is already in use.`, status: 409 };
    throw err;
  }
}

function listShape(s, cls) {
  return { _id: s._id, fullName: s.fullName, admissionNo: s.admissionNo, classId: s.classId, classLabel: cls ? classLabel(cls) : null, status: s.status, gender: s.gender, primaryGuardianName: s.primaryGuardianName || null, documentsPending: (s.documents || []).filter((d) => d.status !== "verified").length };
}

/** Register list: never contains sealed fields. Teachers see only their classes. */
export async function listStudents(orgId, { membership, classId, status, q } = {}) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduStudents, eduClasses } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), status: status || { $ne: "erased" } };
  const limitTo = canKeepStudentRegister(membership) || canHandleFees(membership) ? null : await teachableClassIds(orgId, membership);
  if (limitTo) query.classId = { $in: limitTo };
  if (classId) {
    if (limitTo && !limitTo.some((id) => String(id) === String(classId))) return { error: "You're not assigned to that class.", status: 403 };
    query.classId = toObjectId(classId);
  }
  if (q) {
    const rx = { $regex: String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), $options: "i" };
    query.$or = [{ fullName: rx }, { admissionNo: rx }, { primaryGuardianName: rx }];
  }
  const [rows, classes] = await Promise.all([
    eduStudents.find(query).project({ guardiansSealed: 0, identifiersSealed: 0, addressSealed: 0, medicalSealed: 0 }).sort({ fullName: 1 }).limit(2000).toArray(),
    eduClasses.find({ orgId: toObjectId(orgId) }).toArray(),
  ]);
  const byId = new Map(classes.map((c) => [String(c._id), c]));
  return { students: rows.map((s) => listShape(s, byId.get(String(s.classId)))) };
}

/** Which view of a student this member may see, or null. */
export async function studentViewFor({ orgId, student, membership }) {
  if (canKeepStudentRegister(membership)) return "full";
  if (student.classId && membership?.educationRole === "teacher") {
    const assignments = await getClassAssignments(orgId, student.classId);
    if (isClassTeacher(membership, student.classId, assignments)) return "teacher";
  }
  if (canHandleFees(membership)) return "fees";
  return null;
}

function shapeForView(s, view, cls) {
  const base = { ...listShape(s, cls), dateOfBirth: s.dateOfBirth, admissionDate: s.admissionDate, view };
  const guardians = openJson(s.guardiansSealed) || [];
  if (view === "fees") return { ...base, dateOfBirth: undefined, guardians: guardians.map((g) => ({ name: g.name, relation: g.relation, phone: g.phone, primary: g.primary })) };
  const identifiers = openJson(s.identifiersSealed) || [];
  const medicalNotes = openField(s.medicalSealed);
  if (view === "teacher") {
    return {
      ...base,
      guardians: guardians.map((g) => ({ name: g.name, relation: g.relation, phone: g.phone, primary: g.primary })),
      identifiers: identifiers.map((i) => ({ type: i.type, label: IDENTIFIER_TYPES[i.type]?.label, value: maskValue(i.value) })),
      medicalNotes, documents: s.documents || [],
    };
  }
  return {
    ...base, guardians, address: openField(s.addressSealed), medicalNotes, documents: s.documents || [],
    identifiers: identifiers.map((i) => ({ type: i.type, label: IDENTIFIER_TYPES[i.type]?.label, value: i.value })),
    erasedAt: s.erasedAt || null,
  };
}

/** THE access check for one student's record. Returns {student} or {error,status}. */
export async function getStudent({ orgId, studentId, membership, actorEmail }) {
  if (!canAccessEducation(membership)) return { error: "You don't have Education OS access.", status: 403 };
  const { eduStudents, eduClasses } = await getOrgCollections();
  const s = await eduStudents.findOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId) });
  if (!s) return { error: "Student not found.", status: 404 };
  const view = await studentViewFor({ orgId, student: s, membership });
  if (!view) return { error: "You're not assigned to this student's class, so you can't open this record.", status: 403 };
  const cls = s.classId ? await eduClasses.findOne({ _id: s.classId }) : null;
  await logEducationEvent({ orgId, recordType: "EDU_STUDENT", recordId: s._id, actorEmail, action: "VIEWED", metadata: { view } });
  return { student: shapeForView(s, view, cls) };
}

export async function updateStudent({ orgId, studentId, updates, membership, actorEmail }) {
  if (!canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can change student records.", status: 403 };
  const { eduStudents, eduClasses } = await getOrgCollections();
  const s = await eduStudents.findOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId) });
  if (!s) return { error: "Student not found.", status: 404 };
  if (s.status === "erased") return { error: "This record was erased and can't be changed.", status: 409 };
  const set = {};
  if (updates.fullName !== undefined) { const n = clean(updates.fullName, 100); if (!n) return { error: "Name can't be empty.", status: 400 }; set.fullName = n; }
  if (updates.dateOfBirth !== undefined) { if (updates.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(updates.dateOfBirth)) return { error: "Date of birth must be YYYY-MM-DD.", status: 400 }; set.dateOfBirth = updates.dateOfBirth || null; }
  if (updates.gender !== undefined) { if (!GENDERS.includes(updates.gender ?? null)) return { error: "Gender must be female, male or other.", status: 400 }; set.gender = updates.gender ?? null; }
  if (updates.classId !== undefined) {
    if (updates.classId) {
      const cls = await eduClasses.findOne({ _id: toObjectId(updates.classId), orgId: toObjectId(orgId) });
      if (!cls) return { error: "Class not found.", status: 404 };
      set.classId = cls._id;
    } else set.classId = null;
  }
  if (updates.status !== undefined) {
    if (!["enrolled", "withdrawn", "graduated"].includes(updates.status)) return { error: "Status must be enrolled, withdrawn or graduated.", status: 400 };
    set.status = updates.status;
  }
  const personal = buildPersonalFields(updates);
  if (personal.error) return { error: personal.error, status: 400 };
  Object.assign(set, personal.set, { updatedAt: now(), updatedByEmail: actorEmail });
  await eduStudents.updateOne({ _id: s._id }, { $set: set });
  // Field names only, never values: the audit chain must not become a second copy of the personal data.
  await logEducationEvent({ orgId, recordType: "EDU_STUDENT", recordId: s._id, actorEmail, action: "UPDATED", metadata: { fields: Object.keys(updates).filter((k) => updates[k] !== undefined) } });
  return getStudent({ orgId, studentId, membership, actorEmail });
}

// ---------- Document checklist ----------
// The files themselves live in the Documents module, encrypted on the
// uploader's device; this list only records which document is which and
// whether the office has checked it.
export async function addStudentDocument({ orgId, studentId, type, label, documentId, membership, actorEmail }) {
  if (!canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can manage student documents.", status: 403 };
  if (!DOCUMENT_TYPES.includes(type)) return { error: "Unknown document type.", status: 400 };
  const { eduStudents, orgDocuments } = await getOrgCollections();
  let docRef = null;
  if (documentId) {
    const d = await orgDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId) }, { projection: { _id: 1 } });
    if (!d) return { error: "That document isn't in this school's Documents.", status: 404 };
    docRef = d._id;
  }
  const entry = { id: randomUUID(), type, label: clean(label, 80) || null, documentId: docRef, status: docRef ? "received" : "pending", addedByEmail: actorEmail, addedAt: now() };
  const r = await eduStudents.updateOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId), status: { $ne: "erased" } }, { $push: { documents: entry } });
  if (!r.matchedCount) return { error: "Student not found.", status: 404 };
  await logEducationEvent({ orgId, recordType: "EDU_STUDENT", recordId: studentId, actorEmail, action: "DOCUMENT_ADDED", metadata: { type } });
  return { document: entry };
}

export async function setStudentDocumentStatus({ orgId, studentId, entryId, status, documentId, membership, actorEmail }) {
  if (!canKeepStudentRegister(membership)) return { error: "Only the principal, admissions office, owner or an admin can verify documents.", status: 403 };
  if (!["pending", "received", "verified", "rejected"].includes(status)) return { error: "Status must be pending, received, verified or rejected.", status: 400 };
  const { eduStudents, orgDocuments } = await getOrgCollections();
  const set = { "documents.$.status": status, "documents.$.updatedAt": now(), "documents.$.updatedByEmail": actorEmail };
  if (documentId) {
    const d = await orgDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId) }, { projection: { _id: 1 } });
    if (!d) return { error: "That document isn't in this school's Documents.", status: 404 };
    set["documents.$.documentId"] = d._id;
  }
  if (status === "verified") { set["documents.$.verifiedByEmail"] = actorEmail; set["documents.$.verifiedAt"] = now(); }
  const r = await eduStudents.updateOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId), "documents.id": entryId }, { $set: set });
  if (!r.matchedCount) return { error: "Document entry not found.", status: 404 };
  await logEducationEvent({ orgId, recordType: "EDU_STUDENT", recordId: studentId, actorEmail, action: "DOCUMENT_STATUS", metadata: { entryId, status } });
  return { updated: true };
}

// ---------- Data rights ----------
export async function exportStudentData({ orgId, studentId, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can export a student's data.", status: 403 };
  const c = await getOrgCollections();
  const s = await c.eduStudents.findOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId) });
  if (!s) return { error: "Student not found.", status: 404 };
  const cls = s.classId ? await c.eduClasses.findOne({ _id: s.classId }) : null;
  const sid = s._id; const oid = toObjectId(orgId);
  const [invoices, payments, attendance, marks] = await Promise.all([
    c.eduFeeInvoices.find({ orgId: oid, studentId: sid }).toArray(),
    c.eduFeePayments.find({ orgId: oid, studentId: sid }).toArray(),
    c.eduAttendance.find({ orgId: oid, [`marks.${sid}`]: { $exists: true } }).project({ date: 1, classId: 1, [`marks.${sid}`]: 1 }).toArray(),
    c.eduMarks.find({ orgId: oid, studentId: sid }).toArray(),
  ]);
  await logEducationEvent({ orgId, recordType: "EDU_STUDENT", recordId: sid, actorEmail, action: "EXPORTED", metadata: {} });
  return {
    export: {
      exportedAt: now(), exportedByEmail: actorEmail,
      student: shapeForView(s, "full", cls),
      feeInvoices: invoices, feePayments: payments,
      attendance: attendance.map((a) => ({ date: a.date, status: a.marks?.[String(sid)] })),
      marks,
    },
  };
}

/** Erases personal data on request. Fee invoices and payments are kept
 *  (schools must keep financial records) but re-labelled with an
 *  anonymised name; guardian links are revoked. Cannot be undone. */
export async function eraseStudent({ orgId, studentId, reason, confirm, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can erase a student's data.", status: 403 };
  if (confirm !== "ERASE") return { error: 'Type ERASE to confirm. This can\'t be undone.', status: 400 };
  const why = clean(reason, 300);
  if (!why) return { error: "A reason is required (for example, the guardian's written request).", status: 400 };
  const c = await getOrgCollections();
  const s = await c.eduStudents.findOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId) });
  if (!s) return { error: "Student not found.", status: 404 };
  if (s.status === "erased") return { error: "Already erased.", status: 409 };
  const anon = `Erased student ${s.admissionNo}`;
  await c.eduStudents.updateOne({ _id: s._id }, {
    $set: { fullName: anon, dateOfBirth: null, gender: null, primaryGuardianName: null, guardiansSealed: null, identifiersSealed: null, addressSealed: null, medicalSealed: null, documents: [], status: "erased", erasedAt: now(), erasedByEmail: actorEmail, erasureReason: why },
  });
  await Promise.all([
    c.eduFeeInvoices.updateMany({ orgId: toObjectId(orgId), studentId: s._id }, { $set: { studentName: anon } }),
    c.eduFeePayments.updateMany({ orgId: toObjectId(orgId), studentId: s._id }, { $set: { studentName: anon } }),
    c.eduGuardianLinks.updateMany({ orgId: toObjectId(orgId), studentId: s._id, revokedAt: null }, { $set: { revokedAt: now(), revokedByEmail: actorEmail } }),
  ]);
  await logEducationEvent({ orgId, recordType: "EDU_STUDENT", recordId: s._id, actorEmail, action: "ERASED", metadata: { reason: why } });
  return { erased: true };
}
