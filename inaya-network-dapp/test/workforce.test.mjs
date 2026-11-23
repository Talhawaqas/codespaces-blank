// test/workforce.test.mjs -- Inaya Commerce Phase 6 gate (Master SOW 10.9 + owner additions): attendance is auditable and
// duplicate-safe; only authorised people correct time (and never approve their own); schedules respect role / branch
// permissions; sales attribution reconciles with sales; refunds reverse commissions; checklists and incidents are branch-scoped;
// AI only advises; reports separate estimated from actual labour cost; branch scoping is enforced server-side; user
// administration has no self-elevation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as SALE from "../src/lib/commerce/sale.js";
import * as RET from "../src/lib/commerce/returns.js";
import { recordStockMovement } from "../src/lib/inventory.js";
import * as SC from "../src/lib/workforce/scope.js";
import * as T from "../src/lib/workforce/time.js";
import * as C from "../src/lib/workforce/commissions.js";
import * as A from "../src/lib/workforce/analytics.js";

const orgId = new ObjectId(); const ORG = String(orgId);
const owner = { role: "owner", email: "owner@w6.example" }; const admin = { role: "admin", email: "admin@w6.example" };
let c, dep, lhr, khi, prod, cashierL, cashierK, mgrL, mgrL2;
const key = () => T.newKey();
const day = (d, h, m = 0) => new Date(Date.UTC(2026, 10, d, h, m)).toISOString(); // November 2026
const m = async (email) => c.orgMembers.findOne({ orgId, email });

before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString();
  await c.orgs.insertOne({ _id: orgId, name: "w6 chain", plan: "business", features: { FEATURE_COMMERCE: true }, createdAt: now });
  dep = (await c.departments.insertOne({ orgId, name: "Shops", createdAt: now })).insertedId;
  lhr = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Lahore", createdAt: now })).insertedId;
  khi = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Karachi", createdAt: now })).insertedId;
  prod = (await c.products.insertOne({ orgId, departmentId: dep, sku: `W6-${Date.now()}`, name: "Kettle", unitPrice: 1000, category: "Kitchen", status: "ACTIVE", deletedAt: null, createdAt: now })).insertedId;
  for (const w of [lhr, khi]) await recordStockMovement({ orgId: ORG, productId: String(prod), warehouseId: String(w), delta: 50, type: "RECEIPT", actorEmail: "t", unitCost: 400 });
  const mk = (email, extra) => c.orgMembers.insertOne({ orgId, email, role: "member", status: "active", departmentIds: [dep], createdAt: now, ...extra });
  await c.orgMembers.insertMany([{ orgId, email: owner.email, role: "owner", status: "active", createdAt: now }, { orgId, email: admin.email, role: "admin", status: "active", createdAt: now }]);
  await mk("cash.l@w6.example", {}); await mk("cash.k@w6.example", {}); await mk("mgr.l@w6.example", {}); await mk("mgr.l2@w6.example", {});
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { currency: "PKR", taxMode: "exclusive" } });
  await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: owner.email, code: "GST", name: "GST", rate: 10, isDefault: true });
});
after(async () => {
  for (const n of ["orgs", "departments", "warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries", "org_members", "employees", "leave_requests"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: orgId } : { orgId }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("manage users: templates, branches, no self-change, only the owner makes admins, audited; branch scope enforced", { timeout: 120000 }, async () => {
  assert.equal((await SC.listUsers({ orgId: ORG, membership: { role: "member", email: "x" } })).status, 403);
  const L = String(lhr), Kh = String(khi);
  assert.ok(!(await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: "cash.l@w6.example", input: { template: "cashier", locationIds: [L], defaultLocationId: L } })).error);
  await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: "cash.k@w6.example", input: { template: "cashier", locationIds: [Kh] } });
  await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: "mgr.l@w6.example", input: { template: "store_manager", locationIds: [L] } });
  await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: "mgr.l2@w6.example", input: { template: "area_manager", locationIds: [L, Kh] } });
  cashierL = await m("cash.l@w6.example"); cashierK = await m("cash.k@w6.example"); mgrL = await m("mgr.l@w6.example"); mgrL2 = await m("mgr.l2@w6.example");
  assert.equal(cashierL.commerceRole, "cashier"); assert.equal(String(cashierL.defaultLocationId), L);
  assert.equal((await SC.updateUser({ orgId: ORG, membership: admin, actorEmail: admin.email, email: admin.email, input: { status: "suspended" } })).code, "SELF_CHANGE");
  assert.equal((await SC.updateUser({ orgId: ORG, membership: admin, actorEmail: admin.email, email: "mgr.l@w6.example", input: { role: "admin" } })).status, 403, "only the owner makes admins");
  assert.equal((await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: "cash.l@w6.example", input: { defaultLocationId: Kh } })).error, "The default branch must be one of the user's branches.");
  assert.ok(await c.db.collection("org_activity").findOne({ orgId, action: "MEMBER_ACCESS_CHANGED" }), "audited");
  const mine = await SC.myLocations({ orgId: ORG, membership: cashierL }); assert.deepEqual(mine.locations.map((x) => x.name), ["Lahore"]); assert.equal(mine.canSeeAll, false);
  assert.equal((await SC.myLocations({ orgId: ORG, membership: owner })).locations.length, 2);
  assert.equal(SC.allowedLocation(cashierL, Kh), false); assert.equal(SC.allowedLocation(mgrL2, Kh), true);
  assert.equal(await SC.canAddBranch(ORG), null, "branch limits stay off until the new pricing is switched on");
});

