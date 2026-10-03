// test/ai-actions-all-domains.test.mjs
//
// Phase 16 proof for AI Controlled Actions: for each of the nine domains, drive the whole life of an
// AI-proposed action against the real database and the real code, not stubs:
//
//   the AI tool proposes it -> it waits PENDING_APPROVAL -> the server-side approval gate lets an owner
//   approve it -> it is locked for 36 hours -> the execution sweep does NOTHING before the unlock ->
//   once unlocked the sweep runs the real transition -> the business record changes -> every step is in
//   the cryptographic audit chain, and the chain still verifies.
//
// The only simulated element is the clock: 36 real hours can't be waited out, so `unlockAt` is moved into
// the past on the approved request (exactly the field the sweep compares against `now`). Everything
// else, including the 36 h computed at approval, is asserted as the real code produced it.
//
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/ai-actions-all-domains.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { buildBusinessContext, runBusinessTool } from "../src/lib/ai-business-tools.js";
import { resolveCanApprove } from "../src/lib/ai-action-approval-gate.js";
import { reviewAiAction, executeApprovedAiActions, SETTLEMENT_DELAY_MS } from "../src/lib/ai-action-requests.js";
import { verifyChainIntegrity } from "../src/lib/auditChain.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN = randomUUID().slice(0, 6);
const NOW = new Date().toISOString();
let c, orgId, proposer, approver, proposerMembership, approverMembership, deptId, projectId, supplierId, contactId;
const ids = {};

before(async () => {
  await ensureOrgIndexes();
  c = await getOrgCollections();
  orgId = new ObjectId();
  proposer = `ai-prop-${RUN}@example.com`;
  approver = `ai-appr-${RUN}@example.com`;
  await c.orgs.insertOne({ _id: orgId, name: `ai-all-domains-${RUN}`, createdAt: NOW });
  await c.orgMembers.insertMany([
    { orgId, email: proposer, role: "owner", departmentIds: [], status: "active", createdAt: NOW },
    { orgId, email: approver, role: "owner", departmentIds: [], status: "active", createdAt: NOW },
  ]);
  proposerMembership = await c.orgMembers.findOne({ orgId, email: proposer });
  approverMembership = await c.orgMembers.findOne({ orgId, email: approver });
  deptId = (await c.departments.insertOne({ orgId, name: "Operations", createdAt: NOW })).insertedId;
  projectId = (await c.projects.insertOne({ orgId, departmentId: deptId, name: "Ops", createdAt: NOW, createdByEmail: proposer })).insertedId;
  supplierId = (await c.suppliers.insertOne({ orgId, departmentId: deptId, name: `Globex-${RUN}`, status: "ACTIVE", createdByEmail: proposer, createdAt: NOW, updatedAt: NOW, deletedAt: null })).insertedId;
  contactId = (await c.crmContacts.insertOne({ orgId, departmentId: deptId, type: "CUSTOMER", name: `Acme-${RUN}`, email: "a@acme.example", createdAt: NOW })).insertedId;

  ids.task = (await c.tasks.insertOne({ orgId, departmentId: deptId, projectId, title: `Ship release ${RUN}`, status: "TODO", priority: "MEDIUM", assigneeEmail: null, dueDate: null, createdAt: NOW, deletedAt: null })).insertedId;
  ids.expense = (await c.expenses.insertOne({ orgId, departmentId: deptId, vendor: `Cloudco-${RUN}`, category: "Software", amount: 100, currency: "USD", status: "PENDING_APPROVAL", expenseDate: NOW, createdAt: NOW, deletedAt: null })).insertedId;
  ids.document = (await c.orgDocuments.insertOne({ orgId, departmentId: deptId, projectId, filename: `policy-${RUN}.pdf`, fileHash: randomUUID(), status: "DRAFT", accessLevel: "DEPARTMENT", uploadedByEmail: proposer, cidAlpha: "x", cidBeta: "y", createdAt: NOW, deletedAt: null })).insertedId;
  ids.employee = (await c.employees.insertOne({ orgId, departmentId: deptId, memberEmail: null, fullName: `Dana Employee ${RUN}`, jobTitle: "Engineer", employmentStatus: "ONBOARDING", joiningDate: NOW, createdByEmail: proposer, createdAt: NOW, updatedAt: NOW, deletedAt: null })).insertedId;
  ids.leaveEmployee = (await c.employees.insertOne({ orgId, departmentId: deptId, memberEmail: null, fullName: `Lee Leave ${RUN}`, jobTitle: "Analyst", employmentStatus: "ACTIVE", joiningDate: NOW, annualLeaveAllocationDays: 20, createdByEmail: proposer, createdAt: NOW, updatedAt: NOW, deletedAt: null })).insertedId;
  ids.leave = (await c.leaveRequests.insertOne({ orgId, employeeId: ids.leaveEmployee, leaveType: "ANNUAL", startDate: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10), endDate: new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10), reason: null, status: "PENDING", approvedByEmail: null, createdAt: NOW, updatedAt: NOW })).insertedId;
  ids.invoice = (await c.invoices.insertOne({ orgId, departmentId: deptId, contactId, invoiceNumber: `INV-${RUN}`, issueDate: NOW, dueDate: NOW, lineItems: [{ description: "Services", quantity: 1, unitPrice: 500 }], subtotal: 500, total: 500, currency: "USD", status: "DRAFT", createdByEmail: proposer, createdAt: NOW, updatedAt: NOW, deletedAt: null })).insertedId;
  ids.po = (await c.purchaseOrders.insertOne({ orgId, departmentId: deptId, supplierId, sourceRequestId: null, items: [{ description: "Widgets", quantity: 10, unitPrice: 5 }], currency: "USD", status: "DRAFT", createdByEmail: proposer, createdAt: NOW, updatedAt: NOW, deletedAt: null })).insertedId;
  ids.pr = (await c.purchaseRequests.insertOne({ orgId, departmentId: deptId, supplierId: null, title: `Laptops ${RUN}`, description: null, estimatedCost: 3000, status: "DRAFT", createdByEmail: proposer, createdAt: NOW, updatedAt: NOW, deletedAt: null })).insertedId;
  ids.deal = (await c.crmDeals.insertOne({ orgId, departmentId: deptId, contactId, projectId, title: `Rollout ${RUN}`, value: 9000, status: "PROPOSAL", createdByEmail: proposer, createdAt: NOW, updatedAt: NOW, closedAt: null, deletedAt: null })).insertedId;
});

