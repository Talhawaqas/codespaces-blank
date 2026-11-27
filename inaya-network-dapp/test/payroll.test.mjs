// test/payroll.test.mjs -- Payroll (owner decisions 27 Nov 2026). Pure tax maths against worked examples, then the full
// flow on the TEST database: package gate + add-on, rules confirmation, pay profiles (sealed), unpaid leave, loans,
// four-eyes approval, ledger posting, employee-only payslips, password-locked PDFs and WhatsApp document templates.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "../src/lib/mongodb.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { slabTax, PK_SLABS_TY2027, usFederalWithholding, azIncomeTax, azSocial, uaeGratuity } from "../src/lib/payroll/rules.js";
import { computePayslip, taxMonthIndex, taxYearStart } from "../src/lib/payroll/engine.js";
import { payslipPdf } from "../src/lib/payroll/pdf.js";
import * as P from "../src/lib/payroll/store.js";
import { SUPPORTED_CURRENCIES, convert } from "../src/lib/currency.js";

const RUN = randomUUID().slice(0, 8); const orgIds = [];
async function db() { return (await connectToDatabase()).db; }
async function mkOrg(plan, extra = {}) { const _id = new ObjectId(); orgIds.push(_id); await (await db()).collection("orgs").insertOne({ _id, name: `PAY ${RUN} ${plan}`, plan, ownerEmail: `owner-${RUN}@pay.test`, createdAt: new Date().toISOString(), ...extra }); return _id; }
async function mkEmployee(orgId, name, email, joiningDate = "2024-01-15") { const r = await (await db()).collection("employees").insertOne({ orgId, departmentId: new ObjectId(), memberEmail: email, fullName: name, jobTitle: "Staff", employmentStatus: "ACTIVE", joiningDate, createdAt: new Date().toISOString(), deletedAt: null }); return String(r.insertedId); }
const owner = { email: `owner-${RUN}@pay.test`, role: "owner" }; const hr = { email: `hr-${RUN}@pay.test`, role: "member", hrRole: "manager" };
const fin = { email: `fin-${RUN}@pay.test`, role: "member", financeRole: "manager" };

after(async () => {
  const d = await db();
  for (const c of ["calendar_records", "org_activity", "employees", "leave_requests", "journal_entries", "ledger_accounts"]) await d.collection(c).deleteMany({ orgId: { $in: orgIds } });
  await d.collection("orgs").deleteMany({ _id: { $in: orgIds } });
  await (await mongoClientPromise).close();
});

test("tax maths match worked examples (PK, US, KZ, AZ, UAE)", () => {
  assert.equal(slabTax(2400000, PK_SLABS_TY2027), 156000); // 116,000 + 20% of 200,000
  assert.equal(slabTax(600000, PK_SLABS_TY2027), 0);
  assert.equal(slabTax(8000000, PK_SLABS_TY2027), 1774000); // 1,424,000 + 35% of 1,000,000
  const pk = computePayslip({ settings: { country: "PK" }, profile: { basic: 200000 }, period: "2026-07" });
  assert.equal(pk.tax, 13000); assert.equal(pk.deductions.find((d) => d.code === "EOBI").amount, 407); assert.equal(pk.employer.find((d) => d.code === "EOBI_ER").amount, 2035);
  assert.equal(taxMonthIndex("2026-11", 7), 5); assert.equal(taxYearStart("2027-02", 7), "2026-07"); assert.equal(taxYearStart("2026-07", 7), "2026-07");
  assert.equal(usFederalWithholding({ wages: 5000, w4: { filingStatus: "single" } }), 418.33); // (60,000 - 8,600) -> 1,240 + 12% x 31,500 = 5,020 / 12
  assert.equal(usFederalWithholding({ wages: 10000, w4: { filingStatus: "married" } }), 836.67); // (120,000 - 12,900) = 107,100 -> 2,480 + 12% x 63,000 = 10,040 / 12
  const us = computePayslip({ settings: { country: "US" }, profile: { basic: 5000, w4: { filingStatus: "single" }, statePercent: 5 }, period: "2026-03" });
  assert.equal(us.deductions.find((d) => d.code === "SS").amount, 310); assert.equal(us.deductions.find((d) => d.code === "MED").amount, 72.5); assert.equal(us.deductions.find((d) => d.code === "STATE").amount, 250);
  const usCap = computePayslip({ settings: { country: "US" }, profile: { basic: 20000 }, period: "2026-12", ytd: { ssWages: 180000, medicareWages: 190000, futaWages: 7000 } });
  assert.equal(usCap.deductions.find((d) => d.code === "SS").amount, 279, "social security stops at the $184,500 wage base");
  assert.equal(usCap.deductions.find((d) => d.code === "MED_ADD").amount, 90, "0.9% only on wages above $200,000");
  assert.equal(usCap.employer.find((d) => d.code === "FUTA"), undefined, "FUTA stops after $7,000");
  const kz = computePayslip({ settings: { country: "KZ" }, profile: { basic: 85000, kzStandardDeduction: true }, period: "2026-03" });
  const k = Object.fromEntries([...kz.deductions, ...kz.employer].map((l) => [l.code, l.amount]));
  assert.deepEqual([k.OPV, k.VOSMS, k.TAX, k.OPVR, k.SO, k.OOSMS, k.SOCTAX], [8500, 1700, undefined, 2975, 4250, 2550, 4488]); // the 2026 worked example
  assert.equal(azIncomeTax(3000), 125); assert.equal(azIncomeTax(1000), 24); assert.deepEqual(azSocial(3000), { employee: 286, employer: 464, unemploymentEach: 15, healthEach: 52.5 });
  assert.equal(uaeGratuity({ basicMonthly: 10000, years: 0.9 }), 0); assert.equal(uaeGratuity({ basicMonthly: 3650, years: 2 }), 5040); // 120/day x 21 x 2
  assert.equal(uaeGratuity({ basicMonthly: 3650, years: 30 }), 87600, "capped at 2 years' wages");
  const uz = computePayslip({ settings: { country: "UZ" }, profile: { basic: 10000000 }, period: "2026-03" }); assert.equal(uz.tax, 1200000);
  const uzIt = computePayslip({ settings: { country: "UZ", itPark: true }, profile: { basic: 10000000 }, period: "2026-03" }); assert.equal(uzIt.tax, 750000); assert.equal(uzIt.employer.length, 0);
});

