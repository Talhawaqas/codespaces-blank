// test/infrastructure-loadbalancers.test.mjs -- gap-closure round, Phase C
// (INFRA-ADV-001/INFRA-NET-009): control-plane coverage for
// src/lib/infrastructure/loadBalancers.js. The real HAProxy process
// lifecycle itself (spawn, real round-robin across real backends, a real
// seamless -sf reload) is proven in the Rust loadbalancer crate's own
// tests (cargo test -p loadbalancer) and recorded in the ledger -- this
// suite covers the Node orchestration layer: validation, operation
// dispatch shape, the lazy status-sync pattern, and tenant isolation.
//
// Run: node --env-file=.env.local --test --test-force-exit --test-timeout=60000 test/infrastructure-loadbalancers.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeChatOrg } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as I from "../src/lib/infrastructure/nodes.js";
import * as O from "../src/lib/infrastructure/operations.js";
import * as L from "../src/lib/infrastructure/loadBalancers.js";

const T = { timeout: 60000 };
let org, db, cluster, membership, nodeId, vpc, instanceA, instanceB;

before(async () => {
  await setup();
  db = (await getOrgCollections()).db;
  org = await makeChatOrg("infralb", { people: ["alice"] });
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
  membership = { role: "owner", email: org.owner.email };
  cluster = await I.createCluster({ orgId: org.oid, membership, name: "LB Test Cluster" });
  nodeId = "fake-node-for-lb-tests";
  vpc = await O.createVpc({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, cidr: "10.93.0.1/24" });
  await db.collection("infra_vpcs").updateOne({ orgId: org.oid, vpcId: vpc.vpcId }, { $set: { status: "AVAILABLE" } });
  instanceA = await O.createGuestInstance({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, name: "a", vpcId: vpc.vpcId, role: "plain" });
  instanceB = await O.createGuestInstance({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, name: "b", vpcId: vpc.vpcId, role: "plain" });
  const instances = db.collection("infra_compute_instances");
  await instances.updateOne({ orgId: org.oid, instanceId: instanceA.instanceId }, { $set: { state: "RUNNING" } });
  await instances.updateOne({ orgId: org.oid, instanceId: instanceB.instanceId }, { $set: { state: "RUNNING" } });
});

after(async () => {
  for (const n of ["infra_clusters", "infra_nodes", "infra_operations", "infra_compute_instances", "infra_vpcs", "infra_load_balancers"]) {
    await db.collection(n).deleteMany({ orgId: org.oid }).catch(() => {});
  }
  await teardown();
});

test("createLoadBalancer validates ports and target instances, resolves real static IPs, queues CREATE_LOAD_BALANCER", T, async () => {
  await assert.rejects(() => L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 0, targetInstanceIds: [instanceA.instanceId], targetPort: 80 }), /listenPort/);
  await assert.rejects(() => L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8080, targetInstanceIds: [], targetPort: 80 }), /targetInstanceIds/);
  await assert.rejects(() => L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8080, targetInstanceIds: ["nonexistent"], targetPort: 80 }), /not found/i);

  const lb = await L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8080, targetInstanceIds: [instanceA.instanceId, instanceB.instanceId], targetPort: 80 });
  assert.equal(lb.status, "CREATING");

  const ops = await O.listOperations({ orgId: org.oid, resourceId: lb.lbId });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "CREATE_LOAD_BALANCER");
  assert.equal(ops[0].params.listenPort, 8080);
  assert.equal(ops[0].params.targets.length, 2);
  assert.ok(ops[0].params.targets.every((t) => t.port === 80 && /^10\.93\.0\.\d+$/.test(t.address)), `targets should carry the real resolved static IPs: ${JSON.stringify(ops[0].params.targets)}`);
});

test("createLoadBalancer refuses an instance with no static IP (not a guest-booting instance)", T, async () => {
  const plain = await O.createInstance({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, name: "blank-vol-instance", vcpu: 1, memoryMib: 512 });
  await assert.rejects(() => L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8081, targetInstanceIds: [plain.instanceId], targetPort: 80 }), /no static IP/);
});

