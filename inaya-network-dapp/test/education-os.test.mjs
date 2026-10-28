// test/education-os.test.mjs
//
// Education OS: the properties schools are buying it for.
//   1. Personal data is sealed at rest, and each role sees only its view
//      (an unassigned teacher gets nothing, an assigned teacher gets masked
//      IDs and no address, accounts gets contact details only).
//   2. Money can't be double-billed, overpaid, self-approved or deleted.
//   3. Published marks are locked; changes need the principal and a reason.
//   4. Parent links show fees/attendance/results only, and die on revoke or
//      erasure.
//
// Run with: node --env-file=.env.local --test test/education-os.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { sealField, openField } from "../src/lib/education/crypto.js";
import { validateIdentifiers, maskValue } from "../src/lib/education/identifiers.js";
import { createClass, assignClassTeacher, createSubject, setStaffRole } from "../src/lib/education/structure.js";
import { createStudent, getStudent, listStudents, eraseStudent, exportStudentData } from "../src/lib/education/students.js";
import { createApplication, transitionApplication, enrolApplication } from "../src/lib/education/admissions.js";
import { markAttendance, studentAttendance } from "../src/lib/education/attendance.js";
import { createAssessment, enterMarks, publishAssessment, amendPublishedMark, publishedResults } from "../src/lib/education/exams.js";
import { createFeeStructure, generateInvoices, recordPayment, reversePayment, requestConcession, decideConcession, listInvoices, defaulters, concessionAmount } from "../src/lib/education/fees.js";
import { createGuardianLink, resolveGuardianLink, revokeGuardianLink } from "../src/lib/education/guardianLinks.js";
import { runEducationTool } from "../src/lib/ai-education-tools.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN = randomUUID().slice(0, 8);
const OWNER = { role: "owner", email: `edu-owner-${RUN}@example.com` };
const PRINCIPAL = { role: "member", email: `edu-principal-${RUN}@example.com`, educationRole: "principal" };
const ACCOUNTS = { role: "member", email: `edu-accounts-${RUN}@example.com`, educationRole: "accounts" };
const TEACHER = { role: "member", email: `edu-teacher-${RUN}@example.com`, educationRole: "teacher" };
const OTHER_TEACHER = { role: "member", email: `edu-teacher2-${RUN}@example.com`, educationRole: "teacher" };
const NO_ROLE = { role: "member", email: `edu-norole-${RUN}@example.com` };
let c, orgId, classA, classB;

before(async () => {
  await ensureOrgIndexes();
  c = await getOrgCollections();
  const now = new Date().toISOString();
  orgId = (await c.orgs.insertOne({ name: `Education Test ${RUN} School`, ownerEmail: OWNER.email, vertical: "education", createdAt: now })).insertedId;
  await c.orgMembers.insertMany([OWNER, PRINCIPAL, ACCOUNTS, TEACHER, OTHER_TEACHER, NO_ROLE].map((m) => ({ orgId, email: m.email, role: m.role, status: "active", invitedAt: now })));
  classA = (await createClass({ orgId, name: "Grade 5", section: `A-${RUN}`, membership: OWNER, actorEmail: OWNER.email })).class;
  classB = (await createClass({ orgId, name: "Grade 6", section: `B-${RUN}`, membership: OWNER, actorEmail: OWNER.email })).class;
  await assignClassTeacher({ orgId, classId: classA._id, email: TEACHER.email, role: "class_teacher", membership: OWNER, actorEmail: OWNER.email });
  await assignClassTeacher({ orgId, classId: classB._id, email: OTHER_TEACHER.email, membership: OWNER, actorEmail: OWNER.email });
});

after(async () => {
  const cols = ["eduAcademicYears", "eduClasses", "eduClassTeachers", "eduSubjects", "eduStudents", "eduApplications", "eduAttendance", "eduAssessments", "eduMarks", "eduFeeStructures", "eduFeeInvoices", "eduFeePayments", "eduConcessions", "eduGuardianLinks", "orgMembers", "orgActivity", "auditChainEntries", "auditChainHeads"];
  await Promise.all(cols.map((k) => c[k].deleteMany({ orgId })));
  await c.eduCounters.deleteMany({ _id: { $regex: `^${orgId}:` } });
  await c.orgs.deleteMany({ _id: orgId });
  await (await mongoClientPromise).close();
});

