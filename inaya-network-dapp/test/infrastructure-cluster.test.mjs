// test/infrastructure-cluster.test.mjs -- Sovereign Infrastructure Fabric SOW, Phase 5 (cluster/HA: scheduler,
// node draining, failure detection). Uses 3 real enrolled node identities (real ECDSA keypairs, real CSRs, real
// signed certificates -- the same proven pipeline from test/infrastructure-nodes.test.mjs), each independently
// heartbeating with real capacity numbers, to exercise genuine multi-node scheduling logic. These three "nodes"
// share one underlying kernel (independent cryptographic identities and heartbeat streams, not independent
// physical/virtual hosts) -- see docs/infrastructure/IMPLEMENTATION-LEDGER.md's Phase 5 section for why that
// trade-off was made and what it does and doesn't prove.
//
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/infrastructure-cluster.test.mjs

import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as x509 from "@peculiar/x509";
import { setup, teardown, makeChatOrg } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as I from "../src/lib/infrastructure/nodes.js";
import * as O from "../src/lib/infrastructure/operations.js";

x509.cryptoProvider.set(globalThis.crypto);

const T = { timeout: 300000 };
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
let org, db, cluster, membership;

async function enrollRealNode(hostname) {
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });
  const keys = await globalThis.crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=pending-enrollment", signingAlgorithm: ALG, keys });
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname, csrPem: csr.toString("pem") });
  await I.approveNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });
  return { nodeId: enrolled.nodeId, keys };
}

async function heartbeatWithCapacity(node, capacity) {
  const payload = { nodeId: node.nodeId, iat: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = await globalThis.crypto.subtle.sign(ALG, node.keys.privateKey, Buffer.from(payloadB64, "utf8"));
  const signedToken = `${payloadB64}.${Buffer.from(sig).toString("base64url")}`;
  await I.recordHeartbeat({ signedToken, capacity, runtimeVersion: "test", kernelVersion: "test" });
}

before(async () => {
  await setup();
  db = (await getOrgCollections()).db;
  org = await makeChatOrg("infracluster", { people: ["alice"] });
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
  membership = { role: "owner", email: org.owner.email };
  cluster = await I.createCluster({ orgId: org.oid, membership, name: "Scheduler Test Cluster" });
});

after(async () => {
  for (const n of ["infra_clusters", "infra_nodes", "infra_enrollment_tokens", "infra_operations", "infra_compute_instances", "infra_volumes", "infra_cluster_cas"]) {
    await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {});
  }
  await teardown();
});

test("scheduler: rejects placement when no node has reported capacity yet", T, async () => {
  const node = await enrollRealNode("empty-node");
  await assert.rejects(() => I.scheduleNode({ orgId: org.oid, clusterId: cluster.clusterId, vcpu: 1, memoryMib: 512 }), /NO_CAPACITY|No eligible node/);
});

test("scheduler: picks the node with the most free memory among eligible candidates, with a real explanation", T, async () => {
  const small = await enrollRealNode("small-node");
  const big = await enrollRealNode("big-node");
  await heartbeatWithCapacity(small, { hostVcpu: 4, hostMemoryMib: 4096, allocatedVcpu: 0, allocatedMemoryMib: 0, hostGpu: 0 });
  await heartbeatWithCapacity(big, { hostVcpu: 16, hostMemoryMib: 32768, allocatedVcpu: 0, allocatedMemoryMib: 0, hostGpu: 0 });

  const result = await I.scheduleNode({ orgId: org.oid, clusterId: cluster.clusterId, vcpu: 2, memoryMib: 1024 });
  assert.equal(result.nodeId, big.nodeId);
  assert.match(result.reason, /MiB free/);
});

