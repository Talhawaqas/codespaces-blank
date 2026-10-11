// src/lib/infrastructure/operations.js
//
// Sovereign Infrastructure Fabric SOW §71-72: async operation dispatch to
// a specific node. Reuses the node auth (signed-token) pattern from
// nodes.js. Command dispatch is HTTP long-poll (the node polls on its
// heartbeat cycle), not NATS -- see ADR-003's Phase 1 refinement note: a
// single node polling for its own pending operations is still simple
// request/reply, and standing up a broker before multi-node fan-out is a
// real, tested need (Phase 5) would mean claiming infrastructure this
// phase doesn't actually exercise. Compute/block resources and their
// operations share this one file since Phase 2/3 are tightly coupled (a
// VM's disk is a volume) and splitting them now would be a premature
// abstraction with nothing yet on both sides to justify it.

import crypto from "node:crypto";
import { getOrgCollections } from "../orgs.js";
import { InfrastructureError, verifyNodeAuth, getCluster, scheduleNode } from "./nodes.js";
import { appendAuditEntry } from "../auditChain.js";
import { notifyEvent } from "../notify/router.js";

const OPERATION_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"];

let indexed = false;
async function cols() {
  const c = await getOrgCollections();
  const operations = c.db.collection("infra_operations");
  const instances = c.db.collection("infra_compute_instances");
  const volumes = c.db.collection("infra_volumes");
  const vpcs = c.db.collection("infra_vpcs");
  if (!indexed) {
    await Promise.all([
      operations.createIndex({ nodeId: 1, status: 1 }),
      operations.createIndex({ operationId: 1 }, { unique: true }),
      operations.createIndex({ orgId: 1, resourceId: 1 }),
      instances.createIndex({ instanceId: 1 }, { unique: true }),
      instances.createIndex({ orgId: 1, clusterId: 1 }),
      volumes.createIndex({ volumeId: 1 }, { unique: true }),
      volumes.createIndex({ orgId: 1, clusterId: 1 }),
      vpcs.createIndex({ vpcId: 1 }, { unique: true }),
      vpcs.createIndex({ orgId: 1, clusterId: 1 }),
    ]);
    indexed = true;
  }
  return { c, operations, instances, volumes, vpcs };
}

const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

async function enqueue({ orgId, clusterId, nodeId, type, resourceId, params, actorEmail }) {
  const { operations } = await cols();
  const operationId = crypto.randomUUID();
  const doc = {
    operationId,
    orgId,
    clusterId,
    nodeId,
    type,
    resourceId,
    params: params || {},
    status: "QUEUED",
    result: null,
    error: null,
    createdAt: new Date(),
    createdBy: actorEmail || null,
    startedAt: null,
    completedAt: null,
  };
  await operations.insertOne(doc);
  // One chokepoint for every infra operation request -- covers resource
  // creation and every lifecycle action (start/stop/reboot/terminate)
  // without scattering audit calls across each caller.
  await appendAuditEntry({ orgId, recordType: "INFRA_OPERATION", recordId: operationId, actorEmail: actorEmail || null, action: type, previousState: null, newState: { status: "QUEUED", resourceId }, metadata: { clusterId, nodeId } }).catch(() => {});
  return doc;
}

// ---------------------------------------------------------------------------
// Volumes (SOW §23-25)
// ---------------------------------------------------------------------------

export async function createVolume({ orgId, membership, clusterId, nodeId, sizeGib }) {
  await getCluster({ orgId, clusterId });
  if (!nodeId) throw new InfrastructureError("nodeId is required.", { status: 400 });
  if (!Number.isInteger(sizeGib) || sizeGib <= 0 || sizeGib > 2048) {
    throw new InfrastructureError("sizeGib must be an integer between 1 and 2048.", { status: 400 });
  }
  const { volumes } = await cols();
  const volumeId = crypto.randomUUID();
  await volumes.insertOne({ volumeId, orgId, clusterId, nodeId, sizeGib, status: "CREATING", createdAt: new Date(), createdBy: membership?.email || null });
  await enqueue({ orgId, clusterId, nodeId, type: "CREATE_VOLUME", resourceId: volumeId, params: { volumeId, sizeGib }, actorEmail: membership?.email });
  return { volumeId, status: "CREATING" };
}

