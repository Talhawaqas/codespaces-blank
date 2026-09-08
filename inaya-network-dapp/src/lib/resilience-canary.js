// src/lib/resilience-canary.js
//
// Autonomous Resilience Layer SOW, Phase 2 (canary half) — the answer to
// a hard constraint Phase 0 surfaced: reconstructAndDecrypt() needs the
// real user's plaintext passkey, which this system never stores, so a
// real customer vault can never be automatically, unattended
// reconstructed on a schedule. Confirmed with the user: resilience tests
// run against small SYNTHETIC "canary" assets the resilience layer
// itself owns, pushed through the exact same real pipeline real customer
// uploads use --
//   InayaKernel.disperseAndSlice (custody-sdk, confirmed Node-callable)
//   -> pinningProviders/pinata.js's pin() (the same adapter
//      replicateShard() itself calls, not a hand-rolled duplicate)
//   -> backupEngine.js's replicateShard() (the exact production
//      replication/registration function, unmodified in behavior --
//      see its one additive providerRef field, added this same SOW)
// -- so every primitive under test is real production code, just
// exercised against content this system can safely own and rebung.
//
// fileHash matches src/lib/clientCrypto.js's encryptAndShardFile()
// EXACTLY: "0x" + sha256(shardAlpha + shardBeta) -- same algorithm, same
// prefix, so a canary's fileHash is indistinguishable in shape from a
// real document's.
//
// A canary is ALSO a real, minimal orgDocuments row (isResilienceCanary:
// true, hidden from normal document browsing by that flag) so
// getDocumentAccessLevel()/getAccessibleScope() -- the real permission
// machinery -- can be genuinely exercised by the orchestrator, not
// simulated.
//
// The synthetic passkey is generated and stored directly on the canary
// document. This is safe ONLY because a canary is never real customer
// data -- it is the one deliberate exception to "never store a passkey
// server-side," and it exists specifically so recovery testing can be
// fully unattended.

import { createHash, randomBytes } from "node:crypto";
import { InayaKernel } from "@inaya-network/custody-sdk";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { getProvider, listAvailableProviders } from "./pinningProviders/index.js";
import { replicateShard } from "./backupEngine.js";
import { getPolicy } from "./resilience-policy.js";

const RESILIENCE_DEPARTMENT_NAME = "Resilience Testing (System)";
const RESILIENCE_PROJECT_NAME = "Canary Assets";

function sha256Hex0x(text) {
  return "0x" + createHash("sha256").update(text).digest("hex");
}

function makeSyntheticFile(name, contentString) {
  const bytes = new TextEncoder().encode(contentString);
  return { name, type: "application/json", arrayBuffer: async () => bytes.buffer };
}

/** Creates (once) the hidden department/project every org's canaries live
 *  under, so canaries are genuinely department-scoped (real permission
 *  boundary, not a special-cased exemption) without requiring every
 *  resilience policy to separately pick one. Idempotent. */
async function ensureResilienceHome(orgId) {
  const { departments, projects } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();

  let dept = await departments.findOne({ orgId: orgObjectId, name: RESILIENCE_DEPARTMENT_NAME });
  if (!dept) {
    const { insertedId } = await departments.insertOne({ orgId: orgObjectId, name: RESILIENCE_DEPARTMENT_NAME, createdAt: now });
    dept = { _id: insertedId };
  }
  let proj = await projects.findOne({ orgId: orgObjectId, departmentId: dept._id, name: RESILIENCE_PROJECT_NAME });
  if (!proj) {
    const { insertedId } = await projects.insertOne({ orgId: orgObjectId, departmentId: dept._id, name: RESILIENCE_PROJECT_NAME, createdAt: now });
    proj = { _id: insertedId };
  }
  return { departmentId: dept._id, projectId: proj._id };
}

/** Idempotent: creates one canary per policy category if missing, reuses
 *  existing ones otherwise (canaries are persistent, reusable fixtures --
 *  a deliberate scope decision, not an oversight: re-creating one on
 *  every test run would just add real Pinata/Filebase cost for no
 *  benefit, since the orchestrator already re-tests the EXISTING
 *  replicas/health state on every run). Returns every canary for the
 *  policy, existing or newly created. */
