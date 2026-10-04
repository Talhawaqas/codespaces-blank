// test/ai-policy-builder.test.mjs -- the org AI policy: every write is validated, and the settings that the Policy tab
// offers actually change what the gateway does (provider list, unapproved-model rule, token budget). Real MongoDB.
// Run: node --env-file=.env.local --test --test-force-exit test/ai-policy-builder.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { checkInputSecurity } from "../src/lib/aiSecurity/gateway.js";
import { getOrgAiPolicy, setOrgAiPolicy, listOrgAiPolicyVersions, validatePolicyPatch, DEFAULT_AI_POLICY } from "../src/lib/aiSecurity/orgPolicy.js";

const RUN = randomUUID().slice(0, 8);
let cols; const orgIds = [];
before(async () => { await ensureOrgIndexes(); cols = await getOrgCollections(); });
after(async () => {
  await Promise.all([cols.orgs.deleteMany({ _id: { $in: orgIds } }), cols.orgMembers.deleteMany({ orgId: { $in: orgIds } }), cols.aiSecurityPolicies.deleteMany({ orgId: { $in: orgIds } }), cols.aiSecurityChecks.deleteMany({ orgId: { $in: orgIds } }), cols.orgActivity.deleteMany({ orgId: { $in: orgIds } })]);
  const { default: client } = await import("../src/lib/mongodb.js"); await (await client).close();
});
async function makeOrg(label) {
  const _id = (await cols.orgs.insertOne({ name: `policy-${RUN}-${label}`, createdAt: new Date().toISOString() })).insertedId; orgIds.push(_id);
  const ownerEmail = `o-${RUN}-${label}@example.com`;
  await cols.orgMembers.insertOne({ orgId: _id, email: ownerEmail, role: "owner", status: "active", createdAt: new Date().toISOString() });
  const memberEmail = `m-${RUN}-${label}@example.com`;
  await cols.orgMembers.insertOne({ orgId: _id, email: memberEmail, role: "member", status: "active", createdAt: new Date().toISOString() });
  const owner = await cols.orgMembers.findOne({ orgId: _id, email: ownerEmail }); const member = await cols.orgMembers.findOne({ orgId: _id, email: memberEmail });
  return { orgId: String(_id), ownerEmail, owner, member };
}

test("validatePolicyPatch: only known, well-typed, in-range settings are accepted", () => {
  assert.deepEqual(validatePolicyPatch({ allowSensitiveData: true, maxTokenBudget: 5000, allowedProviders: ["google", "google"] }).patch, { allowSensitiveData: true, maxTokenBudget: 5000, allowedProviders: ["google"] });
  for (const [input, re] of [
    [{ nonsense: 1 }, /Unknown policy setting/],
    [{ allowExternalModels: "false" }, /true or false/],
    [{ maxTokenBudget: 5 }, /between 1000/],
    [{ maxTokenBudget: 1500.5 }, /whole number/],
    [{ retentionDays: 0 }, /retentionDays/],
    [{ allowedProviders: [] }, /at least one/],
    [{ allowedProviders: ["openai-x"] }, /Unknown provider/],
    [{}, /No policy settings/],
    [null, /must be an object/],
    [["a"], /must be an object/],
  ]) assert.match(validatePolicyPatch(input).error, re, JSON.stringify(input));
});

test("setOrgAiPolicy rejects bad input with 400 and stores nothing; members cannot write; good writes version", async () => {
  const o = await makeOrg("w");
  const bad = await setOrgAiPolicy({ orgId: o.orgId, policy: { allowExternalModels: "yes" }, membership: o.owner, actorEmail: o.ownerEmail });
  assert.equal(bad.status, 400);
  assert.equal((await getOrgAiPolicy(o.orgId)).version, 0, "a rejected write creates no version");
  const denied = await setOrgAiPolicy({ orgId: o.orgId, policy: { allowSensitiveData: true }, membership: o.member, actorEmail: "x@example.com" });
  assert.equal(denied.status, 403);
  const ok = await setOrgAiPolicy({ orgId: o.orgId, policy: { maxTokenBudget: 2000 }, membership: o.owner, actorEmail: o.ownerEmail });
  assert.equal(ok.policy.version, 1); assert.equal(ok.policy.maxTokenBudget, 2000); assert.equal(ok.policy.allowedProviders[0], "google", "untouched settings keep their defaults");
  await setOrgAiPolicy({ orgId: o.orgId, policy: { retentionDays: 90 }, membership: o.owner, actorEmail: o.ownerEmail });
  const hist = await listOrgAiPolicyVersions({ orgId: o.orgId, membership: o.owner });
  assert.deepEqual(hist.versions.map((v) => [v.version, v.active]), [[2, true], [1, false]]);
  assert.equal((await listOrgAiPolicyVersions({ orgId: o.orgId, membership: o.member })).status, 403);
});

test("gateway: the token budget blocks an oversized request and records a POLICY event; normal requests still pass", async () => {
  const o = await makeOrg("b");
  const ask = (text) => checkInputSecurity({ orgId: o.orgId, actorEmail: o.ownerEmail, surface: `pol-${RUN}-${Math.random()}`, userInput: text });
  assert.equal((await ask("What is our overdue invoice total?")).allowed, true, "default policy is unchanged");
  await setOrgAiPolicy({ orgId: o.orgId, policy: { maxTokenBudget: 1000 }, membership: o.owner, actorEmail: o.ownerEmail });
  assert.equal((await ask("What is our overdue invoice total?")).allowed, true);
  const big = await ask("word ".repeat(1200)); // ~1500 tokens
  assert.equal(big.allowed, false);
  assert.match(big.reason, /token budget/);
  assert.deepEqual(big.event.controlsTriggered, ["AI-POLICY-001"]);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(await cols.aiSecurityChecks.findOne({ orgId: new (await import("mongodb")).ObjectId(o.orgId), category: "POLICY" }), "the block is recorded as a POLICY security event");
});

test("gateway: the provider list and the unapproved-model rule are enforced per org", async () => {
  const o = await makeOrg("p");
  const ask = (extra) => checkInputSecurity({ orgId: o.orgId, actorEmail: o.ownerEmail, surface: `pol2-${RUN}-${Math.random()}`, userInput: "Summarise open tasks.", ...extra });
  // groq is a REVIEW model: blocked by default (provider not allowed AND not approved) ...
  const r1 = await ask({ provider: "groq", modelId: "openai/gpt-oss-120b" });
  assert.equal(r1.allowed, false);
  assert.match(r1.event.reasons.join(" "), /provider/);
  // ... allowing the provider is not enough while unapproved models are off ...
  await setOrgAiPolicy({ orgId: o.orgId, policy: { allowedProviders: ["google", "groq"] }, membership: o.owner, actorEmail: o.ownerEmail });
  const r2 = await ask({ provider: "groq", modelId: "openai/gpt-oss-120b" });
  assert.equal(r2.allowed, false);
  assert.match(r2.reason, /only allows approved models/);
  // ... and with both opened up it passes; the approved google model passed throughout.
  await setOrgAiPolicy({ orgId: o.orgId, policy: { allowExternalModels: true }, membership: o.owner, actorEmail: o.ownerEmail });
  assert.equal((await ask({ provider: "groq", modelId: "openai/gpt-oss-120b" })).allowed, true);
  assert.equal((await ask({})).allowed, true);
  assert.equal(DEFAULT_AI_POLICY.allowExternalModels, false);
});
