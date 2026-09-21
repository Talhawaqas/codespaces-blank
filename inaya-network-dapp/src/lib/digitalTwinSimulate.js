// src/lib/digitalTwinSimulate.js
//
// Digital Twin SOW -- What If / Scenario Simulation over the dependency
// graph (digitalTwin.js). Same no-mutation guarantee as the Evidence
// Graph SOW's businessEventSimulate.js (this file has NO import of any
// transitionX()/putX() mutation function, only read paths), extended to
// the SOW's own named scenario classes (§54-57): supplier unavailable,
// employee access removed, project delayed, resource (warehouse)
// unavailable. Every one of these traverses the REAL dependency graph
// rather than a second, disconnected simulation model -- the traversal
// IS the simulation, matching §16's "only relationships actually present
// in the model may produce a consequence, no invented causal links."
//
// HONESTY RULE (SOW §17/§31 "missing data must never become false
// certainty"): a numeric consequence (a shifted date, a lost quantity) is
// only ever reported when a real, stored field backs it. Where the SOW's
// own worked examples (§54's "14 Sep -> 28 Sep") would require a field
// this codebase doesn't actually store (POs/projects have no committed
// completion-date field), the result reports UNKNOWN with a stated
// reason instead of inventing a plausible-looking number.

import { getOrgCollections, canAccessDepartment, canAccessStorage, toObjectId } from "./orgs.js";
import { resolveDependents, traverseDependencyGraph } from "./digitalTwin.js";
import { getPlanHealth } from "./storageBackupPolicies.js";
import { canonicalizeForExport } from "./evidenceExporter.js";
import { createHash } from "node:crypto";

export const SCENARIO_TYPES = ["SUPPLIER_UNAVAILABLE", "EMPLOYEE_ACCESS_REMOVED", "PROJECT_DELAYED", "WAREHOUSE_UNAVAILABLE", "STORAGE_RESOURCE_UNAVAILABLE", "BACKUP_POLICY_DISABLED"];

// What-If Scenario Studio SOW §9.8 -- bumped only when a scenario
// handler's actual logic changes (not on every commit), so a stored
// modelVersion genuinely identifies which rules produced a past result.
export const MODEL_VERSION = "1.0";
export const RULES_VERSION = "1.0";

function unknown(reason) {
  return { status: "UNKNOWN", reason };
}

async function simulateSupplierUnavailable({ orgId, entityId, membership }) {
  const { suppliers } = await getOrgCollections();
  const supplier = await suppliers.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId) });
  if (!supplier) return { error: "Supplier not found.", status: 404 };
  if (!canAccessDepartment(membership, supplier.departmentId)) return { error: "You don't have permission to simulate this.", status: 403 };

  const graph = await traverseDependencyGraph({ orgId, startType: "SUPPLIER", startId: entityId, membership, maxDepth: 3 });
  const poEdges = graph.edges.filter((e) => e.to.targetType === "PURCHASE_ORDER");
  const prEdges = graph.edges.filter((e) => e.to.targetType === "PURCHASE_REQUEST");
  const productEdges = graph.edges.filter((e) => e.to.targetType === "PRODUCT");

  const openOrders = poEdges.filter((e) => e.to.summary && !["RECEIVED", "REJECTED", "CANCELLED"].includes(e.to.summary.status));

  return {
    scenario: { type: "SUPPLIER_UNAVAILABLE", subject: { type: "SUPPLIER", id: entityId, name: supplier.name } },
    directImpact: {
      status: openOrders.length > 0 ? "IMPACT_DETECTED" : "NO_IMPACT",
      affectedPurchaseOrders: openOrders.map((e) => ({ id: e.to.targetId, status: e.to.summary?.status })),
      affectedPurchaseRequests: prEdges.map((e) => ({ id: e.to.targetId, status: e.to.summary?.status })),
    },
    indirectImpact: {
      affectedProducts: productEdges.map((e) => e.to.targetId),
      note: "Products sourced through this supplier's open purchase orders. Downstream project/task impact is NOT modeled -- this codebase has no stored relationship linking a product to the project that consumes it.",
    },
    unknowns: [
      { area: "ALTERNATE_SUPPLIER_AVAILABILITY", ...unknown("Not modeled.") },
      { area: "PROJECT_COMPLETION_IMPACT", ...unknown("No stored completion-date field exists on purchase orders or projects to compute a shift from.") },
      { area: "EXTERNAL_LOGISTICS", ...unknown("Outside Inaya's data model.") },
    ],
    resultStatus: openOrders.length > 0 || prEdges.length > 0 ? "PARTIAL" : "COMPLETE",
    noChangesWereMade: true,
  };
}