test("attendance: ordered, duplicate-safe, branch-scoped punches; corrections need another manager; timesheet, lateness, overtime inputs, export", { timeout: 120000 }, async () => {
  const L = String(lhr);
  assert.equal((await T.punch({ orgId: ORG, membership: cashierL, type: "CLOCK_IN", locationId: String(khi), idempotencyKey: key() })).code, "BRANCH_SCOPE", "can't clock in at a branch you aren't assigned to");
  assert.equal((await T.punch({ orgId: ORG, membership: cashierL, type: "CLOCK_OUT", locationId: L, idempotencyKey: key() })).code, "PUNCH_ORDER");
  const k1 = key(); const p1 = await T.punch({ orgId: ORG, membership: cashierL, type: "CLOCK_IN", locationId: L, idempotencyKey: k1, now: new Date(day(3, 9, 12)) }); assert.ok(!p1.error, p1.error);
  assert.ok((await T.punch({ orgId: ORG, membership: cashierL, type: "CLOCK_IN", locationId: L, idempotencyKey: k1, now: new Date(day(3, 9, 12)) })).duplicate, "a double tap records once");
  assert.equal((await T.punch({ orgId: ORG, membership: cashierL, type: "CLOCK_IN", locationId: L, idempotencyKey: key() })).code, "PUNCH_ORDER", "no double clock-in");
  await T.punch({ orgId: ORG, membership: cashierL, type: "BREAK_START", locationId: L, idempotencyKey: key(), now: new Date(day(3, 13)) });
  await T.punch({ orgId: ORG, membership: cashierL, type: "BREAK_END", locationId: L, idempotencyKey: key(), now: new Date(day(3, 13, 30)) });
  await T.punch({ orgId: ORG, membership: cashierL, type: "CLOCK_OUT", locationId: L, idempotencyKey: key(), now: new Date(day(3, 17)) });
  // schedule a 9:00 shift for that day so lateness can be measured (manager at that branch)
  const sh = await T.saveShift({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, input: { email: "cash.l@w6.example", locationId: L, start: day(3, 9), end: day(3, 17) } }); assert.ok(!sh.error, sh.error);
  await T.publishWeek({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, locationId: L, weekStart: day(2, 0) });
  const ts = await T.timesheet({ orgId: ORG, membership: cashierL, from: day(1, 0), to: day(8, 0) });
  assert.equal(ts.days[0].workedHours, 7.3, "9:12-17:00 minus a 30-minute break"); assert.equal(ts.days[0].lateMinutes, 12); assert.equal(ts.days[0].late, true);
  assert.equal((await T.timesheet({ orgId: ORG, membership: cashierL, email: "cash.k@w6.example" })).status, 403, "staff see only their own timesheet");
  // corrections
  assert.equal((await T.requestCorrection({ orgId: ORG, membership: cashierK, actorEmail: cashierK.email, input: { email: "cash.l@w6.example", action: "ADD", type: "CLOCK_IN", at: day(4, 9), locationId: L, reason: "forgot to clock in" } })).status, 403, "staff can't correct someone else");
  const cr = await T.requestCorrection({ orgId: ORG, membership: cashierL, actorEmail: cashierL.email, input: { action: "ADD", type: "CLOCK_IN", at: day(4, 9), locationId: L, reason: "forgot to clock in" } }); assert.ok(!cr.error, cr.error);
  assert.equal((await T.decideCorrection({ orgId: ORG, membership: cashierL, actorEmail: cashierL.email, id: cr.correction.id, approve: true })).status, 403);
  const mgrCr = await T.requestCorrection({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, input: { email: "cash.l@w6.example", action: "ADD", type: "CLOCK_OUT", at: day(4, 17), locationId: L, reason: "left without clocking out" } });
  assert.equal((await T.decideCorrection({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, id: mgrCr.correction.id, approve: true })).code, "SELF_APPROVAL", "the requester can't approve");
  assert.ok((await T.decideCorrection({ orgId: ORG, membership: mgrL2, actorEmail: mgrL2.email, id: cr.correction.id, approve: true })).ok);
  assert.ok((await T.decideCorrection({ orgId: ORG, membership: mgrL2, actorEmail: mgrL2.email, id: mgrCr.correction.id, approve: true })).ok);
  const ts2 = await T.timesheet({ orgId: ORG, membership: mgrL, email: "cash.l@w6.example", from: day(1, 0), to: day(8, 0) });
  assert.equal(ts2.days.find((d) => d.date === "2026-11-04").workedHours, 8, "approved corrections become time events");
  const ex = await T.payrollExport({ orgId: ORG, membership: mgrL, from: day(1, 0), to: day(8, 0) }); assert.match(ex.csv, /cash\.l@w6\.example,2026-11-03,7\.3/);
  assert.equal((await T.payrollExport({ orgId: ORG, membership: cashierL, from: day(1, 0), to: day(8, 0) })).status, 403);
});

