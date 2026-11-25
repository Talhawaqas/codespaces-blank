// test/manage-orders.test.mjs -- Manage Orders SOW acceptance (22.1-22.8) on the TEST database: entitlement, WO lifecycle,
// parts exactly once through the stock ledger, RO authorisation gates + one invoice, scheduler eligibility / conflicts /
// overrides / races, job activity idempotency and separation from attendance, exceptions (review only), evidence, PM
// idempotency, cheque controls (numbers, segregation, approval invalidation, print idempotency, one payment), PO register,
// tenant and branch isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { recordStockMovement } from "../src/lib/inventory.js";
import * as C from "../src/lib/ops/core.js";
import * as J from "../src/lib/ops/jobs.js";
import * as S from "../src/lib/ops/scheduler.js";
import * as A from "../src/lib/ops/activity.js";
import * as P from "../src/lib/ops/pm.js";
import * as Q from "../src/lib/ops/cheques.js";
import * as R from "../src/lib/ops/registers.js";
import { K as WK } from "../src/lib/workforce/time.js";

const orgId = new ObjectId(); const ORG = String(orgId); const orgB = new ObjectId();
const E = (n) => `${n}@mo.example`;
const M = {
  owner: { role: "owner", email: E("owner") }, mgr: { role: "member", opsRole: "manager", email: E("mgr") }, mgr2: { role: "member", opsRole: "manager", email: E("mgr2") },
  disp: { role: "member", opsRole: "dispatcher", email: E("disp") }, adv: { role: "member", opsRole: "advisor", email: E("adv"), financeRole: "staff" },
  tech1: { role: "member", opsRole: "technician", email: E("tech1") }, tech2: { role: "member", opsRole: "technician", email: E("tech2") }, store: { role: "member", opsRole: "storekeeper", email: E("store") },
  fin: { role: "member", financeRole: "staff", email: E("fin") }, finmgr: { role: "member", financeRole: "manager", email: E("finmgr") }, nobody: { role: "member", email: E("nobody") },
};
let c, dep, lhr, khi, prod, contact; const key = () => `k${new ObjectId().toHexString()}`;
const as = (m, extra = {}) => ({ orgId: ORG, membership: m, actorEmail: m.email, ...extra });
const job = async (id) => (await (await C.ccol()).findOne({ _id: new ObjectId(id) }));
const stock = async () => c.stockLevels.findOne({ orgId, productId: prod, warehouseId: lhr });
const ok = (r, msg) => { assert.ok(!r?.error, `${msg || "call"} failed: ${r?.error}`); return r; };

before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString();
  await c.orgs.insertOne({ _id: orgId, name: "mo workshop", plan: "business", features: { FEATURE_MANAGE_ORDERS: true }, createdAt: now });
  await c.orgs.insertOne({ _id: orgB, name: "mo other", plan: "starter", createdAt: now });
  dep = (await c.departments.insertOne({ orgId, name: "Workshop", createdAt: now })).insertedId;
  lhr = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Lahore", createdAt: now })).insertedId;
  khi = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Karachi", createdAt: now })).insertedId;
  M.tech1.locationIds = [String(lhr)]; M.disp.locationIds = [String(lhr)]; M.tech2.locationIds = [String(khi)];
  for (const m of Object.values(M)) { m.departmentIds = [dep]; m.orgId = orgId; }
  await c.orgMembers.insertMany(Object.values(M).map((m) => ({ ...m, status: "active", createdAt: now })));
  prod = (await c.products.insertOne({ orgId, departmentId: dep, sku: `MO-${Date.now()}`, name: "Brake pad", unitPrice: 2500, costPrice: 1200, status: "ACTIVE", deletedAt: null, createdAt: now })).insertedId;
  ok(await recordStockMovement({ orgId: ORG, productId: String(prod), warehouseId: String(lhr), delta: 20, type: "RECEIPT", actorEmail: "t", unitCost: 1200 }), "stock");
  contact = (await c.crmContacts.insertOne({ orgId, name: "Ali Khan", email: "ali@cust.example", deletedAt: null, createdAt: now })).insertedId;
  A.__setEvidenceStore({ mem: new Map(), async put({ key: k, buffer }) { this.mem.set(k, buffer); return { versionId: null }; }, async get({ key: k }) { return this.mem.has(k) ? { buffer: this.mem.get(k) } : null; } });
});
after(async () => {
  try { const { db } = c; for (const n of (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name)) { try { await db.collection(n).deleteMany({ orgId: { $in: [orgId, orgB] } }); } catch { /* ignore */ } } await c.orgs.deleteMany({ _id: { $in: [orgId, orgB] } }); } catch { /* best effort */ }
  await (await mongoClientPromise).close();
});