test("syncLoadBalancerStatus moves CREATING -> ACTIVE once the real operation succeeds, and ERROR with a real reason on failure", T, async () => {
  const lb = await L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8082, targetInstanceIds: [instanceA.instanceId], targetPort: 80 });
  const operations = db.collection("infra_operations");
  await operations.updateOne({ orgId: org.oid, resourceId: lb.lbId, type: "CREATE_LOAD_BALANCER" }, { $set: { status: "SUCCEEDED", result: {} } });

  const synced = await L.syncLoadBalancerStatus({ orgId: org.oid, lbId: lb.lbId });
  assert.equal(synced.status, "ACTIVE");

  const lb2 = await L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8083, targetInstanceIds: [instanceA.instanceId], targetPort: 80 });
  await operations.updateOne({ orgId: org.oid, resourceId: lb2.lbId, type: "CREATE_LOAD_BALANCER" }, { $set: { status: "FAILED", error: "haproxy: address already in use" } });
  const synced2 = await L.syncLoadBalancerStatus({ orgId: org.oid, lbId: lb2.lbId });
  assert.equal(synced2.status, "ERROR");
  assert.match(synced2.errorMessage, /address already in use/);
});

test("updateLoadBalancerTargets queues UPDATE_LOAD_BALANCER_TARGETS with the new resolved target set", T, async () => {
  const lb = await L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8084, targetInstanceIds: [instanceA.instanceId], targetPort: 80 });
  const result = await L.updateLoadBalancerTargets({ orgId: org.oid, membership, lbId: lb.lbId, targetInstanceIds: [instanceA.instanceId, instanceB.instanceId] });
  assert.equal(result.status, "UPDATING");
  const ops = await O.listOperations({ orgId: org.oid, resourceId: lb.lbId });
  const updateOp = ops.find((o) => o.type === "UPDATE_LOAD_BALANCER_TARGETS");
  assert.equal(updateOp.params.targets.length, 2);
});

test("deleteLoadBalancer queues DELETE_LOAD_BALANCER and syncs to DELETED", T, async () => {
  const lb = await L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8085, targetInstanceIds: [instanceA.instanceId], targetPort: 80 });
  await L.deleteLoadBalancer({ orgId: org.oid, membership, lbId: lb.lbId });
  const ops = await O.listOperations({ orgId: org.oid, resourceId: lb.lbId });
  assert.ok(ops.some((o) => o.type === "DELETE_LOAD_BALANCER"));

  const operations = db.collection("infra_operations");
  await operations.updateOne({ orgId: org.oid, resourceId: lb.lbId, type: "DELETE_LOAD_BALANCER" }, { $set: { status: "SUCCEEDED", result: {} } });
  const synced = await L.syncLoadBalancerStatus({ orgId: org.oid, lbId: lb.lbId });
  assert.equal(synced.status, "DELETED");
});

test("tenant isolation: another org cannot see or sync this org's load balancer", T, async () => {
  const lb = await L.createLoadBalancer({ orgId: org.oid, membership, clusterId: cluster.clusterId, nodeId, listenPort: 8086, targetInstanceIds: [instanceA.instanceId], targetPort: 80 });

  const otherOrg = await makeChatOrg("infralb-other", { people: ["bob"] });
  await setOrgFeature({ orgId: otherOrg.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
  await assert.rejects(() => L.getLoadBalancer({ orgId: otherOrg.oid, lbId: lb.lbId }), /not found/i);

  const mine = await L.listLoadBalancers({ orgId: org.oid, clusterId: cluster.clusterId });
  const theirs = await L.listLoadBalancers({ orgId: otherOrg.oid });
  assert.ok(mine.some((l) => l.lbId === lb.lbId));
  assert.equal(theirs.length, 0);

  for (const n of ["infra_clusters"]) await db.collection(n).deleteMany({ orgId: otherOrg.oid }).catch(() => {});
});
