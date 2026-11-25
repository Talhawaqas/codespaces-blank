// src/lib/ops/cheques.js -- Manage Orders SOW section 11: controlled cheque creation, approval, printing and tracking.
//
// No new ledger: a cheque is created from an APPROVED expense (the existing payables record). Issuing it records ONE
// `payments` row (OUTGOING, method "cheque", reference = cheque number, linked to the expense), which the existing
// ledger posts AP -> Cash. Clearing links the bank transaction the AI Bookkeeper imported (existing reconciliation).
// Controls: unique number per cheque book (unique opsKey), one live cheque per expense (unique opsKey2), approval by a
// finance manager who is not the creator (segregation, configurable), payee/amount edits after approval drop the
// approval, reprint/void need permission + reason, a print request with the same key never prints twice, an alignment
// test print never touches a cheque. Only the last 4 digits of an account are stored; bank credentials never are.
// Layout presets are STARTING POINTS: every company aligns its own leaf with the test print before real use.
import { getOrgCollections } from "../orgs.js";
import { canManageFinance, canAccessDepartment } from "../orgGates.js";
import { isSupportedCurrency } from "../currency.js";
import { ccol, oid, sid, clean, fail, nowIso, K, opsAccess, getOpsSettings, audit, notifyMember, isDate, iso } from "./core.js";
import { ensureOpsIndexes } from "./jobs.js";

export const CHEQUE_STATES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PRINTED", "ISSUED", "CLEARED", "RETURNED", "VOIDED"];