test("rota: branch and role permissions, overlap / leave / branch checks, publish, acknowledge, swaps approved by an uninvolved manager, coverage", { timeout: 120000 }, async () => {
  const L = String(lhr), Kh = String(khi);
  assert.equal((await T.saveShift({ orgId: ORG, membership: cashierL, actorEmail: cashierL.email, input: { email: "cash.l@w6.example", locationId: L, start: day(10, 9), end: day(10, 17) } })).status, 403, "staff can't schedule");
  assert.equal((await T.saveShift({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, input: { email: "cash.k@w6.example", locationId: Kh, start: day(10, 9), end: day(10, 17) } })).code, "BRANCH_SCOPE", "a Lahore manager can't schedule Karachi");
  assert.equal((await T.saveShift({ orgId: ORG, membership: mgrL2, actorEmail: mgrL2.email, input: { email: "cash.k@w6.example", locationId: L, start: day(10, 9), end: day(10, 17) } })).code, "SHIFT_CONFLICT", "the person isn't assigned to Lahore");
  const emp = (await c.employees.insertOne({ orgId, memberEmail: "cash.l@w6.example", name: "Cash L", hourlyCost: 500, createdAt: new Date().toISOString() })).insertedId;
  await c.leaveRequests.insertOne({ orgId, employeeId: emp, status: "APPROVED", startDate: "2026-11-12", endDate: "2026-11-12" });
  assert.match((await T.saveShift({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, input: { email: "cash.l@w6.example", locationId: L, start: day(12, 9), end: day(12, 17) } })).error, /approved leave/);
  const a = await T.saveShift({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, input: { email: "cash.l@w6.example", locationId: L, start: day(10, 9), end: day(10, 17), role: "till" } }); assert.ok(!a.error, a.error);
  assert.equal((await T.saveShift({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, input: { email: "cash.l@w6.example", locationId: L, start: day(10, 15), end: day(10, 20) } })).code, "SHIFT_CONFLICT", "no overlapping shifts");
  await T.setNeed({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, input: { locationId: L, weekday: new Date(day(10, 9)).getUTCDay(), fromHour: 9, toHour: 17, staff: 2 } });
  assert.equal((await T.rota({ orgId: ORG, membership: cashierL, locationId: L, weekStart: day(9, 0) })).shifts.length, 0, "staff don't see draft shifts");
  await T.publishWeek({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, locationId: L, weekStart: day(9, 0) });
  const r = await T.rota({ orgId: ORG, membership: mgrL, locationId: L, weekStart: day(9, 0) }); assert.equal(r.coverage.find((x) => x.date === "2026-11-10").state, "UNDERSTAFFED");
  assert.equal((await T.acknowledgeShift({ orgId: ORG, membership: cashierL, id: a.shift.id })).shift.status, "ACKNOWLEDGED");
  await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: "cash.k@w6.example", input: { locationIds: [L, Kh] } }); cashierK = await m("cash.k@w6.example");
  const sw = await T.requestSwap({ orgId: ORG, membership: cashierL, input: { shiftId: a.shift.id, toEmail: "cash.k@w6.example", reason: "family event" } });
  assert.ok((await T.decideSwap({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, id: sw.swap.id, approve: true })).ok);
  assert.equal((await c.db.collection("calendar_records").findOne({ _id: new ObjectId(a.shift.id) })).email, "cash.k@w6.example", "the shift moved, with history");
});

