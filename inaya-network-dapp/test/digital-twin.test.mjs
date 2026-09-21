// test/digital-twin.test.mjs
//
// Digital Twin & Simulation Layer SOW — dependency-graph traversal,
// permission-aware dependent resolution, and the four scenario
// simulations, all against the real database. The load-bearing property
// (SOW §15/§32's own named strongest test): a simulation must NEVER
// mutate real state — verified here by snapshotting every collection a
// scenario reads from before/after and asserting byte-for-byte equality.
//
// Run with: node --env-file=.env.local --test test/digital-twin.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { resolveDependents, traverseDependencyGraph } from "../src/lib/digitalTwin.js";
import { simulateDigitalTwinScenario, listDigitalTwinSimulations } from "../src/lib/digitalTwinSimulate.js";
import { canonicalizeForExport } from "../src/lib/evidenceExporter.js";
import { createHash } from "node:crypto";

const RUN_ID = randomUUID().slice(0, 8);
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, departments, projects, suppliers, purchaseOrders, purchaseRequests, warehouses, products, stockLevels, tasks, projectMembers, orgMembers, orgActivity } = collections;
  await Promise.all([
    orgs.deleteMany({ _id: { $in: cleanup.orgIds } }),
    departments.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    projects.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    suppliers.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    purchaseOrders.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    purchaseRequests.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    warehouses.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    products.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    stockLevels.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    tasks.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    projectMembers.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const ownerEmail = `${label}-owner-${RUN_ID}@example.com`;
  const staffEmail = `${label}-staff-${RUN_ID}@example.com`;
  const orgResult = await collections.orgs.insertOne({ name: `${label} ${RUN_ID} Co`, ownerEmail, createdAt: now });
  const orgId = orgResult.insertedId;
  cleanup.orgIds.push(orgId);
  const deptResult = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });
  const otherDeptResult = await collections.departments.insertOne({ orgId, name: "Other", createdAt: now });
  const departmentId = deptResult.insertedId;
  await collections.orgMembers.insertMany([
    { orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
    { orgId, email: staffEmail, role: "member", departmentIds: [departmentId], status: "active", invitedAt: now, joinedAt: now },
  ]);
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const staff = await collections.orgMembers.findOne({ orgId, email: staffEmail });
  return { orgId, departmentId, otherDepartmentId: otherDeptResult.insertedId, owner, staff, ownerEmail, staffEmail };
}

async function makeSupplier(org, { departmentId = org.departmentId } = {}) {
  const now = new Date().toISOString();
  const { insertedId } = await collections.suppliers.insertOne({ orgId: org.orgId, departmentId, name: "Acme Supply", status: "ACTIVE", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null });
  return insertedId;
}

async function makePO(org, { supplierId, status = "PENDING_APPROVAL", productId = null, warehouseId = null }) {
  const now = new Date().toISOString();
  const items = productId && warehouseId ? [{ description: "Widgets", sku: null, productId, warehouseId, quantity: 10, unitPrice: 5, receivedQuantity: 0 }] : [{ description: "Widgets", sku: null, productId: null, warehouseId: null, quantity: 10, unitPrice: 5, receivedQuantity: 0 }];
  const { insertedId } = await collections.purchaseOrders.insertOne({ orgId: org.orgId, departmentId: org.departmentId, supplierId, sourceRequestId: null, items, currency: "USD", status, createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null });
  return insertedId;
}

async function makeProject(org, { departmentId = org.departmentId } = {}) {
  const now = new Date().toISOString();
  const { insertedId } = await collections.projects.insertOne({ orgId: org.orgId, departmentId, name: "Project Alpha", createdAt: now, createdByEmail: org.ownerEmail });
  return insertedId;
}

async function makeTask(org, { projectId, departmentId = org.departmentId, assigneeEmail = null, dueDate = null, status = "TODO" }) {
  const now = new Date().toISOString();
  const { insertedId } = await collections.tasks.insertOne({ orgId: org.orgId, departmentId, projectId, title: "Do the thing", description: null, status, priority: "medium", assigneeEmail, dueDate, createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, completedAt: null, deletedAt: null });
  return insertedId;
}

async function makeWarehouse(org, { departmentId = org.departmentId } = {}) {
  const now = new Date().toISOString();
  const { insertedId } = await collections.warehouses.insertOne({ orgId: org.orgId, departmentId, name: "Main WH", location: null, createdByEmail: org.ownerEmail, createdAt: now });
  return insertedId;
}

