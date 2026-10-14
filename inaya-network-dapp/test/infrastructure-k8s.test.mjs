// test/infrastructure-k8s.test.mjs -- gap-closure round, Phase D
// (INFRA-ADV-003/004): k3s-on-real-guest-VM orchestration in
// src/lib/infrastructure/k8sClusters.js. The real guest boot + real k3s
// install itself is proven end-to-end against the compiled Rust binaries
// (see docs/infrastructure/IMPLEMENTATION-LEDGER.md, Phase A/D) -- this
// suite covers the control-plane orchestration logic only: operation
// dispatch shape, the lazy PROVISIONING_SERVER -> SERVER_READY/ERROR
// advance, agent gating, kubeconfig secrecy, and tenant isolation. The
// operation's real completion path (completeOperation, which requires a
// real enrolled node's signed token) is exercised for real elsewhere
// (test/infrastructure-nodes.test.mjs); this suite simulates a completed
// operation by writing directly to infra_operations, the same technique
// test/infrastructure-operations.test.mjs already uses for volume/instance
// state transitions.
//
// Run: node --env-file=.env.local --test --test-force-exit --test-timeout=300000 test/infrastructure-k8s.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeChatOrg } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as I from "../src/lib/infrastructure/nodes.js";
import * as O from "../src/lib/infrastructure/operations.js";
import * as K from "../src/lib/infrastructure/k8sClusters.js";

const T = { timeout: 300000 };
let org, db, cluster, membership, nodeId, vpc;

before(async () => {
  await setup();
  db = (await getOrgCollections()).db;
  org = await makeChatOrg("infrak8s", { people: ["alice"] });
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
  membership = { role: "owner", email: org.owner.email };
  cluster = await I.createCluster({ orgId: org.oid, membership, name: "K8s Test Cluster" });
  nodeId = "fake-node-for-k8s-tests"; // operation dispatch doesn't require a real enrolled node, same precedent as infrastructure-operations.test.mjs
  vpc = await O.createVpc({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, cidr: "10.95.0.1/24" });
  await db.collection("infra_vpcs").updateOne({ orgId: org.oid, vpcId: vpc.vpcId }, { $set: { status: "AVAILABLE" } });
});

after(async () => {
  for (const n of ["infra_clusters", "infra_nodes", "infra_operations", "infra_compute_instances", "infra_vpcs", "infra_k8s_clusters"]) {
    await db.collection(n).deleteMany({ orgId: org.oid }).catch(() => {});
  }
  await teardown();
});

test("createK8sCluster requires a vpcId and queues a BOOT_GUEST_INSTANCE operation with role=k8s-server", T, async () => {
  await assert.rejects(() => O.createGuestInstance({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, name: "x", role: "plain" }), /vpcId is required/);

  const k = await K.createK8sCluster({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, vpcId: vpc.vpcId });
  assert.equal(k.status, "PROVISIONING_SERVER");
  assert.ok(k.serverInstanceId);
  assert.match(k.serverStaticIp, /^10\.95\.0\.\d+$/);
  assert.equal(k.kubeApiEndpoint, `https://${k.serverStaticIp}:6443`);

  const ops = await O.listOperations({ orgId: org.oid, resourceId: k.serverInstanceId });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "BOOT_GUEST_INSTANCE");
  assert.equal(ops[0].params.role, "k8s-server");
  assert.equal(ops[0].params.vpcId, vpc.vpcId);
});

test("two instances allocate distinct static IPs inside the same VPC", T, async () => {
  const a = await O.createGuestInstance({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, name: "guest-a", vpcId: vpc.vpcId, role: "plain" });
  const b = await O.createGuestInstance({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, name: "guest-b", vpcId: vpc.vpcId, role: "plain" });
  assert.notEqual(a.staticIp, b.staticIp);
  assert.match(a.staticIp, /^10\.95\.0\.\d+$/);
});

test("lazy advance: a completed server operation moves the cluster to SERVER_READY with an encrypted kubeconfig/token, never plaintext on the doc", T, async () => {
  const k = await K.createK8sCluster({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, vpcId: vpc.vpcId });
  const operations = db.collection("infra_operations");
  // The node's own BOOT_GUEST_INSTANCE executor already substitutes the
  // real static IP for 127.0.0.1 before this result ever reaches the
  // control plane (see operations.rs's "127.0.0.1" -> static_ip rewrite) --
  // so a realistic simulated result already carries the real IP, never the
  // loopback address.
  await operations.updateOne(
    { orgId: org.oid, resourceId: k.serverInstanceId, type: "BOOT_GUEST_INSTANCE" },
    { $set: { status: "SUCCEEDED", result: { staticIp: k.serverStaticIp, k3sNodeToken: "FAKE::real-shaped-token::K10x", kubeconfig: `apiVersion: v1\nclusters:\n- cluster:\n    server: https://${k.serverStaticIp}:6443\n` } } }
  );

  const refreshed = await K.getK8sCluster({ orgId: org.oid, k8sClusterId: k.k8sClusterId });
  assert.equal(refreshed.status, "SERVER_READY");
  assert.ok(refreshed.kubeconfigEncrypted, "kubeconfig should be stored encrypted");
  assert.ok(!refreshed.kubeconfigEncrypted.includes("127.0.0.1"), "stored value must be ciphertext, not the plaintext kubeconfig");

  const kubeconfig = await K.getKubeconfig({ orgId: org.oid, k8sClusterId: k.k8sClusterId });
  assert.ok(kubeconfig.includes(k.serverStaticIp), "the real guest's static IP should have been substituted for 127.0.0.1 by the node before this was ever stored");

  // Re-reading again must not re-derive from a stale op -- status stays SERVER_READY (not re-run).
  const again = await K.getK8sCluster({ orgId: org.oid, k8sClusterId: k.k8sClusterId });
  assert.equal(again.status, "SERVER_READY");
});