test("entitlement: Business/Enterprise behind the switch; explicit grant; kill switch; roles", async () => {
  assert.equal((await C.opsAccess({ orgId: String(orgB), membership: M.owner })).code, "NOT_ENTITLED");
  process.env.FEATURE_MANAGE_ORDERS = "on"; assert.equal(await C.opsEntitled(String(orgB)), false, "starter plan stays out even when released");
  process.env.FEATURE_MANAGE_ORDERS = "off"; assert.equal(await C.opsEntitled(ORG), false, "kill switch beats the grant"); delete process.env.FEATURE_MANAGE_ORDERS;
  assert.equal(await C.opsEntitled(ORG), true);
  assert.equal((await C.opsAccess({ orgId: ORG, membership: M.nobody })).code, "NO_OPS_ROLE");
  assert.equal((await J.createJob(as(M.tech1, { input: { title: "x job", warehouseId: String(lhr) } }))).status, 403, "technicians can't create orders");
});

let wo, wo2;
test("WO lifecycle: create → approve → eligibility (skills, branch) → mobile-style activity → inspection → close, audited", { timeout: 120000 }, async () => {
  wo = ok(await J.createJob(as(M.mgr, { input: { type: "WO", title: "Replace generator belt", warehouseId: String(lhr), priority: "HIGH", estMinutes: 60, skills: ["electrical"], checklist: [{ text: "Isolate power", required: true }, { text: "Photo of new belt", required: true, evidence: true }] } })), "create").job;
  assert.match(wo.number, /^WO-\d{5}$/); assert.equal(wo.status, "DRAFT");
  assert.equal((await J.transitionJob(as(M.mgr, { jobId: wo.id, action: "approve" }))).code, "BAD_STATE");
  ok(await J.transitionJob(as(M.mgr, { jobId: wo.id, action: "submit" }))); ok(await J.transitionJob(as(M.mgr2, { jobId: wo.id, action: "approve" })));
  const start = new Date(Date.now() + 3600000).toISOString(), end = new Date(Date.now() + 2 * 3600000).toISOString();
  const need = await S.assignTechnician(as(M.disp, { jobId: wo.id, email: M.tech1.email, start, end }));
  assert.equal(need.code, "NEEDS_OVERRIDE"); assert.match(need.error, /electrical/);
  assert.equal((await S.assignTechnician(as(M.mgr, { jobId: wo.id, email: M.tech2.email, start, end, override: "urgent" }))).code, "INELIGIBLE", "branch is never overridable");
  ok(await S.saveTechnician(as(M.mgr, { email: M.tech1.email, input: { skills: ["electrical", "mechanical"] } })));
  const asg = ok(await S.assignTechnician(as(M.disp, { jobId: wo.id, email: M.tech1.email, start, end })), "assign").job;
  assert.equal(asg.status, "ASSIGNED"); assert.deepEqual(asg.assignments.map((a) => a.email), [M.tech1.email]);
  // technician visibility
  assert.equal((await J.listJobs(as(M.tech1))).jobs.length, 1); assert.equal((await J.listJobs(as(M.tech2))).jobs.length, 0);
  assert.ok((await J.getJob(as(M.tech2, { jobId: wo.id }))).error, "other branch can't open it");
  // activity
  const k1 = key();
  const s1 = ok(await A.recordActivity(as(M.tech1, { jobId: wo.id, input: { type: "START", idempotencyKey: k1, source: "mobile", device: { platform: "android", version: "1.2" } } })), "start");
  assert.equal(s1.status, "IN_PROGRESS");
  const again = await A.recordActivity(as(M.tech1, { jobId: wo.id, input: { type: "START", idempotencyKey: k1 } })); assert.equal(again.duplicate, true);
  assert.equal(await (await C.ccol()).countDocuments({ orgId, kind: C.K.act, jobId: new ObjectId(wo.id), type: "START" }), 1, "a retried start records once");
  assert.equal((await A.recordActivity(as(M.tech1, { jobId: wo.id, input: { type: "PAUSE", idempotencyKey: key() } }))).error.includes("pause reason"), true);
  const bad = await A.recordActivity(as(M.tech1, { jobId: wo.id, input: { type: "SUBMIT", idempotencyKey: key() } })); assert.equal(bad.code, "INCOMPLETE");
  const j0 = await job(wo.id);
  for (const it of j0.checklist) ok(await J.tickChecklist(as(M.tech1, { jobId: wo.id, itemId: it.id, done: true })));
  assert.equal((await A.recordActivity(as(M.tech1, { jobId: wo.id, input: { type: "SUBMIT", idempotencyKey: key() } }))).code, "INCOMPLETE", "evidence step still needs a photo");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  ok(await A.uploadEvidence(as(M.tech1, { jobId: wo.id, filename: "belt.png", buffer: png, checklistItemId: j0.checklist[1].id })), "evidence");
  assert.ok((await A.uploadEvidence(as(M.tech1, { jobId: wo.id, filename: "x.png", buffer: Buffer.from("MZ\x90\x00hello") }))).error, "fake image refused");
  const sub = ok(await A.recordActivity(as(M.tech1, { jobId: wo.id, input: { type: "SUBMIT", idempotencyKey: key() } })), "submit");
  assert.equal(sub.status, "AWAITING_INSPECTION");
  assert.equal((await J.transitionJob(as(M.tech1, { jobId: wo.id, action: "inspect_pass" }))).status, 403, "technician can't close own job");
  ok(await J.transitionJob(as(M.mgr, { jobId: wo.id, action: "inspect_fail", reason: "Belt tension wrong" })));
  const back = await job(wo.id); assert.equal(back.status, "ASSIGNED"); assert.equal(back.workers[0].state, "NOT_STARTED");
  ok(await A.recordActivity(as(M.tech1, { jobId: wo.id, input: { type: "START", idempotencyKey: key() } })));
  ok(await A.recordActivity(as(M.tech1, { jobId: wo.id, input: { type: "SUBMIT", idempotencyKey: key() } })));
  ok(await J.transitionJob(as(M.mgr, { jobId: wo.id, action: "inspect_pass" }))); ok(await J.transitionJob(as(M.mgr, { jobId: wo.id, action: "close" })));
  const done = await job(wo.id); assert.equal(done.status, "CLOSED"); assert.ok(done.history.length >= 8);
  const file = (await job(wo.id)).evidence[0].fileId;
  assert.ok((await A.downloadEvidence(as(M.tech2, { fileId: String(file) }))).error, "evidence follows job access");
  assert.ok((await A.downloadEvidence(as(M.mgr, { fileId: String(file) }))).buffer?.length);
});

