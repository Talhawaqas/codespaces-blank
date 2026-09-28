// Managed Database Service (RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream A). Real
// database for Inaya's own control-plane records; the Supabase Management API itself is intercepted at the
// fetch boundary (same technique test/help-support.test.mjs uses for Resend) -- this suite never creates,
// pauses, or deletes a real project on any real Supabase account, and never sends a real password anywhere.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../src/lib/orgs.js";
import { getRdsCollections } from "../src/lib/rds/db.js";
import { decryptIntegrationSecret } from "../src/lib/integrationCrypto.js";
import { provisionInstance, listInstances, startInstance, stopInstance, deprovisionInstance, runQuery, listConfiguredProviders } from "../src/lib/rds/instances.js";
import { flushEvidence } from "../src/lib/rds/record.js";
import { listBusinessEvents } from "../src/lib/businessEvents.js";
import clientPromise from "../src/lib/mongodb.js";

const RUN = randomBytes(3).toString("hex"); const created = [];
process.env.INTEGRATION_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || randomBytes(32).toString("base64");
process.env.SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || "sbp_test_token_never_real";

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://api.supabase.com/")) return realFetch(url, init);
  calls.push({ url: u, method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
  if (u.endsWith("/v1/projects") && init?.method === "POST") return new Response(JSON.stringify({ ref: `proj-${RUN}`, organization_id: "org-1", name: JSON.parse(init.body).name, region: JSON.parse(init.body).region || "us-east-1", created_at: new Date().toISOString(), status: "COMING_UP" }), { status: 201 });
  if (/\/v1\/projects\/proj-.*\/pause$/.test(u)) return new Response(JSON.stringify({ ref: `proj-${RUN}`, status: "PAUSING" }), { status: 200 });
  if (/\/v1\/projects\/proj-.*\/restore$/.test(u)) return new Response(JSON.stringify({ ref: `proj-${RUN}`, status: "RESTORING" }), { status: 200 });
  if (/\/v1\/projects\/proj-.*$/.test(u) && init?.method === "DELETE") return new Response(JSON.stringify({ ref: `proj-${RUN}` }), { status: 200 });
  if (/\/v1\/projects\/proj-.*\/database\/query$/.test(u)) return new Response(JSON.stringify([{ result: "ok" }]), { status: 201 });
  return new Response(JSON.stringify({ message: "unhandled test route" }), { status: 500 });
};

after(async () => {
  globalThis.fetch = realFetch;
  await flushEvidence().catch(() => {});
  try {
    const c = await getOrgCollections();
    for (const n of (await c.db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name)) { try { await c.db.collection(n).deleteMany({ orgId: { $in: created } }); } catch { /* ignore */ } }
    await c.orgs.deleteMany({ _id: { $in: created } });
    await c.db.collection("sessions").deleteMany({ email: new RegExp(`^rds-${RUN}`) });
    const rds = await getRdsCollections();
    await rds.rdsInstances.deleteMany({ orgId: { $in: created } });
  } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

let orgId, ownerToken, ownerMembership, memberMembership, instanceId;

test("setup", async () => {
  await ensureOrgIndexes(); const c = await getOrgCollections(); const now = new Date().toISOString();
  orgId = (await c.orgs.insertOne({ name: `rds-${RUN}-co`, createdAt: now })).insertedId; created.push(orgId);
  ownerMembership = { role: "owner" }; memberMembership = { role: "member" };
  ownerToken = (await createSession(`rds-${RUN}-owner@example.com`)).sessionToken;
  assert.ok(listConfiguredProviders().includes("supabase"), "supabase should be configured once SUPABASE_ACCESS_TOKEN is set");
});

test("a plain member cannot provision; the real Supabase API is called with the real fields, and the password is never stored in plaintext", async () => {
  const denied = await provisionInstance({ orgId: String(orgId), membership: memberMembership, actorEmail: "x@example.com", providerName: "supabase", name: `di-${RUN}`, organizationSlug: "acme-org", dbPassword: "correct horse battery staple", highAvailability: false });
  assert.equal(denied.status, 403);

  const r = await provisionInstance({ orgId: String(orgId), membership: ownerMembership, actorEmail: `rds-${RUN}-owner@example.com`, providerName: "supabase", name: `di-${RUN}`, organizationSlug: "acme-org", dbPassword: "correct horse battery staple", highAvailability: false });
  assert.ok(!r.error, JSON.stringify(r)); instanceId = r.instance.instanceId;
  assert.equal(r.instance.providerRef, `proj-${RUN}`);

  const createCall = calls.find((c) => c.url.endsWith("/v1/projects") && c.method === "POST");
  assert.ok(createCall, "the create-project call should have gone out");
  assert.equal(createCall.body.organization_slug, "acme-org");
  assert.equal(createCall.body.db_pass, "correct horse battery staple", "the real password must reach the real provider once");

  const rds = await getRdsCollections();
  const stored = await rds.rdsInstances.findOne({ orgId });
  assert.ok(!JSON.stringify(stored).includes("correct horse battery staple"), "the plaintext password must never be stored");
  assert.equal(decryptIntegrationSecret(stored.dbPasswordEnc), "correct horse battery staple", "but it must be recoverable from its encrypted form");

  const dup = await provisionInstance({ orgId: String(orgId), membership: ownerMembership, actorEmail: "owner@example.com", providerName: "supabase", name: `di-${RUN}`, organizationSlug: "acme-org", dbPassword: "another password here" });
  assert.equal(dup.status, 409, "a second instance with the same name must be refused");
});

test("lifecycle: stop/start call the real provider endpoints; a plain member cannot", async () => {
  const denied = await stopInstance({ orgId: String(orgId), membership: memberMembership, actorEmail: "x@example.com", instanceId });
  assert.equal(denied.status, 403);
  const stop = await stopInstance({ orgId: String(orgId), membership: ownerMembership, actorEmail: "owner@example.com", instanceId });
  assert.ok(stop.ok, JSON.stringify(stop));
  assert.ok(calls.some((c) => c.url.includes("/pause")));
  const start = await startInstance({ orgId: String(orgId), membership: ownerMembership, actorEmail: "owner@example.com", instanceId });
  assert.ok(start.ok, JSON.stringify(start));
  assert.ok(calls.some((c) => c.url.includes("/restore")));
});

test("query: a read query is allowed for a plain member; a write query needs owner/admin", async () => {
  const read = await runQuery({ orgId: String(orgId), membership: memberMembership, actorEmail: "x@example.com", instanceId, sql: "select 1", readOnly: true });
  assert.ok(read.result, JSON.stringify(read));
  const write = await runQuery({ orgId: String(orgId), membership: memberMembership, actorEmail: "x@example.com", instanceId, sql: "delete from x", readOnly: false });
  assert.equal(write.status, 403);
  const writeOk = await runQuery({ orgId: String(orgId), membership: ownerMembership, actorEmail: "owner@example.com", instanceId, sql: "delete from x", readOnly: false });
  assert.ok(writeOk.result, JSON.stringify(writeOk));
});

test("evidence graph: the instance is a real subject with an EXECUTED_AS relationship to its provider ref", async () => {
  await flushEvidence();
  const events = await listBusinessEvents({ orgId: String(orgId), membership: ownerMembership, subjectType: "RDS_INSTANCE" });
  const ev = events.find((e) => String(e.subjectId) === instanceId);
  assert.ok(ev, "an Evidence Graph subject should exist for this instance");
  assert.ok(ev.relationships.some((r) => r.type === "EXECUTED_AS"));
});

test("deletion requires typing the exact instance name, and calls the real delete endpoint", async () => {
  const wrongName = await deprovisionInstance({ orgId: String(orgId), membership: ownerMembership, actorEmail: "owner@example.com", instanceId, confirmName: "not-the-name" });
  assert.equal(wrongName.status, 400);
  const ok = await deprovisionInstance({ orgId: String(orgId), membership: ownerMembership, actorEmail: "owner@example.com", instanceId, confirmName: `di-${RUN}` });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.ok(calls.some((c) => /\/v1\/projects\/proj-.*$/.test(c.url) && c.method === "DELETE"));
  const list = await listInstances({ orgId: String(orgId) });
  assert.equal(list.instances.find((i) => i.instanceId === instanceId).status, "deprovisioned");
});

test("security hardening: provisioning is rate-limited per actor, not just per org", async () => {
  const actor = `ratelimit-${RUN}@example.com`;
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await provisionInstance({ orgId: String(orgId), membership: ownerMembership, actorEmail: actor, providerName: "supabase", name: `di-rl-${RUN}-${i}`, organizationSlug: "acme-org", dbPassword: "correct horse battery staple" }));
  }
  assert.equal(results.slice(0, 5).every((r) => !r.error), true, JSON.stringify(results.slice(0, 5)));
  assert.equal(results[5].status, 429, JSON.stringify(results[5]));
});

test("security hardening: at most 10 active instances per organization, even for a real owner/admin call", async () => {
  const rds = await getRdsCollections();
  const now = new Date().toISOString();
  // Seed enough fake "active" instances directly to be certain the org is at/over the cap,
  // regardless of how many real ones earlier tests in this file left behind.
  await rds.rdsInstances.insertMany(Array.from({ length: 10 }, (_, i) => ({ orgId, name: `cap-test-${RUN}-${i}`, provider: "supabase", engine: "postgres", providerRef: `proj-cap-${RUN}-${i}`, status: "provisioning", createdAt: now, updatedAt: now, createdBy: "owner@example.com" })));
  const overCap = await provisionInstance({ orgId: String(orgId), membership: ownerMembership, actorEmail: `cap-${RUN}@example.com`, providerName: "supabase", name: `di-over-cap-${RUN}`, organizationSlug: "acme-org", dbPassword: "correct horse battery staple" });
  assert.equal(overCap.status, 409, JSON.stringify(overCap));
  assert.match(overCap.error, /at most 10 active/i);
});
