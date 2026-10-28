// src/lib/education/fees.js
//
// Education OS — fee structures, fee invoices (challans), concessions,
// payments, receipts and defaulters.
//
// Rules that protect the money:
//  * Amounts are integer minor units (paisa, cents, fils) in the school's
//    currency, so totals never pick up floating-point drift.
//  * Generating invoices is idempotent per student + period + structure
//    (unique index), so running it twice never double-bills a family.
//  * A concession is requested by one person and approved by another
//    (principal/owner/admin, never the requester), and only applies to
//    invoices generated after approval.
//  * A payment can't be edited or deleted, only reversed with a reason by
//    the principal. The invoice's paid amount is moved with a conditional
//    $inc, so two clerks can't record payments that overpay an invoice.
//  * Each payment gets a sequential receipt number per school per year.
// Fees are recorded here, not collected online: there is no payment
// gateway in this module.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canHandleFees, canManageEducation, canKeepStudentRegister } from "../orgGates.js";
import { logEducationEvent } from "./audit.js";
import { nextNumber } from "./counters.js";
import { getEducationSettings } from "./settings.js";
import { classLabel } from "./structure.js";

export const FEE_FREQUENCIES = ["monthly", "termly", "annual", "one_time"];
export const PAYMENT_METHODS = ["cash", "bank_transfer", "cheque", "card", "mobile_wallet", "online"];
export const CONCESSION_KINDS = ["sibling", "merit", "staff_child", "need_based", "scholarship", "other"];

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const clean = (v, max = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const isMinor = (n) => Number.isInteger(n) && n >= 0 && n <= 1e12;
const deny = () => ({ error: "Only accounts staff, the principal, the owner or an admin can manage fees.", status: 403 });

// ---------- Structures ----------
export async function createFeeStructure({ orgId, name, classId, heads, frequency, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can set fee structures.", status: 403 };
  const n = clean(name);
  if (!n) return { error: "A name such as Monthly tuition 2026-27 is required.", status: 400 };
  if (!FEE_FREQUENCIES.includes(frequency)) return { error: `Frequency must be one of ${FEE_FREQUENCIES.join(", ")}.`, status: 400 };
  const lines = [];
  for (const h of heads || []) {
    const label = clean(h?.name, 60);
    const amount = Number(h?.amountMinor);
    if (!label || !isMinor(amount) || amount === 0) return { error: "Each fee head needs a name and an amount greater than zero.", status: 400 };
    lines.push({ name: label, amountMinor: amount });
  }
  if (!lines.length) return { error: "Add at least one fee head (for example Tuition).", status: 400 };
  const { eduFeeStructures, eduClasses } = await getOrgCollections();
  if (classId && !(await eduClasses.findOne({ _id: toObjectId(classId), orgId: toObjectId(orgId) }))) return { error: "Class not found.", status: 404 };
  const settings = await getEducationSettings(orgId);
  const doc = { orgId: toObjectId(orgId), name: n, classId: classId ? toObjectId(classId) : null, heads: lines, totalMinor: lines.reduce((t, l) => t + l.amountMinor, 0), currency: settings.currency, frequency, active: true, createdByEmail: actorEmail, createdAt: now() };
  const r = await eduFeeStructures.insertOne(doc);
  await logEducationEvent({ orgId, recordType: "EDU_FEE_STRUCTURE", recordId: r.insertedId, actorEmail, action: "CREATED", metadata: { name: n, totalMinor: doc.totalMinor } });
  return { structure: { ...doc, _id: r.insertedId } };
}

export async function listFeeStructures(orgId, { membership }) {
  if (!canHandleFees(membership)) return deny();
  const { eduFeeStructures } = await getOrgCollections();
  return { structures: await eduFeeStructures.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).toArray() };
}

// ---------- Concessions ----------
export async function requestConcession({ orgId, studentId, kind, percent, amountMinor, reason, membership, actorEmail }) {
  if (!canHandleFees(membership)) return deny();
  if (!CONCESSION_KINDS.includes(kind)) return { error: `Kind must be one of ${CONCESSION_KINDS.join(", ")}.`, status: 400 };
  const pct = percent === undefined || percent === null || percent === "" ? null : Number(percent);
  const amt = amountMinor === undefined || amountMinor === null || amountMinor === "" ? null : Number(amountMinor);
  if ((pct === null) === (amt === null)) return { error: "Give either a percentage or a fixed amount, not both.", status: 400 };
  if (pct !== null && !(pct > 0 && pct <= 100)) return { error: "Percentage must be between 0 and 100.", status: 400 };
  if (amt !== null && !(isMinor(amt) && amt > 0)) return { error: "Amount must be a whole number greater than zero, in minor units.", status: 400 };
  const why = clean(reason, 300);
  if (!why) return { error: "A reason is required.", status: 400 };
  const { eduStudents, eduConcessions } = await getOrgCollections();
  const s = await eduStudents.findOne({ _id: toObjectId(studentId), orgId: toObjectId(orgId), status: "enrolled" });
  if (!s) return { error: "Enrolled student not found.", status: 404 };
  const doc = { orgId: toObjectId(orgId), studentId: s._id, studentName: s.fullName, kind, percent: pct, amountMinor: amt, reason: why, status: "REQUESTED", requestedByEmail: actorEmail, createdAt: now() };
  const r = await eduConcessions.insertOne(doc);
  await logEducationEvent({ orgId, recordType: "EDU_CONCESSION", recordId: r.insertedId, actorEmail, action: "REQUESTED", metadata: { kind, percent: pct, amountMinor: amt } });
  return { concession: { ...doc, _id: r.insertedId } };
}

export async function decideConcession({ orgId, concessionId, approve, note, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can approve concessions.", status: 403 };
  const { eduConcessions } = await getOrgCollections();
  const c = await eduConcessions.findOne({ _id: toObjectId(concessionId), orgId: toObjectId(orgId) });
  if (!c) return { error: "Concession not found.", status: 404 };
  if (c.status !== "REQUESTED") return { error: "This concession was already decided.", status: 409 };
  if (c.requestedByEmail === actorEmail) return { error: "You requested this concession, so someone else has to approve it.", status: 403 };
  const status = approve ? "APPROVED" : "REJECTED";
  const r = await eduConcessions.updateOne({ _id: c._id, status: "REQUESTED" }, { $set: { status, decidedByEmail: actorEmail, decidedAt: now(), decisionNote: clean(note, 300) || null } });
  if (!r.modifiedCount) return { error: "This concession was already decided.", status: 409 };
  await logEducationEvent({ orgId, recordType: "EDU_CONCESSION", recordId: c._id, actorEmail, action: status, metadata: {} });
  return { status };
}

export async function endConcession({ orgId, concessionId, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can end concessions.", status: 403 };
  const { eduConcessions } = await getOrgCollections();
  const r = await eduConcessions.updateOne({ _id: toObjectId(concessionId), orgId: toObjectId(orgId), status: "APPROVED" }, { $set: { status: "ENDED", endedAt: now(), endedByEmail: actorEmail } });
  if (!r.modifiedCount) return { error: "No approved concession with that id.", status: 404 };
  await logEducationEvent({ orgId, recordType: "EDU_CONCESSION", recordId: concessionId, actorEmail, action: "ENDED", metadata: {} });
  return { ended: true };
}

export async function listConcessions(orgId, { membership, status }) {
  if (!canHandleFees(membership)) return deny();
  const { eduConcessions } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (status) q.status = status;
  return { concessions: await eduConcessions.find(q).sort({ createdAt: -1 }).limit(1000).toArray() };
}

/** Total discount for a bill of `subtotal`, from approved concessions. */
export function concessionAmount(subtotal, concessions) {
  let off = 0;
  for (const c of concessions) off += c.percent !== null && c.percent !== undefined ? Math.round((subtotal * c.percent) / 100) : c.amountMinor;
  return Math.min(off, subtotal);
}

// ---------- Invoices ----------
export async function generateInvoices({ orgId, structureId, period, dueDate, classId, membership, actorEmail }) {
  if (!canHandleFees(membership)) return deny();
  const p = clean(period, 20);
  if (!/^[\w-]{4,20}$/.test(p)) return { error: "Period must be like 2026-11 or 2026-T1.", status: 400 };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate || "")) return { error: "Due date must be YYYY-MM-DD.", status: 400 };
  const c = await getOrgCollections();
  const oid = toObjectId(orgId);
  const structure = await c.eduFeeStructures.findOne({ _id: toObjectId(structureId), orgId: oid, active: true });
  if (!structure) return { error: "Fee structure not found.", status: 404 };
  const targetClass = classId ? toObjectId(classId) : structure.classId;
  const studentQuery = { orgId: oid, status: "enrolled" };
  if (targetClass) studentQuery.classId = targetClass;
  const [students, concessions, classes] = await Promise.all([
    c.eduStudents.find(studentQuery).project({ fullName: 1, admissionNo: 1, classId: 1 }).toArray(),
    c.eduConcessions.find({ orgId: oid, status: "APPROVED" }).toArray(),
    c.eduClasses.find({ orgId: oid }).toArray(),
  ]);
  const classBy = new Map(classes.map((x) => [String(x._id), x]));
  const year = new Date().getFullYear();
  let created = 0, skipped = 0;
  for (const s of students) {
    const exists = await c.eduFeeInvoices.findOne({ orgId: oid, studentId: s._id, period: p, structureId: structure._id }, { projection: { _id: 1 } });
    if (exists) { skipped += 1; continue; }
    const mine = concessions.filter((x) => String(x.studentId) === String(s._id));
    const discount = concessionAmount(structure.totalMinor, mine);
    const seq = await nextNumber(orgId, `invoice:${year}`);
    const doc = {
      orgId: oid, invoiceNo: `INV-${year}-${String(seq).padStart(6, "0")}`, studentId: s._id, studentName: s.fullName, admissionNo: s.admissionNo,
      classId: s.classId, classLabel: classLabel(classBy.get(String(s.classId))), structureId: structure._id, structureName: structure.name, period: p,
      lines: structure.heads, subtotalMinor: structure.totalMinor, concessionMinor: discount, concessionIds: mine.map((x) => x._id),
      lateFeeMinor: 0, totalMinor: structure.totalMinor - discount, paidMinor: 0, currency: structure.currency,
      status: structure.totalMinor - discount === 0 ? "paid" : "unpaid", dueDate, issuedAt: now(), issuedByEmail: actorEmail,
    };
    try { await c.eduFeeInvoices.insertOne(doc); created += 1; } catch (err) { if (err?.code === 11000) { skipped += 1; continue; } throw err; }
  }
  await logEducationEvent({ orgId, recordType: "EDU_FEE_STRUCTURE", recordId: structure._id, actorEmail, action: "INVOICES_GENERATED", metadata: { period: p, created, skipped } });
  return { created, skipped };
}

export async function listInvoices(orgId, { membership, studentId, status, period, classId }) {
  if (!canHandleFees(membership)) return deny();
  const { eduFeeInvoices } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (studentId) q.studentId = toObjectId(studentId);
  if (status) q.status = status;
  if (period) q.period = period;
  if (classId) q.classId = toObjectId(classId);
  return { invoices: await eduFeeInvoices.find(q).sort({ dueDate: -1, invoiceNo: -1 }).limit(2000).toArray() };
}

export async function cancelInvoice({ orgId, invoiceId, reason, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can cancel an invoice.", status: 403 };
  const why = clean(reason, 300);
  if (!why) return { error: "A reason is required.", status: 400 };
  const { eduFeeInvoices } = await getOrgCollections();
  const r = await eduFeeInvoices.updateOne({ _id: toObjectId(invoiceId), orgId: toObjectId(orgId), paidMinor: 0, status: { $ne: "cancelled" } }, { $set: { status: "cancelled", cancelledAt: now(), cancelledByEmail: actorEmail, cancelReason: why } });
  if (!r.modifiedCount) return { error: "Only an unpaid, uncancelled invoice can be cancelled. Reverse its payments first.", status: 409 };
  await logEducationEvent({ orgId, recordType: "EDU_FEE_INVOICE", recordId: invoiceId, actorEmail, action: "CANCELLED", metadata: { reason: why } });
  return { cancelled: true };
}

/** Adds the school's late fee once to each overdue, unpaid or part-paid invoice. */
export async function applyLateFees({ orgId, asOf, membership, actorEmail }) {
  if (!canHandleFees(membership)) return deny();
  const { lateFeeMinor } = await getEducationSettings(orgId);
  if (!lateFeeMinor) return { error: "Set a late fee in Education settings first.", status: 400 };
  const { eduFeeInvoices } = await getOrgCollections();
  const r = await eduFeeInvoices.updateMany(
    { orgId: toObjectId(orgId), status: { $in: ["unpaid", "partial"] }, dueDate: { $lt: asOf || today() }, lateFeeMinor: 0 },
    [{ $set: { lateFeeMinor, totalMinor: { $add: ["$totalMinor", lateFeeMinor] }, lateFeeAppliedAt: now() } }]
  );
  await logEducationEvent({ orgId, recordType: "EDU_FEE_INVOICE", recordId: null, actorEmail, action: "LATE_FEES_APPLIED", metadata: { count: r.modifiedCount, lateFeeMinor } });
  return { applied: r.modifiedCount };
}

// ---------- Payments ----------
export async function recordPayment({ orgId, invoiceId, amountMinor, method, reference, paidOn, membership, actorEmail }) {
  if (!canHandleFees(membership)) return deny();
  const amt = Number(amountMinor);
  if (!(isMinor(amt) && amt > 0)) return { error: "Amount must be a whole number greater than zero, in minor units.", status: 400 };
  if (!PAYMENT_METHODS.includes(method)) return { error: `Method must be one of ${PAYMENT_METHODS.join(", ")}.`, status: 400 };
  if (method !== "cash" && !clean(reference, 60)) return { error: "A bank, cheque or transaction reference is required for non-cash payments.", status: 400 };
  const day = paidOn || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today()) return { error: "Payment date must be today or earlier (YYYY-MM-DD).", status: 400 };
  const { eduFeeInvoices, eduFeePayments } = await getOrgCollections();
  const oid = toObjectId(orgId);
  // Conditional increment: succeeds only if this payment doesn't take the invoice past its total.
  const inv = await eduFeeInvoices.findOneAndUpdate(
    { _id: toObjectId(invoiceId), orgId: oid, status: { $in: ["unpaid", "partial"] }, $expr: { $lte: [{ $add: ["$paidMinor", amt] }, "$totalMinor"] } },
    { $inc: { paidMinor: amt } },
    { returnDocument: "after" }
  );
  if (!inv) {
    const current = await eduFeeInvoices.findOne({ _id: toObjectId(invoiceId), orgId: oid });
    if (!current) return { error: "Invoice not found.", status: 404 };
    if (!["unpaid", "partial"].includes(current.status)) return { error: `This invoice is ${current.status}.`, status: 409 };
    return { error: `That's more than the outstanding ${current.totalMinor - current.paidMinor} (minor units).`, status: 400 };
  }
  await eduFeeInvoices.updateOne({ _id: inv._id }, { $set: { status: inv.paidMinor >= inv.totalMinor ? "paid" : "partial", lastPaymentAt: now() } });
  const { receiptPrefix } = await getEducationSettings(orgId);
  const year = Number(day.slice(0, 4));
  const receiptNo = `${receiptPrefix}-${year}-${String(await nextNumber(orgId, `receipt:${year}`)).padStart(6, "0")}`;
  const payment = { orgId: oid, receiptNo, invoiceId: inv._id, invoiceNo: inv.invoiceNo, studentId: inv.studentId, studentName: inv.studentName, admissionNo: inv.admissionNo, amountMinor: amt, currency: inv.currency, method, reference: clean(reference, 60) || null, paidOn: day, status: "posted", recordedByEmail: actorEmail, recordedAt: now() };
  try {
    const r = await eduFeePayments.insertOne(payment);
    await logEducationEvent({ orgId, recordType: "EDU_FEE_PAYMENT", recordId: r.insertedId, actorEmail, action: "RECORDED", metadata: { receiptNo, invoiceNo: inv.invoiceNo, amountMinor: amt, method } });
    return { payment: { ...payment, _id: r.insertedId }, invoice: { ...inv, status: inv.paidMinor >= inv.totalMinor ? "paid" : "partial" } };
  } catch (err) {
    // Put the invoice back exactly as it was if the receipt couldn't be written.
    await eduFeeInvoices.updateOne({ _id: inv._id }, { $inc: { paidMinor: -amt } });
    await eduFeeInvoices.updateOne({ _id: inv._id }, [{ $set: { status: { $cond: [{ $eq: ["$paidMinor", 0] }, "unpaid", "partial"] } } }]);
    throw err;
  }
}

export async function reversePayment({ orgId, paymentId, reason, membership, actorEmail }) {
  if (!canManageEducation(membership)) return { error: "Only the principal, owner or an admin can reverse a payment.", status: 403 };
  const why = clean(reason, 300);
  if (!why) return { error: "A reason is required (for example, the cheque bounced).", status: 400 };
  const { eduFeePayments, eduFeeInvoices } = await getOrgCollections();
  const p = await eduFeePayments.findOneAndUpdate({ _id: toObjectId(paymentId), orgId: toObjectId(orgId), status: "posted" }, { $set: { status: "reversed", reversedAt: now(), reversedByEmail: actorEmail, reversalReason: why } }, { returnDocument: "after" });
  if (!p) return { error: "Posted payment not found (it may already be reversed).", status: 404 };
  await eduFeeInvoices.updateOne({ _id: p.invoiceId }, [{ $set: { paidMinor: { $subtract: ["$paidMinor", p.amountMinor] } } }, { $set: { status: { $cond: [{ $lte: ["$paidMinor", 0] }, "unpaid", { $cond: [{ $gte: ["$paidMinor", "$totalMinor"] }, "paid", "partial"] }] } } }]);
  await logEducationEvent({ orgId, recordType: "EDU_FEE_PAYMENT", recordId: p._id, actorEmail, action: "REVERSED", metadata: { receiptNo: p.receiptNo, reason: why } });
  return { reversed: true };
}

export async function listPayments(orgId, { membership, studentId, from, to }) {
  if (!canHandleFees(membership)) return deny();
  const { eduFeePayments } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (studentId) q.studentId = toObjectId(studentId);
  if (from || to) q.paidOn = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  return { payments: await eduFeePayments.find(q).sort({ recordedAt: -1 }).limit(2000).toArray() };
}

export async function getReceipt({ orgId, paymentId, membership }) {
  if (!canHandleFees(membership)) return deny();
  const { eduFeePayments, eduFeeInvoices } = await getOrgCollections();
  const p = await eduFeePayments.findOne({ _id: toObjectId(paymentId), orgId: toObjectId(orgId) });
  if (!p) return { error: "Payment not found.", status: 404 };
  const inv = await eduFeeInvoices.findOne({ _id: p.invoiceId });
  const settings = await getEducationSettings(orgId);
  return { receipt: { schoolName: settings.schoolName, ...p, invoice: inv ? { invoiceNo: inv.invoiceNo, period: inv.period, classLabel: inv.classLabel, lines: inv.lines, concessionMinor: inv.concessionMinor, lateFeeMinor: inv.lateFeeMinor, totalMinor: inv.totalMinor, paidMinor: inv.paidMinor, balanceMinor: inv.totalMinor - inv.paidMinor } : null } };
}

// ---------- Reports ----------
export async function defaulters(orgId, { membership, asOf, classId }) {
  if (!canHandleFees(membership)) return deny();
  const { eduFeeInvoices } = await getOrgCollections();
  const day = asOf || today();
  const match = { orgId: toObjectId(orgId), status: { $in: ["unpaid", "partial"] }, dueDate: { $lt: day } };
  if (classId) match.classId = toObjectId(classId);
  const rows = await eduFeeInvoices.aggregate([
    { $match: match },
    { $group: { _id: "$studentId", studentName: { $first: "$studentName" }, admissionNo: { $first: "$admissionNo" }, classLabel: { $first: "$classLabel" }, currency: { $first: "$currency" }, outstandingMinor: { $sum: { $subtract: ["$totalMinor", "$paidMinor"] } }, invoices: { $sum: 1 }, oldestDue: { $min: "$dueDate" } } },
    { $sort: { outstandingMinor: -1 } },
  ]).toArray();
  return { asOf: day, defaulters: rows.map((r) => ({ studentId: r._id, ...r, _id: undefined, daysOverdue: Math.round((Date.parse(day) - Date.parse(r.oldestDue)) / 86400000) })) };
}

export async function collectionSummary(orgId, { membership, period, from, to }) {
  if (!canHandleFees(membership)) return deny();
  const { eduFeeInvoices, eduFeePayments } = await getOrgCollections();
  const oid = toObjectId(orgId);
  const invMatch = { orgId: oid, status: { $ne: "cancelled" } };
  if (period) invMatch.period = period;
  const payMatch = { orgId: oid, status: "posted" };
  if (from || to) payMatch.paidOn = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [billed, byMethod] = await Promise.all([
    eduFeeInvoices.aggregate([{ $match: invMatch }, { $group: { _id: "$currency", billedMinor: { $sum: "$totalMinor" }, paidMinor: { $sum: "$paidMinor" }, concessionMinor: { $sum: "$concessionMinor" }, invoices: { $sum: 1 } } }]).toArray(),
    eduFeePayments.aggregate([{ $match: payMatch }, { $group: { _id: { currency: "$currency", method: "$method" }, amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } }]).toArray(),
  ]);
  return {
    period: period || null,
    totals: billed.map((b) => ({ currency: b._id, billedMinor: b.billedMinor, collectedMinor: b.paidMinor, outstandingMinor: b.billedMinor - b.paidMinor, concessionMinor: b.concessionMinor, invoices: b.invoices })),
    byMethod: byMethod.map((m) => ({ currency: m._id.currency, method: m._id.method, amountMinor: m.amountMinor, count: m.count })),
  };
}

/** A student's statement: who may see it is the same as who may handle fees,
 *  plus the register keepers (the admissions office answers parents too). */
export async function studentStatement({ orgId, studentId, membership }) {
  if (!canHandleFees(membership) && !canKeepStudentRegister(membership)) return deny();
  return statementFor(orgId, studentId);
}

export async function statementFor(orgId, studentId) {
  const { eduFeeInvoices, eduFeePayments } = await getOrgCollections();
  const oid = toObjectId(orgId), sid = toObjectId(studentId);
  const [invoices, payments] = await Promise.all([
    eduFeeInvoices.find({ orgId: oid, studentId: sid, status: { $ne: "cancelled" } }).sort({ dueDate: 1 }).toArray(),
    eduFeePayments.find({ orgId: oid, studentId: sid }).sort({ paidOn: 1 }).toArray(),
  ]);
  const outstandingMinor = invoices.reduce((t, i) => t + (i.totalMinor - i.paidMinor), 0);
  return { invoices, payments, outstandingMinor, currency: invoices[0]?.currency || null };
}
