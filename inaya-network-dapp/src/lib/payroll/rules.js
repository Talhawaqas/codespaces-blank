// src/lib/payroll/rules.js -- Payroll country presets and pure tax/contribution maths (owner decision 27 Nov 2026:
// engine + presets for Pakistan, UAE, US and Central Asia). Everything here is PURE (no database) so it is unit-tested
// against worked examples. Each preset names its source and the date it was checked; a company must review and confirm
// a preset before its first payroll run, and can override every rate. Inaya calculates; it never files taxes.
//
// Money is in the company's payroll currency, monthly unless stated.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pos = (n) => Math.max(0, Number(n) || 0);

/** Annual tax from a slab table [{ over, fixed, rate }] (rows sorted by `over`). */
export function slabTax(income, slabs) {
  const x = pos(income); let row = slabs[0];
  for (const s of slabs) if (x > s.over) row = s;
  return r2(row.fixed + (x - row.over) * row.rate);
}

// ---------------------------------------------------------------- Pakistan
// Salaried individuals, tax year 2027 (1 Jul 2026 - 30 Jun 2027), Finance Act 2026 (First Schedule, ITO 2001). No
// surcharge for salaried persons in TY2027. Fixed amounts checked for internal consistency.
export const PK_SLABS_TY2027 = [
  { over: 0, fixed: 0, rate: 0 },
  { over: 600000, fixed: 0, rate: 0.01 },
  { over: 1200000, fixed: 6000, rate: 0.11 },
  { over: 2200000, fixed: 116000, rate: 0.20 },
  { over: 3200000, fixed: 316000, rate: 0.25 },
  { over: 4100000, fixed: 541000, rate: 0.29 },
  { over: 5600000, fixed: 976000, rate: 0.32 },
  { over: 7000000, fixed: 1424000, rate: 0.35 },
];

// ---------------------------------------------------------------- United States (federal)
// IRS Publication 15-T (2026), percentage method, annual STANDARD schedules (Form W-4 2020 or later, Step 2 unchecked).
export const US_SCHEDULES_2026 = {
  married: [{ over: 0, fixed: 0, rate: 0 }, { over: 19300, fixed: 0, rate: 0.10 }, { over: 44100, fixed: 2480, rate: 0.12 }, { over: 120100, fixed: 11600, rate: 0.22 }, { over: 230700, fixed: 35932, rate: 0.24 }, { over: 422850, fixed: 82048, rate: 0.32 }, { over: 531750, fixed: 116896, rate: 0.35 }, { over: 788000, fixed: 206583.5, rate: 0.37 }],
  single: [{ over: 0, fixed: 0, rate: 0 }, { over: 7500, fixed: 0, rate: 0.10 }, { over: 19900, fixed: 1240, rate: 0.12 }, { over: 57900, fixed: 5800, rate: 0.22 }, { over: 113200, fixed: 17966, rate: 0.24 }, { over: 209275, fixed: 41024, rate: 0.32 }, { over: 263725, fixed: 58448, rate: 0.35 }, { over: 648100, fixed: 192979.25, rate: 0.37 }],
  head: [{ over: 0, fixed: 0, rate: 0 }, { over: 15550, fixed: 0, rate: 0.10 }, { over: 33250, fixed: 1770, rate: 0.12 }, { over: 83000, fixed: 7740, rate: 0.22 }, { over: 121250, fixed: 16155, rate: 0.24 }, { over: 217300, fixed: 39207, rate: 0.32 }, { over: 271750, fixed: 56631, rate: 0.35 }, { over: 656150, fixed: 191171, rate: 0.37 }],
};
export const US_2026 = { line1g: { married: 12900, other: 8600 }, ssWageBase: 184500, ssRate: 0.062, medicareRate: 0.0145, addlMedicareRate: 0.009, addlMedicareOver: 200000, futaRate: 0.006, futaWageBase: 7000 };