// ------------------------------------------------------------------ amount in words
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ""}`);
const below1000 = (n) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : "", n % 100 ? below100(n % 100) : ""].filter(Boolean).join(" ");
/** system "south_asian" (lakh/crore, used on Pakistani cheques) or "international" (thousand/million/billion). */
export function amountInWords(amount, { currency = "PKR", system = "south_asian" } = {}) {
  const total = Math.round(Number(amount) * 100); if (!Number.isFinite(total) || total < 0 || total >= 1e13) return null;
  let n = Math.floor(total / 100); const paisa = total % 100; const parts = [];
  if (n === 0) parts.push("Zero");
  else if (system === "south_asian") {
    const arab = Math.floor(n / 1e9); n %= 1e9; const crore = Math.floor(n / 1e7); n %= 1e7; const lakh = Math.floor(n / 1e5); n %= 1e5; const th = Math.floor(n / 1000); n %= 1000;
    if (arab) parts.push(`${below1000(arab)} Arab`); if (crore) parts.push(`${below100(crore)} Crore`); if (lakh) parts.push(`${below100(lakh)} Lakh`); if (th) parts.push(`${below100(th)} Thousand`); if (n) parts.push(below1000(n));
  } else {
    for (const [v, w] of [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]]) { const q = Math.floor(n / v); if (q) { parts.push(`${below1000(q)} ${w}`); n %= v; } }
    if (n) parts.push(below1000(n));
  }
  const unit = { PKR: ["Rupees", "Paisa"], USD: ["Dollars", "Cents"], GBP: ["Pounds", "Pence"], EUR: ["Euros", "Cents"], AED: ["Dirhams", "Fils"] }[currency] || [currency, "Cents"];
  return `${unit[0]} ${parts.join(" ")}${paisa ? ` and ${below100(paisa)} ${unit[1]}` : ""} Only`;
}

// ------------------------------------------------------------------ layout presets (mm from the leaf's top-left)
const BASE = { pageWidthMm: 203, pageHeightMm: 89, fontPt: 11, date: { x: 158, y: 12, spacingMm: 4.2, format: "DDMMYYYY" }, payee: { x: 22, y: 27, width: 130 }, amountWords: { x: 22, y: 37, width: 125, lineGapMm: 7 }, amountFigures: { x: 160, y: 41, width: 35 }, memo: { x: 22, y: 60, width: 90, enabled: false }, acPayee: { x: 8, y: 6, enabled: true, text: "A/C PAYEE ONLY" } };
export const PRESETS = {
  GENERIC_PK: { name: "Generic Pakistan cheque", bank: "Generic", ...BASE },
  HBL: { name: "HBL (starting layout)", bank: "HBL", ...BASE },
  MEEZAN: { name: "Meezan Bank (starting layout)", bank: "Meezan Bank", ...BASE },
  MCB: { name: "MCB (starting layout)", bank: "MCB", ...BASE },
};
export const PRESET_NOTE = "Starting layout only: it has not been measured against a real leaf from this bank. Print the alignment test on plain paper, hold it over a real cheque leaf, adjust the positions and save before printing a real cheque.";
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
function cleanLayout(input = {}, base = BASE) {
  const out = { pageWidthMm: num(input.pageWidthMm, 50, 300) ?? base.pageWidthMm, pageHeightMm: num(input.pageHeightMm, 30, 200) ?? base.pageHeightMm, fontPt: num(input.fontPt, 6, 20) ?? base.fontPt, offsetXMm: num(input.offsetXMm, -30, 30) ?? 0, offsetYMm: num(input.offsetYMm, -30, 30) ?? 0 };
  for (const f of ["date", "payee", "amountWords", "amountFigures", "memo", "acPayee"]) {
    const b = base[f]; const i = input[f] || {};
    out[f] = { ...b, x: num(i.x, 0, 300) ?? b.x, y: num(i.y, 0, 200) ?? b.y, ...(b.width !== undefined ? { width: num(i.width, 5, 300) ?? b.width } : {}), ...(b.spacingMm !== undefined ? { spacingMm: num(i.spacingMm, 0, 15) ?? b.spacingMm } : {}), ...(b.lineGapMm !== undefined ? { lineGapMm: num(i.lineGapMm, 2, 20) ?? b.lineGapMm } : {}), ...(b.enabled !== undefined ? { enabled: i.enabled === undefined ? b.enabled : !!i.enabled } : {}), ...(b.text !== undefined ? { text: clean(i.text, 30) || b.text } : {}), ...(b.format !== undefined ? { format: ["DDMMYYYY", "DD/MM/YYYY", "DD-MM-YYYY"].includes(i.format) ? i.format : b.format } : {}) };
  }
  return out;
}

// ------------------------------------------------------------------ templates + books
const tplView = (t) => ({ id: sid(t._id), name: t.name, bank: t.bank, preset: t.preset || null, layout: t.layout, aligned: !!t.aligned, updatedAt: t.updatedAt, note: t.aligned ? null : PRESET_NOTE });
export async function saveTemplate({ orgId, membership, actorEmail, id, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "finance_manage" }); if (d) return d; await ensureOpsIndexes();
  const preset = input.preset && PRESETS[input.preset] ? input.preset : null;
  const base = preset ? PRESETS[preset] : BASE;
  const doc = { name: clean(input.name, 80) || base.name || "Cheque layout", bank: clean(input.bank, 60) || base.bank || "Generic", preset, layout: cleanLayout(input.layout || {}, base), aligned: !!input.aligned, updatedAt: nowIso(), updatedBy: actorEmail };
  const c = await ccol();
  if (id) { const u = await c.findOneAndUpdate({ _id: oid(id), orgId: oid(orgId), kind: K.chqTpl }, { $set: doc }, { returnDocument: "after" }); if (!u) return fail("Layout not found.", 404); await audit({ orgId, actorEmail, recordType: "CHEQUE_TEMPLATE", recordId: u._id, action: "CHEQUE_TEMPLATE_UPDATED", metadata: { aligned: doc.aligned } }); return { template: tplView(u) }; }
  const full = { orgId: oid(orgId), kind: K.chqTpl, opsDoc: true, ...doc, createdAt: doc.updatedAt, createdBy: actorEmail };
  const r = await c.insertOne(full); full._id = r.insertedId;
  await audit({ orgId, actorEmail, recordType: "CHEQUE_TEMPLATE", recordId: r.insertedId, action: "CHEQUE_TEMPLATE_CREATED", metadata: { preset } });
  return { template: tplView(full) };
}
export async function listTemplates({ orgId, membership }) {
  const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d;
  const c = await ccol(); return { templates: (await c.find({ orgId: oid(orgId), kind: K.chqTpl }).sort({ name: 1 }).toArray()).map(tplView), presets: Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, bank: p.bank })), presetNote: PRESET_NOTE };
}
const bookView = (b) => ({ id: sid(b._id), bankName: b.bankName, accountName: b.accountName, accountLast4: b.accountLast4, currency: b.currency, firstNumber: b.firstNumber, lastNumber: b.lastNumber, nextNumber: b.nextNumber, remaining: Math.max(0, b.lastNumber - b.nextNumber + 1), templateId: sid(b.templateId), departmentId: sid(b.departmentId), active: b.active !== false, spoiled: b.spoiled || [] });
export async function saveBook({ orgId, membership, actorEmail, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "finance_manage" }); if (d) return d; await ensureOpsIndexes();
  const bankName = clean(input.bankName, 80); const accountName = clean(input.accountName, 120);
  const last4 = String(input.accountLast4 || "").replace(/\D/g, "").slice(-4);
  if (!bankName || !accountName) return fail("Enter the bank and the account name.");
  if (last4.length !== 4) return fail("Enter only the last 4 digits of the account number.");
  const first = Number(input.firstNumber); const last = Number(input.lastNumber);
  if (!(Number.isInteger(first) && first > 0 && Number.isInteger(last) && last >= first && last - first < 1000)) return fail("Enter the first and last cheque numbers of the book (up to 1000 leaves).");
  const cur = String(input.currency || "PKR").toUpperCase(); if (!isSupportedCurrency(cur)) return fail(`Unsupported currency "${cur}".`);
  const c = await ccol();
  if (input.templateId && !await c.findOne({ _id: oid(input.templateId), orgId: oid(orgId), kind: K.chqTpl })) return fail("Cheque layout not found.", 404);
  // Overlapping number ranges on the same account are refused (duplicate cheque numbers).
  const clash = await c.findOne({ orgId: oid(orgId), kind: K.chqBook, bankName, accountLast4: last4, firstNumber: { $lte: last }, lastNumber: { $gte: first } });
  if (clash) return fail(`Those numbers overlap an existing cheque book for this account (${clash.firstNumber}–${clash.lastNumber}).`, 409, "DUPLICATE_NUMBERS");
  const doc = { orgId: oid(orgId), kind: K.chqBook, opsDoc: true, bankName, accountName, accountLast4: last4, currency: cur, firstNumber: first, lastNumber: last, nextNumber: first, templateId: oid(input.templateId), departmentId: oid(input.departmentId), active: true, spoiled: [], createdBy: actorEmail, createdAt: nowIso() };
  const r = await c.insertOne(doc); doc._id = r.insertedId;
  await audit({ orgId, actorEmail, recordType: "CHEQUE_BOOK", recordId: r.insertedId, action: "CHEQUE_BOOK_CREATED", metadata: { bankName, first, last } });
  return { book: bookView(doc) };
}
export async function listBooks({ orgId, membership }) {
  const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d;
  const c = await ccol(); return { books: (await c.find({ orgId: oid(orgId), kind: K.chqBook }).sort({ createdAt: -1 }).toArray()).map(bookView) };
}
async function takeNumber(c, orgId, bookId) {
  const b = await c.findOneAndUpdate({ _id: oid(bookId), orgId: oid(orgId), kind: K.chqBook, active: { $ne: false }, $expr: { $lte: ["$nextNumber", "$lastNumber"] } }, { $inc: { nextNumber: 1 } }, { returnDocument: "before" });
  return b ? { book: b, number: b.nextNumber } : null;
}

// ------------------------------------------------------------------ cheques
const chqView = (q) => ({ id: sid(q._id), number: q.number, numberText: String(q.number).padStart(6, "0"), bookId: sid(q.bookId), bankName: q.bankName, accountLast4: q.accountLast4, payee: q.payee, amount: q.amount, currency: q.currency, amountWords: q.amountWords, date: q.date, memo: q.memo, expenseId: sid(q.expenseId), departmentId: sid(q.departmentId), status: q.status, approval: q.approval || null, prints: q.prints || [], paymentId: sid(q.paymentId), bankTransactionId: sid(q.bankTransactionId), createdBy: q.createdBy, createdAt: q.createdAt, history: q.history || [], voidReason: q.voidReason || null });

export async function listCheques({ orgId, membership, status, q, from, to, bookId }) {
  const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d;
  const f = { orgId: oid(orgId), kind: K.chq }; if (status) f.status = { $in: String(status).split(",") }; if (bookId) f.bookId = oid(bookId);
  if (from || to) f.date = { ...(from ? { $gte: String(from).slice(0, 10) } : {}), ...(to ? { $lte: String(to).slice(0, 10) } : {}) };
  if (q) { const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i"); f.$or = [{ payee: rx }, { numberText: rx }, { memo: rx }]; }
  const c = await ccol(); const rows = await c.find(f).sort({ createdAt: -1 }).limit(300).toArray();
  return { cheques: rows.map(chqView) };
}
async function loadCheque(orgId, id) { const c = await ccol(); return c.findOne({ _id: oid(id), orgId: oid(orgId), kind: K.chq }); }

/** Create from an APPROVED expense; the amount can't exceed what is still unpaid on it. */
export async function createCheque({ orgId, membership, actorEmail, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d; await ensureOpsIndexes();
  const { expenses, payments } = await getOrgCollections(); const c = await ccol();
  const exp = await expenses.findOne({ _id: oid(input.expenseId), orgId: oid(orgId), deletedAt: null });
  if (!exp) return fail("Choose the approved expense (payable) this cheque pays.", 404);
  if (exp.status !== "APPROVED") return fail("Only an approved expense can be paid by cheque.", 409);
  if (!canAccessDepartment(membership, sid(exp.departmentId))) return fail("You don't have access to that department.", 403);
  const paid = (await payments.find({ orgId: oid(orgId), relatedExpenseId: exp._id, deletedAt: null, direction: "OUTGOING" }).toArray()).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const due = Math.round(((Number(exp.amount) || 0) - paid) * 100) / 100;
  const amount = input.amount === undefined || input.amount === "" ? due : Math.round(Number(input.amount) * 100) / 100;
  if (!(amount > 0)) return fail("This expense is already fully paid.", 409, "ALREADY_PAID");
  if (amount > due + 0.001) return fail(`The cheque can't be more than what is unpaid (${due}).`, 409);
  const payee = clean(input.payee, 120) || clean(exp.vendor, 120); if (payee.length < 2) return fail("Enter the payee name.");
  if (!isDate(input.date)) return fail("Enter a valid cheque date.");
  const book = await c.findOne({ _id: oid(input.bookId), orgId: oid(orgId), kind: K.chqBook, active: { $ne: false } }); if (!book) return fail("Choose a cheque book.", 404);
  if (book.currency !== String(exp.currency || book.currency).toUpperCase()) return fail(`This cheque book is in ${book.currency}; the expense is in ${exp.currency}.`, 409);
  if (await c.findOne({ orgId: oid(orgId), opsKey2: `chqexp:${sid(exp._id)}` }, { projection: { _id: 1 } })) return fail("This expense already has a cheque in progress.", 409, "DUPLICATE");
  const t = await takeNumber(c, orgId, book._id); if (!t) return fail("This cheque book has no leaves left.", 409, "BOOK_EMPTY");
  const now = nowIso(); const date = (input.date ? iso(input.date) : now).slice(0, 10);
  const doc = { orgId: oid(orgId), kind: K.chq, opsDoc: true, opsKey: `chq:${sid(book._id)}:${t.number}`, opsKey2: `chqexp:${sid(exp._id)}`, bookId: book._id, number: t.number, numberText: String(t.number).padStart(6, "0"), bankName: book.bankName, accountLast4: book.accountLast4,
    payee, amount, currency: book.currency, amountWords: amountInWords(amount, { currency: book.currency, system: book.currency === "PKR" ? "south_asian" : "international" }), date, memo: clean(input.memo, 120), expenseId: exp._id, departmentId: exp.departmentId,
    status: "PENDING_APPROVAL", approval: null, prints: [], createdBy: actorEmail, createdAt: now, updatedAt: now, history: [{ to: "PENDING_APPROVAL", by: actorEmail, at: now }] };
  try { const r = await c.insertOne(doc); doc._id = r.insertedId; }
  catch (e) {
    if (e?.code === 11000) { await c.updateOne({ _id: book._id }, { $push: { spoiled: { number: t.number, reason: "number collision on creation", at: now } } }); return fail(String(e.message).includes("opsKey2") ? "This expense already has a cheque in progress." : "That cheque number is already used.", 409, "DUPLICATE"); }
    throw e;
  }
  await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: doc._id, action: "CHEQUE_CREATED", newState: "PENDING_APPROVAL", metadata: { number: t.number, amount, bank: book.bankName } });
  return { cheque: chqView(doc) };
}
/** Payee/amount/date/memo change. After approval the approval is dropped and it must be approved again. */
export async function editCheque({ orgId, membership, actorEmail, id, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d;
  const q = await loadCheque(orgId, id); if (!q) return fail("Cheque not found.", 404);
  if (!["PENDING_APPROVAL", "APPROVED"].includes(q.status)) return fail("A printed or issued cheque can't be edited. Void it and write a new one.", 409);
  const set = {};
  if (input.payee !== undefined) { const p = clean(input.payee, 120); if (p.length < 2) return fail("Enter the payee name."); set.payee = p; }
  if (input.amount !== undefined) { const a = Math.round(Number(input.amount) * 100) / 100; if (!(a > 0)) return fail("Amount must be more than 0."); const { expenses, payments } = await getOrgCollections(); const exp = await expenses.findOne({ _id: q.expenseId }); const paid = (await payments.find({ orgId: q.orgId, relatedExpenseId: q.expenseId, deletedAt: null, direction: "OUTGOING" }).toArray()).reduce((s, p) => s + (Number(p.amount) || 0), 0); if (a > (Number(exp.amount) || 0) - paid + 0.001) return fail("The cheque can't be more than what is unpaid."); set.amount = a; set.amountWords = amountInWords(a, { currency: q.currency, system: q.currency === "PKR" ? "south_asian" : "international" }); }
  if (input.date !== undefined) { if (!isDate(input.date) || !input.date) return fail("Enter a valid date."); set.date = iso(input.date).slice(0, 10); }
  if (input.memo !== undefined) set.memo = clean(input.memo, 120);
  if (!Object.keys(set).length) return fail("Nothing to change.");
  const material = set.payee !== undefined || set.amount !== undefined;
  const now = nowIso(); const c = await ccol();
  const u = await c.findOneAndUpdate({ _id: q._id, status: q.status }, { $set: { ...set, updatedAt: now, ...(material ? { status: "PENDING_APPROVAL", approval: null } : {}) }, $push: { history: { change: Object.keys(set), by: actorEmail, at: now, ...(material && q.status === "APPROVED" ? { approvalDropped: true } : {}) } } }, { returnDocument: "after" });
  if (!u) return fail("The cheque changed at the same time. Reload.", 409);
  await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: "CHEQUE_EDITED", previousState: q.status, newState: u.status, metadata: { fields: Object.keys(set), approvalDropped: material && q.status === "APPROVED" } });
  return { cheque: chqView(u) };
}
export async function decideCheque({ orgId, membership, actorEmail, id, approve, reason }) {
  const d = await opsAccess({ orgId, membership, need: "finance_manage" }); if (d) return d;
  const q = await loadCheque(orgId, id); if (!q) return fail("Cheque not found.", 404);
  if (q.status !== "PENDING_APPROVAL") return fail("Only a cheque waiting for approval can be decided.", 409);
  const s = await getOpsSettings(orgId); if (s.chequeSegregation && q.createdBy === actorEmail) return fail("The person who wrote the cheque can't approve it.", 403, "SEGREGATION");
  const why = clean(reason, 300); if (!approve && why.length < 3) return fail("Give a reason for rejecting.");
  const now = nowIso(); const c = await ccol(); const to = approve ? "APPROVED" : "VOIDED";
  const u = await c.findOneAndUpdate({ _id: q._id, status: "PENDING_APPROVAL", payee: q.payee, amount: q.amount }, { $set: { status: to, approval: approve ? { by: actorEmail, at: now, payee: q.payee, amount: q.amount } : null, ...(approve ? {} : { voidReason: `Rejected: ${why}` }), updatedAt: now }, ...(approve ? {} : { $unset: { opsKey2: "" } }), $push: { history: { from: q.status, to, by: actorEmail, at: now, reason: why || null } } }, { returnDocument: "after" });
  if (!u) return fail("The cheque changed at the same time. Reload.", 409);
  if (!approve) await c.updateOne({ _id: q.bookId }, { $push: { spoiled: { number: q.number, reason: `Rejected: ${why}`, at: now } } });
  await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: approve ? "CHEQUE_APPROVED" : "CHEQUE_REJECTED", previousState: q.status, newState: to, metadata: { number: q.number } });
  if (approve) await notifyMember({ orgId, email: q.createdBy, title: `Cheque ${String(q.number).padStart(6, "0")} approved`, body: "It is ready to print.", type: "ops_cheque_approved", sourceId: q._id, dedupeKey: `ops:chqok:${q._id}` });
  return { cheque: chqView(u) };
}
/** Data for the browser/desktop print page. kind: "test" (alignment, sample text, never touches a cheque) | "print" | "reprint". */
export async function printCheque({ orgId, membership, actorEmail, id, kind = "print", reason, idempotencyKey, templateId }) {
  const c = await ccol();
  if (kind === "test") {
    const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d;
    const t = templateId ? await c.findOne({ _id: oid(templateId), orgId: oid(orgId), kind: K.chqTpl }) : null;
    return { test: true, layout: t?.layout || BASE, fields: { date: new Date().toISOString().slice(0, 10), payee: "ALIGNMENT TEST - NOT A CHEQUE", amountWords: amountInWords(123456.78), amountFigures: "123,456.78", memo: "Test print", acPayee: true }, note: PRESET_NOTE };
  }
  const d = await opsAccess({ orgId, membership, need: kind === "reprint" ? "finance_manage" : "finance" }); if (d) return d;
  const q = await loadCheque(orgId, id); if (!q) return fail("Cheque not found.", 404);
  const key = clean(idempotencyKey, 80); if (!/^[A-Za-z0-9_-]{12,80}$/.test(key)) return fail("Missing print key; reload and try again.");
  const prior = (q.prints || []).find((p) => p.key === key);
  const book = await c.findOne({ _id: q.bookId }); const tpl = book?.templateId ? await c.findOne({ _id: book.templateId }) : null;
  const payload = { layout: tpl?.layout || BASE, aligned: !!tpl?.aligned, fields: { date: q.date, payee: q.payee, amountWords: q.amountWords, amountFigures: Number(q.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), memo: q.memo, acPayee: true }, number: q.number };
  if (prior) return { cheque: chqView(q), ...payload, duplicate: true };
  const now = nowIso();
  if (kind === "print") {
    if (q.status !== "APPROVED") return fail(q.status === "PRINTED" ? "This cheque was already printed. Use reprint (needs a reason)." : "Only an approved cheque can be printed.", 409);
    if (!q.approval || q.approval.payee !== q.payee || q.approval.amount !== q.amount) return fail("The approval doesn't match the cheque any more. Approve it again.", 409);
    const u = await c.findOneAndUpdate({ _id: q._id, status: "APPROVED", "prints.key": { $ne: key } }, { $set: { status: "PRINTED", updatedAt: now }, $push: { prints: { key, kind, by: actorEmail, at: now }, history: { from: "APPROVED", to: "PRINTED", by: actorEmail, at: now } } }, { returnDocument: "after" });
    if (!u) return { cheque: chqView(await loadCheque(orgId, id)), ...payload, duplicate: true };
    await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: "CHEQUE_PRINTED", previousState: "APPROVED", newState: "PRINTED", metadata: { number: q.number } });
    return { cheque: chqView(u), ...payload };
  }
  if (kind === "reprint") {
    if (!["PRINTED"].includes(q.status)) return fail("Only a printed, not yet issued cheque can be reprinted.", 409);
    const why = clean(reason, 300); if (why.length < 3) return fail("Give a reason for the reprint.");
    const u = await c.findOneAndUpdate({ _id: q._id, "prints.key": { $ne: key } }, { $push: { prints: { key, kind, by: actorEmail, at: now, reason: why }, history: { action: "reprint", by: actorEmail, at: now, reason: why } }, $set: { updatedAt: now } }, { returnDocument: "after" });
    await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: "CHEQUE_REPRINTED", metadata: { number: q.number, reason: why } });
    return { cheque: chqView(u || q), ...payload };
  }
  return fail("Unknown print kind.");
}
/** The printed leaf was spoiled (jam, misalignment): void this number and move the same approved cheque to the next leaf. */
export async function spoilAndRenumber({ orgId, membership, actorEmail, id, reason }) {
  const d = await opsAccess({ orgId, membership, need: "finance_manage" }); if (d) return d;
  const q = await loadCheque(orgId, id); if (!q) return fail("Cheque not found.", 404);
  if (q.status !== "PRINTED") return fail("Only a printed, not yet issued cheque can be moved to a new leaf.", 409);
  const why = clean(reason, 300); if (why.length < 3) return fail("Say what happened to the leaf.");
  const c = await ccol(); const t = await takeNumber(c, orgId, q.bookId); if (!t) return fail("This cheque book has no leaves left.", 409);
  const now = nowIso();
  const u = await c.findOneAndUpdate({ _id: q._id, status: "PRINTED", number: q.number }, { $set: { number: t.number, numberText: String(t.number).padStart(6, "0"), opsKey: `chq:${sid(q.bookId)}:${t.number}`, status: "APPROVED", updatedAt: now }, $push: { history: { action: "spoiled_renumbered", from: q.number, to: t.number, by: actorEmail, at: now, reason: why } } }, { returnDocument: "after" });
  if (!u) return fail("The cheque changed at the same time. Reload.", 409);
  await c.updateOne({ _id: q.bookId }, { $push: { spoiled: { number: q.number, reason: why, at: now, by: actorEmail } } });
  await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: "CHEQUE_LEAF_SPOILED", metadata: { spoiled: q.number, newNumber: t.number, reason: why } });
  return { cheque: chqView(u) };
}
/** Handed to the payee: records the one payment against the expense (existing payments + ledger). */
export async function issueCheque({ orgId, membership, actorEmail, id }) {
  const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d;
  const q = await loadCheque(orgId, id); if (!q) return fail("Cheque not found.", 404);
  if (q.status !== "PRINTED") return fail("Print the cheque before marking it issued.", 409);
  const c = await ccol(); const now = nowIso();
  const locked = await c.findOneAndUpdate({ _id: q._id, status: "PRINTED", paymentId: null, issuing: { $ne: true } }, { $set: { issuing: true } });
  if (!locked) return fail("This cheque is being issued already.", 409);
  try {
    const { payments } = await getOrgCollections();
    const exists = await payments.findOne({ orgId: q.orgId, chequeId: q._id, deletedAt: null });
    const pay = exists ? { insertedId: exists._id } : await payments.insertOne({ orgId: q.orgId, departmentId: q.departmentId, direction: "OUTGOING", relatedInvoiceId: null, relatedExpenseId: q.expenseId, relatedPurchaseOrderId: null, amount: q.amount, currency: q.currency, method: "cheque", reference: `CHQ ${String(q.number).padStart(6, "0")} ${q.bankName}`, chequeId: q._id, paymentDate: q.date, status: "APPROVED", approvedBy: q.approval?.by || null, source: "manage-orders-cheque", createdByEmail: actorEmail, createdAt: now, deletedAt: null });
    await c.updateOne({ _id: q._id }, { $set: { status: "ISSUED", paymentId: pay.insertedId, issuedAt: now, updatedAt: now }, $unset: { issuing: "", opsKey2: "" }, $push: { history: { from: "PRINTED", to: "ISSUED", by: actorEmail, at: now } } });
    await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: "CHEQUE_ISSUED", previousState: "PRINTED", newState: "ISSUED", metadata: { number: q.number, paymentId: sid(pay.insertedId) } });
    return { cheque: chqView(await loadCheque(orgId, id)) };
  } catch (e) { await c.updateOne({ _id: q._id }, { $unset: { issuing: "" } }); throw e; }
}
/** Void before issue (needs a finance manager + reason). An issued cheque is marked RETURNED instead (bank bounce /
 *  stop payment); reversing its payment is done in Finance so the ledger keeps a proper trail. */
