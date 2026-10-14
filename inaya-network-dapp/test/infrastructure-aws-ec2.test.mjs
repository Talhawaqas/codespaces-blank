// test/infrastructure-aws-ec2.test.mjs -- gap-closure round, Phase B
// (INFRA-AWS-001..005): control-plane coverage for the AWS EC2-compatible
// route (src/app/api/aws-ec2/route.js) and access-key credentials
// (awsCredentials.js). The real interop bar itself -- an actual `aws` CLI
// v2 installed and run against this exact route via the live dev server
// (RunInstances, DescribeInstances, StopInstances, TerminateInstances, and
// a real MissingParameter error) -- was exercised manually and is recorded
// in docs/infrastructure/IMPLEMENTATION-LEDGER.md; this suite covers what
// a real `aws-cli` session doesn't easily exercise repeatably: credential
// CRUD, tenant isolation, and the route's own per-action logic, each
// request still signed with this project's own real SigV4 implementation
// (awsSigV4.js), not a mock.
//
// Run: node --env-file=.env.local --test --test-force-exit --test-timeout=60000 test/infrastructure-aws-ec2.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setup, teardown, makeChatOrg } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as I from "../src/lib/infrastructure/nodes.js";
import * as A from "../src/lib/infrastructure/awsCredentials.js";
import { _internal } from "../src/lib/infrastructure/awsSigV4.js";
import { POST as awsEc2Post } from "../src/app/api/aws-ec2/route.js";

const T = { timeout: 60000 };
let org, db, cluster, membership;

before(async () => {
  await setup();
  db = (await getOrgCollections()).db;
  org = await makeChatOrg("awsec2", { people: ["alice"] });
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
  membership = { role: "owner", email: org.owner.email };
  cluster = await I.createCluster({ orgId: org.oid, membership, name: "AWS EC2 Test Cluster" });
});

after(async () => {
  for (const n of ["infra_clusters", "infra_nodes", "infra_operations", "infra_compute_instances", "infra_volumes", "infra_vpcs", "infra_aws_credentials"]) {
    await db.collection(n).deleteMany({ orgId: org.oid }).catch(() => {});
  }
  await teardown();
});

// --- credential CRUD -------------------------------------------------

test("createAccessKey mints a real-shaped AKIA key, listAccessKeys never leaks the secret", T, async () => {
  const key = await A.createAccessKey({ orgId: org.oid, membership });
  assert.match(key.accessKeyId, /^AKIA[A-Z2-7]{16}$/);
  assert.equal(key.secretAccessKey.length, 40);

  const list = await A.listAccessKeys({ orgId: org.oid });
  assert.ok(list.some((k) => k.accessKeyId === key.accessKeyId));
  assert.ok(list.every((k) => !("secretAccessKeyEncrypted" in k) && !("secretAccessKey" in k)));
});

test("revokeAccessKey makes resolveAccessKey stop returning it", T, async () => {
  const key = await A.createAccessKey({ orgId: org.oid, membership });
  const before1 = await A.resolveAccessKey({ accessKeyId: key.accessKeyId });
  assert.equal(before1.orgId, org.oid);
  assert.equal(before1.secretAccessKey, key.secretAccessKey);

  await A.revokeAccessKey({ orgId: org.oid, membership, accessKeyId: key.accessKeyId });
  const after1 = await A.resolveAccessKey({ accessKeyId: key.accessKeyId });
  assert.equal(after1, null);
});