after(async () => {
  for (const k of ["orgMembers", "departments", "projects", "suppliers", "crmContacts", "tasks", "expenses", "orgDocuments", "employees", "leaveRequests", "invoices", "purchaseOrders", "purchaseRequests", "crmDeals", "aiActionRequests", "orgActivity", "auditChainEntries", "auditChainHeads", "businessEvents"]) {
    try { await c[k].deleteMany({ orgId }); } catch { /* collection may not exist in this env */ }
  }
  await c.db.collection("notifications").deleteMany({ orgId: String(orgId) }).catch(() => {});
  await c.orgs.deleteMany({ _id: orgId });
  await (await mongoClientPromise).close();
});

const DOMAINS = [
  { type: "TASK", tool: "propose_task_status_change", args: () => ({ taskTitle: `Ship release ${RUN}`, action: "start" }), check: async () => (await c.tasks.findOne({ _id: ids.task })).status === "IN_PROGRESS" },
  { type: "EXPENSE", tool: "propose_expense_decision", args: () => ({ expenseVendor: `Cloudco-${RUN}`, decision: "approve" }), check: async () => (await c.expenses.findOne({ _id: ids.expense })).status === "APPROVED" },
  { type: "DOCUMENT", tool: "propose_document_transition", args: () => ({ filename: `policy-${RUN}.pdf`, action: "submit" }), check: async () => (await c.orgDocuments.findOne({ _id: ids.document })).status === "PENDING" },
  { type: "EMPLOYEE", tool: "propose_employee_transition", args: () => ({ employeeName: `Dana Employee ${RUN}`, action: "activate" }), check: async () => (await c.employees.findOne({ _id: ids.employee })).employmentStatus === "ACTIVE" },
  { type: "INVOICE", tool: "propose_invoice_decision", args: () => ({ invoiceNumber: `INV-${RUN}`, action: "send" }), check: async () => (await c.invoices.findOne({ _id: ids.invoice })).status === "SENT" },
  { type: "LEAVE_REQUEST", tool: "propose_leave_decision", args: () => ({ employeeName: `Lee Leave ${RUN}`, action: "approve" }), check: async () => (await c.leaveRequests.findOne({ _id: ids.leave })).status === "APPROVED" },
  { type: "PURCHASE_ORDER", tool: "propose_purchase_order_transition", args: () => ({ supplierName: `Globex-${RUN}`, action: "submit" }), check: async () => (await c.purchaseOrders.findOne({ _id: ids.po })).status === "PENDING_APPROVAL" },
  { type: "PURCHASE_REQUEST", tool: "propose_purchase_request_transition", args: () => ({ requestTitle: `Laptops ${RUN}`, action: "submit" }), check: async () => (await c.purchaseRequests.findOne({ _id: ids.pr })).status === "PENDING_APPROVAL" },
  { type: "DEAL", tool: "propose_deal_transition", args: () => ({ dealTitle: `Rollout ${RUN}`, action: "advance" }), check: async () => (await c.crmDeals.findOne({ _id: ids.deal })).status === "NEGOTIATION" },
];