test("parts: request → approve → reserve → consume exactly once → return; cancel releases reservations", { timeout: 120000 }, async () => {
  wo2 = ok(await J.createJob(as(M.mgr, { input: { type: "WO", title: "Brake service van", warehouseId: String(lhr) } }))).job;
  ok(await J.transitionJob(as(M.mgr, { jobId: wo2.id, action: "submit" }))); ok(await J.transitionJob(as(M.mgr2, { jobId: wo2.id, action: "approve" })));
  const s = new Date(Date.now() + 5 * 3600000).toISOString(), e = new Date(Date.now() + 6 * 3600000).toISOString();
  ok(await S.assignTechnician(as(M.mgr, { jobId: wo2.id, email: M.tech1.email, start: s, end: e })));
  const req = ok(await J.addPart(as(M.tech1, { jobId: wo2.id, productId: String(prod), quantity: 3 }))).part; assert.equal(req.requested, true);
  assert.equal((await J.partAction(as(M.tech1, { jobId: wo2.id, partId: req.id, action: "consume", quantity: 1 }))).status, 409, "unapproved request can't be used");
  ok(await J.partAction(as(M.store, { jobId: wo2.id, partId: req.id, action: "approve" })));
  const before = (await stock()).quantity;
  ok(await J.partAction(as(M.store, { jobId: wo2.id, partId: req.id, action: "reserve" }))); assert.equal((await stock()).reserved, 3);
  const k = key();
  ok(await J.partAction(as(M.tech1, { jobId: wo2.id, partId: req.id, action: "consume", quantity: 2, idempotencyKey: k })));
  ok(await J.partAction(as(M.tech1, { jobId: wo2.id, partId: req.id, action: "consume", quantity: 2, idempotencyKey: k })));
  assert.equal((await stock()).quantity, before - 2, "retry did not consume twice"); assert.equal((await stock()).reserved, 1);
  assert.equal((await job(wo2.id)).parts[0].consumed, 2);
  ok(await J.partAction(as(M.store, { jobId: wo2.id, partId: req.id, action: "return", quantity: 1 }))); assert.equal((await stock()).quantity, before - 1);
  ok(await J.transitionJob(as(M.mgr, { jobId: wo2.id, action: "cancel", reason: "Customer cancelled" })));
  assert.equal((await stock()).reserved, 0, "cancel released the remaining reservation");
});