async function addStudent(name, classId = classA._id, extra = {}) {
  const r = await createStudent({
    orgId, fullName: name, dateOfBirth: "2015-03-14", gender: "female", classId,
    guardians: [{ name: `Parent of ${name}`, relation: "mother", phone: "+923001234567", email: "parent@example.com" }],
    identifiers: [{ type: "b_form", value: "35202-1234567-8" }], address: "House 12, Street 4, Lahore", medicalNotes: "Peanut allergy",
    membership: PRINCIPAL, actorEmail: PRINCIPAL.email, ...extra,
  });
  assert.equal(r.error, undefined, r.error);
  return r.student;
}

test("crypto: a sealed field round-trips and a tampered one fails closed", () => {
  const sealed = sealField("+923001234567");
  assert.notEqual(sealed, "+923001234567");
  assert.equal(openField(sealed), "+923001234567");
  const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => openField(tampered));
});

test("identifiers: a full Aadhaar is cut to its last 4 digits, bad formats are refused, masking keeps 4", () => {
  assert.deepEqual(validateIdentifiers([{ type: "aadhaar_last4", value: "1234 5678 9012" }]).identifiers, [{ type: "aadhaar_last4", value: "9012" }]);
  assert.ok(validateIdentifiers([{ type: "cnic", value: "12345" }]).error);
  assert.ok(validateIdentifiers([{ type: "emirates_id", value: "784-1990-1234567-1" }]).identifiers);
  assert.equal(maskValue("3520212345678"), "••••••••5678");
});

test("SECURITY: guardian phone, address, ID numbers and medical notes are stored encrypted, not in plain text", async () => {
  const s = await addStudent(`Sealed ${RUN}`);
  const raw = await c.eduStudents.findOne({ _id: s._id });
  const dump = JSON.stringify(raw);
  for (const secret of ["+923001234567", "House 12", "3520212345678", "Peanut"]) assert.ok(!dump.includes(secret), `${secret} must not appear in the stored document`);
  assert.equal(raw.fullName, `Sealed ${RUN}`, "name stays searchable");
});

