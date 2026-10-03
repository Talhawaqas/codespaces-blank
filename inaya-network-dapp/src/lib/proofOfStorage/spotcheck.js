// Automated proof-of-storage spot-check.
//
// At upload the browser builds a Merkle tree over the file's ciphertext (alpha shard + beta shard,
// as one string, in 256 KB chunks) and registers only the ROOT on InayaProofRegistry. Nothing
// ever re-checked that what the providers hold today still hashes to that root: verifyChunkProof()
// had no automated caller. This audit closes that loop without a signer or a transaction:
//
//   1. take the files least recently audited,
//   2. read the registered root from the registry (a view call),
//   3. fetch the alpha and beta shards from the providers that hold them,
//   4. rebuild the Merkle root from the fetched bytes with the same code the uploader used,
//   5. compare. Match = the stored data is exactly what was committed to on-chain.
//
// It deliberately does NOT submit verifyChunkProof() transactions (that mutates on-chain node
// reliability counters and needs a funded verifier key) and never slashes anyone: a mismatch is
// recorded and surfaced for a human, not punished automatically.

import { ethers } from "ethers";
import { buildProofOfStoragePayload } from "../merkle.js";
import { connectToDatabase } from "../mongodb.js";
import { getProvider } from "../pinningProviders/index.js";
import { getShardReplicaRefs, listWalletStyleFileHashes } from "../backupEngine.js";
import { getAdapter } from "../chain-adapters/index.js";
import { CHAIN_IDS } from "../chains.js";

export const STATUS = {
  PASSED: "PASSED",
  ROOT_MISMATCH: "ROOT_MISMATCH",
  FETCH_FAILED: "FETCH_FAILED",
  NO_ROOT: "NO_ROOT",
  NO_REPLICAS: "NO_REPLICAS",
  TOO_LARGE: "TOO_LARGE",
};

const REGISTRY_ABI = [
  "function getAssetProof(bytes32 _fileHash) external view returns (tuple(bytes32 merkleRoot, uint256 chunkCount, address owner, address node, uint256 registeredAt, uint256 lastVerifiedAt, uint256 challengesPassed, uint256 challengesFailed))",
];
const DEFAULT_REGISTRY = "0xEdF431857e92A00420444F27Ad105278b21CEBcB";

/** Production dependencies. Injectable so the comparison logic is testable without a chain. */
export function defaultDeps() {
  return {
    async getOnChainRoot(fileHash) {
      const provider = getAdapter(CHAIN_IDS.BSC_TESTNET, { useServerRpc: true }).provider;
      const registry = new ethers.Contract(process.env.NEXT_PUBLIC_PROOF_REGISTRY_ADDRESS || DEFAULT_REGISTRY, REGISTRY_ABI, provider);
      const proof = await registry.getAssetProof(fileHash);
      if (!proof.merkleRoot || proof.merkleRoot === ethers.ZeroHash) return null;
      return { root: proof.merkleRoot.toLowerCase(), chunkCount: Number(proof.chunkCount) };
    },
    getReplicaRefs: getShardReplicaRefs,
    listWalletFileHashes: listWalletStyleFileHashes,
    async fetchShard({ provider, providerRef }) {
      const content = await getProvider(provider).fetchReplica(providerRef);
      return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
    },
  };
}

async function fetchFirstWorking(refs, deps, maxBytes) {
  let lastError = null;
  for (const ref of refs) {
    try {
      const shard = await deps.fetchShard(ref);
      if (typeof shard === "string" && shard.length) return { shard, ref };
      lastError = new Error("empty shard");
    } catch (err) {
      lastError = err;
    }
  }
  return { error: lastError?.message || "no replica to fetch from" };
}