export async function listVolumes({ orgId, clusterId }) {
  const { volumes } = await cols();
  return volumes.find(clusterId ? { orgId, clusterId } : { orgId }).sort({ createdAt: -1 }).toArray();
}

export async function getVolume({ orgId, volumeId }) {
  const { volumes } = await cols();
  const v = await volumes.findOne({ orgId, volumeId });
  if (!v) throw new InfrastructureError("Volume not found.", { status: 404 });
  return v;
}

export async function deleteVolume({ orgId, membership, volumeId }) {
  const v = await getVolume({ orgId, volumeId });
  if (v.status === "IN_USE") throw new InfrastructureError("Cannot delete a volume that is attached to an instance.", { status: 409 });
  const { volumes } = await cols();
  await volumes.updateOne({ orgId, volumeId }, { $set: { status: "DELETING" } });
  await enqueue({ orgId, clusterId: v.clusterId, nodeId: v.nodeId, type: "DELETE_VOLUME", resourceId: volumeId, params: { volumeId }, actorEmail: membership?.email });
  return { volumeId, status: "DELETING" };
}

// ---------------------------------------------------------------------------
// VPCs / security groups (SOW §28-32, ADR-002: Linux bridge + nftables)
// ---------------------------------------------------------------------------

export async function createVpc({ orgId, membership, clusterId, nodeId, cidr, securityGroupRules }) {
  await getCluster({ orgId, clusterId });
  if (!nodeId) throw new InfrastructureError("nodeId is required.", { status: 400 });
  if (!CIDR_RE.test(cidr || "")) throw new InfrastructureError("cidr must be a valid IPv4 CIDR (e.g. 10.77.0.1/24).", { status: 400 });
  const rules = Array.isArray(securityGroupRules) ? securityGroupRules : [];
  for (const r of rules) {
    if (!["tcp", "udp", "icmp"].includes(r.protocol)) throw new InfrastructureError(`Invalid security group protocol: ${r.protocol}`, { status: 400 });
  }

  const { vpcs } = await cols();
  const vpcId = crypto.randomUUID();
  await vpcs.insertOne({ vpcId, orgId, clusterId, nodeId, cidr, securityGroupRules: rules, status: "CREATING", createdAt: new Date(), createdBy: membership?.email || null });
  await enqueue({ orgId, clusterId, nodeId, type: "CREATE_VPC", resourceId: vpcId, params: { vpcId, cidr, securityGroupRules: rules }, actorEmail: membership?.email });
  return { vpcId, status: "CREATING" };
}

export async function listVpcs({ orgId, clusterId }) {
  const { vpcs } = await cols();
  return vpcs.find(clusterId ? { orgId, clusterId } : { orgId }).sort({ createdAt: -1 }).toArray();
}

export async function getVpc({ orgId, vpcId }) {
  const { vpcs } = await cols();
  const v = await vpcs.findOne({ orgId, vpcId });
  if (!v) throw new InfrastructureError("VPC not found.", { status: 404 });
  return v;
}

export async function deleteVpc({ orgId, membership, vpcId }) {
  const vpc = await getVpc({ orgId, vpcId });
  const { instances } = await cols();
  const attached = await instances.countDocuments({ orgId, vpcId, state: { $in: ["RUNNING", "PROVISIONING"] } });
  if (attached > 0) throw new InfrastructureError("Cannot delete a VPC with attached instances.", { status: 409 });
  const { vpcs } = await cols();
  await vpcs.updateOne({ orgId, vpcId }, { $set: { status: "DELETING" } });
  await enqueue({ orgId, clusterId: vpc.clusterId, nodeId: vpc.nodeId, type: "DELETE_VPC", resourceId: vpcId, params: { vpcId }, actorEmail: membership?.email });
  return { vpcId, status: "DELETING" };
}

// ---------------------------------------------------------------------------
// Compute instances (SOW §12-14)
// ---------------------------------------------------------------------------