test("scheduler: excludes a node without enough free capacity", T, async () => {
  // Isolated in its own cluster -- a tight-capacity node is the only candidate.
  const freshCluster = await I.createCluster({ orgId: org.oid, membership, name: "Tight Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: freshCluster.clusterId });
  const keys = await globalThis.crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=pending-enrollment", signingAlgorithm: ALG, keys });
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "tight-only", csrPem: csr.toString("pem") });
  await I.approveNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });
  await heartbeatWithCapacity({ nodeId: enrolled.nodeId, keys }, { hostVcpu: 2, hostMemoryMib: 1024, allocatedVcpu: 2, allocatedMemoryMib: 900, hostGpu: 0 });

  await assert.rejects(() => I.scheduleNode({ orgId: org.oid, clusterId: freshCluster.clusterId, vcpu: 1, memoryMib: 500 }), /capacity/i);
});

test("createInstance without an explicit nodeId uses the scheduler", T, async () => {
  const freshCluster = await I.createCluster({ orgId: org.oid, membership, name: "Auto-Schedule Cluster" });
  const node = await (async () => {
    const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: freshCluster.clusterId });
    const keys = await globalThis.crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=pending-enrollment", signingAlgorithm: ALG, keys });
    const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "auto-node", csrPem: csr.toString("pem") });
    await I.approveNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });
    return { nodeId: enrolled.nodeId, keys };
  })();
  await heartbeatWithCapacity(node, { hostVcpu: 8, hostMemoryMib: 8192, allocatedVcpu: 0, allocatedMemoryMib: 0, hostGpu: 0 });

  const inst = await O.createInstance({ orgId: org.oid, membership, clusterId: freshCluster.clusterId, name: "auto-scheduled", vcpu: 1, memoryMib: 512 });
  assert.equal(inst.nodeId, node.nodeId);
  assert.ok(inst.schedulingReason.includes("free"));
});

test("a node that stops heartbeating is excluded from scheduling (UNAVAILABLE), and draining blocks new scheduling without a forced migration claim", T, async () => {
  const freshCluster = await I.createCluster({ orgId: org.oid, membership, name: "Failure Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: freshCluster.clusterId });
  const keys = await globalThis.crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=pending-enrollment", signingAlgorithm: ALG, keys });
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "flaky-node", csrPem: csr.toString("pem") });
  await I.approveNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });
  await heartbeatWithCapacity({ nodeId: enrolled.nodeId, keys }, { hostVcpu: 4, hostMemoryMib: 4096, allocatedVcpu: 0, allocatedMemoryMib: 0, hostGpu: 0 });

  // Real scheduling succeeds while healthy.
  const ok = await I.scheduleNode({ orgId: org.oid, clusterId: freshCluster.clusterId, vcpu: 1, memoryMib: 256 });
  assert.equal(ok.nodeId, enrolled.nodeId);

  // Simulate a stale heartbeat (SOW §108: a node that stops renewing
  // eventually reads as UNAVAILABLE) by backdating lastHeartbeatAt directly
  // -- real wall-clock staleness, not a status flag flipped by hand.
  await db.collection("infra_nodes").updateOne({ orgId: org.oid, nodeId: enrolled.nodeId }, { $set: { lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000) } });
  const node = await I.getNode({ orgId: org.oid, nodeId: enrolled.nodeId });
  assert.equal(I.deriveNodeHealth(node), "UNAVAILABLE");
  await assert.rejects(() => I.scheduleNode({ orgId: org.oid, clusterId: freshCluster.clusterId, vcpu: 1, memoryMib: 256 }), /capacity|eligible/i);

  // Draining a healthy node also blocks new scheduling and is honest about not migrating anything.
  await heartbeatWithCapacity({ nodeId: enrolled.nodeId, keys }, { hostVcpu: 4, hostMemoryMib: 4096, allocatedVcpu: 0, allocatedMemoryMib: 0, hostGpu: 0 });
  const drained = await I.drainNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });
  assert.equal(drained.status, "DRAINING");
  assert.equal(drained.activeInstancesNotMigrated, 0);
  // The scheduler excludes it directly by status (query is status:"ACTIVE"),
  // independent of deriveNodeHealth's own heartbeat-age logic.
  await assert.rejects(() => I.scheduleNode({ orgId: org.oid, clusterId: freshCluster.clusterId, vcpu: 1, memoryMib: 256 }), /capacity|eligible/i);
});