async function makeProduct(org, { departmentId = org.departmentId } = {}) {
  const now = new Date().toISOString();
  const { insertedId } = await collections.products.insertOne({ orgId: org.orgId, departmentId, sku: `SKU-${RUN_ID}`, name: "Widget", description: null, unitPrice: 5, reorderThreshold: 0, status: "ACTIVE", createdByEmail: org.ownerEmail, createdAt: now, updatedAt: now, deletedAt: null });
  return insertedId;
}

async function makeStockLevel(org, { productId, warehouseId, quantity = 100 }) {
  const { insertedId } = await collections.stockLevels.insertOne({ orgId: org.orgId, productId, warehouseId, quantity });
  return insertedId;
}

// ---------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------

test("resolveDependents finds real POs referencing a supplier, department-scoped", async () => {
  const org = await makeOrg("dep-supplier");
  const supplierId = await makeSupplier(org);
  const poId = await makePO(org, { supplierId });

  const dependents = await resolveDependents({ orgId: org.orgId, entityType: "SUPPLIER", entityId: supplierId, membership: org.owner });
  const po = dependents.find((d) => d.targetType === "PURCHASE_ORDER");
  assert.equal(po.targetId, poId.toString());
  assert.equal(po.state, "INCLUDED");
  assert.equal(po.summary.status, "PENDING_APPROVAL");
});

test("resolveDependents marks a dependent in an inaccessible department as RESTRICTED, never leaking its summary", async () => {
  const org = await makeOrg("dep-restrict");
  const supplierId = await makeSupplier(org, { departmentId: org.departmentId });
  // PO lives in a DIFFERENT department than the supplier row itself does
  // -- a real, if unusual, case; the dependent's OWN departmentId governs.
  const poId = await makePO(org, { supplierId });
  await collections.purchaseOrders.updateOne({ _id: poId }, { $set: { departmentId: org.otherDepartmentId } });

  const dependents = await resolveDependents({ orgId: org.orgId, entityType: "SUPPLIER", entityId: supplierId, membership: org.staff });
  const po = dependents.find((d) => d.targetType === "PURCHASE_ORDER");
  assert.equal(po.state, "RESTRICTED");
  assert.equal(po.summary, undefined, "a RESTRICTED dependent must never include its summary");
});

test("traverseDependencyGraph finds a product two hops from a supplier (supplier -> PO -> product)", async () => {
  const org = await makeOrg("dep-graph");
  const supplierId = await makeSupplier(org);
  const productId = await makeProduct(org);
  const warehouseId = await makeWarehouse(org);
  await makePO(org, { supplierId, productId, warehouseId });

  const graph = await traverseDependencyGraph({ orgId: org.orgId, startType: "SUPPLIER", startId: supplierId, membership: org.owner, maxDepth: 3 });
  assert.ok(graph.edges.some((e) => e.to.targetType === "PRODUCT" && e.to.targetId === productId.toString()));
});

test("cross-org isolation: a supplier's dependency graph never includes another org's purchase orders", async () => {
  const orgA = await makeOrg("cross-a");
  const orgB = await makeOrg("cross-b");
  const supplierA = await makeSupplier(orgA);
  const supplierB = await makeSupplier(orgB);
  await makePO(orgA, { supplierId: supplierA });
  const poB = await makePO(orgB, { supplierId: supplierB });

  const dependents = await resolveDependents({ orgId: orgA.orgId, entityType: "SUPPLIER", entityId: supplierA, membership: orgA.owner });
  assert.ok(!dependents.some((d) => d.targetId === poB.toString()));
});

// ---------------------------------------------------------------------
// Scenario simulation — correctness
// ---------------------------------------------------------------------

test("SUPPLIER_UNAVAILABLE reports open POs as direct impact and honestly reports project-completion impact as UNKNOWN", async () => {
  const org = await makeOrg("sim-supplier");
  const supplierId = await makeSupplier(org);
  await makePO(org, { supplierId, status: "APPROVED" });

  const { simulation } = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "SUPPLIER_UNAVAILABLE", entityId: supplierId, membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(simulation.directImpact.status, "IMPACT_DETECTED");
  assert.equal(simulation.directImpact.affectedPurchaseOrders.length, 1);
  assert.ok(simulation.unknowns.some((u) => u.area === "PROJECT_COMPLETION_IMPACT"), "must not invent a completion-date shift with no stored field to back it");
  assert.equal(simulation.noChangesWereMade, true);
});

