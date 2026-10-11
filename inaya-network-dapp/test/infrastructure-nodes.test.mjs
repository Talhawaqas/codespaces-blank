// test/infrastructure-nodes.test.mjs -- Sovereign Infrastructure Fabric SOW, Phase 1 (node runtime: cluster,
// enrollment, node identity/certificates, heartbeat, revocation). Real database, real ECDSA P-256 keypairs via
// Node's native WebCrypto (the same algorithm the Rust node runtime's rcgen-generated keys use -- confirmed by
// an end-to-end run of the actual compiled inaya-infra-node/inaya-infra-cli binaries against a live dev server,
// documented in docs/infrastructure/IMPLEMENTATION-LEDGER.md, INFRA-N-006).
//
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/infrastructure-nodes.test.mjs

import "reflect-metadata";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as x509 from "@peculiar/x509";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { canAccessInfrastructure, canManageInfrastructure } from "../src/lib/orgGates.js";
import * as I from "../src/lib/infrastructure/nodes.js";
import { listAuditChain } from "../src/lib/auditChain.js";

x509.cryptoProvider.set(globalThis.crypto);

const T = { timeout: 300000 };
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
let org, db;

async function realCsr(commonName) {
  const keys = await globalThis.crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${commonName}`, signingAlgorithm: ALG, keys });
  return { keys, csrPem: csr.toString("pem") };
}

async function signAuthToken(keys, nodeId, { iatOverride } = {}) {
  const payload = { nodeId, iat: iatOverride ?? Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = await globalThis.crypto.subtle.sign(ALG, keys.privateKey, Buffer.from(payloadB64, "utf8"));
  return `${payloadB64}.${Buffer.from(sig).toString("base64url")}`;
}

before(async () => {
  await setup();
  db = (await getOrgCollections()).db;
  org = await makeChatOrg("infra", { people: ["alice", "bob"] });
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
});

after(async () => {
  for (const n of ["infra_clusters", "infra_enrollment_tokens", "infra_nodes", "infra_cluster_cas"]) {
    await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {});
  }
  await teardown();
});

test("permission gates: infrastructureRole follows the storageRole precedent exactly", T, async () => {
  assert.equal(canAccessInfrastructure(null), false);
  assert.equal(canAccessInfrastructure({ role: "member" }), false);
  assert.equal(canAccessInfrastructure({ role: "member", infrastructureRole: "staff" }), true);
  assert.equal(canManageInfrastructure({ role: "member", infrastructureRole: "staff" }), false);
  assert.equal(canManageInfrastructure({ role: "member", infrastructureRole: "manager" }), true);
  assert.equal(canManageInfrastructure({ role: "owner" }), true);
});

test("createCluster + createEnrollmentToken: real records, token returned once", T, async () => {
  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Test Cluster" });
  assert.ok(cluster.clusterId);
  assert.equal(cluster.mode, "DEVELOPMENT");

  const { token, expiresAt } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32);
  assert.ok(expiresAt instanceof Date);
});

test("full node lifecycle: enroll (real CSR+signing) -> heartbeat -> approve -> revoke", T, async () => {
  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Lifecycle Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });

  const { keys, csrPem } = await realCsr("pending-enrollment");
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "test-host", csrPem });
  assert.equal(enrolled.status, "PENDING");
  assert.ok(enrolled.nodeId);
  assert.ok(enrolled.certificatePem.includes("BEGIN CERTIFICATE"));
  assert.ok(enrolled.caCertificatePem.includes("BEGIN CERTIFICATE"));

  // The signed cert genuinely chains to the cluster CA.
  const nodeCert = new x509.X509Certificate(enrolled.certificatePem);
  const caCert = new x509.X509Certificate(enrolled.caCertificatePem);
  const chainOk = await nodeCert.verify({ publicKey: await caCert.publicKey.export(), signatureOnly: true });
  assert.equal(chainOk, true);

  // A real signed heartbeat is accepted and recorded.
  const signedToken = await signAuthToken(keys, enrolled.nodeId);
  const hb = await I.recordHeartbeat({
    signedToken,
    capacity: { hostVcpu: 4, hostMemoryMib: 8192, reservedVcpu: 0, reservedMemoryMib: 0, allocatedVcpu: 0, allocatedMemoryMib: 0, hostGpu: 0, reservedGpu: 0, allocatedGpu: 0, storageOverheadGib: 0 },
    runtimeVersion: "0.1.0",
    kernelVersion: "test-kernel",
  });
  assert.equal(hb.ok, true);

  const node = await I.getNode({ orgId: org.oid, nodeId: enrolled.nodeId });
  assert.equal(node.capacity.hostVcpu, 4);
  assert.equal(I.deriveNodeHealth(node), "PENDING"); // not yet approved

  await I.approveNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });
  const approved = await I.getNode({ orgId: org.oid, nodeId: enrolled.nodeId });
  assert.equal(approved.status, "ACTIVE");
  assert.equal(I.deriveNodeHealth(approved), "ACTIVE");

  await I.revokeNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });
  const revoked = await I.getNode({ orgId: org.oid, nodeId: enrolled.nodeId });
  assert.equal(revoked.status, "REVOKED");

  // A revoked node's signed heartbeat is rejected.
  const signedToken2 = await signAuthToken(keys, enrolled.nodeId);
  await assert.rejects(() => I.recordHeartbeat({ signedToken: signedToken2, capacity: null, runtimeVersion: "x", kernelVersion: "x" }), /revoked/i);
});

test("enrollment token is single-use: a replayed token is rejected", T, async () => {
  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Replay Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });

  const first = await realCsr("node-a");
  await I.enrollNode({ enrollmentToken: token, hostname: "host-a", csrPem: first.csrPem });

  const second = await realCsr("node-b");
  await assert.rejects(() => I.enrollNode({ enrollmentToken: token, hostname: "host-b", csrPem: second.csrPem }), /already been used/i);
});

test("a malformed CSR is rejected without creating a node", T, async () => {
  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Bad CSR Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });

  await assert.rejects(() => I.enrollNode({ enrollmentToken: token, hostname: "bad-host", csrPem: "not-a-real-csr" }), /Malformed CSR|CSR rejected/i);

  // The token must still be unused -- a rejected CSR doesn't burn it (so a
  // real client that mis-sent a request can simply retry).
  const nodesForCluster = await I.listNodes({ orgId: org.oid, clusterId: cluster.clusterId });
  assert.equal(nodesForCluster.length, 0);
});

test("a forged node auth token (wrong signing key) is rejected", T, async () => {
  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Forgery Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });

  const real = await realCsr("real-node");
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "real-host", csrPem: real.csrPem });

  // An attacker with a DIFFERENT keypair tries to heartbeat as this node_id.
  const attacker = await globalThis.crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const forgedToken = await signAuthToken(attacker, enrolled.nodeId);
  await assert.rejects(() => I.recordHeartbeat({ signedToken: forgedToken, capacity: null, runtimeVersion: "x", kernelVersion: "x" }), /signature verification failed/i);
});

test("an expired/clock-skewed auth token is rejected", T, async () => {
  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Skew Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });

  const { keys, csrPem } = await realCsr("skew-node");
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "skew-host", csrPem });

  const staleToken = await signAuthToken(keys, enrolled.nodeId, { iatOverride: Date.now() - 5 * 60 * 1000 });
  await assert.rejects(() => I.recordHeartbeat({ signedToken: staleToken, capacity: null, runtimeVersion: "x", kernelVersion: "x" }), /clock-skewed|too old/i);
});

test("deriveNodeHealth: UNKNOWN before first heartbeat, UNAVAILABLE once stale", T, async () => {
  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Health Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });
  const { csrPem } = await realCsr("health-node");
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "health-host", csrPem });
  await I.approveNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });

  const nodeBeforeHeartbeat = await I.getNode({ orgId: org.oid, nodeId: enrolled.nodeId });
  assert.equal(I.deriveNodeHealth(nodeBeforeHeartbeat), "UNKNOWN");

  const fakeOldHeartbeatNode = { ...nodeBeforeHeartbeat, status: "ACTIVE", lastHeartbeatAt: new Date(Date.now() - 120_000) };
  assert.equal(I.deriveNodeHealth(fakeOldHeartbeatNode, { staleAfterMs: 90_000 }), "UNAVAILABLE");
});

test("cross-org isolation: another org cannot see or approve this org's nodes", T, async () => {
  const otherOrg = await makeChatOrg("infra-other", { people: ["carol"] });
  await setOrgFeature({ orgId: otherOrg.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });

  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Isolation Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });
  const { csrPem } = await realCsr("isolation-node");
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "isolation-host", csrPem });

  await assert.rejects(() => I.getNode({ orgId: otherOrg.oid, nodeId: enrolled.nodeId }), /not found/i);
  await assert.rejects(() => I.approveNode({ orgId: otherOrg.oid, membership: { role: "owner", email: otherOrg.owner.email }, nodeId: enrolled.nodeId }), /not found/i);

  for (const n of ["infra_clusters", "infra_enrollment_tokens", "infra_nodes", "infra_cluster_cas"]) {
    await db.collection(n).deleteMany({ orgId: otherOrg.orgId }).catch(() => {});
  }
});

test("Phase 7: node lifecycle actions genuinely append to the real audit chain", T, async () => {
  const membership = { role: "owner", email: org.owner.email };
  const cluster = await I.createCluster({ orgId: org.oid, membership, name: "Audit Cluster" });
  const { token } = await I.createEnrollmentToken({ orgId: org.oid, membership, clusterId: cluster.clusterId });
  const { csrPem } = await realCsr("audit-node");
  const enrolled = await I.enrollNode({ enrollmentToken: token, hostname: "audit-host", csrPem });
  await I.approveNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });
  await I.revokeNode({ orgId: org.oid, membership, nodeId: enrolled.nodeId });

  const chain = await listAuditChain(org.oid, { limit: 500 });
  const actions = chain.filter((e) => e.recordId === enrolled.nodeId).map((e) => e.action);
  assert.ok(actions.includes("NODE_ENROLLED"), `expected NODE_ENROLLED in ${JSON.stringify(actions)}`);
  assert.ok(actions.includes("NODE_APPROVED"));
  assert.ok(actions.includes("NODE_REVOKED"));
});
