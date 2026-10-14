// src/lib/infrastructure/loadBalancers.js
//
// Gap-closure round, Phase C (closes INFRA-ADV-001/INFRA-NET-009): real
// HAProxy-backed load balancers, mirroring operations.js's own volume/VPC
// CRUD pattern exactly -- same cols()/enqueue() chokepoint, same
// desired/observed status split reflected by completeOperation.

import crypto from "node:crypto";
import { getOrgCollections } from "../orgs.js";
import { InfrastructureError, getCluster } from "./nodes.js";
import { enqueue, getInstance } from "./operations.js";
import { appendAuditEntry } from "../auditChain.js";

let indexed = false;
async function cols() {
  const c = await getOrgCollections();
  const loadBalancers = c.db.collection("infra_load_balancers");
  if (!indexed) {
    await Promise.all([loadBalancers.createIndex({ lbId: 1 }, { unique: true }), loadBalancers.createIndex({ orgId: 1, clusterId: 1 })]);
    indexed = true;
  }
  return { c, loadBalancers };
}

async function resolveTargets({ orgId, instanceIds, port }) {
  const targets = [];
  for (const instanceId of instanceIds) {
    const inst = await getInstance({ orgId, instanceId });
    if (!inst.staticIp) {
      throw new InfrastructureError(`Instance ${instanceId} has no static IP and cannot be a load-balancer target (only guest-booting instances have a real address -- see Phase A).`, { status: 409 });
    }
    targets.push({ name: instanceId.slice(0, 8), address: inst.staticIp, port });
  }
  return targets;
}

export async function createLoadBalancer({ orgId, membership, clusterId, nodeId, listenPort, targetInstanceIds, targetPort, healthCheckIntervalMs = 2000 }) {
  await getCluster({ orgId, clusterId });
  if (!nodeId) throw new InfrastructureError("nodeId is required.", { status: 400 });
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new InfrastructureError("listenPort must be a valid port number.", { status: 400 });
  if (!Array.isArray(targetInstanceIds) || targetInstanceIds.length === 0) throw new InfrastructureError("targetInstanceIds must be a non-empty array.", { status: 400 });
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new InfrastructureError("targetPort must be a valid port number.", { status: 400 });

  const targets = await resolveTargets({ orgId, instanceIds: targetInstanceIds, port: targetPort });

  const { loadBalancers } = await cols();
  const lbId = crypto.randomUUID();
  await loadBalancers.insertOne({
    lbId,
    orgId,
    clusterId,
    nodeId,
    listenPort,
    targetInstanceIds,
    targetPort,
    healthCheckIntervalMs,
    status: "CREATING",
    createdAt: new Date(),
    createdBy: membership?.email || null,
  });
  await enqueue({ orgId, clusterId, nodeId, type: "CREATE_LOAD_BALANCER", resourceId: lbId, params: { lbId, listenPort, targets, healthCheckIntervalMs }, actorEmail: membership?.email });
  return { lbId, status: "CREATING" };
}

export async function listLoadBalancers({ orgId, clusterId }) {
  const { loadBalancers } = await cols();
  return loadBalancers.find(clusterId ? { orgId, clusterId } : { orgId }).sort({ createdAt: -1 }).toArray();
}

export async function getLoadBalancer({ orgId, lbId }) {
  const { loadBalancers } = await cols();
  const doc = await loadBalancers.findOne({ orgId, lbId });
  if (!doc) throw new InfrastructureError("Load balancer not found.", { status: 404 });
  return doc;
}

export async function updateLoadBalancerTargets({ orgId, membership, lbId, targetInstanceIds }) {
  const lb = await getLoadBalancer({ orgId, lbId });
  if (!Array.isArray(targetInstanceIds) || targetInstanceIds.length === 0) throw new InfrastructureError("targetInstanceIds must be a non-empty array.", { status: 400 });
  const targets = await resolveTargets({ orgId, instanceIds: targetInstanceIds, port: lb.targetPort });

  const { loadBalancers } = await cols();
  await loadBalancers.updateOne({ orgId, lbId }, { $set: { targetInstanceIds, status: "UPDATING" } });
  await enqueue({ orgId, clusterId: lb.clusterId, nodeId: lb.nodeId, type: "UPDATE_LOAD_BALANCER_TARGETS", resourceId: lbId, params: { lbId, listenPort: lb.listenPort, targets, healthCheckIntervalMs: lb.healthCheckIntervalMs }, actorEmail: membership?.email });
  return { lbId, status: "UPDATING" };
}

export async function deleteLoadBalancer({ orgId, membership, lbId }) {
  const lb = await getLoadBalancer({ orgId, lbId });
  const { loadBalancers } = await cols();
  await loadBalancers.updateOne({ orgId, lbId }, { $set: { status: "DELETING" } });
  await enqueue({ orgId, clusterId: lb.clusterId, nodeId: lb.nodeId, type: "DELETE_LOAD_BALANCER", resourceId: lbId, params: { lbId }, actorEmail: membership?.email });
  return { lbId, status: "DELETING" };
}

/** Reflects a completed CREATE/UPDATE/DELETE_LOAD_BALANCER operation's
 *  outcome onto the resource's observed status -- called from
 *  operations.js's completeOperation() default case is NOT viable (that
 *  function doesn't know about load balancers, same layering as
 *  k8sClusters.js), so the org-session route calls this after reading an
 *  operation's result, same lazy-advance-on-read pattern k8sClusters.js
 *  already uses for the exact same async-dispatch reason. */
export async function syncLoadBalancerStatus({ orgId, lbId }) {
  const lb = await getLoadBalancer({ orgId, lbId });
  if (!["CREATING", "UPDATING", "DELETING"].includes(lb.status)) return lb;
  const { c } = await cols();
  const operations = c.db.collection("infra_operations");
  const op = await operations.find({ orgId, resourceId: lbId }).sort({ createdAt: -1 }).limit(1).next();
  if (!op || op.status === "QUEUED" || op.status === "RUNNING") return lb;

  const { loadBalancers } = await cols();
  const ok = op.status === "SUCCEEDED";
  const nextStatus = !ok ? "ERROR" : lb.status === "DELETING" ? "DELETED" : "ACTIVE";
  const update = { status: nextStatus, ...(ok ? {} : { errorMessage: op.error || "operation failed" }) };
  await loadBalancers.updateOne({ orgId, lbId }, { $set: update });
  if (ok && nextStatus === "ACTIVE") {
    await appendAuditEntry({ orgId, recordType: "INFRA_LOAD_BALANCER", recordId: lbId, actorEmail: null, action: "LOAD_BALANCER_ACTIVE", previousState: { status: lb.status }, newState: { status: "ACTIVE" }, metadata: {} }).catch(() => {});
  }
  return { ...lb, ...update };
}