export async function createInstance({ orgId, membership, clusterId, nodeId, name, vcpu, memoryMib, volumeId, vpcId }) {
  await getCluster({ orgId, clusterId });
  if (!name) throw new InfrastructureError("name is required.", { status: 400 });
  if (!Number.isInteger(vcpu) || vcpu < 1 || vcpu > 64) throw new InfrastructureError("vcpu must be an integer between 1 and 64.", { status: 400 });
  if (!Number.isInteger(memoryMib) || memoryMib < 128 || memoryMib > 1048576) {
    throw new InfrastructureError("memoryMib must be an integer between 128 and 1048576.", { status: 400 });
  }
  let schedule = null;
  if (!nodeId) {
    schedule = await scheduleNode({ orgId, clusterId, vcpu, memoryMib });
    nodeId = schedule.nodeId;
  }
  if (volumeId) {
    const v = await getVolume({ orgId, volumeId });
    if (v.status !== "AVAILABLE") throw new InfrastructureError(`Volume is not AVAILABLE (status: ${v.status}).`, { status: 409 });
  }
  let vpcSecurityGroupRules = [];
  if (vpcId) {
    const vpc = await getVpc({ orgId, vpcId });
    if (vpc.status !== "AVAILABLE") throw new InfrastructureError(`VPC is not AVAILABLE (status: ${vpc.status}).`, { status: 409 });
    vpcSecurityGroupRules = vpc.securityGroupRules || [];
  }

  const { instances, volumes } = await cols();
  const instanceId = crypto.randomUUID();
  await instances.insertOne({
    instanceId,
    orgId,
    clusterId,
    nodeId,
    name,
    vcpu,
    memoryMib,
    volumeId: volumeId || null,
    vpcId: vpcId || null,
    state: "PROVISIONING",
    createdAt: new Date(),
    createdBy: membership?.email || null,
  });
  if (volumeId) {
    await volumes.updateOne({ orgId, volumeId }, { $set: { status: "ATTACHING" } });
  }
  await enqueue({
    orgId,
    clusterId,
    nodeId,
    type: "CREATE_INSTANCE",
    resourceId: instanceId,
    params: { instanceId, name, vcpu, memoryMib, volumeId: volumeId || null, vpcId: vpcId || null, securityGroupRules: vpcSecurityGroupRules },
    actorEmail: membership?.email,
  });
  return { instanceId, state: "PROVISIONING", nodeId, schedulingReason: schedule?.reason || "explicitly requested node" };
}

async function instanceAction(action, { orgId, membership, instanceId }) {
  const { instances } = await cols();
  const inst = await instances.findOne({ orgId, instanceId });
  if (!inst) throw new InfrastructureError("Instance not found.", { status: 404 });
  const TYPE = { start: "START_INSTANCE", stop: "STOP_INSTANCE", reboot: "REBOOT_INSTANCE", terminate: "TERMINATE_INSTANCE" }[action];
  await enqueue({ orgId, clusterId: inst.clusterId, nodeId: inst.nodeId, type: TYPE, resourceId: instanceId, params: { instanceId }, actorEmail: membership?.email });
  return { instanceId, queued: TYPE };
}
export const startInstance = (args) => instanceAction("start", args);
export const stopInstance = (args) => instanceAction("stop", args);
export const rebootInstance = (args) => instanceAction("reboot", args);
export const terminateInstance = (args) => instanceAction("terminate", args);

export async function listInstances({ orgId, clusterId }) {
  const { instances } = await cols();
  return instances.find(clusterId ? { orgId, clusterId } : { orgId }).sort({ createdAt: -1 }).toArray();
}

export async function getInstance({ orgId, instanceId }) {
  const { instances } = await cols();
  const inst = await instances.findOne({ orgId, instanceId });
  if (!inst) throw new InfrastructureError("Instance not found.", { status: 404 });
  return inst;
}

// ---------------------------------------------------------------------------
// Node-facing: poll pending operations, report completion
// ---------------------------------------------------------------------------

/** Called by a node on its heartbeat cycle. Atomically claims (QUEUED ->
 *  RUNNING) so two concurrent polls from the same node never double-claim
 *  the same operation (SOW §73-74's concurrency-safety requirement). */