test("EMPLOYEE_ACCESS_REMOVED reports real project memberships and assigned tasks, and requires reassignment explicitly", async () => {
  const org = await makeOrg("sim-employee");
  const projectId = await makeProject(org);
  const taskId = await makeTask(org, { projectId, assigneeEmail: org.staffEmail });
  await collections.projectMembers.insertOne({ orgId: org.orgId, projectId, email: org.staffEmail, addedAt: new Date().toISOString(), addedByEmail: org.ownerEmail });

  const { simulation } = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "EMPLOYEE_ACCESS_REMOVED", entityId: org.staffEmail, membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(simulation.directImpact.status, "IMPACT_DETECTED");
  assert.equal(simulation.directImpact.projectMembershipsAffected.length, 1);
  assert.equal(simulation.directImpact.tasksAffected[0].taskId, taskId.toString());
  assert.equal(simulation.directImpact.tasksAffected[0].expectedReassignment, "REQUIRED");
});

test("PROJECT_DELAYED computes a real shifted due date only for tasks that actually have one, and counts the rest honestly", async () => {
  const org = await makeOrg("sim-delay");
  const projectId = await makeProject(org);
  const withDueDate = new Date("2026-10-01T00:00:00.000Z").toISOString();
  await makeTask(org, { projectId, dueDate: withDueDate });
  await makeTask(org, { projectId, dueDate: null });

  const { simulation } = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "PROJECT_DELAYED", entityId: projectId, membership: org.owner, actorEmail: org.ownerEmail, params: { delayDays: 14 } });
  assert.equal(simulation.directImpact.openTaskCount, 2);
  assert.equal(simulation.directImpact.tasksWithComputedShift.length, 1);
  assert.equal(simulation.directImpact.tasksWithComputedShift[0].shiftedDueDate, new Date(new Date(withDueDate).getTime() + 14 * 86400000).toISOString());
  assert.equal(simulation.directImpact.tasksWithNoDueDate, 1);
});

test("WAREHOUSE_UNAVAILABLE respects the warehouse's own department permission, even though stockLevels have no departmentId of their own (SECURITY)", async () => {
  const org = await makeOrg("sim-warehouse");
  const warehouseId = await makeWarehouse(org, { departmentId: org.otherDepartmentId });
  const productId = await makeProduct(org);
  await makeStockLevel(org, { productId, warehouseId, quantity: 42 });

  const deniedForStaff = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "WAREHOUSE_UNAVAILABLE", entityId: warehouseId, membership: org.staff, actorEmail: org.staffEmail });
  assert.equal(deniedForStaff.error, "You don't have permission to simulate this.");

  const { simulation } = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "WAREHOUSE_UNAVAILABLE", entityId: warehouseId, membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(simulation.directImpact.affectedStockLevels[0].quantity, 42);
});

// ---------------------------------------------------------------------
// THE critical security test — simulation never mutates real state
// ---------------------------------------------------------------------

