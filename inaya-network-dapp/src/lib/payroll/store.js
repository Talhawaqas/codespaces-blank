// src/lib/payroll/store.js -- Payroll (owner decisions 27 Nov 2026): Business + Enterprise, Professional add-on.
// Stored in `calendar_records` (production is at its collection limit), salary data sealed field-by-field:
//   p_settings  per company: country preset, currency, overrides, preset confirmation, WhatsApp template, accounts
//   p_profile   per employee: sealed pay profile (salary, allowances, deductions, bank, tax fields, payslip password)
//   p_loan      an advance/loan repaid by monthly instalments (sealed amounts, remaining tracked)
//   p_run       one month's payroll: DRAFT -> SUBMITTED -> APPROVED -> PAID (or CANCELLED); preparer != approver
//   p_slip      one employee's payslip in a run (sealed), published to the employee when the run is PAID
// Access: HR managers (or owners/admins) prepare; an owner/admin or finance manager who did NOT prepare the run
// approves. An employee sees only their own published payslips.
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { getOrgCollections, canManageHR, canManageOrg, toObjectId } from "../orgs.js";
import { ccol, oid, sid, clean, fail, nowIso } from "../commerce/store.js";
import { logOrgActivity } from "../org-activity-log.js";
import { planAllows, PLAN_GATE_PROJECTION, planGateMessage } from "../planGates.js";
import { isSupportedCurrency } from "../currency.js";
import { PRESETS, COUNTRIES, uaeGratuity } from "./rules.js";
import { computePayslip, taxYearStart } from "./engine.js";
import { payslipPdf, periodLabel } from "./pdf.js";

export const K = { settings: "p_settings", profile: "p_profile", loan: "p_loan", run: "p_run", slip: "p_slip" };
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------------------------------------------------------------- sealing (own key, or HKDF from the integration key)
let key = null;
function getKey() {
  if (key) return key;
  if (process.env.PAYROLL_DATA_KEY) { const k = Buffer.from(process.env.PAYROLL_DATA_KEY, "base64"); if (k.length !== 32) throw new Error("PAYROLL_DATA_KEY must decode to 32 bytes."); return (key = k); }
  const root = process.env.INTEGRATION_ENCRYPTION_KEY; if (!root) throw new Error("Payroll can't store salary data: no encryption key is configured.");
  return (key = Buffer.from(hkdfSync("sha256", Buffer.from(root, "base64"), Buffer.from("inaya-payroll"), Buffer.from("salary-data-v1"), 32)));
}
export function seal(value) {
  if (value === null || value === undefined) return null;
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return "pay1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function unseal(s) {
  if (!s) return null; if (!String(s).startsWith("pay1:")) throw new Error("Not a payroll sealed value.");
  const raw = Buffer.from(String(s).slice(5), "base64"); const d = createDecipheriv("aes-256-gcm", getKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}
export function _resetPayrollKey() { key = null; }

// ---------------------------------------------------------------- access
const isPreparer = (m) => canManageHR(m);
const isApprover = (m) => canManageOrg(m) || m?.financeRole === "manager";
async function org(orgId) { const { orgs } = await getOrgCollections(); return orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1, ...PLAN_GATE_PROJECTION } }); }
export async function entitled(orgId) { const o = await org(orgId); if (!o) return fail("Company not found.", 404); if (!planAllows(o, "payroll")) return { ...fail(planGateMessage(o, "payroll"), 403), code: "PLAN_UPGRADE_REQUIRED" }; return { ok: true, org: o }; }
async function audit(orgId, actorEmail, action, recordId, metadata = {}) { await logOrgActivity({ orgId: toObjectId(orgId), recordType: "PAYROLL", recordId: recordId ? toObjectId(String(recordId)) : null, actorEmail, action, previousState: null, newState: null, metadata }).catch(() => {}); }

