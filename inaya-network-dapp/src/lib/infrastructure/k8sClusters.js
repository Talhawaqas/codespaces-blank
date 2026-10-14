// src/lib/infrastructure/k8sClusters.js
//
// Gap-closure round, Phase D (closes INFRA-ADV-003/004): real Kubernetes
// via k3s (real upstream Kubernetes, a single static binary) running on
// real guest-OS-booting VMs (Phase A's BOOT_GUEST_INSTANCE operation).
// Container hosting isn't a separate feature here -- k3s running real
// containers is the complete answer, per the original SOW bundling them
// together.
//
// Orchestration note: operation dispatch is async (the node polls for
// work), so cluster creation can't synchronously know the server's real
// node-token the moment it's requested. This file advances a cluster's
// status lazily, on read (getK8sCluster/listK8sClusters), by checking
// whether its BOOT_GUEST_INSTANCE operation has completed yet -- the same
// "desired vs observed state, reflected when it's actually known" pattern
// operations.js's own completeOperation() already uses, just one layer up.

import crypto from "node:crypto";
import { getOrgCollections } from "../orgs.js";
import { InfrastructureError, getCluster } from "./nodes.js";
import { createGuestInstance, listOperations, terminateInstance } from "./operations.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { appendAuditEntry } from "../auditChain.js";

let indexed = false;
async function cols() {
  const c = await getOrgCollections();
  const k8sClusters = c.db.collection("infra_k8s_clusters");
  if (!indexed) {
    await Promise.all([
      k8sClusters.createIndex({ k8sClusterId: 1 }, { unique: true }),
      k8sClusters.createIndex({ orgId: 1, clusterId: 1 }),
    ]);
    indexed = true;
  }
  return { c, k8sClusters };
}

const K3S_API_PORT = 6443;

export async function createK8sCluster({ orgId, membership, clusterId, nodeId, vpcId, serverVcpu = 2, serverMemoryMib = 2048, sizeGib }) {
  await getCluster({ orgId, clusterId });
  if (!isIntegrationCryptoConfigured()) {
    throw new InfrastructureError("INTEGRATION_ENCRYPTION_KEY is not configured -- a k3s kubeconfig/join token cannot be stored until it's set.", { status: 500 });
  }
  const server = await createGuestInstance({ orgId, membership, clusterId, nodeId, name: "k8s-server", vcpu: serverVcpu, memoryMib: serverMemoryMib, sizeGib, vpcId, role: "k8s-server" });

  const { k8sClusters } = await cols();
  const k8sClusterId = crypto.randomUUID();
  const doc = {
    k8sClusterId,
    orgId,
    clusterId,
    vpcId,
    serverInstanceId: server.instanceId,
    serverStaticIp: server.staticIp,
    serverNodeId: server.nodeId,
    agentInstanceIds: [],
    status: "PROVISIONING_SERVER",
    kubeApiEndpoint: `https://${server.staticIp}:${K3S_API_PORT}`,
    kubeconfigEncrypted: null,
    nodeTokenEncrypted: null,
    createdAt: new Date(),
    createdBy: membership?.email || null,
  };
  await k8sClusters.insertOne(doc);
  await appendAuditEntry({ orgId, recordType: "INFRA_K8S_CLUSTER", recordId: k8sClusterId, actorEmail: membership?.email || null, action: "K8S_CLUSTER_CREATING", previousState: null, newState: { status: "PROVISIONING_SERVER" }, metadata: { clusterId, vpcId, serverInstanceId: server.instanceId } }).catch(() => {});
  return doc;
}

/** Checks the server's BOOT_GUEST_INSTANCE operation and advances the
 *  cluster's stored status the first time it observes a real outcome --
 *  never re-derives from a stale cached result once already advanced. */
async function advanceIfPending(doc) {
  if (doc.status !== "PROVISIONING_SERVER") return doc;
  const ops = await listOperations({ orgId: doc.orgId, resourceId: doc.serverInstanceId });
  const bootOp = ops.find((o) => o.type === "BOOT_GUEST_INSTANCE");
  if (!bootOp || bootOp.status === "QUEUED" || bootOp.status === "RUNNING") return doc;

  const { k8sClusters } = await cols();
  if (bootOp.status === "FAILED") {
    const update = { status: "ERROR", errorMessage: bootOp.error || "k3s server provisioning failed." };
    await k8sClusters.updateOne({ orgId: doc.orgId, k8sClusterId: doc.k8sClusterId }, { $set: update });
    return { ...doc, ...update };
  }
  // SUCCEEDED
  const nodeToken = bootOp.result?.k3sNodeToken;
  const kubeconfig = bootOp.result?.kubeconfig;
  if (!nodeToken || !kubeconfig) {
    // The instance itself came up (QEMU-level success) but the k3s-specific
    // artifacts are missing -- report honestly rather than claiming READY.
    const update = { status: "ERROR", errorMessage: "k3s server instance booted but did not return a node-token/kubeconfig." };
    await k8sClusters.updateOne({ orgId: doc.orgId, k8sClusterId: doc.k8sClusterId }, { $set: update });
    return { ...doc, ...update };
  }
  const update = { status: "SERVER_READY", nodeTokenEncrypted: encryptIntegrationSecret(nodeToken), kubeconfigEncrypted: encryptIntegrationSecret(kubeconfig), serverReadyAt: new Date() };
  await k8sClusters.updateOne({ orgId: doc.orgId, k8sClusterId: doc.k8sClusterId }, { $set: update });
  await appendAuditEntry({ orgId: doc.orgId, recordType: "INFRA_K8S_CLUSTER", recordId: doc.k8sClusterId, actorEmail: null, action: "K8S_SERVER_READY", previousState: { status: "PROVISIONING_SERVER" }, newState: { status: "SERVER_READY" }, metadata: {} }).catch(() => {});
  return { ...doc, ...update };
}

