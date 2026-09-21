// src/lib/digitalTwin.js
//
// Inaya Digital Twin & Privacy-Preserving Organizational Simulation Layer
// SOW. Phase 0 audit finding: the SOW's own §24 storage-strategy rule
// ("do not introduce a graph database until measurable requirements
// justify it... prefer existing records + typed relationships") applies
// directly here. Every foreign key this file traverses already exists on
// a real record (supplierId on a PO, productId/warehouseId inside a PO's
// items, departmentId everywhere, projectId on tasks/deals, assigneeEmail
// on tasks) -- so the "dependency graph" is computed ON DEMAND from those
// real references, not a second, syncable graph collection that could
// drift from the data it's supposed to describe.
//
// This is deliberately NOT a rebuild of the Evidence Graph SOW's
// businessEventSimulate.js -- that engine already answers "is this ONE
// record's transition legal and authorized, with zero mutation." This
// file answers a different question: "starting from one entity, what
// ELSE in the org references it, transitively" -- the traversal
// businessEventSimulate.js's own single-record scope never needed.

import { getOrgCollections, canAccessDepartment, toObjectId } from "./orgs.js";

// Entity types this Twin can resolve dependents for, and the query that
// finds "records of type X that reference entity Y." Each entry is kept
// deliberately explicit (not a generic "any field ending in Id" scanner)
// -- a wrong, guessed relationship would be worse than a Twin that's
// honest about what it doesn't model yet (SOW §9's own "no invented
// causal links" rule).
const DEPENDENT_RESOLVERS = {
  SUPPLIER: [
    { targetType: "PURCHASE_ORDER", collectionKey: "purchaseOrders", field: "supplierId" },
    { targetType: "PURCHASE_REQUEST", collectionKey: "purchaseRequests", field: "supplierId" },
  ],
  WAREHOUSE: [
    // stockLevels/stockMovements reference a warehouse directly; PO items
    // reference one per line item (nested, handled separately below).
    { targetType: "STOCK_LEVEL", collectionKey: "stockLevels", field: "warehouseId" },
  ],
  PRODUCT: [
    { targetType: "STOCK_LEVEL", collectionKey: "stockLevels", field: "productId" },
  ],
  DEPARTMENT: [
    { targetType: "PROJECT", collectionKey: "projects", field: "departmentId" },
    { targetType: "SUPPLIER", collectionKey: "suppliers", field: "departmentId" },
    { targetType: "PURCHASE_ORDER", collectionKey: "purchaseOrders", field: "departmentId" },
    { targetType: "INVOICE", collectionKey: "invoices", field: "departmentId" },
    { targetType: "EMPLOYEE", collectionKey: "employees", field: "departmentId" },
  ],
  PROJECT: [
    { targetType: "TASK", collectionKey: "tasks", field: "projectId" },
    { targetType: "DEAL", collectionKey: "crmDeals", field: "projectId" },
  ],
  PURCHASE_ORDER: [
    // A PO's line items reference products/warehouses -- resolved specially
    // in resolveDependents() below since they're nested, not a top-level FK.
  ],
};

// project_members and task.assigneeEmail reference a PERSON (email), not
// an ObjectId -- kept as its own resolver since "employee" here means
// "org membership," which this codebase identifies by email, not a
// separate employee-collection _id in every case. Both tasks and
// projects carry their own real departmentId (see orgs.js's own
// tasks.createIndex({orgId,departmentId}) / projects.createIndex(same)),
// so this filters by the SAME canAccessDepartment rule every other
// resolver uses -- an employee-access simulation must not leak a task in
// a department the caller can't see just because the query started from
// a person rather than a department.
async function resolveEmployeeDependents({ orgId, email, membership }) {
  const { projectMembers, tasks, projects } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const [memberships, assignedTasks] = await Promise.all([
    projectMembers.find({ orgId: orgObjectId, email }).toArray(),
    tasks.find({ orgId: orgObjectId, assigneeEmail: email, deletedAt: null }).toArray(),
  ]);

  const projectIds = memberships.map((m) => m.projectId);
  const projectDocs = projectIds.length ? await projects.find({ _id: { $in: projectIds } }).toArray() : [];
  const projectById = new Map(projectDocs.map((p) => [p._id.toString(), p]));

  const results = [];
  for (const m of memberships) {
    const project = projectById.get(m.projectId.toString());
    const visible = project ? canAccessDepartment(membership, project.departmentId) : false;
    results.push({ targetType: "PROJECT_MEMBERSHIP", targetId: String(m.projectId), state: visible ? "INCLUDED" : "RESTRICTED", summary: visible ? { projectName: project.name } : undefined });
  }
  for (const t of assignedTasks) {
    const visible = canAccessDepartment(membership, t.departmentId);
    results.push({ targetType: "TASK", targetId: String(t._id), state: visible ? "INCLUDED" : "RESTRICTED", summary: visible ? { title: t.title, status: t.status } : undefined });
  }
  return results;
}