test("resolveAccessKey is cross-org (identity derives only from the credential, same discipline as node auth/API keys)", T, async () => {
  const otherOrg = await makeChatOrg("awsec2-other", { people: ["bob"] });
  await setOrgFeature({ orgId: otherOrg.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
  const key = await A.createAccessKey({ orgId: otherOrg.oid, membership: { email: otherOrg.owner.email } });
  const resolved = await A.resolveAccessKey({ accessKeyId: key.accessKeyId });
  assert.equal(resolved.orgId, otherOrg.oid);
  assert.notEqual(resolved.orgId, org.oid);
  for (const n of ["infra_clusters", "infra_aws_credentials"]) await db.collection(n).deleteMany({ orgId: otherOrg.oid }).catch(() => {});
});

// --- route-level dispatch, each request really SigV4-signed -----------

function signedRequest({ accessKeyId, secretAccessKey, action, params = {} }) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const body = new URLSearchParams({ Action: action, Version: "2016-11-15", ...params }).toString();
  const url = "http://127.0.0.1/aws-ec2";
  const headers = { host: "127.0.0.1", "content-type": "application/x-www-form-urlencoded; charset=utf-8", "x-amz-date": amzDate };
  const signedHeaderNames = Object.keys(headers).sort();
  const payloadHashHex = _internal.sha256Hex(body);
  const canonicalRequest = _internal.buildCanonicalRequest({ method: "POST", pathname: "/aws-ec2", searchParams: new URLSearchParams(), headers, signedHeaderNames, payloadHashHex });
  const credentialScope = `${dateStamp}/us-east-1/ec2/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, _internal.sha256Hex(canonicalRequest)].join("\n");
  const signingKey = _internal.deriveSigningKey(secretAccessKey, dateStamp, "us-east-1", "ec2");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;
  return new Request(url, { method: "POST", headers: { ...headers, authorization }, body });
}

async function parseXml(response) {
  const text = await response.text();
  return { status: response.status, text };
}

test("RunInstances with a real signed request creates a real tracked instance; DescribeInstances lists it back", T, async () => {
  const key = await A.createAccessKey({ orgId: org.oid, membership });
  const nodes = db.collection("infra_nodes");
  await nodes.updateOne(
    { orgId: org.oid, nodeId: "fake-node-aws-route-test" },
    { $set: { nodeId: "fake-node-aws-route-test", orgId: org.oid, clusterId: cluster.clusterId, hostname: "fake", status: "ACTIVE", capacity: { hostVcpu: 8, hostMemoryMib: 8192, allocatedVcpu: 0, allocatedMemoryMib: 0, hostGpu: 0 }, lastHeartbeatAt: new Date() } },
    { upsert: true }
  );

  const runReq = signedRequest({
    accessKeyId: key.accessKeyId,
    secretAccessKey: key.secretAccessKey,
    action: "RunInstances",
    params: { InstanceType: "inaya.medium", "TagSpecification.1.ResourceType": "instance", "TagSpecification.1.Tag.1.Key": "clusterId", "TagSpecification.1.Tag.1.Value": cluster.clusterId },
  });
  const runRes = await parseXml(await awsEc2Post(runReq));
  assert.equal(runRes.status, 200);
  assert.match(runRes.text, /<RunInstancesResponse/);
  const instanceId = /<instanceId>([^<]+)<\/instanceId>/.exec(runRes.text)?.[1];
  assert.ok(instanceId, `expected an instanceId in: ${runRes.text}`);
  assert.match(runRes.text, /<code>0<\/code><name>pending<\/name>/);

  const descReq = signedRequest({ accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, action: "DescribeInstances" });
  const descRes = await parseXml(await awsEc2Post(descReq));
  assert.equal(descRes.status, 200);
  assert.ok(descRes.text.includes(instanceId));
});

test("an unsigned/garbage Authorization header is rejected with AuthFailure, never silently treated as anonymous", T, async () => {
  const req = new Request("http://127.0.0.1/aws-ec2", {
    method: "POST",
    headers: { authorization: "not-a-real-sigv4-header", "x-amz-date": "20261013T000000Z", host: "127.0.0.1" },
    body: "Action=DescribeInstances&Version=2016-11-15",
  });
  const res = await awsEc2Post(req);
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.match(text, /<Code>AuthFailure<\/Code>/);
});

test("a request signed with the wrong secret is rejected with SignatureDoesNotMatch", T, async () => {
  const key = await A.createAccessKey({ orgId: org.oid, membership });
  const req = signedRequest({ accessKeyId: key.accessKeyId, secretAccessKey: "totallyWrongSecretXXXXXXXXXXXXXXXXXXXXX", action: "DescribeInstances" });
  const res = await awsEc2Post(req);
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.match(text, /<Code>SignatureDoesNotMatch<\/Code>/);
});

test("a request signed by org A's key never sees org B's instances (tenant isolation through the route)", T, async () => {
  const otherOrg = await makeChatOrg("awsec2-iso", { people: ["carol"] });
  await setOrgFeature({ orgId: otherOrg.oid, name: "FEATURE_INFRASTRUCTURE", enabled: true });
  const otherMembership = { email: otherOrg.owner.email };
  const otherCluster = await I.createCluster({ orgId: otherOrg.oid, membership: otherMembership, name: "Other" });
  const otherKey = await A.createAccessKey({ orgId: otherOrg.oid, membership: otherMembership });

  // org (the outer suite's org) already has at least one instance from the earlier test.
  const req = signedRequest({ accessKeyId: otherKey.accessKeyId, secretAccessKey: otherKey.secretAccessKey, action: "DescribeInstances" });
  const res = await parseXml(await awsEc2Post(req));
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<instanceId>/, "org B's key must never see org A's instances");

  for (const n of ["infra_clusters", "infra_aws_credentials"]) await db.collection(n).deleteMany({ orgId: otherOrg.oid }).catch(() => {});
  void otherCluster;
});

test("an unsupported Action is rejected with InvalidAction, not a silent no-op", T, async () => {
  const key = await A.createAccessKey({ orgId: org.oid, membership });
  const req = signedRequest({ accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, action: "DescribeRegions" });
  const res = await parseXml(await awsEc2Post(req));
  assert.equal(res.status, 400);
  assert.match(res.text, /<Code>InvalidAction<\/Code>/);
});
