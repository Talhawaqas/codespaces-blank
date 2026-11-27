// src/lib/payroll/engine.js -- one employee's payslip for one month. PURE: the caller supplies the pay profile, the
// month's attendance figures (from clock-in timesheets and approved unpaid leave), loan instalments and year-to-date
// totals; this returns every line with its amount. Unit-tested in test/payroll.test.mjs.
import { statutory, PRESETS } from "./rules.js";
import { ZERO_DECIMAL_CURRENCIES } from "../currency.js";

const pos = (n) => Math.max(0, Number(n) || 0);
export function roundFor(currency) {
  const zero = ZERO_DECIMAL_CURRENCIES.includes(currency) || ["PKR", "KZT"].includes(currency);
  return (n) => (zero ? Math.round(Number(n) || 0) : Math.round((Number(n) || 0) * 100) / 100);
}

/** Month index (1..12) of `period` (YYYY-MM) inside a tax year that starts in `startMonth`. */
export function taxMonthIndex(period, startMonth = 1) {
  const m = Number(String(period).slice(5, 7)); return ((m - startMonth + 12) % 12) + 1;
}
/** First period (YYYY-MM) of the tax year containing `period`. */
export function taxYearStart(period, startMonth = 1) {
  const y = Number(String(period).slice(0, 4)); const m = Number(String(period).slice(5, 7));
  const sy = m >= startMonth ? y : y - 1; return `${sy}-${String(startMonth).padStart(2, "0")}`;
}

/**
 * @param p.settings    company payroll settings ({ country, currency, ...preset rule overrides })
 * @param p.profile     { basic, allowances:[{name,amount,taxable}], deductions:[{name,amount}], ...country fields }
 * @param p.period      "YYYY-MM"
 * @param p.attendance  { unpaidDays, overtimeHours, daysInPeriod }
 * @param p.loans       [{ id, name, installment, remaining }]
 * @param p.ytd         { taxable, tax, ssWages, medicareWages, futaWages }
 * @param p.adjustments [{ name, amount, type: "earning"|"deduction", taxable }]  one-off bonus / fine for this month
 */
export function computePayslip({ settings = {}, profile = {}, period, attendance = {}, loans = [], ytd = {}, adjustments = [] }) {
  const country = settings.country || "OTHER"; const preset = PRESETS[country] || PRESETS.OTHER;
  const s = { ...preset.defaults, ...settings }; const currency = s.currency || preset.currency; const R = roundFor(currency);
  const basic = pos(profile.basic);
  const earnings = [{ code: "BASIC", label: "Basic salary", amount: R(basic), taxable: true }];
  for (const a of profile.allowances || []) if (pos(a.amount) > 0) earnings.push({ code: "ALLOW", label: String(a.name || "Allowance").slice(0, 60), amount: R(a.amount), taxable: a.taxable !== false });
  const fixed = earnings.reduce((n, e) => n + e.amount, 0);
  const hourly = basic / (pos(s.standardMonthlyHours) || 173.33);
  const ot = pos(attendance.overtimeHours);
  if (ot > 0) earnings.push({ code: "OT", label: `Overtime (${Math.round(ot * 100) / 100} h x ${s.overtimeMultiplier})`, amount: R(ot * hourly * pos(s.overtimeMultiplier || 1)), taxable: true });
  for (const a of adjustments) if (a.type !== "deduction" && pos(a.amount) > 0) earnings.push({ code: "ADJ", label: String(a.name || "Bonus").slice(0, 60), amount: R(a.amount), taxable: a.taxable !== false });
  const days = pos(attendance.daysInPeriod) || 30; const unpaid = Math.min(pos(attendance.unpaidDays), days);
  const unpaidAmt = unpaid > 0 ? R((fixed / days) * unpaid) : 0;
  const grossRaw = earnings.reduce((n, e) => n + e.amount, 0) - unpaidAmt;
  const gross = R(pos(grossRaw));
  const taxableRaw = earnings.filter((e) => e.taxable).reduce((n, e) => n + e.amount, 0) - unpaidAmt;
  const taxableGross = R(pos(taxableRaw));
  const monthIndex = taxMonthIndex(period, preset.taxYearStartMonth);
  // Overtime and one-off bonuses are irregular: taxed in the month they're paid, never projected over the rest of the year.
  const oneOffTaxable = R(Math.min(taxableGross, earnings.filter((e) => e.taxable && (e.code === "OT" || e.code === "ADJ")).reduce((n, e) => n + e.amount, 0)));
  const stat = statutory({ country, settings: s, profile, gross, taxableGross, oneOffTaxable, basic: pos(basic - (basic / days) * unpaid), ytd, monthIndex, year: Number(String(period).slice(0, 4)) });
  const deductions = [];
  if (unpaidAmt > 0) deductions.push({ code: "UNPAID", label: `Unpaid leave (${unpaid} day${unpaid === 1 ? "" : "s"})`, amount: unpaidAmt, shownAsReduction: true });
  if (stat.tax > 0) deductions.push({ code: "TAX", label: country === "US" ? "Federal income tax" : "Income tax", amount: R(stat.tax) });
  for (const l of stat.employee) deductions.push({ ...l, amount: R(l.amount) });
  for (const d of profile.deductions || []) if (pos(d.amount) > 0) deductions.push({ code: "DED", label: String(d.name || "Deduction").slice(0, 60), amount: R(d.amount) });
  for (const a of adjustments) if (a.type === "deduction" && pos(a.amount) > 0) deductions.push({ code: "ADJ_D", label: String(a.name || "Deduction").slice(0, 60), amount: R(a.amount) });
  const loanLines = [];
  for (const l of loans) { const amt = R(Math.min(pos(l.installment), pos(l.remaining))); if (amt > 0) { deductions.push({ code: "LOAN", label: `Loan / advance: ${String(l.name || "repayment").slice(0, 40)}`, amount: amt, loanId: l.id }); loanLines.push({ loanId: l.id, amount: amt }); } }
  const totalDeductions = R(deductions.filter((d) => !d.shownAsReduction).reduce((n, d) => n + d.amount, 0));
  const net = R(gross - totalDeductions);
  const employer = stat.employer.map((l) => ({ ...l, amount: R(l.amount) }));
  const employerCost = R(employer.reduce((n, l) => n + l.amount, 0));
  const warnings = [];
  if (net < 0) warnings.push("Deductions are larger than pay this month: net pay is negative. Reduce a loan instalment or deduction.");
  return {
    period, country, currency, earnings, deductions, employer, gross, taxableGross, taxBase: R(stat.taxBase ?? taxableGross),
    tax: R(stat.tax), totalDeductions, net, employerCost, totalCost: R(gross + employerCost), loanLines,
    attendance: { unpaidDays: unpaid, overtimeHours: ot, daysInPeriod: days }, presetVersion: preset.version, warnings,
  };
}
