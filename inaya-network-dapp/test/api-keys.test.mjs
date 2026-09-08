// test/api-keys.test.mjs
//
// Institutional Trust Infrastructure SOW, Phase 4 coverage: key issuance
// (raw value returned once, only its hash ever persisted), revocation,
// listApiKeys never exposing the hash/raw value, and requireApiKey()'s
// resolution — including the core security guarantee that a key always
// resolves to its OWN bound org, never one the caller names.
//
// requireApiKey() takes a plain Request-like object ({headers: {get}}) —
// api-keys.js itself never imports next/server, so this can be
// constructed by hand instead of needing route.js (which plain
// `node --test` can't resolve, per this codebase's established
// convention -- see task-workflow.test.mjs's header comment).
//
// Run with: node --env-file=.env.local --test test/api-keys.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createApiKey, revokeApiKey, listApiKeys, requireApiKey } from "../src/lib/api-keys.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-apikeys-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { apiKeys } = collections;
  await apiKeys.deleteMany({ orgId: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function newOrgId() {
  const id = new ObjectId();
  cleanup.orgIds.push(id);
  return id;
}

function fakeReq(rawKey) {
  return { headers: { get: (name) => (name.toLowerCase() === "authorization" && rawKey ? `Bearer ${rawKey}` : null) } };
}

test("createApiKey: returns the raw key once; only its hash is ever stored", async () => {
  const orgId = newOrgId();
  const { rawKey, apiKeyId } = await createApiKey({ orgId, label: "test key", actorEmail: email("a") });
  assert.ok(rawKey.startsWith("inaya_"));

  const { apiKeys } = collections;
  const stored = await apiKeys.findOne({ _id: new ObjectId(apiKeyId) });
  assert.ok(stored.tokenHash, "a hash must be stored");
  assert.notEqual(stored.tokenHash, rawKey, "the raw key itself must never be stored");
  assert.equal(stored.tokenHash.length, 64, "sha256 hex digest length");
});

test("listApiKeys: never exposes tokenHash or the raw key", async () => {
  const orgId = newOrgId();
  await createApiKey({ orgId, label: "list-test", actorEmail: email("b") });
  const { apiKeys } = await listApiKeys({ orgId });
  assert.equal(apiKeys.length, 1);
  assert.ok(!("tokenHash" in apiKeys[0]));
  assert.ok(!("rawKey" in apiKeys[0]));
});

test("revokeApiKey: revoking twice fails the second time (already gone)", async () => {
  const orgId = newOrgId();
  const { apiKeyId } = await createApiKey({ orgId, label: "revoke-test", actorEmail: email("c") });
  const first = await revokeApiKey({ orgId, apiKeyId });
  assert.equal(first.revoked, true);
  const second = await revokeApiKey({ orgId, apiKeyId });
  assert.equal(second.status, 404);
});

test("requireApiKey: a valid key resolves to its own bound org, an invalid/missing/revoked key is rejected", async () => {
  const orgId = newOrgId();
  const { rawKey, apiKeyId } = await createApiKey({ orgId, label: "auth-test", actorEmail: email("d") });

  const ok = await requireApiKey(fakeReq(rawKey));
  assert.equal(ok.orgId, orgId.toString());
  assert.equal(ok.membership.role, "owner");

  const missing = await requireApiKey(fakeReq(null));
  assert.equal(missing.status, 401);

  const garbage = await requireApiKey(fakeReq("not-a-real-key"));
  assert.equal(garbage.status, 401);

  await revokeApiKey({ orgId, apiKeyId });
  const revoked = await requireApiKey(fakeReq(rawKey));
  assert.equal(revoked.status, 401, "a revoked key must stop authenticating immediately");
});

test("SECURITY: a key always resolves to its OWN org -- there is no parameter to override this", async () => {
  const orgA = newOrgId();
  const orgB = newOrgId();
  const { rawKey: keyA } = await createApiKey({ orgId: orgA, label: "org-a-key", actorEmail: email("e") });
  await createApiKey({ orgId: orgB, label: "org-b-key", actorEmail: email("f") });

  const resolved = await requireApiKey(fakeReq(keyA));
  assert.equal(resolved.orgId, orgA.toString());
  assert.notEqual(resolved.orgId, orgB.toString(), "org A's key must never resolve to org B under any circumstance");
});