async function simulateEmployeeAccessRemoved({ orgId, entityId, membership }) {
  const dependents = await resolveDependents({ orgId, entityType: "EMPLOYEE", entityId, membership });
  const memberships = dependents.filter((d) => d.targetType === "PROJECT_MEMBERSHIP");
  const tasks = dependents.filter((d) => d.targetType === "TASK");
  const restrictedCount = dependents.filter((d) => d.state === "RESTRICTED").length;

  return {
    scenario: { type: "EMPLOYEE_ACCESS_REMOVED", subject: { type: "EMPLOYEE", id: entityId } },
    directImpact: {
      status: memberships.length > 0 || tasks.length > 0 ? "IMPACT_DETECTED" : "NO_IMPACT",
      projectMembershipsAffected: memberships.filter((m) => m.state === "INCLUDED").map((m) => ({ projectId: m.targetId, name: m.summary?.projectName })),
      tasksAffected: tasks.filter((t) => t.state === "INCLUDED").map((t) => ({ taskId: t.targetId, title: t.summary?.title, status: t.summary?.status, expectedReassignment: "REQUIRED" })),
    },
    unknowns: [
      { area: "DOCUMENT_ACCESS", ...unknown("Document-level access is resolved per-document, not enumerable from a single membership/task query without a full document scan -- deferred.") },
      { area: "PENDING_APPROVAL_REASSIGNMENT", ...unknown("Approval authority is role-derived (owner/admin/domain-manager), not tied to this specific person's membership, so removing them does not itself change who can approve -- no reassignment is modeled or needed here.") },
      ...(restrictedCount > 0 ? [{ area: "RESTRICTED_DEPENDENTS", status: "PARTIAL", reason: `${restrictedCount} affected record(s) exist in a department you cannot access -- their existence is disclosed, their content is not.` }] : []),
    ],
    resultStatus: restrictedCount > 0 ? "PARTIAL" : "COMPLETE",
    noChangesWereMade: true,
  };
}

async function simulateProjectDelayed({ orgId, entityId, membership, delayDays }) {
  const { projects, tasks } = await getOrgCollections();
  const project = await projects.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId) });
  if (!project) return { error: "Project not found.", status: 404 };
  if (!canAccessDepartment(membership, project.departmentId)) return { error: "You don't have permission to simulate this.", status: 403 };

  const openTasks = await tasks.find({ orgId: toObjectId(orgId), projectId: toObjectId(entityId), deletedAt: null, status: { $nin: ["DONE", "CANCELLED"] } }).toArray();
  const tasksWithDueDate = openTasks.filter((t) => t.dueDate);

  return {
    scenario: { type: "PROJECT_DELAYED", subject: { type: "PROJECT", id: entityId, name: project.name }, params: { delayDays: Number(delayDays) || null } },
    directImpact: {
      status: openTasks.length > 0 ? "IMPACT_DETECTED" : "NO_IMPACT",
      openTaskCount: openTasks.length,
      // Only tasks with a REAL stored dueDate get a computed shifted date;
      // a task with no dueDate has nothing to shift, reported as such
      // rather than assigning it today's date + delay by assumption.
      tasksWithComputedShift: Number.isFinite(Number(delayDays))
        ? tasksWithDueDate.map((t) => ({ taskId: String(t._id), title: t.title, currentDueDate: t.dueDate, shiftedDueDate: new Date(new Date(t.dueDate).getTime() + Number(delayDays) * 86400000).toISOString() }))
        : [],
      tasksWithNoDueDate: openTasks.length - tasksWithDueDate.length,
    },
    unknowns: [
      { area: "CUSTOMER_COMMITMENT_IMPACT", ...unknown("Not modeled -- no stored external-commitment data.") },
      { area: "FINANCIAL_CONSEQUENCE", ...unknown("Not modeled -- no stored cost-of-delay field.") },
      { area: "PROCUREMENT_DEPENDENCY", ...unknown("This project's own linked purchase orders/requests are not evaluated in this scenario -- use SUPPLIER_UNAVAILABLE or run a dedicated dependency traversal from the project's purchase records.") },
    ],
    resultStatus: "PARTIAL",
    noChangesWereMade: true,
  };
}