test("commissions: attribution reconciles with sales, refunds reverse, rules versioned, approval lock without self-approval; tips by hours", { timeout: 180000 }, async () => {
  const L = String(lhr); const today = new Date().toISOString().slice(0, 10);
  assert.match((await C.saveRule({ orgId: ORG, membership: mgrL2, actorEmail: mgrL2.email, input: { percent: 5, effectiveFrom: "2020-01-01" } })).error, /past/);
  assert.ok((await C.saveRule({ orgId: ORG, membership: mgrL2, actorEmail: mgrL2.email, input: { percent: 5, effectiveFrom: today } })).ok);
  const sell = (mm, q) => SALE.completeSale({ orgId: ORG, membership: mm, actorEmail: mm.email, input: { warehouseId: L, idempotencyKey: SALE.newIdempotencyKey(), lines: [{ productId: String(prod), quantity: q }], tenders: [{ method: "CASH", amount: 1100 * q }] } });
  const s1 = await sell(cashierL, 2); assert.ok(!s1.error, s1.error);
  await C.accrueSale({ orgId: ORG, saleId: s1.sale.id });
  let sum = await C.commissionSummary({ orgId: ORG, membership: mgrL, month: today.slice(0, 7) });
  assert.equal(sum.people.find((p) => p.email === "cash.l@w6.example").commission, 100, "5% of PKR 2,000 net");
  await C.accrueSale({ orgId: ORG, saleId: s1.sale.id }); sum = await C.commissionSummary({ orgId: ORG, membership: mgrL, month: today.slice(0, 7) });
  assert.equal(sum.people.find((p) => p.email === "cash.l@w6.example").commission, 100, "accrual is idempotent");
  // split 50/50 with the manager's approval
  assert.ok(!(await C.setAttribution({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, saleId: s1.sale.id, attribution: [{ email: "cash.l@w6.example", share: 50 }, { email: "cash.k@w6.example", share: 50 }], reason: "helped at the till" })).error);
  sum = await C.commissionSummary({ orgId: ORG, membership: mgrL, month: today.slice(0, 7) });
  assert.equal(sum.people.find((p) => p.email === "cash.k@w6.example").commission, 50);
  assert.equal(sum.people.reduce((n, p) => n + p.commission, 0), 100, "split commissions still reconcile to the sale");
  // a refund reverses the commission on what came back
  const rf = await RET.processReturn({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { saleId: s1.sale.id, lines: [{ lineIndex: 0, quantity: 1 }], idempotencyKey: SALE.newIdempotencyKey(), reason: "faulty kettle" } }); assert.ok(!rf.error, rf.error);
  await C.accrueSale({ orgId: ORG, saleId: s1.sale.id }); sum = await C.commissionSummary({ orgId: ORG, membership: mgrL, month: today.slice(0, 7) });
  assert.equal(sum.people.reduce((n, p) => n + p.commission, 0), 50, "half the kettles came back, half the commission reversed");
  // approval: someone paid commission this month can't approve it
  assert.equal((await C.approvePeriod({ orgId: ORG, membership: { ...cashierL, commerceRole: "manager" }, actorEmail: cashierL.email, month: today.slice(0, 7) })).code, "SELF_APPROVAL");
  assert.ok((await C.approvePeriod({ orgId: ORG, membership: mgrL2, actorEmail: mgrL2.email, month: today.slice(0, 7) })).ok);
  assert.match((await C.setAttribution({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, saleId: s1.sale.id, attribution: [{ email: "cash.l@w6.example", share: 100 }], reason: "late change" })).error, /already approved/, "an approved month is locked");
  assert.match((await C.exportPeriod({ orgId: ORG, membership: mgrL2, month: today.slice(0, 7) })).csv, /cash\.l@w6\.example/);
  // tips by hours worked that day
  const dd = today; const n0 = new Date(`${dd}T08:00:00Z`);
  await T.punch({ orgId: ORG, membership: mgrL, type: "CLOCK_IN", locationId: L, idempotencyKey: key(), now: n0 }); await T.punch({ orgId: ORG, membership: mgrL, type: "CLOCK_OUT", locationId: L, idempotencyKey: key(), now: new Date(n0.getTime() + 2 * 3600000) });
  const tips = await C.allocateTips({ orgId: ORG, membership: mgrL2, actorEmail: mgrL2.email, locationId: L, date: dd, amount: 300 }); assert.ok(!tips.error, tips.error);
  assert.equal(tips.allocation.reduce((n, x) => n + x.amount, 0), 300, "every rupee of the pool is allocated");
});