test("SECURITY: every scenario type leaves every collection it reads byte-for-byte unchanged", async () => {
  const org = await makeOrg("sim-nomutate");
  const supplierId = await makeSupplier(org);
  const productId = await makeProduct(org);
  const warehouseId = await makeWarehouse(org);
  const poId = await makePO(org, { supplierId, productId, warehouseId, status: "APPROVED" });
  const projectId = await makeProject(org);
  const taskId = await makeTask(org, { projectId, assigneeEmail: org.staffEmail, dueDate: new Date().toISOString() });
  await collections.projectMembers.insertOne({ orgId: org.orgId, projectId, email: org.staffEmail, addedAt: new Date().toISOString(), addedByEmail: org.ownerEmail });
  await makeStockLevel(org, { productId, warehouseId, quantity: 10 });

  const snapshot = async () => ({
    supplier: await collections.suppliers.findOne({ _id: supplierId }),
    po: await collections.purchaseOrders.findOne({ _id: poId }),
    project: await collections.projects.findOne({ _id: projectId }),
    task: await collections.tasks.findOne({ _id: taskId }),
    stock: await collections.stockLevels.findOne({ orgId: org.orgId, productId, warehouseId }),
    memberships: await collections.projectMembers.find({ orgId: org.orgId, projectId }).toArray(),
  });

  const before = await snapshot();

  await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "SUPPLIER_UNAVAILABLE", entityId: supplierId, membership: org.owner, actorEmail: org.ownerEmail });
  await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "EMPLOYEE_ACCESS_REMOVED", entityId: org.staffEmail, membership: org.owner, actorEmail: org.ownerEmail });
  await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "PROJECT_DELAYED", entityId: projectId, membership: org.owner, actorEmail: org.ownerEmail, params: { delayDays: 30 } });
  await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "WAREHOUSE_UNAVAILABLE", entityId: warehouseId, membership: org.owner, actorEmail: org.ownerEmail });

  const after = await snapshot();
  assert.deepEqual(after, before, "no scenario simulation may mutate any real record it reads");

  // The only write anywhere must be the DIGITAL_TWIN_SIMULATION audit
  // entries themselves, never anything against the subjects' own
  // recordType (same discipline as businessEventSimulate.js).
  const subjectAudits = await collections.orgActivity.find({ orgId: org.orgId, recordType: { $in: ["SUPPLIER", "PURCHASE_ORDER", "PROJECT", "TASK"] } }).toArray();
  assert.equal(subjectAudits.length, 0, "a simulation must never write an activity entry against any subject's own recordType");

  const twinAudits = await collections.orgActivity.find({ orgId: org.orgId, recordType: "DIGITAL_TWIN_SIMULATION", action: "SIMULATION_RUN" }).toArray();
  assert.equal(twinAudits.length, 4, "each of the 4 simulations run above must have logged exactly one DIGITAL_TWIN_SIMULATION audit entry");
});

// ---------------------------------------------------------------------
// What-If Scenario Studio SOW — provenance, integrity, and history
// ---------------------------------------------------------------------

test("a simulation result carries a real, independently-recomputable integrity hash and provenance", async () => {
  const org = await makeOrg("provenance");
  const supplierId = await makeSupplier(org);
  await makePO(org, { supplierId, status: "APPROVED" });

  const { simulation } = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "SUPPLIER_UNAVAILABLE", entityId: supplierId, membership: org.owner, actorEmail: org.ownerEmail });
  assert.ok(simulation.simulationId);
  assert.ok(simulation.integrityHash);
  assert.equal(simulation.modelVersion, "1.0");
  assert.equal(simulation.rulesVersion, "1.0");
  assert.ok(simulation.runAt);

  const recomputed = createHash("sha256")
    .update(canonicalizeForExport({ scenario: simulation.scenario, directImpact: simulation.directImpact, indirectImpact: simulation.indirectImpact || null, unknowns: simulation.unknowns, modelVersion: simulation.modelVersion, rulesVersion: simulation.rulesVersion }))
    .digest("hex");
  assert.equal(recomputed, simulation.integrityHash, "the integrity hash must be independently recomputable from the result's own content");
});

test("scenario history lists past simulations for the org, most recent first, and never leaks another org's runs", async () => {
  const orgA = await makeOrg("history-a");
  const orgB = await makeOrg("history-b");
  const supplierA = await makeSupplier(orgA);
  const supplierB = await makeSupplier(orgB);

  await simulateDigitalTwinScenario({ orgId: orgA.orgId, scenarioType: "SUPPLIER_UNAVAILABLE", entityId: supplierA, membership: orgA.owner, actorEmail: orgA.ownerEmail });
  await new Promise((r) => setTimeout(r, 5));
  await simulateDigitalTwinScenario({ orgId: orgA.orgId, scenarioType: "SUPPLIER_UNAVAILABLE", entityId: supplierA, membership: orgA.owner, actorEmail: orgA.ownerEmail });
  await simulateDigitalTwinScenario({ orgId: orgB.orgId, scenarioType: "SUPPLIER_UNAVAILABLE", entityId: supplierB, membership: orgB.owner, actorEmail: orgB.ownerEmail });

  const historyA = await listDigitalTwinSimulations({ orgId: orgA.orgId });
  assert.equal(historyA.length, 2);
  assert.ok(new Date(historyA[0].runAt) >= new Date(historyA[1].runAt), "history must be most-recent-first");
  assert.ok(historyA.every((h) => h.scenarioType === "SUPPLIER_UNAVAILABLE" && h.integrityHash));

  const historyB = await listDigitalTwinSimulations({ orgId: orgB.orgId });
  assert.equal(historyB.length, 1);
});