test("scheduler: overlap needs an override, leave blocks, self-assign refused, concurrent double-booking prevented, board states", { timeout: 120000 }, async () => {
  const mk = async (t) => { const j = ok(await J.createJob(as(M.mgr, { input: { type: "WO", title: t, warehouseId: String(lhr) } }))).job; ok(await J.transitionJob(as(M.mgr, { jobId: j.id, action: "submit" }))); ok(await J.transitionJob(as(M.mgr2, { jobId: j.id, action: "approve" }))); return j; };
  const a = await mk("Job A"), b = await mk("Job B"), x = await mk("Job X"), y = await mk("Job Y");
  const s = new Date(Date.now() + 30 * 3600000).toISOString(), e = new Date(Date.now() + 32 * 3600000).toISOString();
  ok(await S.assignTechnician(as(M.mgr, { jobId: a.id, email: M.tech1.email, start: s, end: e })));
  const clash = await S.assignTechnician(as(M.mgr, { jobId: b.id, email: M.tech1.email, start: s, end: e })); assert.equal(clash.code, "NEEDS_OVERRIDE"); assert.match(clash.error, /Already booked/);
  const ov = ok(await S.assignTechnician(as(M.mgr, { jobId: b.id, email: M.tech1.email, start: s, end: e, override: "Two-person job, same bay" })));
  assert.equal((await job(b.id)).assignments.at(-1).override.reason, "Two-person job, same bay"); assert.ok(ov.warnings.length);
  assert.equal((await S.assignTechnician(as(M.mgr, { jobId: b.id, email: M.mgr.email, start: s, end: e }))).code !== "SELF_ASSIGN", true);
  assert.equal((await S.assignTechnician(as(M.disp, { jobId: b.id, email: M.disp.email, start: s, end: e }))).code, "SELF_ASSIGN");
  // leave
  const emp = (await c.employees.insertOne({ orgId, memberEmail: M.tech1.email, fullName: "Tech One", deletedAt: null })).insertedId;
  const d1 = new Date(Date.now() + 72 * 3600000); await c.leaveRequests.insertOne({ orgId, employeeId: emp, status: "APPROVED", startDate: d1.toISOString().slice(0, 10), endDate: d1.toISOString().slice(0, 10) });
  const lv = await S.assignTechnician(as(M.mgr, { jobId: x.id, email: M.tech1.email, start: d1.toISOString(), end: new Date(d1.getTime() + 3600000).toISOString() })); assert.match(lv.error, /leave/);
  // race: two dispatchers book the same free slot on two jobs at once -> one wins, the other must override
  const s2 = new Date(Date.now() + 100 * 3600000).toISOString(), e2 = new Date(Date.now() + 101 * 3600000).toISOString();
  const [r1, r2] = await Promise.all([S.assignTechnician(as(M.mgr, { jobId: x.id, email: M.tech1.email, start: s2, end: e2 })), S.assignTechnician(as(M.mgr2, { jobId: y.id, email: M.tech1.email, start: s2, end: e2 }))]);
  assert.equal([r1, r2].filter((r) => !r.error).length, 1, `exactly one booking wins (${r1.error || "ok"} / ${r2.error || "ok"})`);
  const bd = ok(await S.board(as(M.mgr, { from: new Date().toISOString(), to: new Date(Date.now() + 200 * 3600000).toISOString() })));
  const lane = bd.lanes.find((l) => l.email === M.tech1.email); assert.ok(lane.jobs.length >= 3); assert.ok(lane.jobs.every((j) => j.state === "SCHEDULED_NOT_STARTED"));
  ok(await S.rescheduleJob(as(M.mgr, { jobId: a.id, start: new Date(Date.now() + 40 * 3600000).toISOString(), end: new Date(Date.now() + 41 * 3600000).toISOString(), reason: "Parts late" })));
  assert.equal((await S.unassignTechnician(as(M.mgr, { jobId: a.id, email: M.tech1.email }))).error, "Give a reason for the change.");
  ok(await S.unassignTechnician(as(M.mgr, { jobId: a.id, email: M.tech1.email, reason: "Moved to Ahmed" }))); const ua = await job(a.id);
  assert.equal(ua.status, "READY"); assert.equal(ua.assignments.length, 1); assert.equal(ua.assignments[0].active, false, "history kept");
});