/** Audits one file. Never throws for an expected failure mode: it returns a status. */
export async function spotCheckFile(fileHash, { deps = defaultDeps(), maxBytes = 16 * 1024 * 1024 } = {}) {
  const checkedAt = new Date().toISOString();
  const result = (status, extra = {}) => ({ fileHash, status, checkedAt, ...extra });

  let onChain;
  try { onChain = await deps.getOnChainRoot(fileHash); } catch (err) { return result(STATUS.FETCH_FAILED, { detail: `registry read failed: ${err.message}` }); }
  if (!onChain) return result(STATUS.NO_ROOT, { detail: "no Merkle root is registered for this file" });

  const refs = await deps.getReplicaRefs(fileHash);
  if (!refs.alpha.length || !refs.beta.length) return result(STATUS.NO_REPLICAS, { detail: "no retrievable replica for one of the shards", registeredRoot: onChain.root });

  const [alpha, beta] = await Promise.all([fetchFirstWorking(refs.alpha, deps, maxBytes), fetchFirstWorking(refs.beta, deps, maxBytes)]);
  if (alpha.error || beta.error) {
    return result(STATUS.FETCH_FAILED, { detail: `could not fetch ${alpha.error ? "alpha" : "beta"}: ${alpha.error || beta.error}`, registeredRoot: onChain.root });
  }
  const bytes = alpha.shard.length + beta.shard.length;
  if (bytes > maxBytes) return result(STATUS.TOO_LARGE, { detail: `${bytes} bytes exceeds the ${maxBytes}-byte audit limit`, registeredRoot: onChain.root });

  const { root, chunkCount } = buildProofOfStoragePayload(alpha.shard + beta.shard);
  const computedRoot = root.toLowerCase();
  const matches = computedRoot === onChain.root;
  return result(matches ? STATUS.PASSED : STATUS.ROOT_MISMATCH, {
    registeredRoot: onChain.root,
    computedRoot,
    registeredChunkCount: onChain.chunkCount,
    computedChunkCount: chunkCount,
    sizeBytes: bytes,
    alphaProvider: alpha.ref.provider,
    betaProvider: beta.ref.provider,
    ...(matches ? {} : { detail: onChain.chunkCount !== chunkCount ? `chunk count differs (${onChain.chunkCount} registered, ${chunkCount} stored)` : "stored bytes no longer hash to the registered root" }),
  });
}

/** Audits the `limit` least recently audited wallet files and records each outcome. `only` restricts
 *  the candidate set to specific file hashes (used by tests and for targeted re-checks). */
export async function runProofSpotChecks({ limit = 3, deps = defaultDeps(), maxBytes, only } = {}) {
  const { db } = await connectToDatabase();
  const files = db.collection("metadata_files");
  const checks = db.collection("proof_spotchecks");
  await checks.createIndex({ fileHash: 1 }, { unique: true });

  const lastChecked = new Map((await checks.find({}, { projection: { fileHash: 1, checkedAt: 1 } }).toArray()).map((c) => [c.fileHash, c.checkedAt]));
  // Candidates: registered wallet files plus wallet-style hashes in the replica inventory.
  const query = only ? { deletedAt: null, fileHash: { $in: only } } : { deletedAt: null };
  const registered = (await files.find(query, { projection: { fileHash: 1 } }).toArray()).map((f) => f.fileHash);
  const replicated = only ? [] : await (deps.listWalletFileHashes ? deps.listWalletFileHashes() : []);
  const candidates = [...new Set([...registered, ...replicated])]
    .filter(Boolean)
    .sort((a, b) => (lastChecked.get(a) || "").localeCompare(lastChecked.get(b) || "")) // never-checked first, then oldest
    .slice(0, limit);

  const results = [];
  for (const fileHash of candidates) {
    const outcome = await spotCheckFile(fileHash, { deps, ...(maxBytes ? { maxBytes } : {}) });
    await checks.updateOne({ fileHash }, { $set: outcome, $inc: { checkCount: 1 }, $setOnInsert: { firstCheckedAt: outcome.checkedAt } }, { upsert: true });
    if (outcome.status === STATUS.ROOT_MISMATCH) console.error(`proof-of-storage spot-check: ROOT MISMATCH for ${fileHash} -- ${outcome.detail}`);
    results.push({ fileHash, status: outcome.status });
  }
  const summary = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  return { checked: results.length, summary, results };
}