test("SECURITY: each role gets its own view of a student, and an unassigned teacher gets none", async () => {
  const s = await addStudent(`Views ${RUN}`);
  const full = await getStudent({ orgId, studentId: s._id, membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal(full.student.view, "full");
  assert.equal(full.student.address, "House 12, Street 4, Lahore");
  assert.equal(full.student.identifiers[0].value, "3520212345678");

  const teacher = await getStudent({ orgId, studentId: s._id, membership: TEACHER, actorEmail: TEACHER.email });
  assert.equal(teacher.student.view, "teacher");
  assert.equal(teacher.student.address, undefined, "teachers don't get the home address");
  assert.equal(teacher.student.identifiers[0].value, "••••••••5678", "teachers see masked ID numbers");
  assert.equal(teacher.student.medicalNotes, "Peanut allergy", "the class teacher needs allergy information");

  const fees = await getStudent({ orgId, studentId: s._id, membership: ACCOUNTS, actorEmail: ACCOUNTS.email });
  assert.equal(fees.student.view, "fees");
  assert.equal(fees.student.identifiers, undefined);
  assert.equal(fees.student.medicalNotes, undefined);
  assert.equal(fees.student.guardians[0].phone, "+923001234567");

  const other = await getStudent({ orgId, studentId: s._id, membership: OTHER_TEACHER, actorEmail: OTHER_TEACHER.email });
  assert.equal(other.status, 403, "a teacher of a different class must be refused");
  const none = await getStudent({ orgId, studentId: s._id, membership: NO_ROLE, actorEmail: NO_ROLE.email });
  assert.equal(none.status, 403, "a member with no education role must be refused");

  const otherList = await listStudents(orgId, { membership: OTHER_TEACHER });
  assert.ok(!otherList.students.some((x) => String(x._id) === String(s._id)), "the register list is limited to the teacher's own classes");
  assert.equal(JSON.stringify(otherList).includes("Sealed"), false);
});

test("only the owner or an admin can hand out education roles", async () => {
  const byPrincipal = await setStaffRole({ orgId, email: NO_ROLE.email, educationRole: "principal", membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal(byPrincipal.status, 403);
  const byOwner = await setStaffRole({ orgId, email: NO_ROLE.email, educationRole: "admissions", membership: OWNER, actorEmail: OWNER.email });
  assert.equal(byOwner.educationRole, "admissions");
  await setStaffRole({ orgId, email: NO_ROLE.email, educationRole: null, membership: OWNER, actorEmail: OWNER.email });
});

test("duplicate students (same name and date of birth) are flagged, not silently added", async () => {
  await addStudent(`Twin ${RUN}`);
  const again = await createStudent({ orgId, fullName: `Twin ${RUN}`, dateOfBirth: "2015-03-14", membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal(again.status, 409);
  assert.equal(again.duplicates.length, 1);
});

test("admissions: an application must be accepted before enrolment, and enrolling creates the student once", async () => {
  const { application } = await createApplication({ orgId, applicantName: `Applicant ${RUN}`, dateOfBirth: "2016-01-01", classId: classA._id, guardian: { name: "Mr Applicant", phone: "03001112223" }, membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal((await enrolApplication({ orgId, applicationId: application._id, membership: PRINCIPAL, actorEmail: PRINCIPAL.email })).status, 409);
  assert.equal((await transitionApplication({ orgId, applicationId: application._id, toStatus: "ACCEPTED", membership: PRINCIPAL, actorEmail: PRINCIPAL.email })).status, 409, "APPLIED can't jump to ACCEPTED");
  await transitionApplication({ orgId, applicationId: application._id, toStatus: "UNDER_REVIEW", membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  await transitionApplication({ orgId, applicationId: application._id, toStatus: "ACCEPTED", membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  const enrolled = await enrolApplication({ orgId, applicationId: application._id, membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.ok(enrolled.student?._id);
  assert.equal((await enrolApplication({ orgId, applicationId: application._id, membership: PRINCIPAL, actorEmail: PRINCIPAL.email })).status, 409, "can't enrol twice");
  const full = await getStudent({ orgId, studentId: enrolled.student._id, membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal(full.student.guardians[0].name, "Mr Applicant");
});

test("attendance: only the class's teacher can mark it, and the rate counts late as attended", async () => {
  const s = await addStudent(`Attend ${RUN}`);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await markAttendance({ orgId, classId: classA._id, date: day, marks: { [s._id]: "present" }, membership: OTHER_TEACHER, actorEmail: OTHER_TEACHER.email })).status, 403);
  assert.equal((await markAttendance({ orgId, classId: classA._id, date: "2999-01-01", marks: { [s._id]: "present" }, membership: TEACHER, actorEmail: TEACHER.email })).status, 400);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  assert.equal((await markAttendance({ orgId, classId: classA._id, date: day, marks: { [s._id]: "late" }, membership: TEACHER, actorEmail: TEACHER.email })).saved, 1);
  await markAttendance({ orgId, classId: classA._id, date: yesterday, marks: { [s._id]: "absent" }, membership: TEACHER, actorEmail: TEACHER.email });
  const t = await studentAttendance({ orgId, studentId: s._id });
  assert.equal(t.rate, 50);
  const old = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  assert.equal((await markAttendance({ orgId, classId: classA._id, date: old, marks: { [s._id]: "present" }, membership: TEACHER, actorEmail: TEACHER.email })).status, 403, "old registers need the principal");
});

test("exams: published marks are locked; the principal can amend with a reason and the old mark is kept", async () => {
  const s = await addStudent(`Exam ${RUN}`);
  const { subject } = await createSubject({ orgId, name: `Maths ${RUN}`, membership: OWNER });
  const { assessment } = await createAssessment({ orgId, classId: classA._id, subjectId: subject._id, name: "Mid-term", term: "Term 1", maxMarks: 50, membership: TEACHER, actorEmail: TEACHER.email });
  assert.equal((await enterMarks({ orgId, assessmentId: assessment._id, entries: [{ studentId: s._id, marks: 60 }], membership: TEACHER, actorEmail: TEACHER.email })).status, 400, "above max");
  await enterMarks({ orgId, assessmentId: assessment._id, entries: [{ studentId: s._id, marks: 41 }], membership: TEACHER, actorEmail: TEACHER.email });
  assert.equal((await publishedResults(orgId, s._id)).length, 0, "drafts never reach a report card");
  assert.equal((await publishAssessment({ orgId, assessmentId: assessment._id, membership: TEACHER, actorEmail: TEACHER.email })).status, 403);
  await publishAssessment({ orgId, assessmentId: assessment._id, membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal((await enterMarks({ orgId, assessmentId: assessment._id, entries: [{ studentId: s._id, marks: 45 }], membership: TEACHER, actorEmail: TEACHER.email })).status, 409);
  assert.equal((await amendPublishedMark({ orgId, assessmentId: assessment._id, studentId: s._id, marks: 45, membership: PRINCIPAL, actorEmail: PRINCIPAL.email })).status, 400, "a reason is required");
  await amendPublishedMark({ orgId, assessmentId: assessment._id, studentId: s._id, marks: 45, reason: "Re-check of paper", membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  const [r] = await publishedResults(orgId, s._id);
  assert.equal(r.marks, 45); assert.equal(r.percent, 90); assert.equal(r.grade, "A+");
  const row = await c.eduMarks.findOne({ orgId, studentId: s._id });
  assert.equal(row.history[0].marks, 41);
});

test("fees: concession maths never goes below zero", () => {
  assert.equal(concessionAmount(10000, [{ percent: 25 }]), 2500);
  assert.equal(concessionAmount(10000, [{ percent: 50 }, { amountMinor: 8000 }]), 10000);
});

test("MONEY: invoices aren't duplicated, concessions need a second person, payments can't overpay, receipts are sequential, reversals restore the balance", async () => {
  const s = await addStudent(`Fees ${RUN}`, classB._id);
  const { structure } = await createFeeStructure({ orgId, name: `Monthly ${RUN}`, classId: classB._id, frequency: "monthly", heads: [{ name: "Tuition", amountMinor: 800000 }, { name: "Lab", amountMinor: 200000 }], membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal(structure.totalMinor, 1000000);

  const { concession } = await requestConcession({ orgId, studentId: s._id, kind: "sibling", percent: 10, reason: "Sibling in Grade 2", membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal((await decideConcession({ orgId, concessionId: concession._id, approve: true, membership: PRINCIPAL, actorEmail: PRINCIPAL.email })).status, 403, "no self-approval");
  assert.equal((await decideConcession({ orgId, concessionId: concession._id, approve: true, membership: ACCOUNTS, actorEmail: ACCOUNTS.email })).status, 403, "accounts can't approve");
  assert.equal((await decideConcession({ orgId, concessionId: concession._id, approve: true, membership: OWNER, actorEmail: OWNER.email })).status, "APPROVED");

  const first = await generateInvoices({ orgId, structureId: structure._id, period: "2026-11", dueDate: "2026-11-10", membership: ACCOUNTS, actorEmail: ACCOUNTS.email });
  const again = await generateInvoices({ orgId, structureId: structure._id, period: "2026-11", dueDate: "2026-11-10", membership: ACCOUNTS, actorEmail: ACCOUNTS.email });
  assert.equal(again.created, 0); assert.ok(again.skipped >= 1);
  assert.ok(first.created >= 1);
  const [inv] = (await listInvoices(orgId, { membership: ACCOUNTS, studentId: s._id })).invoices;
  assert.equal(inv.concessionMinor, 100000); assert.equal(inv.totalMinor, 900000);

  assert.equal((await recordPayment({ orgId, invoiceId: inv._id, amountMinor: 900001, method: "cash", membership: ACCOUNTS, actorEmail: ACCOUNTS.email })).status, 400, "overpayment refused");
  assert.equal((await recordPayment({ orgId, invoiceId: inv._id, amountMinor: 1000, method: "bank_transfer", membership: ACCOUNTS, actorEmail: ACCOUNTS.email })).status, 400, "bank transfer needs a reference");
  assert.equal((await recordPayment({ orgId, invoiceId: inv._id, amountMinor: 1000, method: "cash", membership: TEACHER, actorEmail: TEACHER.email })).status, 403);

  const p1 = await recordPayment({ orgId, invoiceId: inv._id, amountMinor: 400000, method: "cash", membership: ACCOUNTS, actorEmail: ACCOUNTS.email });
  const p2 = await recordPayment({ orgId, invoiceId: inv._id, amountMinor: 500000, method: "bank_transfer", reference: "HBL-778812", membership: ACCOUNTS, actorEmail: ACCOUNTS.email });
  assert.equal(p1.invoice.status, "partial"); assert.equal(p2.invoice.status, "paid");
  const n1 = Number(p1.payment.receiptNo.split("-").pop()), n2 = Number(p2.payment.receiptNo.split("-").pop());
  assert.equal(n2, n1 + 1);
  assert.equal((await recordPayment({ orgId, invoiceId: inv._id, amountMinor: 1, method: "cash", membership: ACCOUNTS, actorEmail: ACCOUNTS.email })).status, 409, "a paid invoice takes no more payments");

  assert.equal((await reversePayment({ orgId, paymentId: p2.payment._id, reason: "Cheque bounced", membership: ACCOUNTS, actorEmail: ACCOUNTS.email })).status, 403, "only the principal reverses");
  await reversePayment({ orgId, paymentId: p2.payment._id, reason: "Transfer recalled", membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  const after = await c.eduFeeInvoices.findOne({ _id: inv._id });
  assert.equal(after.paidMinor, 400000); assert.equal(after.status, "partial");
  assert.equal((await c.eduFeePayments.findOne({ _id: p2.payment._id })).status, "reversed", "kept, not deleted");

  const due = await defaulters(orgId, { membership: ACCOUNTS, asOf: "2026-12-01" });
  const mine = due.defaulters.find((d) => String(d.studentId) === String(s._id));
  assert.equal(mine.outstandingMinor, 500000); assert.equal(mine.daysOverdue, 21);
});

test("PARENT LINK: shows fees, attendance and published results only; dies on revoke and on erasure", async () => {
  const s = await addStudent(`Parent ${RUN}`);
  assert.equal((await createGuardianLink({ orgId, studentId: s._id, membership: TEACHER, actorEmail: TEACHER.email })).status, 403);
  const made = await createGuardianLink({ orgId, studentId: s._id, days: 7, membership: ACCOUNTS, actorEmail: ACCOUNTS.email });
  const stored = await c.eduGuardianLinks.findOne({ _id: made.link._id });
  assert.notEqual(stored.tokenHash, made.token, "only the hash is stored");
  const { view } = await resolveGuardianLink(made.token);
  assert.equal(view.student.fullName, `Parent ${RUN}`);
  const dump = JSON.stringify(view);
  for (const secret of ["+923001234567", "House 12", "3520212345678", "Peanut", "parent@example.com"]) assert.ok(!dump.includes(secret), `${secret} must not reach the parent page`);
  assert.equal((await resolveGuardianLink("x".repeat(43))).status, 404);

  await revokeGuardianLink({ orgId, linkId: made.link._id, membership: ACCOUNTS, actorEmail: ACCOUNTS.email });
  assert.equal((await resolveGuardianLink(made.token)).status, 404);

  const second = await createGuardianLink({ orgId, studentId: s._id, membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.ok((await resolveGuardianLink(second.token)).view);
  assert.equal((await eraseStudent({ orgId, studentId: s._id, reason: "Guardian request", confirm: "yes", membership: PRINCIPAL, actorEmail: PRINCIPAL.email })).status, 400, "must type ERASE");
  assert.equal((await eraseStudent({ orgId, studentId: s._id, reason: "Guardian request", confirm: "ERASE", membership: ACCOUNTS, actorEmail: ACCOUNTS.email })).status, 403);
  await eraseStudent({ orgId, studentId: s._id, reason: "Guardian request", confirm: "ERASE", membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal((await resolveGuardianLink(second.token)).status, 404, "erasure kills existing links");
  const erased = await c.eduStudents.findOne({ _id: s._id });
  assert.equal(erased.guardiansSealed, null); assert.equal(erased.addressSealed, null); assert.equal(erased.identifiersSealed, null);
  assert.match(erased.fullName, /^Erased student /);
});

test("export: the principal gets the full record as JSON, others don't", async () => {
  const s = await addStudent(`Export ${RUN}`);
  assert.equal((await exportStudentData({ orgId, studentId: s._id, membership: ACCOUNTS, actorEmail: ACCOUNTS.email })).status, 403);
  const e = await exportStudentData({ orgId, studentId: s._id, membership: PRINCIPAL, actorEmail: PRINCIPAL.email });
  assert.equal(e.export.student.address, "House 12, Street 4, Lahore");
});

test("AI tools see only what the person could see by hand", async () => {
  const ctxTeacher = { orgId, membership: OTHER_TEACHER, email: OTHER_TEACHER.email };
  assert.ok((await runEducationTool("list_fee_defaulters", {}, ctxTeacher)).error, "teachers can't see fees through the assistant");
  const found = await runEducationTool("search_students", { query: `Views ${RUN}` }, ctxTeacher);
  assert.equal(found.students.length, 0, "a student in another class isn't found");
  const own = await runEducationTool("search_students", { query: `Views ${RUN}` }, { orgId, membership: TEACHER, email: TEACHER.email });
  assert.equal(own.students.length, 1);
  assert.equal(JSON.stringify(own).includes("+92300"), false);
});