const orgRequests = (extra = {}) => c.aiActionRequests.find({ orgId, ...extra }).toArray();
const activity = (action) => c.orgActivity.countDocuments({ orgId, recordType: "AI_ACTION_REQUEST", action });

for (const d of DOMAINS) {
  test(`${d.type}: proposed by the AI, approved by an owner, locked 36h, executed only after the unlock, audited`, async () => {
    // 1. the AI tool proposes it (through the same dispatcher /api/ai/business-chat uses)
    const ctx = await buildBusinessContext({ orgId, membership: proposerMembership, email: proposer });
    const proposed = await runBusinessTool(d.tool, d.args(), ctx);
    assert.equal(proposed.submitted, true, `${d.tool} should submit a proposal: ${JSON.stringify(proposed)}`);

    const req = (await orgRequests({ targetRecordType: d.type, status: "PENDING_APPROVAL" }))[0];
    assert.ok(req, "a PENDING_APPROVAL request exists");
    assert.equal(req.requestedByEmail, proposer);
    assert.equal(await d.check(), false, "the AI proposal alone changed NOTHING in the business record");

    // 2. the server-side gate decides who may approve, then an owner approves
    const gate = await resolveCanApprove({ orgId, targetRecordType: d.type, targetRecordId: req.targetRecordId, proposedAction: req.proposedAction, membership: approverMembership, email: approver });
    assert.equal(gate.canApprove, true, `the gate should let an owner approve ${d.type}`);
    const approved = await reviewAiAction({ orgId, requestId: String(req._id), decision: "approve", actorEmail: approver, canApprove: gate.canApprove });
    assert.ok(!approved.error, JSON.stringify(approved));

    // 3. approval starts the 36h lock, computed by the real code
    const locked = await c.aiActionRequests.findOne({ _id: req._id });
    assert.equal(locked.status, "APPROVED");
    const lockMs = new Date(locked.unlockAt).getTime() - Date.now();
    assert.ok(Math.abs(lockMs - SETTLEMENT_DELAY_MS) < 2 * 60_000, `unlockAt is ~36h away (got ${(lockMs / 3_600_000).toFixed(2)}h)`);

    // 4. the sweep leaves it alone while it is locked
    const early = await executeApprovedAiActions({ orgId });
    assert.equal(early.executed, 0);
    assert.equal((await c.aiActionRequests.findOne({ _id: req._id })).status, "APPROVED");
    assert.equal(await d.check(), false, "still unchanged during the 36h lock");

    // 5. 36 hours pass (the one simulated element), and the sweep runs the real transition
    await c.aiActionRequests.updateOne({ _id: req._id }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });
    const late = await executeApprovedAiActions({ orgId });
    assert.equal(late.executed, 1, JSON.stringify(late));
    const done = await c.aiActionRequests.findOne({ _id: req._id });
    assert.equal(done.status, "EXECUTED", JSON.stringify(done.executionResult));
    assert.equal(await d.check(), true, `the ${d.type} record now reflects the approved action`);

    // 6. a second sweep never re-runs it
    assert.equal((await executeApprovedAiActions({ orgId })).executed, 0);
  });
}

test("every step of every domain is in the audit chain, and the chain still verifies end to end", async () => {
  for (const action of ["AI_ACTION_PROPOSED", "AI_ACTION_APPROVED", "AI_ACTION_EXECUTED"]) {
    assert.equal(await activity(action), DOMAINS.length, `${DOMAINS.length} ${action} entries`);
  }
  const requests = await orgRequests();
  assert.equal(requests.length, DOMAINS.length);
  assert.ok(requests.every((r) => r.status === "EXECUTED"));
  const integrity = await verifyChainIntegrity(String(orgId));
  assert.equal(integrity.valid ?? integrity.ok, true, JSON.stringify(integrity));
});

test("the audit trail names who proposed, who approved, and who the action ran as", async () => {
  const entries = await c.orgActivity.find({ orgId, recordType: "AI_ACTION_REQUEST" }).toArray();
  const by = (action) => new Set(entries.filter((e) => e.action === action).map((e) => e.actorEmail));
  assert.deepEqual([...by("AI_ACTION_PROPOSED")], [proposer]);
  assert.deepEqual([...by("AI_ACTION_APPROVED")], [approver]);
  assert.deepEqual([...by("AI_ACTION_EXECUTED")], [approver], "execution is attributed to the human who approved it");
});
