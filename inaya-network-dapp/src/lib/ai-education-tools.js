// src/lib/ai-education-tools.js
//
// Education OS AI tools. Same 4-export shape as ai-government-tools.js so
// it plugs into ai-os-router.js identically, and 100% READ-ONLY for the
// same reason: the assistant can find and summarise, never record a
// payment, change a mark, approve a concession or open a parent link.
//
// Every tool calls the same src/lib/education/* function the screens use,
// with the caller's own membership, so the assistant sees exactly what the
// person could see by hand: a teacher's assistant only finds students in
// that teacher's classes, and fee tools return 403 for anyone who doesn't
// handle fees. Sealed personal data (guardian phone/address, ID numbers,
// medical notes) is never returned by any of these tools.

import { Type } from "@google/genai";
import { listStudents } from "./education/students.js";
import { defaulters, collectionSummary } from "./education/fees.js";
import { classAttendanceSummary, todayOverview } from "./education/attendance.js";
import { educationDashboard } from "./education/dashboard.js";
import { listClasses } from "./education/structure.js";

export async function buildEducationContext({ orgId, membership, email }) {
  return { orgId, membership, email };
}

const cap = (n, d = 25) => Math.min(Math.max(Number(n) || d, 1), 100);

async function searchStudents(args, ctx) {
  const r = await listStudents(ctx.orgId, { membership: ctx.membership, q: args.query, classId: args.classId });
  if (r.error) return { error: r.error };
  return { students: r.students.slice(0, cap(args.limit)).map((s) => ({ name: s.fullName, admissionNo: s.admissionNo, class: s.classLabel, status: s.status })), total: r.students.length };
}

async function listFeeDefaulters(args, ctx) {
  const r = await defaulters(ctx.orgId, { membership: ctx.membership, classId: args.classId });
  if (r.error) return { error: r.error };
  return { asOf: r.asOf, count: r.defaulters.length, defaulters: r.defaulters.slice(0, cap(args.limit)).map((d) => ({ name: d.studentName, admissionNo: d.admissionNo, class: d.classLabel, outstanding: d.outstandingMinor / 100, currency: d.currency, daysOverdue: d.daysOverdue })) };
}

async function feeCollection(args, ctx) {
  const r = await collectionSummary(ctx.orgId, { membership: ctx.membership, period: args.period, from: args.from, to: args.to });
  if (r.error) return { error: r.error };
  return { period: r.period, totals: r.totals.map((t) => ({ currency: t.currency, billed: t.billedMinor / 100, collected: t.collectedMinor / 100, outstanding: t.outstandingMinor / 100, concessions: t.concessionMinor / 100 })), byMethod: r.byMethod.map((m) => ({ ...m, amount: m.amountMinor / 100, amountMinor: undefined })) };
}

async function attendanceForClass(args, ctx) {
  const r = await classAttendanceSummary({ orgId: ctx.orgId, classId: args.classId, from: args.from, to: args.to, membership: ctx.membership });
  if (r.error) return { error: r.error };
  return { days: r.days, lowestFirst: r.students.slice(0, cap(args.limit)).map((s) => ({ name: s.fullName, rate: s.rate, absent: s.absent, late: s.late })) };
}

async function listMyClasses(_args, ctx) {
  const r = await listClasses(ctx.orgId, { membership: ctx.membership });
  if (r.error) return { error: r.error };
  return { classes: r.classes.map((c) => ({ id: String(c._id), name: c.label, enrolled: c.enrolled, mine: c.mine })) };
}

async function schoolOverview(_args, ctx) {
  const [d, today] = await Promise.all([educationDashboard({ orgId: ctx.orgId, membership: ctx.membership }), todayOverview({ orgId: ctx.orgId, membership: ctx.membership })]);
  if (d.error) return { error: d.error };
  return { enrolled: d.enrolled, classes: d.classes, openApplications: d.openApplications, studentsWithDocumentsToCheck: d.documentsPending, attendanceToday: today.error ? null : { marked: today.marked, of: today.classes, rate: today.rate }, fees: d.fees ? { currency: d.fees.currency, collectedThisMonth: d.fees.collectedThisMonthMinor / 100, overdue: d.fees.overdueMinor / 100, familiesOverdue: d.fees.defaulters, concessionsAwaitingApproval: d.fees.pendingConcessions } : "not visible to your role" };
}

export const EDUCATION_TOOL_DECLARATIONS = [
  { name: "school_overview", description: "Today's school overview: enrolment, registers marked, attendance rate, open applications and (for fee staff) collections and overdue fees.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "list_classes", description: "List classes with enrolment counts; 'mine' marks classes the user teaches. Use the id with other tools.", parameters: { type: Type.OBJECT, properties: {} } },
  { name: "search_students", description: "Search students the user is allowed to see (teachers: only their classes) by name, admission number or guardian name. Returns names and classes only, never contact details or ID numbers.", parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING }, classId: { type: Type.STRING }, limit: { type: Type.INTEGER } } } },
  { name: "list_fee_defaulters", description: "Students with overdue fees, largest balance first (fee staff and principal only).", parameters: { type: Type.OBJECT, properties: { classId: { type: Type.STRING }, limit: { type: Type.INTEGER } } } },
  { name: "fee_collection_summary", description: "Billed, collected and outstanding fees, optionally for one period (e.g. 2026-11) or a payment date range (fee staff and principal only).", parameters: { type: Type.OBJECT, properties: { period: { type: Type.STRING }, from: { type: Type.STRING }, to: { type: Type.STRING } } } },
  { name: "class_attendance", description: "Attendance rates for one class over a date range, lowest first.", parameters: { type: Type.OBJECT, properties: { classId: { type: Type.STRING }, from: { type: Type.STRING }, to: { type: Type.STRING }, limit: { type: Type.INTEGER } }, required: ["classId"] } },
];

const TOOL_IMPLEMENTATIONS = {
  school_overview: schoolOverview,
  list_classes: listMyClasses,
  search_students: searchStudents,
  list_fee_defaulters: listFeeDefaulters,
  fee_collection_summary: feeCollection,
  class_attendance: attendanceForClass,
};

export async function runEducationTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  try { return await impl(args || {}, ctx); } catch { return { error: "That information isn't available right now." }; }
}

export function educationSystemInstruction() {
  return `You are the Inaya Education Assistant for a school or college. You can summarise the school's day, find students the user is allowed to see, and report on attendance and fees. You are read-only: you cannot record payments, change marks, approve concessions, enrol students or share parent links, so point the user to the right screen for that. You never have guardian phone numbers, addresses, ID numbers or medical notes; don't guess them. If a tool says the user's role can't see something, say so plainly. Amounts are in the school's currency; state the currency.`;
}