async function simulateWarehouseUnavailable({ orgId, entityId, membership }) {
  // A stockLevel row has no departmentId of its own (see inventory.js) --
  // its real access boundary is the WAREHOUSE it belongs to, which does
  // store one (see inventory/warehouses/route.js). Checked here, at the
  // traversal's starting point, rather than relying on
  // resolveDependents()'s generic per-dependent-doc check, which would
  // silently default a departmentId-less stockLevel to visible.
  const { warehouses } = await getOrgCollections();
  const warehouse = await warehouses.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId) });
  if (!warehouse) return { error: "Warehouse not found.", status: 404 };
  if (!canAccessDepartment(membership, warehouse.departmentId)) return { error: "You don't have permission to simulate this.", status: 403 };

  const graph = await traverseDependencyGraph({ orgId, startType: "WAREHOUSE", startId: entityId, membership, maxDepth: 2 });
  const stockEdges = graph.edges.filter((e) => e.to.targetType === "STOCK_LEVEL");

  return {
    scenario: { type: "WAREHOUSE_UNAVAILABLE", subject: { type: "WAREHOUSE", id: entityId } },
    directImpact: {
      status: stockEdges.length > 0 ? "IMPACT_DETECTED" : "NO_IMPACT",
      affectedStockLevels: stockEdges.map((e) => ({ id: e.to.targetId, quantity: e.to.summary?.quantity ?? null })),
    },
    unknowns: [
      { area: "PROJECT_DEPENDENCY", ...unknown("No stored relationship links a warehouse's stock directly to a consuming project/task.") },
      { area: "LOGISTICS_REROUTING", ...unknown("Outside Inaya's data model.") },
    ],
    resultStatus: stockEdges.length > 0 ? "PARTIAL" : "COMPLETE",
    noChangesWereMade: true,
  };
}

// IBM Cloud VPC Storage Gap Expansion SOW, Workstream U -- "what happens
// if this storage resource becomes unavailable" / "what happens if this
// backup policy is disabled." Gated on canAccessStorage (the resource's
// real access boundary, per digitalTwin.js's own STORAGE_RESOURCE
// special-case comment), not canAccessDepartment -- storage resources
// have no department scope.
async function simulateStorageResourceUnavailable({ orgId, entityId, membership }) {
  const { storageResources } = await getOrgCollections();
  const resource = await storageResources.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId), deletedAt: null });
  if (!resource) return { error: "Storage resource not found.", status: 404 };
  if (!canAccessStorage(membership)) return { error: "You don't have permission to simulate this.", status: 403 };

  const graph = await traverseDependencyGraph({ orgId, startType: "STORAGE_RESOURCE", startId: entityId, membership, maxDepth: 1 });
  const snapshotEdges = graph.edges.filter((e) => e.to.targetType === "STORAGE_SNAPSHOT");

  return {
    scenario: { type: "STORAGE_RESOURCE_UNAVAILABLE", subject: { type: "STORAGE_RESOURCE", id: entityId, name: resource.name } },
    directImpact: {
      status: resource.attachmentState === "ATTACHED" ? "IMPACT_DETECTED" : "NO_IMPACT",
      currentAttachmentState: resource.attachmentState,
      attachedTo: resource.attachedTo,
      availableSnapshots: snapshotEdges.filter((e) => e.to.state === "INCLUDED").map((e) => ({ snapshotId: e.to.targetId, ...e.to.summary })),
    },
    unknowns: [
      { area: "DEPENDENT_CONSUMERS", ...unknown("No other Inaya resource type currently stores a foreign key referencing a storage resource, so nothing beyond this resource's own attachment state and snapshots can be traced as an effect.") },
      { area: "RESTORE_TIME", ...unknown("No backend primitive exists to estimate restore duration ahead of actually running it -- see the Fast Restore workstream's own documented non-implementation.") },
    ],
    resultStatus: snapshotEdges.length > 0 ? "PARTIAL" : "COMPLETE",
    noChangesWereMade: true,
  };
}

async function simulateBackupPolicyDisabled({ orgId, entityId, membership }) {
  const { storageBackupPolicies, storageBackupPlans, storageResources } = await getOrgCollections();
  const policy = await storageBackupPolicies.findOne({ _id: toObjectId(entityId), orgId: toObjectId(orgId), deletedAt: null });
  if (!policy) return { error: "Backup policy not found.", status: 404 };
  if (!canAccessStorage(membership)) return { error: "You don't have permission to simulate this.", status: 403 };

  const plans = await storageBackupPlans.find({ orgId: toObjectId(orgId), policyId: policy._id, deletedAt: null }).toArray();
  const resources = await storageResources.find({ orgId: toObjectId(orgId), deletedAt: null }).toArray();
  const { matchesSelector } = await import("./storageResources.js");
  const affectedResources = resources.filter((r) => matchesSelector(r.tags, policy.tagSelector));

  return {
    scenario: { type: "BACKUP_POLICY_DISABLED", subject: { type: "STORAGE_BACKUP_POLICY", id: entityId, name: policy.name } },
    directImpact: {
      status: affectedResources.length > 0 ? "IMPACT_DETECTED" : "NO_IMPACT",
      resourcesNoLongerProtected: affectedResources.map((r) => ({ resourceId: String(r._id), name: r.name })),
      plansAffected: plans.map((p) => ({ planId: String(p._id), frequency: p.frequency, currentHealth: getPlanHealth(p) })),
    },
    unknowns: [
      { area: "TIME_TO_STALE", ...unknown("How soon a resource's already-existing snapshots become insufficient for recovery depends on that resource's own real change rate, which is not tracked as a projectable metric here.") },
    ],
    resultStatus: affectedResources.length > 0 ? "PARTIAL" : "COMPLETE",
    noChangesWereMade: true,
  };
}