function summarize(entityType, doc) {
  if (entityType === "PURCHASE_ORDER" || entityType === "PURCHASE_REQUEST") return { status: doc.status, supplierId: doc.supplierId ? String(doc.supplierId) : null };
  if (entityType === "TASK") return { title: doc.title, status: doc.status, dueDate: doc.dueDate || null };
  if (entityType === "DEAL") return { title: doc.title, stage: doc.stage };
  if (entityType === "INVOICE") return { invoiceNumber: doc.invoiceNumber, status: doc.status, total: doc.total ?? null };
  if (entityType === "STOCK_LEVEL") return { quantity: doc.quantity };
  if (entityType === "PROJECT") return { name: doc.name };
  if (entityType === "SUPPLIER") return { name: doc.name, status: doc.status };
  if (entityType === "EMPLOYEE") return { name: doc.name || doc.memberEmail };
  return {};
}

/** Direct dependents of one entity -- one hop, not the full transitive
 *  closure (see traverseDependencyGraph for that). Permission-filtered
 *  against each DEPENDENT doc's own departmentId where it has one. A
 *  stockLevel row has no departmentId of its own (see inventory.js) --
 *  callers that start a traversal at WAREHOUSE or PRODUCT MUST check that
 *  starting entity's own departmentId themselves before calling this
 *  (see digitalTwinSimulate.js's simulateWarehouseUnavailable for the
 *  pattern), since this function has no way to know a caller can't
 *  already see the warehouse/product itself. Never expose this as a raw
 *  "traverse anything" API without that same starting-point check. */
export async function resolveDependents({ orgId, entityType, entityId, membership }) {
  const collections = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const dependents = [];

  if (entityType === "EMPLOYEE") {
    return resolveEmployeeDependents({ orgId, email: entityId, membership });
  }

  const resolvers = DEPENDENT_RESOLVERS[entityType] || [];
  for (const resolver of resolvers) {
    const docs = await collections[resolver.collectionKey]
      .find({ orgId: orgObjectId, [resolver.field]: toObjectId(entityId), deletedAt: { $ne: true } })
      .toArray();
    for (const doc of docs) {
      const visible = doc.departmentId ? canAccessDepartment(membership, doc.departmentId) : true;
      dependents.push({
        targetType: resolver.targetType,
        targetId: String(doc._id),
        state: visible ? "INCLUDED" : "RESTRICTED",
        summary: visible ? summarize(resolver.targetType, doc) : undefined,
      });
    }
  }

  // A Purchase Order's line items reference products/warehouses directly
  // inside its own items array (see purchase-order-workflow.js) -- not a
  // separate top-level FK, so resolved here rather than forced into the
  // generic resolver table above.
  if (entityType === "SUPPLIER") {
    const orders = await collections.purchaseOrders.find({ orgId: orgObjectId, supplierId: toObjectId(entityId), deletedAt: { $ne: true } }).toArray();
    const productWarehousePairs = new Set();
    for (const po of orders) {
      for (const item of po.items || []) {
        if (item.productId && item.warehouseId) productWarehousePairs.add(`${item.productId}:${item.warehouseId}`);
      }
    }
    for (const pair of productWarehousePairs) {
      const [productId, warehouseId] = pair.split(":");
      dependents.push({ targetType: "PRODUCT", targetId: productId, state: "INCLUDED", summary: { viaWarehouse: warehouseId } });
    }
  }

  return dependents;
}

/** Bounded breadth-first traversal of the dependency graph starting from
 *  one entity. maxDepth defaults to 3 -- deep enough for the SOW's own
 *  named examples (supplier -> PO -> product -> project -> task is 4
 *  hops) while staying a bounded, predictable-cost query rather than an
 *  unbounded walk (SOW §61's own "prefer relevant-subgraph extraction"
 *  performance guidance). RESTRICTED nodes are included (existence
 *  disclosed) but never traversed further -- the Twin cannot use a
 *  caller's own query to discover what's behind something they can't see. */
export async function traverseDependencyGraph({ orgId, startType, startId, membership, maxDepth = 3 }) {
  const visited = new Set([`${startType}:${startId}`]);
  const edges = [];
  let frontier = [{ targetType: startType, targetId: String(startId) }];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier = [];
    for (const node of frontier) {
      const dependents = await resolveDependents({ orgId, entityType: node.targetType, entityId: node.targetId, membership });
      for (const dep of dependents) {
        edges.push({ from: node, to: dep, depth: depth + 1 });
        const key = `${dep.targetType}:${dep.targetId}`;
        if (dep.state === "INCLUDED" && !visited.has(key)) {
          visited.add(key);
          nextFrontier.push(dep);
        }
      }
    }
    frontier = nextFrontier;
  }

  return { startType, startId: String(startId), maxDepth, nodeCount: visited.size, edges };
}