test("payslip lines: allowances, unpaid leave, overtime, loans, negative-net warning", () => {
  const s = computePayslip({ settings: { country: "AE" }, profile: { basic: 9000, allowances: [{ name: "Housing", amount: 3000 }] }, period: "2026-03", attendance: { unpaidDays: 3, overtimeHours: 10 }, loans: [{ id: "l1", name: "Advance", installment: 2000, remaining: 1500 }] });
  assert.equal(s.deductions.find((d) => d.code === "UNPAID").amount, 1200); // 12,000 / 30 x 3
  assert.equal(s.earnings.find((e) => e.code === "OT").amount, 540.87); // 9,000 / 208 x 10 x 1.25
  assert.equal(s.deductions.find((d) => d.code === "LOAN").amount, 1500, "never more than what is left on the loan");
  assert.equal(s.gross, 11340.87); assert.equal(s.net, 9840.87);
  const neg = computePayslip({ settings: { country: "OTHER" }, profile: { basic: 100, deductions: [{ name: "Fine", amount: 500 }] }, period: "2026-03" });
  assert.ok(neg.warnings.length && neg.net < 0);
  assert.equal(computePayslip({ settings: { country: "PK" }, profile: { basic: 100000.4 }, period: "2026-07" }).gross, 100000, "PKR is paid in whole rupees");
});

test("currencies: Gulf, South-East and Central Asia supported with a rate", () => {
  for (const c of ["SAR", "QAR", "OMR", "KWD", "BHD", "SGD", "MYR", "IDR", "THB", "PHP", "LKR", "VND", "KZT", "UZS", "AZN"]) { assert.ok(SUPPORTED_CURRENCIES.includes(c), c); assert.ok(convert(100, "USD", c).convertedAmount > 0, c); }
  assert.equal(convert(375, "SAR", "USD").convertedAmount, 100);
});

test("payslip PDF is locked with the employee's password", async () => {
  const s = computePayslip({ settings: { country: "PK" }, profile: { basic: 150000 }, period: "2026-08" });
  const open = await payslipPdf({ ...s, employeeName: "A", companyName: "B" }); const locked = await payslipPdf({ ...s, employeeName: "A", companyName: "B" }, { password: "secret-123" });
  assert.equal(open.slice(0, 5).toString(), "%PDF-"); assert.ok(!open.includes("/Encrypt")); assert.ok(locked.includes("/Encrypt"));
  assert.ok(!locked.includes("Net pay"), "content is not readable without the password");
});

