// test/governance-lifecycle.test.mjs -- GOV-003: the time-based part of published retention and archival policies (review, archive, delete after the period), with every
// safety rule: scope, protections, one action per object per policy, and the cron route. Real MongoDB.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/governance-lifecycle.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import * as P from "../src/lib/governance/policies.js";
import { runOrgLifecycle } from "../src/lib/governance/lifecycle.js";

const T = { timeout: 300000 };
let org, owner, db, dept, proj;
const DAYS = 86400_000;
const mkDoc = async (name, ageDays, extra = {}) => String((await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: dept, projectId: proj, filename: name, fileHash: `0xlc-${randomBytes(4).toString("hex")}`, sizeBytes: 5, cidAlpha: "QmA", cidBeta: "QmB", uploadedByEmail: owner.email, txHash: "0x1", createdAt: new Date(Date.now() - ageDays * DAYS).toISOString(), updatedAt: new Date(Date.now() - ageDays * DAYS).toISOString(), isLatest: true, deletedAt: null, status: "APPROVED", ...extra })).insertedId);
const mk = async (type, config, scope = {}) => { const p = await P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type, name: `lc-${type}-${randomBytes(2).toString("hex")}`, config, scope, precedence: 1 }); await P.publishPolicy({ orgId: org.oid, policyId: p.policyId, actorEmail: owner.email, membership: owner.membership }); return p.policyId; };
const retire = (id) => P.retirePolicy({ orgId: org.oid, policyId: id, actorEmail: owner.email, membership: owner.membership, reason: "test done" });
const byName = async (n) => cols.orgDocuments.findOne({ orgId: org.orgId, filename: n });
before(async () => { await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("lc", { people: [] }); owner = org.owner; const now = new Date().toISOString(); dept = (await cols.departments.insertOne({ orgId: org.orgId, name: "Ops", createdAt: now })).insertedId; proj = (await cols.projects.insertOne({ orgId: org.orgId, departmentId: dept, name: "P", createdAt: now })).insertedId; });
after(async () => { await cols.orgDocuments.deleteMany({ orgId: org.orgId }); await cols.projects.deleteMany({ orgId: org.orgId }); await cols.departments.deleteMany({ orgId: org.orgId }); await db.collection("governance_policies").deleteMany({ orgId: org.orgId }).catch(() => {}); await teardown(); });

test("retention afterAction=archive archives only old, in-scope, approved objects, once, and never anything protected", T, async () => {
  const id = await mk("retention", { days: 30, afterAction: "archive" }, { pathPrefix: "keep/" });
  await mkDoc("keep/old.txt", 40); await mkDoc("keep/young.txt", 5); await mkDoc("other/old.txt", 40); await mkDoc("keep/held.txt", 40, { legalHold: true }); await mkDoc("keep/locked.txt", 40, { lock: { expiresAt: new Date(Date.now() + 3600_000).toISOString() } }); await mkDoc("keep/draft.txt", 40, { status: "DRAFT" });
  const r = await runOrgLifecycle({ orgId: org.oid }); assert.equal(r.archived, 1, "exactly the old, in-scope, approved, unprotected one"); assert.equal(r.skippedProtected, 2, "the held and the locked ones are left alone");
  assert.equal((await byName("keep/old.txt")).status, "ARCHIVED"); for (const n of ["keep/young.txt", "other/old.txt", "keep/held.txt", "keep/locked.txt"]) assert.equal((await byName(n)).status, "APPROVED", n);
  assert.equal((await byName("keep/draft.txt")).status, "DRAFT", "a draft is not archived by policy");
  assert.deepEqual(await runOrgLifecycle({ orgId: org.oid }), { reviewed: 0, archived: 0, deleted: 0, skippedProtected: 2 }, "a second run changes nothing (one action per object per policy); the two protected ones are looked at again so they are handled once their protection ends");
  await retire(id);
});

test("afterAction=review flags the objects and tells the administrators without changing them; afterAction=delete hides them only when the policy says so, honouring protections", T, async () => {
  const rv = await mk("retention", { days: 10, afterAction: "review" }, { pathPrefix: "rev/" }); await mkDoc("rev/a.txt", 20);
  const r1 = await runOrgLifecycle({ orgId: org.oid }); assert.equal(r1.reviewed, 1); const a = await byName("rev/a.txt"); assert.equal(a.status, "APPROVED"); assert.equal(a.deletedAt, null); assert.ok(a.lifecycleReview, "flagged for review");
  assert.ok(await db.collection("notifications").findOne({ orgId: org.orgId, type: "governance.review" }), "the administrators are told"); await retire(rv);
  const dl = await mk("retention", { days: 10, afterAction: "delete" }, { pathPrefix: "del/" }); await mkDoc("del/gone.txt", 20); await mkDoc("del/held.txt", 20, { legalHold: true }); await mkDoc("del/perm.txt", 20, { metadata: { retention_class: "permanent" } });
  const r2 = await runOrgLifecycle({ orgId: org.oid }); assert.equal(r2.deleted, 1); assert.ok((await byName("del/gone.txt")).deletedAt, "hidden like an S3 delete"); assert.equal((await byName("del/held.txt")).deletedAt, null); assert.equal((await byName("del/perm.txt")).deletedAt, null);
  await retire(dl);
});

test("an archival policy archives approved documents nobody has touched; a retired policy does nothing; the cron route needs the secret and runs the job", T, async () => {
  const ar = await mk("archival", { afterDaysInactive: 60 }, { pathPrefix: "idle/" }); await mkDoc("idle/old.txt", 90); await mkDoc("idle/new.txt", 3);
  assert.equal((await runOrgLifecycle({ orgId: org.oid })).archived, 1); assert.equal((await byName("idle/new.txt")).status, "APPROVED"); await retire(ar);
  await mkDoc("idle/later.txt", 90); assert.equal((await runOrgLifecycle({ orgId: org.oid })).archived, 0, "no published policy, no action");
  process.env.CRON_SECRET = process.env.CRON_SECRET || "test-cron-secret"; const route = await import("../src/app/api/cron/governance-lifecycle/route.js");
  assert.equal((await route.GET(new NextRequest("http://localhost:3000/x"))).status, 401); const ok = await route.GET(new NextRequest("http://localhost:3000/x", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })); assert.equal(ok.status, 200); assert.equal((await ok.json()).success, true);
});