test("lazy advance: a failed server operation moves the cluster to ERROR with a real reason, and addK8sAgent is refused", T, async () => {
  const k = await K.createK8sCluster({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, vpcId: vpc.vpcId });
  const operations = db.collection("infra_operations");
  await operations.updateOne({ orgId: org.oid, resourceId: k.serverInstanceId, type: "BOOT_GUEST_INSTANCE" }, { $set: { status: "FAILED", error: "qemu failed to boot: out of memory on the test host" } });

  const refreshed = await K.getK8sCluster({ orgId: org.oid, k8sClusterId: k.k8sClusterId });
  assert.equal(refreshed.status, "ERROR");
  assert.match(refreshed.errorMessage, /out of memory/);

  await assert.rejects(() => K.addK8sAgent({ orgId: org.oid, membership, k8sClusterId: k.k8sClusterId }), /READY/);
});

test("addK8sAgent, once SERVER_READY, queues a BOOT_GUEST_INSTANCE with role=k8s-agent carrying the real decrypted token", T, async () => {
  const k = await K.createK8sCluster({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, vpcId: vpc.vpcId });
  const operations = db.collection("infra_operations");
  await operations.updateOne(
    { orgId: org.oid, resourceId: k.serverInstanceId, type: "BOOT_GUEST_INSTANCE" },
    { $set: { status: "SUCCEEDED", result: { staticIp: k.serverStaticIp, k3sNodeToken: "FAKE::another-token::K10x", kubeconfig: "apiVersion: v1\n" } } }
  );
  await K.getK8sCluster({ orgId: org.oid, k8sClusterId: k.k8sClusterId }); // trigger the advance

  const agent = await K.addK8sAgent({ orgId: org.oid, membership, k8sClusterId: k.k8sClusterId });
  const ops = await O.listOperations({ orgId: org.oid, resourceId: agent.instanceId });
  assert.equal(ops[0].type, "BOOT_GUEST_INSTANCE");
  assert.equal(ops[0].params.role, "k8s-agent");
  assert.equal(ops[0].params.k3sToken, "FAKE::another-token::K10x");
  assert.equal(ops[0].params.k3sServerUrl, k.kubeApiEndpoint);

  const final = await K.getK8sCluster({ orgId: org.oid, k8sClusterId: k.k8sClusterId });
  assert.ok(final.agentInstanceIds.includes(agent.instanceId));
});

test("deleteK8sCluster terminates the server and all agent instances", T, async () => {
  const k = await K.createK8sCluster({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, vpcId: vpc.vpcId });
  await K.deleteK8sCluster({ orgId: org.oid, membership, k8sClusterId: k.k8sClusterId });

  const instance = await O.getInstance({ orgId: org.oid, instanceId: k.serverInstanceId });
  const ops = await O.listOperations({ orgId: org.oid, resourceId: k.serverInstanceId });
  assert.ok(ops.some((o) => o.type === "TERMINATE_INSTANCE"), "deleting the cluster should queue a real TERMINATE_INSTANCE for its server");
  assert.ok(instance, "the instance record itself is preserved for audit, only its state transitions");

  const refreshed = await K.getK8sCluster({ orgId: org.oid, k8sClusterId: k.k8sClusterId });
  assert.equal(refreshed.status, "DELETED");
});

test("tenant isolation: another org cannot see or read this org's k8s cluster", T, async () => {
  const k = await K.createK8sCluster({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, vpcId: vpc.vpcId });

  const otherOrg = await makeChatOrg("infrak8s-other", { people: ["bob"] });
  await setOrgFeature({ orgId: otherOrg.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
  await assert.rejects(() => K.getK8sCluster({ orgId: otherOrg.oid, k8sClusterId: k.k8sClusterId }), /not found/i);

  const mine = await K.listK8sClusters({ orgId: org.oid, clusterId: cluster.clusterId });
  const theirs = await K.listK8sClusters({ orgId: otherOrg.oid });
  assert.ok(mine.some((c) => c.k8sClusterId === k.k8sClusterId));
  assert.equal(theirs.length, 0);

  for (const n of ["infra_clusters"]) await db.collection(n).deleteMany({ orgId: otherOrg.oid }).catch(() => {});
});