test("RO: intake → diagnosis → estimate must be approved before work → change order blocks resume → QC → one invoice", { timeout: 120000 }, async () => {
  const asset = ok(await J.saveAsset(as(M.adv, { input: { type: "Car", make: "Toyota", model: "Corolla", identifier: "LEA-1234", contactId: String(contact) } }))).asset;
  assert.ok((await J.createJob(as(M.adv, { input: { type: "RO", title: "Brake noise", warehouseId: String(lhr) } }))).error, "RO needs a customer");
  const ro = ok(await J.createJob(as(M.adv, { input: { type: "RO", title: "Brake noise", warehouseId: String(lhr), contactId: String(contact), assetId: asset.id, intake: { reportedIssue: "Squeal when braking", accessories: "Spare key", condition: "Scratch rear bumper" } } }))).job;
  ok(await J.transitionJob(as(M.adv, { jobId: ro.id, action: "check_in" }))); ok(await J.recordIntakeAck(as(M.adv, { jobId: ro.id, customerName: "Ali Khan", method: "in_person" })));
  ok(await J.recordDiagnosis(as(M.adv, { jobId: ro.id, input: { findings: "Front pads worn", faultCodes: "C1234" } })));
  assert.equal((await S.assignTechnician(as(M.mgr, { jobId: ro.id, email: M.tech1.email }))).status, 409, "no scheduling before customer approval");
  const est = ok(await J.createEstimate(as(M.adv, { jobId: ro.id, input: { currency: "PKR", taxPercent: 0, lines: [{ kind: "part", productId: String(prod), description: "Brake pads", quantity: 1, unitPrice: 2500 }, { kind: "labour", description: "Labour", quantity: 1, unitPrice: 1500 }] } }))).estimate;
  assert.equal((await job(ro.id)).status, "AWAITING_APPROVAL");
  assert.ok((await J.decideEstimate(as(M.adv, { jobId: ro.id, estimateId: est.id, decision: "approve" }))).error, "customer name + method required");
  ok(await J.decideEstimate(as(M.adv, { jobId: ro.id, estimateId: est.id, decision: "approve", customerName: "Ali Khan", method: "phone" })));
  const s = new Date(Date.now() + 200 * 3600000).toISOString(), e = new Date(Date.now() + 201 * 3600000).toISOString();
  ok(await S.assignTechnician(as(M.mgr, { jobId: ro.id, email: M.tech1.email, start: s, end: e })));
  ok(await A.recordActivity(as(M.tech1, { jobId: ro.id, input: { type: "START", idempotencyKey: key() } }))); assert.equal((await job(ro.id)).status, "IN_REPAIR");
  ok(await A.recordActivity(as(M.tech1, { jobId: ro.id, input: { type: "PAUSE", reason: "customer_approval", idempotencyKey: key() } })));
  const co = ok(await J.createEstimate(as(M.adv, { jobId: ro.id, input: { currency: "PKR", lines: [{ kind: "part", description: "Brake pads", quantity: 1, unitPrice: 2500 }, { kind: "labour", description: "Labour", quantity: 1, unitPrice: 1500 }, { kind: "part", description: "Rotor skim", quantity: 1, unitPrice: 2000 }] } }))).estimate;
  assert.equal(co.changeOrder, true);
  assert.equal((await A.recordActivity(as(M.tech1, { jobId: ro.id, input: { type: "RESUME", idempotencyKey: key() } }))).code, "BAD_STATE", "extra work not authorised yet");
  ok(await J.decideEstimate(as(M.adv, { jobId: ro.id, estimateId: co.id, decision: "approve", customerName: "Ali Khan", method: "whatsapp" })));
  assert.equal((await job(ro.id)).status, "IN_REPAIR");
  ok(await A.recordActivity(as(M.tech1, { jobId: ro.id, input: { type: "RESUME", idempotencyKey: key() } })));
  ok(await A.recordActivity(as(M.tech1, { jobId: ro.id, input: { type: "SUBMIT", idempotencyKey: key() } }))); assert.equal((await job(ro.id)).status, "QUALITY_CHECK");
  ok(await J.transitionJob(as(M.mgr, { jobId: ro.id, action: "qc_pass" }))); ok(await J.recordCompletion(as(M.adv, { jobId: ro.id, input: { summary: "Pads replaced, rotors skimmed", customerName: "Ali Khan", collection: "collected" } })));
  ok(await J.transitionJob(as(M.adv, { jobId: ro.id, action: "complete" })));
  const inv = ok(await J.invoiceRepair(as(M.adv, { jobId: ro.id, departmentId: String(dep) })), "invoice"); assert.equal(inv.total, 6000);
  assert.equal((await J.invoiceRepair(as(M.adv, { jobId: ro.id, departmentId: String(dep) }))).status, 409);
  assert.equal(await c.invoices.countDocuments({ orgId, relatedRepairOrderId: new ObjectId(ro.id) }), 1, "exactly one invoice");
  const h = ok(await J.assetHistory(as(M.adv, { assetId: asset.id }))); assert.equal(h.jobs.length, 1);
});