test("checklists and incidents are branch-scoped; sign-off needs every item; reports label estimated labour cost; AI only advises", { timeout: 120000 }, async () => {
  const L = String(lhr), Kh = String(khi);
  assert.ok((await C.saveChecklist({ orgId: ORG, membership: mgrL, actorEmail: mgrL.email, input: { name: "Opening", type: "OPENING", items: ["Lights on", "Till float counted"], locationId: L, dueTime: "00:01" } })).ok);
  assert.equal((await C.branchChecklists({ orgId: ORG, membership: cashierL, locationId: Kh })).code, "BRANCH_SCOPE");
  const list = await C.branchChecklists({ orgId: ORG, membership: cashierL, locationId: L }); const op = list.checklists.find((x) => x.name === "Opening"); assert.ok(op);
  assert.match((await C.tickChecklist({ orgId: ORG, membership: cashierL, actorEmail: cashierL.email, templateId: op.templateId, locationId: L, ticks: [true, false], signOff: true })).error, /every item/);
  assert.ok((await C.tickChecklist({ orgId: ORG, membership: cashierL, actorEmail: cashierL.email, templateId: op.templateId, locationId: L, ticks: [true, true], signOff: true })).ok);
  assert.equal((await C.branchChecklists({ orgId: ORG, membership: cashierL, locationId: L })).checklists.find((x) => x.name === "Opening").state, "DONE");
  assert.equal((await C.reportIncident({ orgId: ORG, membership: cashierL, actorEmail: cashierL.email, input: { locationId: Kh, summary: "Spill in aisle 3" } })).code, "BRANCH_SCOPE");
  const inc = await C.reportIncident({ orgId: ORG, membership: cashierL, actorEmail: cashierL.email, input: { locationId: L, summary: "Spill in aisle 3", severity: "LOW" } }); assert.ok(inc.id);
  assert.equal((await C.listIncidents({ orgId: ORG, membership: { ...cashierK, locationIds: [khi] } })).incidents.length, 0, "Karachi staff don't see Lahore incidents");
  const rep = await A.workforceReport({ orgId: ORG, membership: mgrL2, from: "2026-11-01T00:00:00Z", to: new Date(Date.now() + 86400000).toISOString() });
  assert.ok(rep.notes[0].includes("estimate"), "labour cost is labelled as an estimate"); assert.equal(rep.totals.labourCostComplete, false, "and flagged incomplete when some people have no hourly cost");
  const before = await c.db.collection("calendar_records").countDocuments({ orgId, kind: "w_shift" });
  const brief = await A.operationsBrief({ orgId: ORG, membership: mgrL, locationId: L }); assert.equal(brief.advisoryOnly, true); assert.ok(brief.summary.length >= 1);
  assert.equal(await c.db.collection("calendar_records").countDocuments({ orgId, kind: "w_shift" }), before, "the assistant changed nothing");
  assert.equal((await A.workforceReport({ orgId: ORG, membership: cashierL })).status, 403);
});