test("full flow: gate, rules confirmation, run, four-eyes, paid, ledger, loans, employee-only payslips", async () => {
  const pro = await mkOrg("professional"); assert.match((await P.saveSettings({ orgId: String(pro), membership: owner, actorEmail: owner.email, input: { country: "PK" } })).error, /Business/);
  const proAdd = await mkOrg("professional", { addOns: { payroll: true } }); assert.ok((await P.saveSettings({ orgId: String(proAdd), membership: owner, actorEmail: owner.email, input: { country: "PK" } })).settings, "the add-on unlocks payroll on Professional");

  const org = await mkOrg("business"); const o = String(org);
  const eA = await mkEmployee(org, "Ayesha Khan", `ayesha-${RUN}@pay.test`); const eB = await mkEmployee(org, "Bilal Ahmed", `bilal-${RUN}@pay.test`);
  assert.equal((await P.saveSettings({ orgId: o, membership: { email: "x@pay.test", role: "member" }, actorEmail: "x", input: { country: "PK" } })).status, 403);
  await P.saveSettings({ orgId: o, membership: hr, actorEmail: hr.email, input: { country: "PK", currency: "PKR" } });
  await P.saveProfile({ orgId: o, membership: hr, actorEmail: hr.email, employeeId: eA, input: { basic: 200000, allowances: [{ name: "House rent", amount: 40000 }], bankName: "HBL", iban: "PK36SCBL0000001123456702", whatsapp: "+923001234567" } });
  await P.saveProfile({ orgId: o, membership: hr, actorEmail: hr.email, employeeId: eB, input: { basic: 80000 } });
  const raw = await (await db()).collection("calendar_records").findOne({ orgId: org, kind: "p_profile" }); assert.ok(String(raw.data).startsWith("pay1:") && !JSON.stringify(raw).includes("200000"), "salary is stored sealed");
  assert.equal((await P.createRun({ orgId: o, membership: hr, actorEmail: hr.email, period: "2026-09" })).code, "RULES_NOT_CONFIRMED");
  await P.confirmPreset({ orgId: o, membership: hr, actorEmail: hr.email });
  await (await db()).collection("leave_requests").insertOne({ orgId: org, employeeId: new ObjectId(eB), leaveType: "Unpaid leave", status: "APPROVED", startDate: "2026-09-10", endDate: "2026-09-11" });
  await P.createLoan({ orgId: o, membership: hr, actorEmail: hr.email, employeeId: eA, input: { name: "Advance", principal: 30000, installment: 10000 } });
  const run = (await P.createRun({ orgId: o, membership: hr, actorEmail: hr.email, period: "2026-09" })).run; assert.equal(run.employees, 2);
  assert.equal((await P.createRun({ orgId: o, membership: hr, actorEmail: hr.email, period: "2026-09" })).status, 409, "one payroll per month");
  const full = await P.getRun({ orgId: o, membership: hr, runId: run.id });
  const b = full.slips.find((s) => s.employeeName === "Bilal Ahmed"); assert.equal(b.deductions.find((d) => d.code === "UNPAID").amount, Math.round(80000 / 30 * 2));
  const a = full.slips.find((s) => s.employeeName === "Ayesha Khan"); assert.equal(a.deductions.find((d) => d.code === "LOAN").amount, 10000);

  // employees can't see a payslip before it's paid, nor anyone else's
  const ayesha = { email: `ayesha-${RUN}@pay.test`, role: "member" }; const bilal = { email: `bilal-${RUN}@pay.test`, role: "member" };
  assert.equal((await P.getPayslip({ orgId: o, membership: ayesha, slipId: a.id })).status, 404);
  assert.equal((await P.transitionRun({ orgId: o, membership: hr, actorEmail: hr.email, runId: run.id, action: "submit" })).run.status, "SUBMITTED");
  assert.equal((await P.transitionRun({ orgId: o, membership: hr, actorEmail: hr.email, runId: run.id, action: "approve" })).status, 403, "HR can't approve");
  const ownerAsPreparer = await P.transitionRun({ orgId: o, membership: { ...owner, email: hr.email }, actorEmail: hr.email, runId: run.id, action: "approve" }); assert.equal(ownerAsPreparer.code, "SAME_PERSON");
  assert.equal((await P.transitionRun({ orgId: o, membership: fin, actorEmail: fin.email, runId: run.id, action: "approve" })).run.status, "APPROVED");
  const csv = await P.bankFile({ orgId: o, membership: fin, runId: run.id }); assert.match(csv.content, /PK36SCBL0000001123456702/); assert.match(csv.content, /Ayesha Khan/);
  const paid = await P.transitionRun({ orgId: o, membership: fin, actorEmail: fin.email, runId: run.id, action: "pay" }); assert.equal(paid.run.status, "PAID"); assert.ok(paid.run.ledgerEntryId, "ledger entry posted");
  const je = await (await db()).collection("journal_entries").findOne({ _id: new ObjectId(paid.run.ledgerEntryId) });
  const dr = je.lines.reduce((n, l) => n + l.debit, 0), cr = je.lines.reduce((n, l) => n + l.credit, 0); assert.equal(Math.round(dr * 100), Math.round(cr * 100));
  assert.equal((await P.transitionRun({ orgId: o, membership: fin, actorEmail: fin.email, runId: run.id, action: "pay" })).status, 409, "can't pay twice");
  const loans = (await P.listLoans({ orgId: o, membership: hr })).loans; assert.equal(loans[0].remaining, 20000);

  const mine = await P.myPayslips({ orgId: o, membership: ayesha }); assert.equal(mine.payslips.length, 1); assert.equal(mine.payslips[0].net, a.net);
  assert.equal((await P.getPayslip({ orgId: o, membership: bilal, slipId: a.id })).status, 403, "someone else's payslip");
  const dl = await P.payslipDownload({ orgId: o, membership: ayesha, slipId: a.id }); assert.equal(dl.buffer.slice(0, 5).toString(), "%PDF-");
  assert.match((await P.setMyPayslipOptions({ orgId: o, membership: ayesha, input: { payslipPassword: "123" } })).error, /6 to 64/);
  assert.equal((await P.setMyPayslipOptions({ orgId: o, membership: ayesha, input: { payslipPassword: "ayesha-pass-1" } })).hasPayslipPassword, true);
  const prof = await P.getProfile({ orgId: o, membership: hr, employeeId: eA }); assert.equal(prof.profile.payslipPassword, undefined, "HR never sees the payslip password"); assert.equal(prof.profile.hasPayslipPassword, true);
  await P.saveProfile({ orgId: o, membership: hr, actorEmail: hr.email, employeeId: eA, input: { basic: 210000 } });
  assert.equal((await P.getProfile({ orgId: o, membership: hr, employeeId: eA })).profile.hasPayslipPassword, true, "an HR edit keeps the employee's password");
  assert.match((await P.deliverRun({ orgId: o, membership: hr, actorEmail: hr.email, runId: run.id, channels: ["whatsapp"] })).error, /Inaya Connect|WhatsApp/);

  // next month: tax year to date carries over (PK tax year starts in July)
  const r2 = (await P.createRun({ orgId: o, membership: hr, actorEmail: hr.email, period: "2026-10" })).run; const f2 = await P.getRun({ orgId: o, membership: hr, runId: r2.id });
  assert.ok(f2.slips.find((s) => s.employeeName === "Ayesha Khan").tax > 0);
});