export async function voidCheque({ orgId, membership, actorEmail, id, reason, returned = false }) {
  const d = await opsAccess({ orgId, membership, need: "finance_manage" }); if (d) return d;
  const q = await loadCheque(orgId, id); if (!q) return fail("Cheque not found.", 404);
  const why = clean(reason, 300); if (why.length < 3) return fail("Give a reason.");
  const now = nowIso(); const c = await ccol();
  if (returned) {
    if (!["ISSUED", "CLEARED"].includes(q.status)) return fail("Only an issued cheque can be marked returned.", 409);
    await c.updateOne({ _id: q._id }, { $set: { status: "RETURNED", returnReason: why, updatedAt: now }, $push: { history: { from: q.status, to: "RETURNED", by: actorEmail, at: now, reason: why } } });
    await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: "CHEQUE_RETURNED", previousState: q.status, newState: "RETURNED", metadata: { reason: why } });
    return { cheque: chqView(await loadCheque(orgId, id)), followUp: "Reverse or re-pay the expense in Finance; the original payment is linked on this cheque." };
  }
  if (["ISSUED", "CLEARED", "RETURNED", "VOIDED"].includes(q.status)) return fail("An issued cheque can't be voided. Mark it returned instead.", 409);
  const u = await c.findOneAndUpdate({ _id: q._id, status: q.status }, { $set: { status: "VOIDED", voidReason: why, updatedAt: now }, $unset: { opsKey2: "" }, $push: { history: { from: q.status, to: "VOIDED", by: actorEmail, at: now, reason: why } } }, { returnDocument: "after" });
  if (!u) return fail("The cheque changed at the same time. Reload.", 409);
  await c.updateOne({ _id: q.bookId }, { $push: { spoiled: { number: q.number, reason: `Voided: ${why}`, at: now, by: actorEmail } } });
  await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: "CHEQUE_VOIDED", previousState: q.status, newState: "VOIDED", metadata: { reason: why, number: q.number } });
  return { cheque: chqView(u) };
}
/** Clearing: link the bank statement line (AI Bookkeeper import). Suggests lines with the cheque number / amount. */
export async function reconcileCheque({ orgId, membership, actorEmail, id, bankTransactionId, suggestOnly = false }) {
  const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d;
  const q = await loadCheque(orgId, id); if (!q) return fail("Cheque not found.", 404);
  const { getBookkeeperCollections } = await import("../bookkeeper/db.js"); const bk = await getBookkeeperCollections();
  const coll = bk.bkTransactions || null; if (!coll) return fail("Bank statements aren't available yet. Import one in AI Bookkeeper first.", 409);
  const numText = String(q.number); const pad = String(q.number).padStart(6, "0");
  if (suggestOnly || !bankTransactionId) {
    const rows = await coll.find({ orgId: q.orgId, $or: [{ reference: { $in: [numText, pad] } }, { description: { $regex: `\\b(${numText}|${pad})\\b` } }, { amount: { $in: [q.amount, -q.amount] } }] }).limit(20).toArray();
    return { suggestions: rows.map((t) => ({ id: sid(t._id), date: t.date, amount: t.amount, reference: t.reference || null, description: t.description || "", matchesNumber: [numText, pad].includes(String(t.reference || "")) || new RegExp(`\\b(${numText}|${pad})\\b`).test(t.description || ""), matchesAmount: Math.abs(Math.abs(Number(t.amount)) - q.amount) < 0.005 })) };
  }
  if (!["ISSUED", "RETURNED"].includes(q.status)) return fail("Only an issued cheque can be cleared.", 409);
  const t = await coll.findOne({ _id: oid(bankTransactionId), orgId: q.orgId }); if (!t) return fail("Bank transaction not found.", 404);
  const diff = Math.round((Math.abs(Number(t.amount)) - q.amount) * 100) / 100;
  const c = await ccol(); const now = nowIso();
  await c.updateOne({ _id: q._id }, { $set: { status: "CLEARED", bankTransactionId: t._id, clearedAt: now, reconciliationDifference: diff, updatedAt: now }, $push: { history: { from: q.status, to: "CLEARED", by: actorEmail, at: now, difference: diff } } });
  await audit({ orgId, actorEmail, recordType: "CHEQUE", recordId: q._id, action: "CHEQUE_RECONCILED", previousState: q.status, newState: "CLEARED", metadata: { bankTransactionId: sid(t._id), difference: diff } });
  return { cheque: chqView(await loadCheque(orgId, id)), difference: diff, discrepancy: diff !== 0 };
}
export async function chequeReport({ orgId, membership }) {
  const d = await opsAccess({ orgId, membership, need: "finance" }); if (d) return d;
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: K.chq }).toArray();
  const by = (k) => rows.reduce((m, q) => { const key = q[k] || "—"; m[key] = m[key] || { count: 0, amount: 0 }; m[key].count++; m[key].amount = Math.round((m[key].amount + q.amount) * 100) / 100; return m; }, {});
  return { byStatus: by("status"), byBank: by("bankName"), byPayee: by("payee"), outstanding: rows.filter((q) => q.status === "ISSUED").map(chqView), discrepancies: rows.filter((q) => q.reconciliationDifference).map(chqView), pendingApproval: rows.filter((q) => q.status === "PENDING_APPROVAL").length };
}