export async function ensureCanaryAssets(policyId, { orgId, actorEmail }) {
  const { resilienceCanaryAssets, orgDocuments } = await getOrgCollections();
  const policyResult = await getPolicy({ orgId, policyId });
  if (policyResult.error) return policyResult;
  const policy = policyResult.policy;

  // Real production always pins primary via Pinata (api/upload/route.js) --
  // but this picks whichever REAL provider is actually configured in the
  // current environment, matching pinningProviders/index.js's own stated
  // purpose for listAvailableProviders() ("gate integration tests... rather
  // than failing"). Still 100% real pinning/replication either way, never
  // a mock -- just not hardcoded to a provider that might not have
  // credentials in every environment this runs in.
  const availableProviders = listAvailableProviders();
  if (availableProviders.length === 0) return { error: "No pinning provider is configured -- resilience canaries need at least one of PINATA_JWT / FILEBASE_* to be set.", status: 500 };
  const primaryProviderName = availableProviders[0];

  const { departmentId, projectId } = await ensureResilienceHome(orgId);
  const orgObjectId = toObjectId(orgId);
  const policyObjectId = toObjectId(policyId);
  const canaries = [];

  for (const category of policy.criticalAssetCategories) {
    const existing = await resilienceCanaryAssets.findOne({ orgId: orgObjectId, policyId: policyObjectId, categoryLabel: category.label });
    if (existing) {
      canaries.push(existing);
      continue;
    }

    const passkey = randomBytes(32).toString("hex");
    const content = JSON.stringify({ resilienceCanary: true, policyId: policyId.toString(), categoryLabel: category.label, nonce: randomBytes(8).toString("hex"), createdAt: new Date().toISOString() });
    const expectedContentHash = sha256Hex0x(content);

    const salt = InayaKernel.generateSecureSalt();
    const encryptionKey = await InayaKernel.deriveVaultKey({ passkey, salt });
    const file = makeSyntheticFile(`resilience-canary-${category.label}.json`, content);
    const { shardAlpha, shardBeta } = await InayaKernel.disperseAndSlice({ file, encryptionKey });
    const fileHash = sha256Hex0x(shardAlpha + shardBeta);

    const pinResults = {};
    const replicasByShardId = {};
    for (const [shardId, shardContent] of [["alpha", shardAlpha], ["beta", shardBeta]]) {
      const primaryPin = await getProvider(primaryProviderName).pin(shardContent, { name: `resilience_${fileHash}_${shardId}` });
      const { replicas } = await replicateShard({ fileHash, shardId, content: shardContent, primaryProvider: primaryProviderName, primaryCid: primaryPin.cid, primaryProviderRef: primaryPin.providerRef });
      pinResults[shardId] = primaryPin.cid;
      // Captured here (not re-derived later) because getBackupStatus()'s summary
      // doesn't expose providerRef -- replicateShard()'s own return is the one
      // place a Filebase-style providerRef (its S3 key, distinct from cid) is
      // ever visible to a caller.
      replicasByShardId[shardId] = replicas.filter((r) => r.status !== "failed").map((r) => ({ provider: r.provider, cid: r.cid, providerRef: r.providerRef }));
    }

    const now = new Date().toISOString();
    const { insertedId: documentId } = await orgDocuments.insertOne({
      orgId: orgObjectId, departmentId, projectId,
      filename: `resilience-canary-${category.label}.json`,
      fileHash, sizeBytes: content.length, cidAlpha: pinResults.alpha, cidBeta: pinResults.beta,
      uploadedByEmail: actorEmail, txHash: null, status: "APPROVED", accessLevel: "DEPARTMENT",
      isResilienceCanary: true, createdAt: now, deletedAt: null,
    });

    const doc = {
      orgId: orgObjectId, policyId: policyObjectId, categoryLabel: category.label,
      documentId, departmentId, projectId, fileHash, expectedContentHash, passkey,
      replicas: replicasByShardId, createdAt: now,
    };
    const { insertedId } = await resilienceCanaryAssets.insertOne(doc);
    canaries.push({ ...doc, _id: insertedId });
  }

  return { canaries };
}

export async function listCanaryAssets({ orgId, policyId }) {
  const { resilienceCanaryAssets } = await getOrgCollections();
  const rows = await resilienceCanaryAssets.find({ orgId: toObjectId(orgId), policyId: toObjectId(policyId) }).toArray();
  return { canaries: rows };
}