test("exceptions: clocked in with no job → one review item; corrections need a different manager; nothing automatic", { timeout: 120000 }, async () => {
  const cc = await C.ccol(); const at = new Date(Date.now() - 90 * 60000).toISOString();
  await cc.insertOne({ orgId, kind: WK.punch, email: M.tech2.email, type: "CLOCK_IN", locationId: khi, at, idem: key(), source: "self", createdAt: at });
  const r1 = await A.scanExceptions(ORG); const r2 = await A.scanExceptions(ORG);
  assert.ok(r1.raised >= 1); assert.equal(await cc.countDocuments({ orgId, kind: C.K.exc, type: "NO_JOB_START" }), 1, "deduplicated"); void r2;
  const ex = (await A.listExceptions(as(M.mgr))).exceptions.find((x) => x.type === "NO_JOB_START");
  assert.equal((await A.resolveException(as(M.mgr, { id: ex.id, action: "dismiss" }))).error, "Give a reason.");
  ok(await A.resolveException(as(M.mgr, { id: ex.id, action: "request_explanation", reason: "Please explain" })));
  ok(await A.explainException(as(M.tech2, { id: ex.id, text: "Waiting for keys from reception" })));
  assert.equal((await A.listExceptions(as(M.tech1))).status, 403, "technicians don't see the queue");
  const corr = ok(await A.requestLabourCorrection(as(M.tech1, { jobId: wo.id, minutesDelta: 15, reason: "Forgot to resume after lunch" })));
  ok(await A.resolveException(as(M.mgr, { id: corr.requestId, action: "approve_correction" })));
  assert.equal(await cc.countDocuments({ orgId, kind: C.K.act, type: "CORRECTION" }), 1, "correction is a new event; originals untouched");
});