export async function claimPendingOperations({ signedToken, maxOperations = 5 }) {
  const { node, orgId } = await verifyNodeAuth({ signedToken });
  const { operations } = await cols();
  const claimed = [];
  for (let i = 0; i < maxOperations; i++) {
    const result = await operations.findOneAndUpdate(
      { orgId, nodeId: node.nodeId, status: "QUEUED" },
      { $set: { status: "RUNNING", startedAt: new Date() } },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );
    if (!result) break;
    claimed.push(result);
  }
  return claimed;
}

export async function completeOperation({ signedToken, operationId, status, result, error }) {
  const { node, orgId } = await verifyNodeAuth({ signedToken });
  if (!["SUCCEEDED", "FAILED"].includes(status)) throw new InfrastructureError("status must be SUCCEEDED or FAILED.", { status: 400 });
  const { operations, instances, volumes, vpcs } = await cols();
  const op = await operations.findOne({ orgId, operationId, nodeId: node.nodeId });
  if (!op) throw new InfrastructureError("Operation not found.", { status: 404 });

  await operations.updateOne({ orgId, operationId }, { $set: { status, result: result || null, error: error || null, completedAt: new Date() } });
  await appendAuditEntry({ orgId, recordType: "INFRA_OPERATION", recordId: operationId, actorEmail: null, action: `${op.type}_${status}`, previousState: { status: "RUNNING" }, newState: { status }, metadata: { error: error || null } }).catch(() => {});
  if (status === "FAILED") {
    notifyEvent({ orgId, event: "infra.operation_failed", audience: "admins", title: "Infrastructure operation failed", body: `${op.type} failed on node ${op.nodeId}: ${error || "unknown error"}`, link: null, sourceId: operationId, dedupeKey: `infra-op-failed-${operationId}` }).catch(() => {});
  }

  // Reflect the outcome onto the resource's observed state (SOW §78:
  // desired vs observed, never a silently stale badge).
  const ok = status === "SUCCEEDED";
  switch (op.type) {
    case "CREATE_VPC":
      await vpcs.updateOne({ orgId, vpcId: op.resourceId }, { $set: { status: ok ? "AVAILABLE" : "FAILED" } });
      break;
    case "DELETE_VPC":
      if (ok) await vpcs.updateOne({ orgId, vpcId: op.resourceId }, { $set: { status: "DELETED" } });
      break;
    case "CREATE_VOLUME":
      await volumes.updateOne({ orgId, volumeId: op.resourceId }, { $set: { status: ok ? "AVAILABLE" : "FAILED" } });
      break;
    case "DELETE_VOLUME":
      if (ok) await volumes.updateOne({ orgId, volumeId: op.resourceId }, { $set: { status: "DELETED" } });
      break;
    case "CREATE_INSTANCE":
      await instances.updateOne({ orgId, instanceId: op.resourceId }, { $set: { state: ok ? "RUNNING" : "ERROR" } });
      if (ok && op.params?.volumeId) await volumes.updateOne({ orgId, volumeId: op.params.volumeId }, { $set: { status: "IN_USE" } });
      break;
    case "START_INSTANCE":
      await instances.updateOne({ orgId, instanceId: op.resourceId }, { $set: { state: ok ? "RUNNING" : "ERROR" } });
      break;
    case "STOP_INSTANCE":
      await instances.updateOne({ orgId, instanceId: op.resourceId }, { $set: { state: ok ? "STOPPED" : "ERROR" } });
      break;
    case "REBOOT_INSTANCE":
      await instances.updateOne({ orgId, instanceId: op.resourceId }, { $set: { state: ok ? "RUNNING" : "ERROR" } });
      break;
    case "TERMINATE_INSTANCE":
      await instances.updateOne({ orgId, instanceId: op.resourceId }, { $set: { state: ok ? "TERMINATED" : "ERROR" } });
      break;
    default:
      break;
  }
  return { ok: true };
}

export async function listOperations({ orgId, resourceId }) {
  const { operations } = await cols();
  return operations.find(resourceId ? { orgId, resourceId } : { orgId }).sort({ createdAt: -1 }).limit(100).toArray();
}

export { OPERATION_STATUSES };