// ---------------------------------------------------------------- settings
export async function getSettings(orgId) {
  const c = await ccol(); const s = await c.findOne({ orgId: oid(orgId), kind: K.settings });
  return s ? { ...s.settings, confirmed: s.confirmed || null } : null;
}
function cleanSettings(input = {}, prev = {}) {
  const country = COUNTRIES.includes(input.country) ? input.country : prev.country; if (!country) return fail("Choose the country your payroll follows.");
  const preset = PRESETS[country]; const currency = String(input.currency || prev.currency || preset.currency).toUpperCase();
  if (!isSupportedCurrency(currency)) return fail(`${currency} isn't a supported currency.`);
  const out = { ...preset.defaults, ...(prev.country === country ? prev : {}), country, currency };
  const num = (v, min = 0, max = 1e12) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : undefined; };
  for (const k of ["overtimeMultiplier", "standardMonthlyHours", "periodsPerYear", "flatTaxRate", "year"]) { const n = num(input[k]); if (n !== undefined) out[k] = n; }
  for (const k of ["futa", "itPark", "gratuityAccrual", "requireSecondApprover"]) if (typeof input[k] === "boolean") out[k] = input[k];
  for (const grp of ["eobi", "providentFund", "socialSecurity", "gpssa"]) if (input[grp] && typeof input[grp] === "object") { out[grp] = { ...(out[grp] || {}) }; for (const [k, v] of Object.entries(input[grp])) { if (typeof v === "boolean") out[grp][k] = v; else { const n = num(v); if (n !== undefined) out[grp][k] = n; } } }
  if (Array.isArray(input.contributions)) out.contributions = input.contributions.slice(0, 10).map((c) => ({ name: clean(c.name, 60), percent: num(c.percent, 0, 100) || 0, payer: c.payer === "employer" ? "employer" : "employee" })).filter((c) => c.name);
  if (input.whatsappTemplate !== undefined) out.whatsappTemplate = input.whatsappTemplate ? { name: clean(input.whatsappTemplate.name, 120).replace(/[^a-z0-9_]/g, ""), language: clean(input.whatsappTemplate.language || "en_US", 10) } : null;
  if (input.uae && typeof input.uae === "object") out.uae = { establishmentId: clean(input.uae.establishmentId, 20).replace(/\D/g, ""), routingCode: clean(input.uae.routingCode, 12).replace(/\D/g, "") };
  if (out.requireSecondApprover === undefined) out.requireSecondApprover = true;
  return { settings: out };
}
export async function saveSettings({ orgId, membership, actorEmail, input }) {
  if (!isPreparer(membership)) return fail("Only an HR manager or an owner/admin can change payroll settings.", 403);
  const ent = await entitled(orgId); if (ent.error) return ent;
  const prev = (await getSettings(orgId)) || {}; const r = cleanSettings(input, prev); if (r.error) return r;
  const changedCountry = prev.country && prev.country !== r.settings.country;
  const c = await ccol();
  await c.updateOne({ orgId: oid(orgId), kind: K.settings }, { $set: { settings: r.settings, updatedAt: nowIso(), updatedBy: actorEmail, ...(changedCountry ? { confirmed: null } : {}) }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  await audit(orgId, actorEmail, "PAYROLL_SETTINGS_UPDATED", null, { country: r.settings.country, currency: r.settings.currency });
  return { settings: await getSettings(orgId) };
}
/** The company reviews and confirms the preset (who, when, which version) before the first run. */
export async function confirmPreset({ orgId, membership, actorEmail }) {
  if (!isPreparer(membership)) return fail("Only an HR manager or an owner/admin can confirm the payroll rules.", 403);
  const s = await getSettings(orgId); if (!s) return fail("Save the payroll settings first.");
  const confirmed = { at: nowIso(), by: actorEmail, version: PRESETS[s.country].version };
  const c = await ccol(); await c.updateOne({ orgId: oid(orgId), kind: K.settings }, { $set: { confirmed } });
  await audit(orgId, actorEmail, "PAYROLL_RULES_CONFIRMED", null, confirmed);
  return { confirmed };
}
export function presetInfo() { return Object.values(PRESETS).map((p) => ({ country: p.country, name: p.name, currency: p.currency, version: p.version, checkedOn: p.checkedOn, source: p.source, notes: p.notes, defaults: p.defaults, taxYearStartMonth: p.taxYearStartMonth })); }

// ---------------------------------------------------------------- pay profiles
const PROFILE_FIELDS = ["basic", "allowances", "deductions", "bankName", "accountNumber", "iban", "routingCode", "w4", "statePercent", "uaeNational", "personId", "kzStandardDeduction", "kzBornBefore1975", "eobiExempt", "pfExempt", "whatsapp", "payslipEmail", "employeeRef"];
function cleanProfile(input = {}) {
  const p = {}; const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : undefined; };
  if (num(input.basic) === undefined) return fail("Enter the basic monthly salary.");
  p.basic = num(input.basic);
  p.allowances = (Array.isArray(input.allowances) ? input.allowances : []).slice(0, 20).map((a) => ({ name: clean(a.name, 60), amount: num(a.amount) || 0, taxable: a.taxable !== false })).filter((a) => a.name && a.amount > 0);
  p.deductions = (Array.isArray(input.deductions) ? input.deductions : []).slice(0, 20).map((a) => ({ name: clean(a.name, 60), amount: num(a.amount) || 0 })).filter((a) => a.name && a.amount > 0);
  for (const k of ["bankName", "accountNumber", "iban", "routingCode", "personId", "employeeRef"]) if (input[k] !== undefined) p[k] = clean(input[k], 64);
  if (input.whatsapp !== undefined) p.whatsapp = String(input.whatsapp || "").replace(/[^\d+]/g, "").slice(0, 20);
  if (input.payslipEmail !== undefined) p.payslipEmail = clean(input.payslipEmail, 120).toLowerCase();
  if (input.w4 && typeof input.w4 === "object") p.w4 = { filingStatus: ["single", "married", "head"].includes(input.w4.filingStatus) ? input.w4.filingStatus : "single", step2: !!input.w4.step2, credits: num(input.w4.credits) || 0, otherIncome: num(input.w4.otherIncome) || 0, deductions: num(input.w4.deductions) || 0, extraWithholding: num(input.w4.extraWithholding) || 0 };
  if (input.statePercent !== undefined) { const n = Number(input.statePercent); p.statePercent = Number.isFinite(n) && n >= 0 && n <= 20 ? n : 0; }
  for (const k of ["uaeNational", "kzStandardDeduction", "kzBornBefore1975", "eobiExempt", "pfExempt"]) if (input[k] !== undefined) p[k] = !!input[k];
  return { profile: p };
}
async function employeeOf(orgId, employeeId) { const { employees } = await getOrgCollections(); return employees.findOne({ _id: toObjectId(employeeId), orgId: toObjectId(orgId), deletedAt: null }); }
const empEmail = (e) => String(e?.memberEmail || e?.contactEmail || "").toLowerCase() || null;

export async function listProfiles({ orgId, membership }) {
  if (!isPreparer(membership) && !isApprover(membership)) return fail("Only payroll staff can see pay profiles.", 403);
  const { employees } = await getOrgCollections(); const c = await ccol();
  const emps = await employees.find({ orgId: toObjectId(orgId), deletedAt: null, employmentStatus: { $ne: "TERMINATED" } }).project({ fullName: 1, jobTitle: 1, memberEmail: 1, contactEmail: 1, employmentStatus: 1, departmentId: 1, joiningDate: 1 }).toArray();
  const profs = await c.find({ orgId: oid(orgId), kind: K.profile }).toArray(); const byEmp = new Map(profs.map((p) => [sid(p.employeeId), p]));
  return { employees: emps.map((e) => { const p = byEmp.get(sid(e._id)); const d = p ? unseal(p.data) : null; return { employeeId: sid(e._id), name: e.fullName, jobTitle: e.jobTitle || null, email: empEmail(e), status: e.employmentStatus, joiningDate: e.joiningDate || null, hasProfile: !!p, active: p ? p.active !== false : false, basic: d?.basic ?? null, hasPayslipPassword: !!d?.payslipPassword, hasWhatsapp: !!d?.whatsapp }; }) };
}
export async function getProfile({ orgId, membership, employeeId }) {
  if (!isPreparer(membership)) return fail("Only an HR manager or an owner/admin can see a pay profile.", 403);
  const c = await ccol(); const p = await c.findOne({ orgId: oid(orgId), kind: K.profile, employeeId: oid(employeeId) });
  if (!p) return { profile: null };
  const d = unseal(p.data); const { payslipPassword, ...rest } = d; return { profile: { ...rest, hasPayslipPassword: !!payslipPassword, active: p.active !== false } };
}
export async function saveProfile({ orgId, membership, actorEmail, employeeId, input }) {
  if (!isPreparer(membership)) return fail("Only an HR manager or an owner/admin can change pay.", 403);
  const ent = await entitled(orgId); if (ent.error) return ent;
  const e = await employeeOf(orgId, employeeId); if (!e) return fail("Employee not found.", 404);
  const r = cleanProfile(input); if (r.error) return r;
  const c = await ccol(); const prev = await c.findOne({ orgId: oid(orgId), kind: K.profile, employeeId: e._id });
  const old = prev ? unseal(prev.data) : {}; const data = { ...old, ...r.profile }; // keeps the employee's own payslip password
  await c.updateOne({ orgId: oid(orgId), kind: K.profile, employeeId: e._id }, { $set: { data: seal(data), email: empEmail(e), active: input.active !== false, updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  await audit(orgId, actorEmail, prev ? "PAYROLL_PROFILE_UPDATED" : "PAYROLL_PROFILE_CREATED", e._id, { employee: e.fullName, salaryChanged: prev ? old.basic !== data.basic : true });
  return { ok: true };
}
/** The employee sets their own payslip password (protects emailed/WhatsApp PDFs) and WhatsApp number. */
export async function setMyPayslipOptions({ orgId, membership, input }) {
  const me = String(membership.email).toLowerCase(); const c = await ccol();
  const p = await c.findOne({ orgId: oid(orgId), kind: K.profile, email: me }); if (!p) return fail("Your employer hasn't set up your pay profile yet.", 404);
  const d = unseal(p.data);
  if (input.payslipPassword !== undefined) { const pw = String(input.payslipPassword || ""); if (pw && (pw.length < 6 || pw.length > 64)) return fail("Choose a payslip password of 6 to 64 characters."); d.payslipPassword = pw || null; }
  if (input.whatsapp !== undefined) d.whatsapp = String(input.whatsapp || "").replace(/[^\d+]/g, "").slice(0, 20);
  await c.updateOne({ _id: p._id }, { $set: { data: seal(d), updatedAt: nowIso() } });
  await audit(orgId, me, "PAYSLIP_OPTIONS_CHANGED", p.employeeId, { password: input.payslipPassword !== undefined, whatsapp: input.whatsapp !== undefined });
  return { ok: true, hasPayslipPassword: !!d.payslipPassword, whatsapp: d.whatsapp || null };
}

// ---------------------------------------------------------------- loans / advances
export async function createLoan({ orgId, membership, actorEmail, employeeId, input }) {
  if (!isPreparer(membership)) return fail("Only an HR manager or an owner/admin can record a loan.", 403);
  const e = await employeeOf(orgId, employeeId); if (!e) return fail("Employee not found.", 404);
  const principal = Number(input.principal), inst = Number(input.installment);
  if (!(principal > 0) || !(inst > 0) || inst > principal) return fail("Enter the amount and a monthly instalment no larger than the amount.");
  const c = await ccol(); const doc = { orgId: oid(orgId), kind: K.loan, employeeId: e._id, name: clean(input.name || "Advance", 60), data: seal({ principal, installment: inst }), remaining: seal(principal), status: "ACTIVE", createdAt: nowIso(), createdBy: actorEmail };
  const r = await c.insertOne(doc); await audit(orgId, actorEmail, "PAYROLL_LOAN_CREATED", e._id, { employee: e.fullName });
  return { loanId: sid(r.insertedId) };
}
export async function listLoans({ orgId, membership, employeeId }) {
  if (!isPreparer(membership)) return fail("Only payroll staff can see loans.", 403);
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: K.loan, ...(employeeId ? { employeeId: oid(employeeId) } : {}) }).sort({ createdAt: -1 }).toArray();
  return { loans: rows.map((l) => ({ id: sid(l._id), employeeId: sid(l.employeeId), name: l.name, ...unseal(l.data), remaining: unseal(l.remaining), status: l.status, createdAt: l.createdAt })) };
}

// ---------------------------------------------------------------- attendance for a month
function monthRange(period) { const [y, m] = period.split("-").map(Number); const from = new Date(Date.UTC(y, m - 1, 1)); const to = new Date(Date.UTC(y, m, 0, 23, 59, 59)); return { from, to, days: new Date(Date.UTC(y, m, 0)).getUTCDate() }; }
async function attendanceFor(orgId, e, period, settings) {
  const { from, to, days } = monthRange(period); const { leaveRequests } = await getOrgCollections();
  const leaves = await leaveRequests.find({ orgId: toObjectId(orgId), employeeId: e._id, status: "APPROVED", startDate: { $lte: to.toISOString().slice(0, 10) }, endDate: { $gte: from.toISOString().slice(0, 10) } }).toArray();
  let unpaid = 0;
  for (const l of leaves) if (/unpaid|without pay|lwp|no pay/i.test(String(l.leaveType || ""))) { const s = new Date(Math.max(Date.parse(l.startDate), from.getTime())); const en = new Date(Math.min(Date.parse(l.endDate), to.getTime())); unpaid += Math.max(0, Math.round((en - s) / 86400000) + 1); }
  let overtime = 0; const email = empEmail(e);
  if (email) {
    try {
      const { computeTimesheet, getTimeSettings, K: WK } = await import("../workforce/time.js");
      const c = await ccol(); const punches = await c.find({ orgId: oid(orgId), kind: WK.punch, email, at: { $gte: from.toISOString(), $lte: to.toISOString() } }).toArray();
      if (punches.length) { const ts = computeTimesheet(punches, [], await getTimeSettings(orgId)); const weekly = (await getTimeSettings(orgId)).weeklyOvertimeHours || 48; const weeks = new Map(); for (const d of ts.days) { const dt = new Date(d.date + "T00:00:00Z"); const wk = `${dt.getUTCFullYear()}-${Math.floor((dt - Date.UTC(dt.getUTCFullYear(), 0, 1)) / 604800000)}`; weeks.set(wk, (weeks.get(wk) || 0) + d.workedHours); } for (const h of weeks.values()) overtime += Math.max(0, h - weekly); }
    } catch { /* no clock-in data: overtime 0 */ }
  }
  return { unpaidDays: Math.min(unpaid, days), overtimeHours: Math.round(overtime * 100) / 100, daysInPeriod: settings.workingDaysBasis || 30 };
}
async function ytdFor(orgId, employeeId, period, settings) {
  const start = taxYearStart(period, PRESETS[settings.country].taxYearStartMonth); const c = await ccol();
  const slips = await c.find({ orgId: oid(orgId), kind: K.slip, employeeId: oid(employeeId), status: "PAID", period: { $gte: start, $lt: period } }).toArray();
  const y = { taxable: 0, tax: 0, ssWages: 0, medicareWages: 0, futaWages: 0 };
  for (const s of slips) { const d = unseal(s.data); y.taxable += d.taxBase ?? d.taxableGross; y.tax += d.tax; y.ssWages += d.gross; y.medicareWages += d.gross; y.futaWages += d.gross; }
  return y;
}
function serviceYears(e, period) { const j = Date.parse(e.joiningDate || ""); if (!Number.isFinite(j)) return 0; return Math.max(0, (Date.parse(period + "-28") - j) / (365.25 * 86400000)); }

// ---------------------------------------------------------------- runs
const runView = (r) => ({ id: sid(r._id), period: r.period, status: r.status, preparedBy: r.preparedBy, submittedBy: r.submittedBy || null, approvedBy: r.approvedBy || null, paidAt: r.paidAt || null, paidBy: r.paidBy || null, createdAt: r.createdAt, totals: r.totals ? unseal(r.totals) : null, employees: r.count || 0, warnings: r.warnings || [], ledgerEntryId: r.ledgerEntryId || null, cancelledReason: r.cancelledReason || null });
export async function listRuns({ orgId, membership }) {
  if (!isPreparer(membership) && !isApprover(membership)) return fail("Only payroll staff can see payroll runs.", 403);
  const c = await ccol(); return { runs: (await c.find({ orgId: oid(orgId), kind: K.run }).sort({ period: -1, createdAt: -1 }).limit(48).toArray()).map(runView) };
}
async function buildSlips(orgId, run, settings, adjustments = {}) {
  const c = await ccol(); const { employees } = await getOrgCollections(); const o = await org(orgId);
  const profs = await c.find({ orgId: oid(orgId), kind: K.profile, active: { $ne: false } }).toArray();
  const out = []; const warnings = [];
  for (const p of profs) {
    const e = await employees.findOne({ _id: p.employeeId, orgId: toObjectId(orgId), deletedAt: null }); if (!e || e.employmentStatus === "TERMINATED") continue;
    const prof = { ...unseal(p.data), serviceYears: serviceYears(e, run.period) };
    const loans = (await c.find({ orgId: oid(orgId), kind: K.loan, employeeId: e._id, status: "ACTIVE" }).toArray()).map((l) => ({ id: sid(l._id), name: l.name, installment: unseal(l.data).installment, remaining: unseal(l.remaining) }));
    const slip = computePayslip({ settings, profile: prof, period: run.period, attendance: await attendanceFor(orgId, e, run.period, settings), loans, ytd: await ytdFor(orgId, e._id, run.period, settings), adjustments: adjustments[sid(e._id)] || [] });
    for (const w of slip.warnings) warnings.push(`${e.fullName}: ${w}`);
    out.push({ employeeId: e._id, email: empEmail(e), slip: { ...slip, employeeName: e.fullName, employeeRef: prof.employeeRef || sid(e._id).slice(-6).toUpperCase(), jobTitle: e.jobTitle || null, companyName: o?.name || "" }, bank: { name: prof.bankName || null, account: prof.accountNumber || null, iban: prof.iban || null, routing: prof.routingCode || null, personId: prof.personId || null } });
  }
  return { slips: out, warnings };
}
function totalsOf(slips) { const t = { gross: 0, net: 0, tax: 0, deductions: 0, employerCost: 0, totalCost: 0 }; for (const { slip: s } of slips) { t.gross += s.gross; t.net += s.net; t.tax += s.tax; t.deductions += s.totalDeductions; t.employerCost += s.employerCost; t.totalCost += s.totalCost; } for (const k in t) t[k] = Math.round(t[k] * 100) / 100; return t; }
async function writeSlips(orgId, runId, period, built) {
  const c = await ccol(); await c.deleteMany({ orgId: oid(orgId), kind: K.slip, runId, status: "DRAFT" });
  if (built.length) await c.insertMany(built.map((b) => ({ orgId: oid(orgId), kind: K.slip, runId, period, employeeId: b.employeeId, email: b.email, status: "DRAFT", data: seal(b.slip), bank: seal(b.bank), createdAt: nowIso() })));
}
export async function createRun({ orgId, membership, actorEmail, period, adjustments }) {
  if (!isPreparer(membership)) return fail("Only an HR manager or an owner/admin can prepare payroll.", 403);
  const ent = await entitled(orgId); if (ent.error) return ent;
  if (!PERIOD.test(String(period))) return fail("Choose the month (YYYY-MM).");
  const settings = await getSettings(orgId); if (!settings) return fail("Set up payroll first: choose the country and currency.");
  if (!settings.confirmed || settings.confirmed.version !== PRESETS[settings.country].version) return fail("Review and confirm the payroll rules for your country before the first run (Payroll > Settings).", 409, "RULES_NOT_CONFIRMED");
  const c = await ccol();
  if (await c.findOne({ orgId: oid(orgId), kind: K.run, period, status: { $ne: "CANCELLED" } })) return fail(`There is already a payroll for ${periodLabel(period)}. Open it, or cancel it first.`, 409);
  const ins = await c.insertOne({ orgId: oid(orgId), kind: K.run, period, status: "DRAFT", preparedBy: actorEmail, createdAt: nowIso(), adjustments: seal(adjustments || {}) });
  const built = await buildSlips(orgId, { period }, settings, adjustments || {});
  if (!built.slips.length) { await c.deleteOne({ _id: ins.insertedId }); return fail("No employee has a pay profile yet. Add salaries under Payroll > Employees."); }
  await writeSlips(orgId, ins.insertedId, period, built.slips);
  await c.updateOne({ _id: ins.insertedId }, { $set: { totals: seal(totalsOf(built.slips)), count: built.slips.length, warnings: built.warnings.slice(0, 50), currency: settings.currency } });
  await audit(orgId, actorEmail, "PAYROLL_RUN_CREATED", ins.insertedId, { period, employees: built.slips.length });
  return { run: runView(await c.findOne({ _id: ins.insertedId })) };
}
async function runOf(orgId, runId) { const c = await ccol(); return c.findOne({ _id: oid(runId), orgId: oid(orgId), kind: K.run }); }
export async function recalcRun({ orgId, membership, actorEmail, runId, adjustments }) {
  if (!isPreparer(membership)) return fail("Only an HR manager or an owner/admin can change payroll.", 403);
  const r = await runOf(orgId, runId); if (!r) return fail("Payroll run not found.", 404); if (r.status !== "DRAFT") return fail("Only a draft payroll can be recalculated. Send it back to draft first.", 409);
  const settings = await getSettings(orgId); const adj = adjustments ?? unseal(r.adjustments) ?? {};
  const built = await buildSlips(orgId, r, settings, adj); await writeSlips(orgId, r._id, r.period, built.slips);
  const c = await ccol(); await c.updateOne({ _id: r._id }, { $set: { adjustments: seal(adj), totals: seal(totalsOf(built.slips)), count: built.slips.length, warnings: built.warnings.slice(0, 50), preparedBy: actorEmail, updatedAt: nowIso() } });
  await audit(orgId, actorEmail, "PAYROLL_RUN_RECALCULATED", r._id, { period: r.period });
  return { run: runView(await runOf(orgId, runId)) };
}
export async function getRun({ orgId, membership, runId }) {
  if (!isPreparer(membership) && !isApprover(membership)) return fail("Only payroll staff can open a payroll run.", 403);
  const r = await runOf(orgId, runId); if (!r) return fail("Payroll run not found.", 404);
  const c = await ccol(); const slips = await c.find({ orgId: oid(orgId), kind: K.slip, runId: r._id }).toArray();
  return { run: runView(r), adjustments: unseal(r.adjustments) || {}, slips: slips.map((s) => ({ id: sid(s._id), employeeId: sid(s.employeeId), email: s.email, status: s.status, delivery: s.delivery || {}, ...unseal(s.data) })) };
}
export async function transitionRun({ orgId, membership, actorEmail, runId, action, reason }) {
  const r = await runOf(orgId, runId); if (!r) return fail("Payroll run not found.", 404);
  const settings = await getSettings(orgId); const c = await ccol(); const set = { updatedAt: nowIso() };
  if (action === "submit") { if (!isPreparer(membership)) return fail("Only payroll staff can submit.", 403); if (r.status !== "DRAFT") return fail("Only a draft can be submitted.", 409); Object.assign(set, { status: "SUBMITTED", submittedBy: actorEmail, submittedAt: nowIso() }); }
  else if (action === "reopen") { if (!isPreparer(membership) && !isApprover(membership)) return fail("Not allowed.", 403); if (!["SUBMITTED", "APPROVED"].includes(r.status)) return fail("Only a submitted or approved payroll can go back to draft.", 409); Object.assign(set, { status: "DRAFT", approvedBy: null, approvedAt: null }); }
  else if (action === "approve") {
    if (!isApprover(membership)) return fail("Only an owner/admin or a finance manager can approve payroll.", 403);
    if (r.status !== "SUBMITTED") return fail("Submit the payroll before approving it.", 409);
    if (settings.requireSecondApprover !== false && [r.preparedBy, r.submittedBy].map((x) => String(x || "").toLowerCase()).includes(String(actorEmail).toLowerCase())) return fail("Someone other than the person who prepared this payroll must approve it.", 409, "SAME_PERSON");
    Object.assign(set, { status: "APPROVED", approvedBy: actorEmail, approvedAt: nowIso() });
  } else if (action === "cancel") { if (!isPreparer(membership)) return fail("Not allowed.", 403); if (r.status === "PAID") return fail("A paid payroll can't be cancelled.", 409); Object.assign(set, { status: "CANCELLED", cancelledReason: clean(reason, 300) || null, cancelledBy: actorEmail }); await c.deleteMany({ orgId: oid(orgId), kind: K.slip, runId: r._id }); }
  else if (action === "pay") return markPaid({ orgId, membership, actorEmail, run: r, settings });
  else return fail("Unknown action.");
  const u = await c.updateOne({ _id: r._id, status: r.status }, { $set: set }); if (!u.modifiedCount) return fail("Someone else changed this payroll; reload it.", 409);
  await audit(orgId, actorEmail, `PAYROLL_RUN_${action.toUpperCase()}`, r._id, { period: r.period });
  return { run: runView(await runOf(orgId, runId)) };
}

const ACC = { SAL: { code: "5100", name: "Salaries & Wages", type: "EXPENSE" }, ER: { code: "5110", name: "Employer Payroll Contributions", type: "EXPENSE" }, LIAB: { code: "2400", name: "Payroll Taxes & Deductions Payable", type: "LIABILITY" }, LOAN: { code: "1300", name: "Employee Loans & Advances", type: "ASSET" } };
async function markPaid({ orgId, membership, actorEmail, run, settings }) {
  if (!isApprover(membership)) return fail("Only an owner/admin or a finance manager can mark payroll as paid.", 403);
  if (run.status !== "APPROVED") return fail("Approve the payroll before marking it paid.", 409);
  const c = await ccol(); const claim = await c.updateOne({ _id: run._id, status: "APPROVED" }, { $set: { status: "PAYING" } }); if (!claim.modifiedCount) return fail("This payroll is already being paid.", 409);
  const slips = await c.find({ orgId: oid(orgId), kind: K.slip, runId: run._id }).toArray(); const t = unseal(run.totals);
  let loanTotal = 0;
  for (const s of slips) { const d = unseal(s.data); for (const l of d.loanLines || []) { const loan = await c.findOne({ _id: oid(l.loanId), orgId: oid(orgId), kind: K.loan }); if (!loan) continue; const rem = Math.max(0, Math.round((unseal(loan.remaining) - l.amount) * 100) / 100); loanTotal += l.amount; await c.updateOne({ _id: loan._id }, { $set: { remaining: seal(rem), status: rem <= 0 ? "REPAID" : "ACTIVE" } }); } }
  let ledgerEntryId = null;
  try {
    const L = await import("../ledger.js"); const accounts = await L.listAccounts(orgId); const have = new Set(accounts.map((a) => a.code));
    for (const a of Object.values(ACC)) if (!have.has(a.code)) await L.createAccount({ orgId, ...a, actorEmail: "system:payroll" });
    const liab = Math.round((t.deductions - loanTotal + t.employerCost) * 100) / 100;
    const lines = [{ accountCode: ACC.SAL.code, debit: t.gross, memo: "Gross pay" }];
    if (t.employerCost > 0) lines.push({ accountCode: ACC.ER.code, debit: t.employerCost, memo: "Employer contributions" });
    lines.push({ accountCode: L.ACCOUNTS.CASH, credit: t.net, memo: "Net pay" });
    if (liab > 0) lines.push({ accountCode: ACC.LIAB.code, credit: liab, memo: "Tax and contributions to pay" });
    if (loanTotal > 0) lines.push({ accountCode: ACC.LOAN.code, credit: Math.round(loanTotal * 100) / 100, memo: "Loan repayments" });
    const pe = await L.postEntry({ orgId, date: nowIso(), memo: `Payroll ${periodLabel(run.period)}`, lines, source: { type: "payroll", id: sid(run._id), event: "paid" }, actorEmail });
    if (pe.entry) ledgerEntryId = sid(pe.entry._id);
  } catch (e) { console.error("payroll ledger post failed (payroll still paid):", e.message); }
  await c.updateMany({ orgId: oid(orgId), kind: K.slip, runId: run._id }, { $set: { status: "PAID", publishedAt: nowIso() } });
  await c.updateOne({ _id: run._id }, { $set: { status: "PAID", paidAt: nowIso(), paidBy: actorEmail, ledgerEntryId } });
  await audit(orgId, actorEmail, "PAYROLL_RUN_PAID", run._id, { period: run.period, employees: slips.length, ledgerEntryId });
  return { run: runView(await runOf(orgId, sid(run._id))) };
}

// ---------------------------------------------------------------- bank files
export async function bankFile({ orgId, membership, runId, format = "csv" }) {
  if (!isApprover(membership) && !isPreparer(membership)) return fail("Not allowed.", 403);
  const r = await runOf(orgId, runId); if (!r) return fail("Payroll run not found.", 404); if (!["APPROVED", "PAID"].includes(r.status)) return fail("Approve the payroll first.", 409);
  const c = await ccol(); const slips = await c.find({ orgId: oid(orgId), kind: K.slip, runId: r._id }).toArray(); const settings = await getSettings(orgId);
  const rows = slips.map((s) => ({ d: unseal(s.data), b: unseal(s.bank) || {} }));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  if (format === "wps") {
    const u = settings.uae || {}; if (!u.establishmentId || !u.routingCode) return fail("Add your MOHRE establishment ID and your bank/agent routing code in Payroll > Settings first.");
    const [y, m] = r.period.split("-"); const end = new Date(Date.UTC(+y, +m, 0)).toISOString().slice(0, 10); const start = `${y}-${m}-01`;
    const missing = rows.filter(({ b }) => !b.personId || !b.iban).map(({ d }) => d.employeeName); if (missing.length) return fail(`Add the labour person ID and IBAN for: ${missing.slice(0, 10).join(", ")}.`);
    const lines = rows.map(({ d, b }) => ["EDR", b.personId.padStart(14, "0"), (b.routing || u.routingCode).padStart(9, "0"), b.iban, start, end, String(d.attendance.daysInPeriod), (d.net).toFixed(2), "0.00", String(d.attendance.unpaidDays || 0)].join(","));
    const now = new Date(); const total = rows.reduce((n, { d }) => n + d.net, 0);
    lines.push(["SCR", u.establishmentId.padStart(13, "0"), u.routingCode.padStart(9, "0"), now.toISOString().slice(0, 10), `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`, `${m}${y}`, String(rows.length), total.toFixed(2), "AED", `PAYROLL${y}${m}`].join(","));
    return { filename: `${u.establishmentId}${now.toISOString().slice(2, 10).replace(/-/g, "")}${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}.SIF`, content: lines.join("\n") + "\n", contentType: "text/plain" };
  }
  const lines = [["employee", "employee_id", "bank", "account_number", "iban", "routing_code", "amount", "currency", "reference"].join(",")];
  for (const { d, b } of rows) lines.push([q(d.employeeName), q(d.employeeRef), q(b.name), q(b.account), q(b.iban), q(b.routing), d.net.toFixed(2), d.currency, q(`Salary ${periodLabel(r.period)}`)].join(","));
  return { filename: `payroll-${r.period}.csv`, content: lines.join("\n") + "\n", contentType: "text/csv" };
}

// ---------------------------------------------------------------- payslips (employee side + delivery)
async function slipFor(orgId, membership, slipId) {
  const c = await ccol(); const s = await c.findOne({ _id: oid(slipId), orgId: oid(orgId), kind: K.slip }); if (!s) return fail("Payslip not found.", 404);
  const own = s.email && s.email === String(membership.email).toLowerCase();
  if (!own && !isPreparer(membership) && !isApprover(membership)) return fail("You can only see your own payslips.", 403);
  if (own && !isPreparer(membership) && s.status !== "PAID") return fail("This payslip isn't published yet.", 404);
  return { s, d: unseal(s.data), own };
}
export async function myPayslips({ orgId, membership }) {
  const c = await ccol(); const me = String(membership.email).toLowerCase();
  const rows = await c.find({ orgId: oid(orgId), kind: K.slip, email: me, status: "PAID" }).sort({ period: -1 }).limit(36).toArray();
  const p = await c.findOne({ orgId: oid(orgId), kind: K.profile, email: me }); const d = p ? unseal(p.data) : null;
  return { payslips: rows.map((s) => { const x = unseal(s.data); return { id: sid(s._id), period: s.period, net: x.net, gross: x.gross, currency: x.currency }; }), options: d ? { hasPayslipPassword: !!d.payslipPassword, whatsapp: d.whatsapp || null } : null };
}
export async function getPayslip({ orgId, membership, slipId }) {
  const r = await slipFor(orgId, membership, slipId); if (r.error) return r;
  if (r.own) { const c = await ccol(); await c.updateOne({ _id: r.s._id, viewedAt: { $exists: false } }, { $set: { viewedAt: nowIso() } }); }
  return { payslip: { id: sid(r.s._id), status: r.s.status, ...r.d } };
}
/** In-app download: the signed-in person's own copy (no password needed: they are already signed in). */
export async function payslipDownload({ orgId, membership, slipId }) {
  const r = await slipFor(orgId, membership, slipId); if (r.error) return r;
  await audit(orgId, membership.email, "PAYSLIP_DOWNLOADED", r.s.employeeId, { period: r.s.period, own: r.own });
  return { filename: `payslip-${r.s.period}.pdf`, buffer: await payslipPdf(r.d) };
}
async function passwordFor(orgId, employeeId) { const c = await ccol(); const p = await c.findOne({ orgId: oid(orgId), kind: K.profile, employeeId }); const d = p ? unseal(p.data) : {}; return { password: d.payslipPassword || null, whatsapp: d.whatsapp || null, email: d.payslipEmail || p?.email || null }; }

/** Sends every published payslip in a run by email and/or WhatsApp. A payslip goes out as a PDF only when the employee
 *  has set a payslip password (the PDF is encrypted with it); otherwise the email says the payslip is in the app. */
export async function deliverRun({ orgId, membership, actorEmail, runId, channels = ["email"] }) {
  if (!isPreparer(membership) && !isApprover(membership)) return fail("Only payroll staff can send payslips.", 403);
  const r = await runOf(orgId, runId); if (!r) return fail("Payroll run not found.", 404); if (r.status !== "PAID") return fail("Payslips go out once the payroll is marked paid.", 409);
  const c = await ccol(); const slips = await c.find({ orgId: oid(orgId), kind: K.slip, runId: r._id }).toArray(); const settings = await getSettings(orgId);
  const o = await org(orgId); const app = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.inayanetwork.com").replace(/\/$/, "") + "/business";
  const result = { email: { sent: 0, noticeOnly: 0, failed: 0, skipped: 0 }, whatsapp: { sent: 0, failed: 0, skipped: 0, errors: [] } };
  let conn = null;
  if (channels.includes("whatsapp")) {
    const { connectEntitled } = await import("../connect/core.js"); const { getConnection } = await import("../connect/connection.js");
    if (!(await connectEntitled(orgId))) return fail("WhatsApp payslips need Inaya Connect (Business or Enterprise).", 403);
    conn = await getConnection(orgId); if (!conn) return fail("Connect your WhatsApp Business number in Inaya Connect first.", 409);
    if (!settings.whatsappTemplate?.name) return fail("Add your approved WhatsApp payslip template (with a DOCUMENT header) in Payroll > Settings first.", 409);
  }
  for (const s of slips) {
    const d = unseal(s.data); const who = await passwordFor(orgId, s.employeeId); const label = periodLabel(s.period); const delivery = { ...(s.delivery || {}) };
    if (channels.includes("email")) {
      if (!who.email) result.email.skipped++;
      else {
        try {
          const { sendEmail } = await import("../email.js");
          if (who.password) {
            const pdf = await payslipPdf(d, { password: who.password });
            const sent = await sendEmail({ to: who.email, subject: `Your payslip for ${label} - ${o?.name || ""}`, text: `Your payslip for ${label} is attached. Open it with your payslip password (the one you chose in Inaya). You can also see it in Inaya: ${app}`, html: `<p>Your payslip for <b>${label}</b> is attached.</p><p>Open it with <b>your payslip password</b> (the one you chose in Inaya).</p><p>You can also see and download it in Inaya: <a href="${app}">${app}</a></p>`, attachments: [{ filename: `payslip-${s.period}.pdf`, content: pdf.toString("base64") }] });
            if (!sent?.sent) throw new Error(sent?.reason || "not sent");
            result.email.sent++; delivery.email = { at: nowIso(), pdf: true };
          } else {
            const sent = await sendEmail({ to: who.email, subject: `Your payslip for ${label} is ready - ${o?.name || ""}`, text: `Your payslip for ${label} is ready in Inaya: ${app}. Set a payslip password in Inaya (My payslips) to receive it as a protected PDF.`, html: `<p>Your payslip for <b>${label}</b> is ready in Inaya: <a href="${app}">${app}</a>.</p><p>Set a payslip password in Inaya (My payslips) to receive future payslips as a password-protected PDF.</p>` });
            if (!sent?.sent) throw new Error(sent?.reason || "not sent");
            result.email.noticeOnly++; delivery.email = { at: nowIso(), pdf: false };
          }
        } catch { result.email.failed++; }
      }
    }
    if (channels.includes("whatsapp")) {
      if (!who.whatsapp || !who.password) { result.whatsapp.skipped++; }
      else {
        try {
          const g = await import("../connect/graph.js"); const pdf = await payslipPdf(d, { password: who.password });
          const { mediaId } = await g.uploadMedia(conn, pdf, "application/pdf", `payslip-${s.period}.pdf`);
          const sent = await g.sendDocumentTemplate(conn, who.whatsapp, settings.whatsappTemplate.name, settings.whatsappTemplate.language, mediaId, `payslip-${s.period}.pdf`, [d.employeeName, label]);
          result.whatsapp.sent++; delivery.whatsapp = { at: nowIso(), waMessageId: sent.waMessageId || null };
          const { bumpUsage } = await import("../connect/messages.js"); await bumpUsage(orgId, "outbound").catch(() => {}); await bumpUsage(orgId, "out_utility").catch(() => {});
        } catch (e) { result.whatsapp.failed++; if (result.whatsapp.errors.length < 5) result.whatsapp.errors.push(`${d.employeeName}: ${String(e.message).slice(0, 160)}`); }
      }
    }
    await c.updateOne({ _id: s._id }, { $set: { delivery } });
  }
  await audit(orgId, actorEmail, "PAYSLIPS_SENT", r._id, { period: r.period, channels, email: result.email, whatsapp: { sent: result.whatsapp.sent, failed: result.whatsapp.failed, skipped: result.whatsapp.skipped } });
  return result;
}

// ---------------------------------------------------------------- UAE final settlement helper
export async function gratuityEstimate({ orgId, membership, employeeId, lastDay }) {
  if (!isPreparer(membership)) return fail("Only payroll staff can calculate gratuity.", 403);
  const e = await employeeOf(orgId, employeeId); if (!e) return fail("Employee not found.", 404);
  const c = await ccol(); const p = await c.findOne({ orgId: oid(orgId), kind: K.profile, employeeId: e._id }); if (!p) return fail("No pay profile.", 404);
  const d = unseal(p.data); const end = Date.parse(lastDay || nowIso()); const years = Math.max(0, (end - Date.parse(e.joiningDate)) / (365.25 * 86400000));
  return { employee: e.fullName, years: Math.round(years * 100) / 100, basicMonthly: d.basic, gratuity: uaeGratuity({ basicMonthly: d.basic, years }), note: "Decree-Law 33 of 2021: 21 days' basic wage per year for the first 5 years, 30 days after, capped at 2 years' wages; under 1 year of service: none. Unpaid leave days may reduce service: check before paying." };
}