test("branch scoping on existing screens: POS sales, registers, shifts, reports, stock and sales orders only show the member's branches", { timeout: 120000 }, async () => {
  const { branchGuard } = await import("../src/lib/workforce/branchGuard.js");
  const SH = await import("../src/lib/commerce/shifts.js"); const REP = await import("../src/lib/commerce/reports.js");
  const { getAccessibleScope } = await import("../src/lib/document-permissions.js");
  const L = String(lhr), Kh = String(khi);
  // a Karachi sale exists alongside the Lahore sales from the commissions test
  const k = await SALE.completeSale({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { warehouseId: Kh, idempotencyKey: SALE.newIdempotencyKey(), lines: [{ productId: String(prod), quantity: 1 }], tenders: [{ method: "CASH", amount: 5000 }] } });
  assert.ok(!k.error, k.error);
  // direct and indirect (register, shift, sale) branch checks
  assert.equal(await branchGuard({ orgId: ORG, membership: cashierL, warehouseIds: [L] }), null);
  assert.equal((await branchGuard({ orgId: ORG, membership: cashierL, warehouseIds: [Kh] })).code, "BRANCH_SCOPE");
  assert.equal((await branchGuard({ orgId: ORG, membership: cashierL, saleId: k.sale.id })).code, "BRANCH_SCOPE", "can't open or refund another branch's sale");
  assert.equal(await branchGuard({ orgId: ORG, membership: owner, warehouseIds: [Kh], saleId: k.sale.id }), null, "owner sees every branch");
  const rk = await SH.saveRegister({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { code: "K1", name: "Karachi till", warehouseId: Kh } }); assert.ok(!rk.error, rk.error);
  const rl = await SH.saveRegister({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { code: "L1", name: "Lahore till", warehouseId: L } }); assert.ok(!rl.error, rl.error);
  assert.equal((await branchGuard({ orgId: ORG, membership: cashierL, registerId: rk.id })).code, "BRANCH_SCOPE", "can't open a shift on another branch's till");
  // list reads are filtered
  const regs = await SH.listRegisters({ orgId: ORG, membership: cashierL }); assert.deepEqual(regs.registers.map((r) => r.name), ["Lahore till"]);
  const sales = await SALE.listSales({ orgId: ORG, membership: cashierL }); assert.ok(sales.sales.length > 0); assert.ok(sales.sales.every((s) => s.warehouseId === L), "only Lahore sales");
  assert.ok((await SALE.listSales({ orgId: ORG, membership: owner })).sales.some((s) => s.warehouseId === Kh));
  const repAll = await REP.commerceReport({ orgId: ORG, membership: owner, input: { period: "custom", from: "2026-06-01", to: "2027-01-31" } });
  const repL = await REP.commerceReport({ orgId: ORG, membership: mgrL, input: { period: "custom", from: "2026-06-01", to: "2027-01-31" } });
  assert.ok(!repAll.error && !repL.error, repAll.error || repL.error);
  assert.ok(JSON.stringify(repL).includes("Lahore") && !JSON.stringify(repL).includes("Karachi"), "the Lahore manager's report has no Karachi figures");
  assert.ok(JSON.stringify(repAll).includes("Karachi"));
  // stock screens: warehouses list
  const sc = await getAccessibleScope({ orgId: ORG, membership: cashierL, email: cashierL.email });
  assert.deepEqual(sc.visibleWarehouses.map((w) => w.name), ["Lahore"]);
  assert.equal((await getAccessibleScope({ orgId: ORG, membership: owner, email: owner.email })).visibleWarehouses.length, 2);
});