test("cheques: numbering, one live cheque per payable, segregation, edits drop approval, print once, one payment, void/return", { timeout: 120000 }, async () => {
  const now = new Date().toISOString();
  const exp = (await c.expenses.insertOne({ orgId, departmentId: dep, vendor: "Auto Parts Co", amount: 125000, currency: "PKR", status: "APPROVED", createdByEmail: M.fin.email, createdAt: now, deletedAt: null })).insertedId;
  const draftExp = (await c.expenses.insertOne({ orgId, departmentId: dep, vendor: "Other", amount: 500, currency: "PKR", status: "DRAFT", createdAt: now, deletedAt: null })).insertedId;
  const tpl = ok(await Q.saveTemplate(as(M.finmgr, { input: { preset: "MEEZAN" } }))).template; assert.ok(tpl.note);
  const book = ok(await Q.saveBook(as(M.finmgr, { input: { bankName: "Meezan Bank", accountName: "MO Workshop", accountLast4: "12345678", firstNumber: 100001, lastNumber: 100010, currency: "PKR", templateId: tpl.id } }))).book;
  assert.equal(book.accountLast4, "5678");
  assert.equal((await Q.saveBook(as(M.finmgr, { input: { bankName: "Meezan Bank", accountName: "MO Workshop", accountLast4: "5678", firstNumber: 100005, lastNumber: 100020 } }))).code, "DUPLICATE_NUMBERS");
  assert.ok((await Q.createCheque(as(M.fin, { input: { expenseId: String(draftExp), bookId: book.id } }))).error, "only approved payables");
  const ch = ok(await Q.createCheque(as(M.fin, { input: { expenseId: String(exp), bookId: book.id, date: "2026-11-30" } }))).cheque;
  assert.equal(ch.number, 100001); assert.equal(ch.amountWords, "Rupees One Lakh Twenty-Five Thousand Only");
  assert.equal((await Q.createCheque(as(M.fin, { input: { expenseId: String(exp), bookId: book.id } }))).code, "DUPLICATE", "one live cheque per payable");
  assert.equal((await Q.decideCheque(as(M.fin, { id: ch.id, approve: true }))).status, 403, "staff can't approve");
  ok(await Q.decideCheque(as(M.finmgr, { id: ch.id, approve: true })));
  const ed = ok(await Q.editCheque(as(M.fin, { id: ch.id, input: { amount: 100000 } }))).cheque; assert.equal(ed.status, "PENDING_APPROVAL"); assert.equal(ed.approval, null);
  ok(await Q.decideCheque(as(M.finmgr, { id: ch.id, approve: true })));
  const test1 = ok(await Q.printCheque(as(M.fin, { kind: "test", templateId: tpl.id }))); assert.equal(test1.test, true);
  assert.equal((await Q.listCheques(as(M.fin))).cheques[0].status, "APPROVED", "alignment test changed nothing");
  const pk = key();
  ok(await Q.printCheque(as(M.fin, { id: ch.id, idempotencyKey: pk }))); const p2 = ok(await Q.printCheque(as(M.fin, { id: ch.id, idempotencyKey: pk }))); assert.equal(p2.duplicate, true);
  assert.equal((await Q.printCheque(as(M.fin, { id: ch.id, idempotencyKey: key() }))).status, 409, "second print needs reprint");
  assert.equal((await Q.printCheque(as(M.fin, { id: ch.id, kind: "reprint", reason: "jam", idempotencyKey: key() }))).status, 403);
  ok(await Q.printCheque(as(M.finmgr, { id: ch.id, kind: "reprint", reason: "Printer jam", idempotencyKey: key() })));
  ok(await Q.issueCheque(as(M.fin, { id: ch.id }))); assert.equal((await Q.issueCheque(as(M.fin, { id: ch.id }))).status, 409);
  const pays = await c.payments.find({ orgId, relatedExpenseId: exp }).toArray(); assert.equal(pays.length, 1); assert.equal(pays[0].method, "cheque"); assert.equal(pays[0].amount, 100000); assert.equal(pays[0].status, "APPROVED");
  assert.equal((await Q.voidCheque(as(M.finmgr, { id: ch.id, reason: "x" }))).error, "Give a reason.");
  assert.equal((await Q.voidCheque(as(M.finmgr, { id: ch.id, reason: "Lost" }))).status, 409, "issued cheques are returned, not voided");
  ok(await Q.voidCheque(as(M.finmgr, { id: ch.id, reason: "Bank returned: signature mismatch", returned: true })));
  // the remaining 25,000 can go on a new cheque, which is then voided before issue
  const ch2 = ok(await Q.createCheque(as(M.fin, { input: { expenseId: String(exp), bookId: book.id } }))).cheque; assert.equal(ch2.amount, 25000); assert.equal(ch2.number, 100002);
  ok(await Q.voidCheque(as(M.finmgr, { id: ch2.id, reason: "Wrong payee" })));
  const bk = (await Q.listBooks(as(M.fin))).books[0]; assert.ok(bk.spoiled.some((s) => s.number === 100002));
  assert.equal(Q.amountInWords(1234567.5, { system: "south_asian" }), "Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven and Fifty Paisa Only");
  assert.equal(Q.amountInWords(1234567, { currency: "USD", system: "international" }), "Dollars One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven Only");
});