test("WhatsApp: payslip PDF goes as a document-header template", async () => {
  const g = await import("../src/lib/connect/graph.js"); const calls = [];
  const { encryptIntegrationSecret } = await import("../src/lib/integrationCrypto.js");
  g.__setGraphTransport(async (r) => { calls.push(r); return r.upload ? { mediaId: "MEDIA1" } : { messages: [{ id: "wamid.1" }] }; });
  const conn = { phoneNumberId: "123", accessTokenEncrypted: encryptIntegrationSecret("tok") };
  const up = await g.uploadMedia(conn, Buffer.from("%PDF-1.6"), "application/pdf", "payslip-2026-09.pdf"); assert.equal(up.mediaId, "MEDIA1");
  const sent = await g.sendDocumentTemplate(conn, "+92 300 1234567", "payslip_notice", "en_US", "MEDIA1", "payslip-2026-09.pdf", ["Ayesha", "September 2026"]);
  assert.equal(sent.waMessageId, "wamid.1");
  const body = calls[1].body; assert.equal(body.to, "923001234567"); assert.equal(body.template.name, "payslip_notice");
  assert.equal(body.template.components[0].parameters[0].type, "document"); assert.equal(body.template.components[0].parameters[0].document.id, "MEDIA1");
  assert.deepEqual(body.template.components[1].parameters.map((p) => p.text), ["Ayesha", "September 2026"]);
  g.__setGraphTransport(null);
});

test("one-off pay (bonus, overtime) is taxed in the month paid, not projected over the year", () => {
  const plain = computePayslip({ settings: { country: "PK" }, profile: { basic: 200000 }, period: "2026-07" });
  const bonus = computePayslip({ settings: { country: "PK" }, profile: { basic: 200000 }, period: "2026-07", adjustments: [{ name: "Eid bonus", amount: 100000 }] });
  assert.equal(bonus.tax - plain.tax, 20000, "the bonus moves annual income from 2.4m to 2.5m: 20% of 100,000, all this month");
  const us = computePayslip({ settings: { country: "US" }, profile: { basic: 5000 }, period: "2026-03", adjustments: [{ name: "Bonus", amount: 1000 }] });
  assert.equal(us.tax, 638.33, "supplemental wages at the 22% flat rate");
});
