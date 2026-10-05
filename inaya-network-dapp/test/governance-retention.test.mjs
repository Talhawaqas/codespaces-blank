// test/governance-retention.test.mjs -- GOV-003: published retention and legal-hold POLICIES are enforced on the destructive storage paths (delete, in-place overwrite,
// lifecycle expiry), scoped correctly, stacked on the existing per-object protections, and lifted when the policy is retired. Real MongoDB and the real object store.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/governance-retention.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeChatOrg } from "./_chat-fixtures.mjs";
import { getOrgCollections, toObjectId } from "../src/lib/orgs.js";
import { issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, deleteS3Object } from "../src/lib/s3-compat/store.js";
import * as P from "../src/lib/governance/policies.js";
import { retentionBlock } from "../src/lib/governance/retention.js";

const T = { timeout: 300000 };
let org, owner, db; const created = [];
const mk = async (type, config, scope = {}) => { const p = await P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type, name: `t-${type}-${created.length}`, config, scope, precedence: 1 }); await P.publishPolicy({ orgId: org.oid, policyId: p.policyId, actorEmail: owner.email, membership: owner.membership }); created.push(p.policyId); return p.policyId; };
const put = (key) => putS3Object({ orgId: org.oid, bucket: "govb", key, bodyBuffer: Buffer.from("data " + key), contentType: "text/plain", actorEmail: "t" });
const del = (key) => deleteS3Object({ orgId: org.oid, bucket: "govb", key, actorEmail: "t" });
const age = async (key, days) => { const { orgDocuments } = await getOrgCollections(); await orgDocuments.updateMany({ orgId: toObjectId(org.oid), filename: key }, { $set: { createdAt: new Date(Date.now() - days * 86400_000).toISOString() } }); };
before(async () => { await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("ret", { people: [] }); owner = org.owner; await issueS3Credential({ owner: { type: "org", orgId: org.oid }, actorEmail: "t" }); });
after(async () => { await db.collection("governance_policies").deleteMany({ orgId: org.orgId }).catch(() => {}); try { const { purgeOrgObjects } = await import("../src/lib/s3-compat/purge.js"); await purgeOrgObjects(org.oid); } catch { /* best effort */ } await teardown(); });

test("a retention policy keeps an object until it is old enough, only within its scope, and then allows removal", T, async () => {
  const id = await mk("retention", { days: 30, afterAction: "review" }, { pathPrefix: "keep/" });
  await put("keep/a.txt"); await put("other/b.txt");
  await assert.rejects(del("keep/a.txt"), /retention policy/); await del("other/b.txt");
  await put("keep/c.txt"); await assert.rejects(put("keep/c.txt"), /retention policy/, "an in-place overwrite of a protected object is refused too");
  await age("keep/a.txt", 31); await del("keep/a.txt");
  await P.retirePolicy({ orgId: org.oid, policyId: id, actorEmail: owner.email, membership: owner.membership, reason: "test done" }); await del("keep/c.txt");
});

test("a legal-hold policy with blockDeletion blocks every removal in its scope until it is retired, without any per-object hold", T, async () => {
  const id = await mk("legal_hold", { blockDeletion: true }); await put("held/x.txt");
  await assert.rejects(del("held/x.txt"), /legal-hold policy/);
  await P.retirePolicy({ orgId: org.oid, policyId: id, actorEmail: owner.email, membership: owner.membership, reason: "released" }); await del("held/x.txt");
});

test("the permanent retention class is never deletable, and a policy that is not published has no effect", T, async () => {
  await put("perm/y.txt"); const { orgDocuments } = await getOrgCollections(); await orgDocuments.updateMany({ orgId: toObjectId(org.oid), filename: "perm/y.txt" }, { $set: { "metadata.retention_class": "permanent" } });
  await assert.rejects(del("perm/y.txt"), /permanent retention/);
  const draft = await P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type: "retention", name: "draft-only", config: { days: 9999, afterAction: "review" }, precedence: 1 });
  const doc = await orgDocuments.findOne({ orgId: toObjectId(org.oid), filename: "perm/y.txt" }); assert.equal((await retentionBlock({ orgId: org.oid, doc: { ...doc, metadata: {} } })), null, "a draft policy is not enforced");
  void draft;
});