/** Federal income tax withholding for one pay period (Publication 15-T Worksheet 1A, W-4 2020+). */
export function usFederalWithholding({ wages, periodsPerYear = 12, w4 = {} }) {
  const status = w4.filingStatus === "married" ? "married" : w4.filingStatus === "head" ? "head" : "single";
  const annual = pos(wages) * periodsPerYear + pos(w4.otherIncome); // 1c + 1d
  const adj = pos(w4.deductions) + (w4.step2 ? 0 : US_2026.line1g[status === "married" ? "married" : "other"]); // 1f + 1g
  const adjusted = pos(annual - adj);
  const schedules = w4.step2 ? null : US_SCHEDULES_2026[status];
  // Step 2 checked: Publication 15-T uses separate schedules; we approximate with half the standard thresholds, stated in the UI.
  const tentativeAnnual = schedules ? slabTax(adjusted, schedules) : slabTax(adjusted, US_SCHEDULES_2026[status].map((s) => ({ over: s.over / 2, fixed: s.fixed / 2, rate: s.rate })));
  const perPeriod = tentativeAnnual / periodsPerYear;
  const afterCredits = pos(perPeriod - pos(w4.credits) / periodsPerYear);
  return r2(afterCredits + pos(w4.extraWithholding));
}

// ---------------------------------------------------------------- Kazakhstan (2026 Tax Code)
export const KZ_2026 = { mci: 4325, mzp: 85000, iitLowRate: 0.10, iitHighRate: 0.15, iitThresholdMci: 8500, stdDeductionMci: 30, opv: 0.10, opvCapMzp: 50, vosms: 0.02, vosmsCapMzp: 20, opvr: 0.035, so: 0.05, soMinMzp: 1, soMaxMzp: 7, oosms: 0.03, oosmsCapMzp: 40, socialTax: 0.06, socialTaxMinMci: 14 };

// ---------------------------------------------------------------- Azerbaijan (private non-oil sector, 2026)
export const AZ_2026 = { lowBandRate: { 2026: 0.03, 2027: 0.05, default: 0.07 } };
export function azIncomeTax(gross, year = 2026) {
  const g = pos(gross); const low = AZ_2026.lowBandRate[year] ?? AZ_2026.lowBandRate.default;
  if (g <= 2500) return r2(low * pos(g - 200));
  if (g <= 8000) return r2(low * 2500 + 0.10 * (g - 2500));
  return r2(low * 2500 + 0.10 * 5500 + 0.14 * (g - 8000));
}
export function azSocial(gross) {
  const g = pos(gross);
  const employee = g <= 200 ? 0.03 * g : g <= 8000 ? 6 + 0.10 * (g - 200) : 786 + 0.10 * (g - 8000);
  const employer = g <= 200 ? 0.22 * g : g <= 8000 ? 44 + 0.15 * (g - 200) : 1214 + 0.11 * (g - 8000);
  const health = g <= 2500 ? 0.02 * g : 50 + 0.005 * (g - 2500);
  return { employee: r2(employee), employer: r2(employer), unemploymentEach: r2(0.005 * g), healthEach: r2(health) };
}