const SCENARIO_HANDLERS = {
  SUPPLIER_UNAVAILABLE: simulateSupplierUnavailable,
  EMPLOYEE_ACCESS_REMOVED: simulateEmployeeAccessRemoved,
  PROJECT_DELAYED: simulateProjectDelayed,
  WAREHOUSE_UNAVAILABLE: simulateWarehouseUnavailable,
  STORAGE_RESOURCE_UNAVAILABLE: simulateStorageResourceUnavailable,
  BACKUP_POLICY_DISABLED: simulateBackupPolicyDisabled,
};

/** Read-only entry point. Never writes to any collection -- every handler
 *  above only calls find()/findOne() (directly or via digitalTwin.js's
 *  own read-only resolvers). Logs the simulation request itself for
 *  auditability, but never against the subject entity's own recordType
 *  (same discipline businessEventSimulate.js established: a simulation
 *  must never appear in a record's own history as if it were real).
 *
 *  What-If Scenario Studio SOW §9.8/9.9 -- attaches provenance (a real
 *  simulation ID from the audit entry itself, the model/rules version
 *  that actually ran, and an integrity hash over the full result) so a
 *  past simulation is independently re-checkable: recompute the hash
 *  over the same {scenario, directImpact, indirectImpact, unknowns}
 *  fields and confirm it matches what was recorded at the time. Reuses
 *  evidenceExporter.js's own canonicalize function -- one hashing
 *  convention across every Inaya feature that hashes a result, not a
 *  second one invented here. */
export async function simulateDigitalTwinScenario({ orgId, scenarioType, entityId, membership, actorEmail, params = {} }) {
  const handler = SCENARIO_HANDLERS[scenarioType];
  if (!handler) return { error: `Unknown scenario type "${scenarioType}". Must be one of ${SCENARIO_TYPES.join(", ")}.`, status: 400 };

  const result = await handler({ orgId, entityId, membership, ...params });
  if (result.error) return result;

  const provenance = { modelVersion: MODEL_VERSION, rulesVersion: RULES_VERSION };
  const integrityHash = createHash("sha256")
    .update(canonicalizeForExport({ scenario: result.scenario, directImpact: result.directImpact, indirectImpact: result.indirectImpact || null, unknowns: result.unknowns, ...provenance }))
    .digest("hex");

  const { logOrgActivity } = await import("./org-activity-log.js");
  const event = await logOrgActivity({
    orgId, recordType: "DIGITAL_TWIN_SIMULATION", recordId: toObjectId(orgId), actorEmail,
    action: "SIMULATION_RUN", previousState: null, newState: null,
    metadata: { scenarioType, entityId: String(entityId), resultStatus: result.resultStatus, integrityHash, ...provenance },
  });

  return { simulation: { ...result, simulationId: event.eventId, ...provenance, integrityHash, runAt: event.timestamp, runByEmail: actorEmail } };
}

/** Scenario history (SOW's "scenario history" UI requirement) -- reads
 *  the same audit/activity entries simulateDigitalTwinScenario() itself
 *  writes, org-scoped, most recent first. No second storage location for
 *  "past simulations" -- the audit log already durably records them. */
export async function listDigitalTwinSimulations({ orgId, limit = 50 }) {
  const { orgActivity } = await getOrgCollections();
  const entries = await orgActivity
    .find({ orgId: toObjectId(orgId), recordType: "DIGITAL_TWIN_SIMULATION", action: "SIMULATION_RUN" })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
  return entries.map((e) => ({
    simulationId: e.eventId,
    scenarioType: e.metadata?.scenarioType,
    entityId: e.metadata?.entityId,
    resultStatus: e.metadata?.resultStatus,
    integrityHash: e.metadata?.integrityHash,
    modelVersion: e.metadata?.modelVersion,
    rulesVersion: e.metadata?.rulesVersion,
    runAt: e.timestamp,
    runByEmail: e.actorEmail,
  }));
}