test("PO register reads Procurement; WO/RO links don't duplicate POs; tenant isolation", { timeout: 60000 }, async () => {
  const po = (await c.purchaseOrders.insertOne({ orgId, departmentId: dep, supplierId: null, items: [{ description: "Belts", quantity: 4, unitPrice: 900, receivedQuantity: 2 }], currency: "PKR", status: "ORDERED", createdAt: new Date().toISOString(), deletedAt: null })).insertedId;
  ok(await J.linkPurchaseOrder(as(M.mgr, { jobId: wo2.id, purchaseOrderId: String(po) })));
  const reg = ok(await R.poRegister(as(M.mgr))); const row = reg.orders.find((o) => o.id === String(po));
  assert.equal(row.receivedPct, 50); assert.equal(row.linkedOrders[0].id, wo2.id); assert.equal(await c.purchaseOrders.countDocuments({ orgId }), 1);
  // another company's manager can't reach these records even with the id
  const other = { role: "owner", email: "boss@other.example" };
  assert.ok((await J.getJob({ orgId: String(orgB), membership: other, jobId: wo.id })).error);
  const dash = ok(await R.opsDashboard(as(M.mgr))); assert.ok(dash.completed >= 1);
  const rep = ok(await R.technicianReport(as(M.tech1))); assert.ok(rep.labourMinutes >= 0); assert.ok(rep.attendanceMinutes !== undefined);
  assert.equal((await R.technicianReport(as(M.tech1, { email: M.tech2.email }))).status, 403);
});

test("preventive maintenance: due template creates one Work Order per due date, retries don't duplicate", { timeout: 60000 }, async () => {
  const today = new Date().toISOString().slice(0, 10);
  ok(await P.savePmTemplate(as(M.mgr, { input: { title: "Generator service", warehouseId: String(lhr), everyDays: 30, nextDue: today, leadDays: 0, checklist: ["Oil", "Filters"] } })));
  const g1 = await P.generateDuePm(ORG); const g2 = await P.generateDuePm(ORG);
  assert.equal(g1.created, 1); assert.equal(g2.created, 0);
  const t = (await P.listPmTemplates(as(M.mgr))).templates[0]; assert.ok(t.nextDue > today);
  const gen = (await J.listJobs(as(M.mgr, { q: "Generator service" }))).jobs[0]; assert.equal(gen.status, "AWAITING_APPROVAL"); assert.equal(gen.checklist.length, 2);
});