// ---------------------------------------------------------------- presets
export const PRESETS = {
  PK: {
    country: "PK", name: "Pakistan", currency: "PKR", taxYearStartMonth: 7, version: "PK-TY2027-v1", checkedOn: "2026-11-27",
    source: "Finance Act 2026, salaried slabs for tax year 2027 (1 Jul 2026 - 30 Jun 2027); EOBI Act 1976 contributions on the minimum wage. Confirm with FBR / EOBI and your tax adviser.",
    defaults: { eobi: { enabled: true, minimumWage: 40700, employeeRate: 0.01, employerRate: 0.05 }, providentFund: { enabled: false, employeeRate: 0.10, employerRate: 0.10 }, socialSecurity: { enabled: false, employerRate: 0.06, wageCeiling: 40700 }, overtimeMultiplier: 2, standardMonthlyHours: 208 },
    notes: ["Income tax is spread over the tax year: each month withholds (tax on projected annual salary - tax already withheld this tax year) / months left.", "EOBI and social security are charged on the minimum wage set here; provinces differ, so check your province's rate.", "Inaya does not file returns or pay the FBR, EOBI or social security for you."],
  },
  AE: {
    country: "AE", name: "United Arab Emirates", currency: "AED", taxYearStartMonth: 1, version: "AE-2026-v1", checkedOn: "2026-11-27",
    source: "No personal income tax. End-of-service gratuity under Federal Decree-Law 33 of 2021 (21 days' basic wage per year for the first 5 years, 30 days after, capped at 2 years' wages). GPSSA pension for UAE nationals (employee 11%, employer 12.5%). WPS salary file (SIF). Confirm with MOHRE, GPSSA and your WPS agent/bank.",
    defaults: { gpssa: { employeeRate: 0.11, employerRate: 0.125 }, gratuityAccrual: true, overtimeMultiplier: 1.25, standardMonthlyHours: 208 },
    notes: ["Gratuity is accrued monthly as an employer cost and paid at the end of service.", "The WPS SIF file needs your establishment ID and your bank/agent routing code; your bank may require small format changes."],
  },
  US: {
    country: "US", name: "United States", currency: "USD", taxYearStartMonth: 1, version: "US-2026-v1", checkedOn: "2026-11-27",
    source: "IRS Publication 15-T (2026) percentage method and Publication 15 (2026): social security 6.2% to $184,500, Medicare 1.45% (+0.9% over $200,000), FUTA 0.6% on the first $7,000. State and local income tax: a rate you enter per employee.",
    defaults: { periodsPerYear: 12, futa: true, overtimeMultiplier: 1.5, standardMonthlyHours: 173.33 },
    notes: ["State and local income tax is NOT calculated from state tables: enter each employee's state withholding rate.", "Inaya does not file Forms 941/940/W-2 or deposit taxes for you."],
  },
  KZ: {
    country: "KZ", name: "Kazakhstan", currency: "KZT", taxYearStartMonth: 1, version: "KZ-2026-v1", checkedOn: "2026-11-27",
    source: "Tax Code 2026: IIT 10% up to 8,500 MCI a year, 15% above; standard deduction 30 MCI a month (with the employee's application); OPV 10% (cap 50 MZP), VOSMS 2% (cap 20 MZP); employer OPVR 3.5%, social contributions 5% (1-7 MZP), OOSMS 3% (cap 40 MZP), social tax 6%. MCI 4,325, MZP 85,000. Confirm with the State Revenue Committee.",
    defaults: { ...KZ_2026, overtimeMultiplier: 1.5, standardMonthlyHours: 168 },
    notes: ["IIT is cumulative over the calendar year.", "OPVR is not due for employees born before 1 January 1975: tick that on their pay profile."],
  },
  UZ: {
    country: "UZ", name: "Uzbekistan", currency: "UZS", taxYearStartMonth: 1, version: "UZ-2026-v1", checkedOn: "2026-11-27",
    source: "Personal income tax 12% (withheld by the employer); employer social tax 12% (IT Park residents: 7.5% income tax, no social tax, until 1 Jan 2028). Confirm with the State Tax Committee.",
    defaults: { pitRate: 0.12, socialTaxRate: 0.12, itPark: false, overtimeMultiplier: 2, standardMonthlyHours: 168 },
    notes: ["Tick 'IT Park resident' in payroll settings if it applies to your company."],
  },
  AZ: {
    country: "AZ", name: "Azerbaijan", currency: "AZN", taxYearStartMonth: 1, version: "AZ-2026-v1", checkedOn: "2026-11-27",
    source: "Private non-oil sector, 2026: income tax 3% up to 2,500 AZN a month (200 AZN relief), 10% to 8,000, 14% above; social insurance (employee 3% to 200 then 10%; employer 22% to 200, 15% to 8,000, 11% above); unemployment 0.5% each; health insurance 2% each to 2,500 then 0.5%. Confirm with the State Tax Service.",
    defaults: { year: 2026, overtimeMultiplier: 2, standardMonthlyHours: 160 },
    notes: ["The low-band income tax rate rises to 5% in 2027: update the year in payroll settings."],
  },
  OTHER: {
    country: "OTHER", name: "Other country (your own rates)", currency: "USD", taxYearStartMonth: 1, version: "CUSTOM-v1", checkedOn: null,
    source: "No ready-made rules. Enter your own income tax percentage and contribution rules.",
    defaults: { flatTaxRate: 0, contributions: [], overtimeMultiplier: 1.5, standardMonthlyHours: 173.33 },
    notes: ["Every rate here is yours: Inaya applies exactly what you enter."],
  },
};
export const COUNTRIES = Object.keys(PRESETS);