export async function listK8sClusters({ orgId, clusterId }) {
  const { k8sClusters } = await cols();
  const docs = await k8sClusters.find(clusterId ? { orgId, clusterId } : { orgId }).sort({ createdAt: -1 }).toArray();
  return Promise.all(docs.map(advanceIfPending));
}

export async function getK8sCluster({ orgId, k8sClusterId }) {
  const { k8sClusters } = await cols();
  const doc = await k8sClusters.findOne({ orgId, k8sClusterId });
  if (!doc) throw new InfrastructureError("Kubernetes cluster not found.", { status: 404 });
  return advanceIfPending(doc);
}

export async function addK8sAgent({ orgId, membership, k8sClusterId, agentVcpu = 2, agentMemoryMib = 2048, sizeGib, nodeId }) {
  const doc = await getK8sCluster({ orgId, k8sClusterId });
  if (doc.status !== "SERVER_READY") throw new InfrastructureError(`Cannot add an agent until the server is READY (current status: ${doc.status}).`, { status: 409 });
  const nodeToken = decryptIntegrationSecret(doc.nodeTokenEncrypted);
  const agent = await createGuestInstance({
    orgId,
    membership,
    clusterId: doc.clusterId,
    // Defaults to the server's own node -- a reasonable default for a
    // single-node dev/test deployment; an explicit nodeId lets a caller
    // place an agent on a different real node when one exists.
    nodeId: nodeId || doc.serverNodeId,
    name: `k8s-agent-${doc.agentInstanceIds.length + 1}`,
    vcpu: agentVcpu,
    memoryMib: agentMemoryMib,
    sizeGib,
    vpcId: doc.vpcId,
    role: "k8s-agent",
    k3sServerUrl: doc.kubeApiEndpoint,
    k3sToken: nodeToken,
  });
  const { k8sClusters } = await cols();
  await k8sClusters.updateOne({ orgId, k8sClusterId }, { $addToSet: { agentInstanceIds: agent.instanceId } });
  await appendAuditEntry({ orgId, recordType: "INFRA_K8S_CLUSTER", recordId: k8sClusterId, actorEmail: membership?.email || null, action: "K8S_AGENT_ADDED", previousState: null, newState: { agentInstanceId: agent.instanceId }, metadata: {} }).catch(() => {});
  return agent;
}

export async function getKubeconfig({ orgId, k8sClusterId }) {
  const doc = await getK8sCluster({ orgId, k8sClusterId });
  if (!doc.kubeconfigEncrypted) throw new InfrastructureError(`Kubeconfig is not available yet (status: ${doc.status}).`, { status: 409 });
  return decryptIntegrationSecret(doc.kubeconfigEncrypted);
}

export async function deleteK8sCluster({ orgId, membership, k8sClusterId }) {
  const doc = await getK8sCluster({ orgId, k8sClusterId });
  const { k8sClusters } = await cols();
  // Reuses the exact same instance-termination path every other compute
  // instance in this codebase goes through -- a k8s server/agent is a
  // real infra_compute_instances row like any other, not a parallel
  // resource type with its own teardown logic.
  for (const instanceId of [doc.serverInstanceId, ...doc.agentInstanceIds]) {
    await terminateInstance({ orgId, membership, instanceId }).catch(() => {});
  }
  await k8sClusters.updateOne({ orgId, k8sClusterId }, { $set: { status: "DELETED", deletedAt: new Date(), deletedBy: membership?.email || null } });
  await appendAuditEntry({ orgId, recordType: "INFRA_K8S_CLUSTER", recordId: k8sClusterId, actorEmail: membership?.email || null, action: "K8S_CLUSTER_DELETED", previousState: { status: doc.status }, newState: { status: "DELETED" }, metadata: {} }).catch(() => {});
  return { k8sClusterId, status: "DELETED" };
}
