// test/ai-security-anomaly-wiring.test.mjs -- the anomaly route and alerting cron against the real database.
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/ai-security-anomaly-wiring.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server.js";
import { getOrgCollections, ensureOrgIndexes, createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN = randomUUID().slice(0, 8);
const NOW = Date.now();
let c, orgId, otherOrg, owner, member, ownerToken, otherToken, memberToken;
const CRON = `cron-${RUN}`;

before(async () => {
  await ensureOrgIndexes();
  c = await getOrgCollections();
  process.env.CRON_SECRET = CRON;
  orgId = new ObjectId(); otherOrg = new ObjectId();
  owner = `anom-owner-${RUN}@example.com`; member = `anom-member-${RUN}@example.com`;
  const other = `anom-other-${RUN}@example.com`;
  const iso = new Date().toISOString();
  for (const id of [orgId, otherOrg]) await c.orgs.insertOne({ _id: id, name: `anom-${RUN}-${id}`, createdAt: iso });
  await c.orgMembers.insertMany([
    { orgId, email: owner, role: "owner", status: "active", createdAt: iso },
    { orgId, email: member, role: "member", status: "active", createdAt: iso },
    { orgId: otherOrg, email: other, role: "owner", status: "active", createdAt: iso },
  ]);
  const ev = (minAgo, actor, decision = "BLOCK", category = "PROMPT_INJECTION") => ({
    orgId, requestId: randomUUID(), timestamp: new Date(NOW - minAgo * 60_000).toISOString(), createdAt: new Date(NOW - minAgo * 60_000).toISOString(),
    actorEmail: actor, surface: "business-chat", category, severity: "HIGH", decision, reasons: [], controlsTriggered: [], deletedAt: null,
  });
  const history = [];
  for (let h = 3; h < 24 * 7; h += 5) history.push(ev(h * 60, `u${h % 3}@x.com`, h % 2 ? "BLOCK" : "ALLOW"));
  const spike = Array.from({ length: 14 }, (_, i) => ev((i + 1) * 2, "mallory@x.com", "BLOCK", "UNAUTHORIZED_ACCESS"));
  await c.aiSecurityChecks.insertMany([...history, ...spike]);
  ownerToken = (await createSession(owner)).sessionToken;
  memberToken = (await createSession(member)).sessionToken;
  otherToken = (await createSession(other)).sessionToken;
});

after(async () => {
  for (const k of ["orgs", "orgMembers", "aiSecurityChecks", "notifications"]) {
    try { await (c[k] || c.db.collection(k)).deleteMany(k === "orgs" ? { _id: { $in: [orgId, otherOrg] } } : { orgId: { $in: [orgId, otherOrg, String(orgId)] } }); } catch { /* ignore */ }
  }
  await c.db.collection("notifications").deleteMany({ targetEmail: { $regex: RUN } });
  await (await mongoClientPromise).close();
});

const get = (url, token, headers = {}) =>
  new NextRequest(`http://localhost${url}`, { headers: { ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), ...headers } });

test("the owner sees the spike with its evidence", async () => {
  const { GET } = await import("../src/app/api/orgs/ai-security/anomalies/route.js");
  const res = await GET(get(`/api/orgs/ai-security/anomalies?orgId=${orgId}`, ownerToken));
  assert.equal(res.status, 200);
  const body = await res.json();
  const hit = body.anomalies.find((a) => a.type === "ACTOR_BLOCK_SPIKE");
  assert.ok(hit && hit.actor === "mallory@x.com");
  assert.ok(hit.evidence.length > 0);
});

test("a plain member (no AI-security access), another org's owner, and an anonymous caller are refused", async () => {
  const { GET } = await import("../src/app/api/orgs/ai-security/anomalies/route.js");
  assert.equal((await GET(get(`/api/orgs/ai-security/anomalies?orgId=${orgId}`, memberToken))).status, 403);
  assert.equal((await GET(get(`/api/orgs/ai-security/anomalies?orgId=${orgId}`, otherToken))).status, 403);
  assert.equal((await GET(get(`/api/orgs/ai-security/anomalies?orgId=${orgId}`, null))).status, 401);
  assert.equal((await GET(get(`/api/orgs/ai-security/anomalies`, ownerToken))).status, 400);
});

test("the cron rejects a missing or wrong secret, and alerts the owner exactly once per hour", async () => {
  const { GET } = await import("../src/app/api/cron/ai-security-anomalies/route.js");
  assert.equal((await GET(get("/api/cron/ai-security-anomalies", null))).status, 401);
  assert.equal((await GET(get("/api/cron/ai-security-anomalies", null, { authorization: "Bearer wrong" }))).status, 401);

  const first = await (await GET(get("/api/cron/ai-security-anomalies", null, { authorization: `Bearer ${CRON}` }))).json();
  assert.equal(first.success, true);
  assert.ok(first.notified >= 1);
  const count = () => c.db.collection("notifications").countDocuments({ targetEmail: owner, type: "ai_security_anomaly" });
  const afterFirst = await count();
  assert.ok(afterFirst >= 1);

  await GET(get("/api/cron/ai-security-anomalies", null, { authorization: `Bearer ${CRON}` }));
  assert.equal(await count(), afterFirst, "a repeat run in the same hour does not alert again");
  assert.equal(await c.db.collection("notifications").countDocuments({ targetEmail: member, type: "ai_security_anomaly" }), 0, "plain members are not alerted");
});
