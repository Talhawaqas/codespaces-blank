// app/api/orgs/education/[[...path]]/route.js -- Education OS (schools and colleges). Session + membership, then
// requireVertical(orgId, "education") before ANY education logic runs (test/vertical-lock-wiring.test.mjs checks this).
// Role checks live in src/lib/education/*; this file only routes.
//
//   GET dashboard | options                    GET settings   PUT settings { country, currency, institutionType, receiptPrefix, lateFeeMinor, attendanceThreshold }
//   GET|POST years                             GET|POST subjects
//   GET|POST classes                           POST|DELETE classes/{id}/teachers { email, role }
//   GET staff-roles                            PUT staff-roles { email, educationRole|null }
//   GET|POST students (?classId&status&q)      GET|PATCH students/{id}     GET students/{id}/export   POST students/{id}/erase { reason, confirm:"ERASE" }
//   POST students/{id}/documents { type, label, documentId }   PATCH students/{id}/documents/{entryId} { status, documentId }
//   GET students/{id}/statement | report-card  GET|POST students/{id}/guardian-links { days, label }   DELETE guardian-links/{linkId}
//   GET|POST applications                      GET applications/{id}   POST applications/{id}/transition { toStatus, note }   POST applications/{id}/enrol
//   GET attendance/today | register?classId&date | summary?classId&from&to          POST attendance { classId, date, marks }
//   GET|POST assessments (?classId)            GET assessments/{id}   PUT assessments/{id}/marks { entries }   POST assessments/{id}/publish | amend
//   GET|POST fee-structures                    POST fee-structures/{id}/generate { period, dueDate, classId }
//   GET invoices                               POST invoices/{id}/cancel { reason }   POST invoices/late-fees { asOf }
//   GET|POST payments                          GET payments/{id}/receipt   POST payments/{id}/reverse { reason }
//   GET|POST concessions                       POST concessions/{id}/decide { approve, note } | end
//   GET defaulters (?asOf&classId)             GET collections (?period&from&to)
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { EDUCATION_ROLES } from "../../../../../lib/orgGates.js";
import * as SET from "../../../../../lib/education/settings.js";
import * as STR from "../../../../../lib/education/structure.js";
import * as STU from "../../../../../lib/education/students.js";
import * as ADM from "../../../../../lib/education/admissions.js";
import * as ATT from "../../../../../lib/education/attendance.js";
import * as EX from "../../../../../lib/education/exams.js";
import * as FEE from "../../../../../lib/education/fees.js";
import * as GL from "../../../../../lib/education/guardianLinks.js";
import { educationDashboard } from "../../../../../lib/education/dashboard.js";
import { IDENTIFIER_TYPES } from "../../../../../lib/education/identifiers.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r, ok = 200) => (r?.error ? json({ error: r.error, ...(r.duplicates ? { duplicates: r.duplicates } : {}) }, r.status || 400) : json(r, ok));

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const q = Object.fromEntries(new URL(req.url).searchParams.entries()); let body = {};
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) { try { body = await req.json(); } catch { body = {}; } }
    const orgId = q.orgId || body.orgId; if (!orgId || typeof orgId !== "string") return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const verticalCheck = await requireVertical(orgId, "education"); if (verticalCheck.error) return json({ error: verticalCheck.error }, verticalCheck.status);
    const membership = auth.membership, actorEmail = auth.session.email; const base = { orgId, membership, actorEmail }; const [a, b, c, d] = path;

    if (a === "dashboard" && method === "GET") return out(await educationDashboard(base));
    if (a === "options" && method === "GET") return json({ roles: EDUCATION_ROLES, educationRole: membership.educationRole || null, countries: SET.EDUCATION_COUNTRIES, institutionTypes: SET.INSTITUTION_TYPES, identifierTypes: Object.fromEntries(Object.entries(IDENTIFIER_TYPES).map(([k, v]) => [k, { label: v.label, country: v.country }])), documentTypes: STU.DOCUMENT_TYPES, paymentMethods: FEE.PAYMENT_METHODS, frequencies: FEE.FEE_FREQUENCIES, concessionKinds: FEE.CONCESSION_KINDS, attendanceStatuses: ATT.ATTENDANCE_STATUSES });
    if (a === "settings") { if (method === "GET") return json({ settings: await SET.getEducationSettings(orgId) }); if (method === "PUT") return out(await SET.updateEducationSettings({ ...base, updates: body })); }
    if (a === "years") { if (method === "GET") return out(await STR.listAcademicYears(orgId, base)); if (method === "POST") return out(await STR.createAcademicYear({ ...body, ...base }), 201); }
    if (a === "subjects") { if (method === "GET") return out(await STR.listSubjects(orgId, base)); if (method === "POST") return out(await STR.createSubject({ ...body, ...base }), 201); }
    if (a === "classes") {
      if (!b && method === "GET") return out(await STR.listClasses(orgId, base)); if (!b && method === "POST") return out(await STR.createClass({ ...body, ...base }), 201);
      if (b && c === "teachers" && method === "POST") return out(await STR.assignClassTeacher({ ...base, classId: b, email: body.email, role: body.role }));
      if (b && c === "teachers" && method === "DELETE") return out(await STR.unassignClassTeacher({ ...base, classId: b, email: body.email }));
    }
    if (a === "staff-roles") { if (method === "GET") return out(await STR.listStaffRoles(orgId, base)); if (method === "PUT") return out(await STR.setStaffRole({ ...base, email: body.email, educationRole: body.educationRole })); }
    if (a === "students") {
      if (!b && method === "GET") return out(await STU.listStudents(orgId, { membership, classId: q.classId, status: q.status, q: q.q }));
      if (!b && method === "POST") return out(await STU.createStudent({ ...body, ...base }), 201);
      if (b && !c && method === "GET") return out(await STU.getStudent({ ...base, studentId: b }));
      if (b && !c && method === "PATCH") { const { orgId: _o, ...updates } = body; return out(await STU.updateStudent({ ...base, studentId: b, updates })); }
      if (b && c === "export" && method === "GET") return out(await STU.exportStudentData({ ...base, studentId: b }));
      if (b && c === "erase" && method === "POST") return out(await STU.eraseStudent({ ...base, studentId: b, reason: body.reason, confirm: body.confirm }));
      if (b && c === "documents" && !d && method === "POST") return out(await STU.addStudentDocument({ ...base, studentId: b, type: body.type, label: body.label, documentId: body.documentId }), 201);
      if (b && c === "documents" && d && method === "PATCH") return out(await STU.setStudentDocumentStatus({ ...base, studentId: b, entryId: d, status: body.status, documentId: body.documentId }));
      if (b && c === "statement" && method === "GET") return out(await FEE.studentStatement({ ...base, studentId: b }));
      if (b && c === "report-card" && method === "GET") return out(await EX.reportCard({ ...base, studentId: b }));
      if (b && c === "guardian-links" && method === "GET") return out(await GL.listGuardianLinks({ ...base, studentId: b }));
      if (b && c === "guardian-links" && method === "POST") return out(await GL.createGuardianLink({ ...base, studentId: b, days: body.days, label: body.label }), 201);
    }
    if (a === "guardian-links" && b && method === "DELETE") return out(await GL.revokeGuardianLink({ ...base, linkId: b }));
    if (a === "applications") {
      if (!b && method === "GET") return out(await ADM.listApplications(orgId, { membership, status: q.status }));
      if (!b && method === "POST") return out(await ADM.createApplication({ ...body, ...base }), 201);
      if (b && !c && method === "GET") return out(await ADM.getApplication({ ...base, applicationId: b }));
      if (b && c === "transition" && method === "POST") return out(await ADM.transitionApplication({ ...base, applicationId: b, toStatus: body.toStatus, note: body.note }));
      if (b && c === "enrol" && method === "POST") return out(await ADM.enrolApplication({ ...base, applicationId: b, classId: body.classId, admissionNo: body.admissionNo, allowDuplicate: body.allowDuplicate === true }), 201);
    }
    if (a === "attendance") {
      if (b === "today" && method === "GET") return out(await ATT.todayOverview(base));
      if (b === "register" && method === "GET") return out(await ATT.getRegister({ ...base, classId: q.classId, date: q.date || new Date().toISOString().slice(0, 10) }));
      if (b === "summary" && method === "GET") return out(await ATT.classAttendanceSummary({ ...base, classId: q.classId, from: q.from, to: q.to }));
      if (!b && method === "POST") return out(await ATT.markAttendance({ ...base, classId: body.classId, date: body.date, marks: body.marks }));
    }
    if (a === "assessments") {
      if (!b && method === "GET") return out(await EX.listAssessments(orgId, { membership, classId: q.classId }));
      if (!b && method === "POST") return out(await EX.createAssessment({ ...body, ...base }), 201);
      if (b && !c && method === "GET") return out(await EX.getMarksSheet({ ...base, assessmentId: b }));
      if (b && c === "marks" && method === "PUT") return out(await EX.enterMarks({ ...base, assessmentId: b, entries: body.entries }));
      if (b && c === "publish" && method === "POST") return out(await EX.publishAssessment({ ...base, assessmentId: b }));
      if (b && c === "amend" && method === "POST") return out(await EX.amendPublishedMark({ ...base, assessmentId: b, studentId: body.studentId, marks: body.marks, absent: body.absent, reason: body.reason }));
    }
    if (a === "fee-structures") {
      if (!b && method === "GET") return out(await FEE.listFeeStructures(orgId, base));
      if (!b && method === "POST") return out(await FEE.createFeeStructure({ ...body, ...base }), 201);
      if (b && c === "generate" && method === "POST") return out(await FEE.generateInvoices({ ...base, structureId: b, period: body.period, dueDate: body.dueDate, classId: body.classId }));
    }
    if (a === "invoices") {
      if (!b && method === "GET") return out(await FEE.listInvoices(orgId, { membership, studentId: q.studentId, status: q.status, period: q.period, classId: q.classId }));
      if (b === "late-fees" && method === "POST") return out(await FEE.applyLateFees({ ...base, asOf: body.asOf }));
      if (b && c === "cancel" && method === "POST") return out(await FEE.cancelInvoice({ ...base, invoiceId: b, reason: body.reason }));
    }
    if (a === "payments") {
      if (!b && method === "GET") return out(await FEE.listPayments(orgId, { membership, studentId: q.studentId, from: q.from, to: q.to }));
      if (!b && method === "POST") return out(await FEE.recordPayment({ ...base, invoiceId: body.invoiceId, amountMinor: body.amountMinor, method: body.method, reference: body.reference, paidOn: body.paidOn }), 201);
      if (b && c === "receipt" && method === "GET") return out(await FEE.getReceipt({ ...base, paymentId: b }));
      if (b && c === "reverse" && method === "POST") return out(await FEE.reversePayment({ ...base, paymentId: b, reason: body.reason }));
    }
    if (a === "concessions") {
      if (!b && method === "GET") return out(await FEE.listConcessions(orgId, { membership, status: q.status }));
      if (!b && method === "POST") return out(await FEE.requestConcession({ ...body, ...base }), 201);
      if (b && c === "decide" && method === "POST") return out(await FEE.decideConcession({ ...base, concessionId: b, approve: body.approve === true, note: body.note }));
      if (b && c === "end" && method === "POST") return out(await FEE.endConcession({ ...base, concessionId: b }));
    }
    if (a === "defaulters" && method === "GET") return out(await FEE.defaulters(orgId, { membership, asOf: q.asOf, classId: q.classId }));
    if (a === "collections" && method === "GET") return out(await FEE.collectionSummary(orgId, { membership, period: q.period, from: q.from, to: q.to }));
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err?.name === "BSONError" || /input must be a 24 character hex string|Argument passed in must be/i.test(String(err?.message))) return json({ error: "Invalid id." }, 400);
    console.error("orgs/education failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export async function GET(req, ctx) { return handle(req, ctx); }
export async function POST(req, ctx) { return handle(req, ctx); }
export async function PUT(req, ctx) { return handle(req, ctx); }
export async function PATCH(req, ctx) { return handle(req, ctx); }
export async function DELETE(req, ctx) { return handle(req, ctx); }