/** UAE end-of-service gratuity for completed service (Decree-Law 33/2021, Art. 51). Basic wage only; under 1 year: none. */
export function uaeGratuity({ basicMonthly, years }) {
  const y = pos(years); if (y < 1) return 0;
  const daily = (pos(basicMonthly) * 12) / 365;
  const first = Math.min(y, 5) * 21 * daily; const rest = pos(y - 5) * 30 * daily;
  return r2(Math.min(first + rest, pos(basicMonthly) * 24));
}

/**
 * Statutory lines for one month. Returns { tax, employee: [{code,label,amount}], employer: [...] , notes }.
 *  ctx: { country, settings, profile, gross, taxableGross, basic, ytd: { taxable, tax, ssWages, medicareWages, futaWages, months }, monthIndex (1-12 within the tax year), year }
 */
export function statutory(ctx) {
  const { country, settings = {}, profile = {}, gross, taxableGross, basic, ytd = {}, monthIndex = 1, year = new Date().getUTCFullYear() } = ctx;
  const oneOff = Math.min(pos(ctx.oneOffTaxable), pos(taxableGross)); const regular = pos(taxableGross) - oneOff;
  const emp = [], er = []; let tax = 0; const notes = [];
  const add = (arr, code, label, amount) => { const a = r2(amount); if (a > 0) arr.push({ code, label, amount: a }); return a; };
  if (country === "PK") {
    const monthsLeft = 12 - monthIndex + 1; // including this month
    const projected = pos(ytd.taxable) + regular * monthsLeft;
    const base = slabTax(projected, PK_SLABS_TY2027);
    tax = r2(pos(base - pos(ytd.tax)) / monthsLeft + (oneOff > 0 ? slabTax(projected + oneOff, PK_SLABS_TY2027) - base : 0));
    const e = settings.eobi || {}; if (e.enabled !== false && !profile.eobiExempt) { add(emp, "EOBI", "EOBI (employee)", pos(e.minimumWage) * pos(e.employeeRate)); add(er, "EOBI_ER", "EOBI (employer)", pos(e.minimumWage) * pos(e.employerRate)); }
    const pf = settings.providentFund || {}; if (pf.enabled && !profile.pfExempt) { add(emp, "PF", "Provident fund (employee)", pos(basic) * pos(pf.employeeRate)); add(er, "PF_ER", "Provident fund (employer)", pos(basic) * pos(pf.employerRate)); }
    const ss = settings.socialSecurity || {}; if (ss.enabled && pos(gross) <= pos(ss.wageCeiling || Infinity)) add(er, "SS_ER", "Provincial social security (employer)", pos(e.minimumWage || ss.wageCeiling) * pos(ss.employerRate));
  } else if (country === "AE") {
    if (profile.uaeNational) { const g = settings.gpssa || {}; add(emp, "GPSSA", "GPSSA pension (employee)", pos(basic) * pos(g.employeeRate)); add(er, "GPSSA_ER", "GPSSA pension (employer)", pos(basic) * pos(g.employerRate)); }
    else if (settings.gratuityAccrual !== false) { const yrs = pos(profile.serviceYears); add(er, "GRATUITY", "End-of-service gratuity accrual", (pos(basic) * 12 / 365) * (yrs >= 5 ? 30 : 21) / 12); }
  } else if (country === "US") {
    const ppy = pos(settings.periodsPerYear) || 12;
    tax = r2(usFederalWithholding({ wages: regular, periodsPerYear: ppy, w4: profile.w4 || {} }) + oneOff * 0.22); // one-off pay: IRS optional flat rate for supplemental wages
    const ssRoom = pos(US_2026.ssWageBase - pos(ytd.ssWages)); const ssW = Math.min(pos(gross), ssRoom);
    add(emp, "SS", "Social security", ssW * US_2026.ssRate); add(er, "SS_ER", "Social security (employer)", ssW * US_2026.ssRate);
    add(emp, "MED", "Medicare", pos(gross) * US_2026.medicareRate); add(er, "MED_ER", "Medicare (employer)", pos(gross) * US_2026.medicareRate);
    const over = pos(pos(ytd.medicareWages) + pos(gross) - US_2026.addlMedicareOver) - pos(pos(ytd.medicareWages) - US_2026.addlMedicareOver);
    add(emp, "MED_ADD", "Additional Medicare", over * US_2026.addlMedicareRate);
    if (settings.futa !== false) add(er, "FUTA", "FUTA (employer)", Math.min(pos(gross), pos(US_2026.futaWageBase - pos(ytd.futaWages))) * US_2026.futaRate);
    if (pos(profile.statePercent) > 0) add(emp, "STATE", `State/local income tax (${profile.statePercent}%)`, pos(taxableGross) * pos(profile.statePercent) / 100);
  } else if (country === "KZ") {
    const k = { ...KZ_2026, ...settings }; const g = pos(gross);
    const opv = add(emp, "OPV", "OPV pension (10%)", Math.min(g, k.opvCapMzp * k.mzp) * k.opv);
    const vosms = add(emp, "VOSMS", "VOSMS medical (2%)", Math.min(g, k.vosmsCapMzp * k.mzp) * k.vosms);
    const ded = profile.kzStandardDeduction ? k.stdDeductionMci * k.mci : 0;
    const base = pos(pos(taxableGross) - opv - vosms - ded);
    const ytdBase = pos(ytd.taxable) + base; const thr = k.iitThresholdMci * k.mci;
    const cumTax = Math.min(ytdBase, thr) * k.iitLowRate + pos(ytdBase - thr) * k.iitHighRate;
    tax = r2(pos(cumTax - pos(ytd.tax))); ctx.taxBaseOut = base;
    if (!profile.kzBornBefore1975) add(er, "OPVR", "OPVR employer pension (3.5%)", Math.min(g, 50 * k.mzp) * k.opvr);
    add(er, "SO", "Social contributions (5%)", Math.min(Math.max(g - opv, k.soMinMzp * k.mzp), k.soMaxMzp * k.mzp) * k.so);
    add(er, "OOSMS", "OOSMS employer medical (3%)", Math.min(g, k.oosmsCapMzp * k.mzp) * k.oosms);
    add(er, "SOCTAX", "Social tax (6%)", Math.max(g - opv - vosms, k.socialTaxMinMci * k.mci) * k.socialTax);
  } else if (country === "UZ") {
    const rate = settings.itPark ? 0.075 : pos(settings.pitRate ?? 0.12); tax = r2(pos(taxableGross) * rate);
    if (!settings.itPark) add(er, "SOCTAX", "Social tax (employer)", pos(gross) * pos(settings.socialTaxRate ?? 0.12));
  } else if (country === "AZ") {
    const yr = Number(settings.year) || year; tax = azIncomeTax(taxableGross, yr); const s = azSocial(gross);
    add(emp, "DSMF", "Social insurance (employee)", s.employee); add(er, "DSMF_ER", "Social insurance (employer)", s.employer);
    add(emp, "UNEMP", "Unemployment insurance (employee)", s.unemploymentEach); add(er, "UNEMP_ER", "Unemployment insurance (employer)", s.unemploymentEach);
    add(emp, "HEALTH", "Health insurance (employee)", s.healthEach); add(er, "HEALTH_ER", "Health insurance (employer)", s.healthEach);
  } else {
    tax = r2(pos(taxableGross) * pos(settings.flatTaxRate) / 100);
    for (const c of settings.contributions || []) { const amt = pos(gross) * pos(c.percent) / 100; add(c.payer === "employer" ? er : emp, `C_${String(c.name).slice(0, 12)}`, String(c.name).slice(0, 60), amt); }
  }
  return { tax: r2(pos(tax)), employee: emp, employer: er, notes, taxBase: ctx.taxBaseOut ?? taxableGross };
}
